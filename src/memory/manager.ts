import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fsSync from "node:fs";
import { type FSWatcher } from "chokidar";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { extractKeywords } from "./query-expansion.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;

const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();

// ── hmem knowledge base support ──────────────────────────────────────────
const HMEM_FILENAME = "OPENCLAW.hmem";
let hmemDbCache: { db: DatabaseSync; path: string } | null = null;

function getHmemDb(workspaceDir: string): DatabaseSync | null {
  const hmemPath = path.resolve(workspaceDir, HMEM_FILENAME);
  if (hmemDbCache?.path === hmemPath) {
    return hmemDbCache.db;
  }
  if (!fsSync.existsSync(hmemPath)) {
    return null;
  }
  try {
    const db = new DatabaseSync(hmemPath);
    hmemDbCache = { db, path: hmemPath };
    return db;
  } catch (err) {
    log.warn(`hmem: failed to open ${hmemPath}: ${err}`);
    return null;
  }
}

/**
 * Search the hmem knowledge base by querying the `memories` table (entry-level).
 * Only 339 rows — fast even without indexes. Returns entry titles + L1 summaries.
 * The agent can then drill down via readHmemNode().
 */
function searchHmem(
  workspaceDir: string,
  query: string,
  maxResults: number,
): MemorySearchResult[] {
  const db = getHmemDb(workspaceDir);
  if (!db) return [];
  try {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (keywords.length === 0) return [];

    // Search entry-level only (memories table, ~339 rows) — title + level_1
    const conditions = keywords.map(
      () => "(LOWER(title) LIKE ? OR LOWER(level_1) LIKE ?)",
    );
    const params = keywords.flatMap((kw) => [`%${kw}%`, `%${kw}%`]);

    const rows = db
      .prepare(
        `SELECT prefix || printf('%04d', seq) as id, title, level_1
         FROM memories
         WHERE (obsolete = 0 OR obsolete IS NULL) AND (${conditions.join(" OR ")})
         LIMIT ?`,
      )
      .all(...params, maxResults * 2) as Array<{
      id: string;
      title: string;
      level_1: string;
    }>;

    // Score by keyword hits in title (2x weight) + level_1
    const scored = rows
      .map((row) => {
        const titleLower = (row.title ?? "").toLowerCase();
        const l1Lower = (row.level_1 ?? "").toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (titleLower.includes(kw)) score += 2;
          if (l1Lower.includes(kw)) score += 1;
        }
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored.map(({ row, score }) => ({
      path: HMEM_FILENAME,
      startLine: 1,
      endLine: 1,
      score: Math.min(score / (keywords.length * 2), 1),
      snippet: `[hmem:${row.id}] ${row.title}\n${(row.level_1 ?? "").substring(0, SNIPPET_MAX_CHARS)}`,
      source: "memory" as MemorySource,
    }));
  } catch (err) {
    log.warn(`hmem search failed: ${err}`);
    return [];
  }
}

/**
 * Read an hmem node by ID. Supports both entry IDs (O0030) and node IDs (O0030.2).
 * Returns the node content + its direct children for lazy-loading.
 */
function readHmemNode(
  workspaceDir: string,
  nodeId: string,
): { text: string; path: string } | null {
  const db = getHmemDb(workspaceDir);
  if (!db) return null;
  try {
    // Check if it's a root entry ID (no dots) — return entry + L2 children
    if (!nodeId.includes(".")) {
      const entry = db
        .prepare(
          `SELECT prefix || printf('%04d', seq) as id, title, level_1
           FROM memories WHERE prefix || printf('%04d', seq) = ?`,
        )
        .get(nodeId) as { id: string; title: string; level_1: string } | undefined;
      if (!entry) return null;

      const children = db
        .prepare(
          `SELECT id, content FROM memory_nodes
           WHERE id LIKE ? AND depth = 2 ORDER BY id`,
        )
        .all(`${nodeId}.%`, ) as Array<{ id: string; content: string }>;

      const lines = [`[${entry.id}] ${entry.title}`, entry.level_1];
      for (const child of children) {
        const text =
          child.content.length > 200 ? child.content.substring(0, 200) + "..." : child.content;
        lines.push(`  [${child.id}] ${text}`);
      }
      return { text: lines.join("\n"), path: `hmem:${nodeId}` };
    }

    // Node ID with dots — read the specific node + direct children
    const node = db
      .prepare("SELECT id, content, depth FROM memory_nodes WHERE id = ?")
      .get(nodeId) as { id: string; content: string; depth: number } | undefined;
    if (!node) return null;

    const children = db
      .prepare(
        `SELECT id, content, depth FROM memory_nodes
         WHERE id LIKE ? AND depth = ?
         ORDER BY id`,
      )
      .all(`${nodeId}.%`, node.depth + 1) as Array<{
      id: string;
      content: string;
      depth: number;
    }>;

    const lines = [`[${node.id}] ${node.content}`];
    for (const child of children) {
      const text =
        child.content.length > 200 ? child.content.substring(0, 200) + "..." : child.content;
      lines.push(`  [${child.id}] ${text}`);
    }
    return { text: lines.join("\n"), path: `hmem:${nodeId}` };
  } catch (err) {
    log.warn(`hmem readNode failed: ${err}`);
    return null;
  }
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "auto";
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral";
  protected fallbackReason?: string;
  private readonly providerUnavailableReason?: string;
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
      purpose: params.purpose,
    });
    INDEX_CACHE.set(key, manager);
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.providerUnavailableReason = params.providerResult.providerUnavailableReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.mistral = params.providerResult.mistral;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.ensureWatcher();
    this.ensureSessionListener();
    this.ensureIntervalSync();
    const statusOnly = params.purpose === "status";
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
    this.batch = this.resolveBatchConfig();
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    void this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        // Fall through to hmem-only search below
        return this.mergeWithHmem([], cleaned, maxResults);
      }

      // Extract keywords for better FTS matching on conversational queries
      // e.g., "that thing we discussed about the API" → ["discussed", "API"]
      const keywords = extractKeywords(cleaned);
      const searchTerms = keywords.length > 0 ? keywords : [cleaned];

      // Search with each keyword and merge results
      const resultSets = await Promise.all(
        searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
      );

      // Merge and deduplicate results, keeping highest score for each chunk
      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()]
        .toSorted((a, b) => b.score - a.score)
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults);

      return this.mergeWithHmem(merged, cleaned, maxResults);
    }

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled) {
      const results = vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
      return this.mergeWithHmem(results, cleaned, maxResults);
    }

    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });

    const results = merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    return this.mergeWithHmem(results, cleaned, maxResults);
  }

  /**
   * Merge normal search results with hmem knowledge base results.
   * hmem results fill remaining slots after normal results.
   */
  private mergeWithHmem(
    normalResults: MemorySearchResult[],
    query: string,
    maxResults: number,
  ): MemorySearchResult[] {
    const hmemSlots = Math.max(3, maxResults - normalResults.length);
    const hmemResults = searchHmem(this.workspaceDir, query, hmemSlots);
    if (hmemResults.length === 0) return normalResults;
    // Deduplicate by snippet prefix (hmem results have unique node IDs in snippet)
    const combined = [...normalResults];
    for (const hr of hmemResults) {
      if (combined.length >= maxResults) break;
      combined.push(hr);
    }
    return combined;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    // In FTS-only mode (no provider), search all models; otherwise filter by current provider's model
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    // Check if path is an hmem node ID (e.g. O0030, O0030.2, E0006.1)
    if (/^[A-Z]\d{4}(\.\d+)*$/.test(rawPath)) {
      const hmemResult = readHmemNode(this.workspaceDir, rawPath);
      if (hmemResult) return hmemResult;
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const statResult = await statRegularFile(absPath);
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if (isFileMissingError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
    })();

    // Determine search mode: "fts-only" if no provider, "hybrid" otherwise
    const searchMode = this.provider ? "hybrid" : "fts-only";
    const providerInfo = this.provider
      ? { provider: this.provider.id, model: this.provider.model }
      : { provider: "none", model: undefined };

    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    // FTS-only mode: vector search not available
    if (!this.provider) {
      return false;
    }
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      };
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingSync = this.syncing;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    if (pendingSync) {
      try {
        await pendingSync;
      } catch {}
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}

#!/usr/bin/env node
/**
 * Ingest curated OpenClaw docs into OPENCLAW.hmem.
 *
 * Two prefixes:
 *   W — Workspace bootstrap files (SOUL.md, TOOLS.md, USER.md, etc.)
 *   O — Curated documentation (AGENTS.md reference chain + core concepts)
 *
 * Usage: node scripts/ingest-docs.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { HmemStore, loadHmemConfig } from "../../hmem/dist/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const HMEM_PATH = path.join(ROOT, "OPENCLAW.hmem");
const DRY_RUN = process.argv.includes("--dry-run");

// ============================================================
// File lists — curated, not blind-walked
// ============================================================

/** Workspace bootstrap templates → W prefix */
const WORKSPACE_FILES = [
  "docs/reference/templates/SOUL.md",
  "docs/reference/templates/TOOLS.md",
  "docs/reference/templates/USER.md",
  "docs/reference/templates/HEARTBEAT.md",
  "docs/reference/templates/IDENTITY.md",
  "docs/reference/templates/BOOT.md",
  "docs/reference/templates/BOOTSTRAP.md",
];

/** Curated docs → O prefix */
const DOC_FILES = [
  // AGENTS.md reference chain
  "SECURITY.md",
  "docs/reference/RELEASING.md",
  "docs/platforms/mac/release.md",
  "docs/help/testing.md",
  "docs/gateway/doctor.md",
  "docs/.i18n/README.md",
  ".github/pull_request_template.md",

  // Channels (directly referenced from AGENTS.md)
  "docs/channels/bluebubbles.md",
  "docs/channels/broadcast-groups.md",
  "docs/channels/channel-routing.md",
  "docs/channels/discord.md",
  "docs/channels/feishu.md",
  "docs/channels/googlechat.md",
  "docs/channels/grammy.md",
  "docs/channels/group-messages.md",
  "docs/channels/groups.md",
  "docs/channels/imessage.md",
  "docs/channels/index.md",
  "docs/channels/irc.md",
  "docs/channels/line.md",
  "docs/channels/location.md",
  "docs/channels/matrix.md",
  "docs/channels/mattermost.md",
  "docs/channels/msteams.md",
  "docs/channels/nextcloud-talk.md",
  "docs/channels/nostr.md",
  "docs/channels/pairing.md",
  "docs/channels/signal.md",
  "docs/channels/slack.md",
  "docs/channels/synology-chat.md",
  "docs/channels/telegram.md",
  "docs/channels/tlon.md",
  "docs/channels/troubleshooting.md",
  "docs/channels/twitch.md",
  "docs/channels/whatsapp.md",
  "docs/channels/zalo.md",
  "docs/channels/zalouser.md",

  // Core concepts (architecture knowledge for developer agent)
  "docs/concepts/agent.md",
  "docs/concepts/agent-loop.md",
  "docs/concepts/agent-workspace.md",
  "docs/concepts/architecture.md",
  "docs/concepts/compaction.md",
  "docs/concepts/context.md",
  "docs/concepts/features.md",
  "docs/concepts/markdown-formatting.md",
  "docs/concepts/memory.md",
  "docs/concepts/messages.md",
  "docs/concepts/model-failover.md",
  "docs/concepts/model-providers.md",
  "docs/concepts/models.md",
  "docs/concepts/multi-agent.md",
  "docs/concepts/oauth.md",
  "docs/concepts/presence.md",
  "docs/concepts/queue.md",
  "docs/concepts/retry.md",
  "docs/concepts/session.md",
  "docs/concepts/session-pruning.md",
  "docs/concepts/session-tool.md",
  "docs/concepts/streaming.md",
  "docs/concepts/system-prompt.md",
  "docs/concepts/timezone.md",
  "docs/concepts/typebox.md",
  "docs/concepts/typing-indicators.md",
  "docs/concepts/usage-tracking.md",

  // Design docs
  "docs/design/kilo-gateway-integration.md",
];

// ============================================================
// Frontmatter parser
// ============================================================

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { meta: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: content };

  const yaml = content.substring(4, end).trim();
  const meta = {};
  for (const line of yaml.split("\n")) {
    const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (match) meta[match[1]] = match[2];
  }
  return { meta, body: content.substring(end + 4).trim() };
}

// ============================================================
// Markdown → hmem converter
// ============================================================

/**
 * Convert markdown to hmem content string.
 *
 * Structure:
 *   L1 (0 tabs): title — summary (≤118 chars)
 *   L2 (1 tab):  ## headings + prose
 *   L3 (2 tabs): ### headings
 *   L4 (3 tabs): #### headings
 *   Code blocks: +1 tab from current heading, joined with " | "
 */
function mdToHmem(title, summary, body) {
  const lines = body.split("\n");
  const parts = [];

  // L1: "Title — Summary" (≤118 chars for autoExtractTitle)
  const maxL1 = 118;
  if (summary) {
    const combined = `${title} — ${summary}`;
    if (combined.length <= maxL1) {
      parts.push(combined);
    } else {
      const available = maxL1 - title.length - 3;
      parts.push(available > 20 ? `${title} — ${summary.substring(0, available)}` : title);
    }
  } else {
    parts.push(title);
  }

  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let headingDepth = 1;
  let proseBuffer = [];

  function flushProse() {
    const text = proseBuffer.join(" ").trim();
    proseBuffer = [];
    if (!text) return;
    const maxChars = headingDepth <= 1 ? 2400 : headingDepth <= 2 ? 5000 : 10000;
    const truncated = text.length > maxChars ? text.substring(0, maxChars) : text;
    const tabs = "\t".repeat(headingDepth);
    parts.push(`${tabs}${truncated}`);
  }

  for (const line of lines) {
    // Skip H1
    if (!inCode && /^# [^#]/.test(line)) continue;

    // Code fence
    if (line.startsWith("```")) {
      if (!inCode) {
        flushProse();
        inCode = true;
        codeLang = line.substring(3).trim() || "code";
        codeLines = [];
        continue;
      } else {
        inCode = false;
        const depth = Math.min(headingDepth + 1, 4);
        const tabs = "\t".repeat(depth);
        const codeSingleLine = codeLines.map(l => l.trim()).filter(Boolean).join(" | ");
        const maxCodeLen = 1500;
        const truncCode = codeSingleLine.length > maxCodeLen
          ? codeSingleLine.substring(0, maxCodeLen)
          : codeSingleLine;
        parts.push(`${tabs}${codeLang}: ${truncCode}`);
        codeLines = [];
        continue;
      }
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Headings
    const h4 = line.match(/^####\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);

    if (h2) {
      flushProse();
      headingDepth = 1;
      parts.push(`\t${h2[1]}`);
    } else if (h3) {
      flushProse();
      headingDepth = 2;
      parts.push(`\t\t${h3[1]}`);
    } else if (h4) {
      flushProse();
      headingDepth = 3;
      parts.push(`\t\t\t${h4[1]}`);
    } else {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "---") {
        proseBuffer.push(trimmed);
      }
    }
  }
  flushProse();

  return parts.join("\n");
}

// ============================================================
// Ingest a single file
// ============================================================

function ingestFile(store, prefix, filePath, relPath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);

  // Title: W-prefix → always filename; O-prefix → frontmatter title or filename
  let title;
  if (prefix === "W") {
    title = path.basename(relPath); // SOUL.md, TOOLS.md, etc.
  } else {
    const baseName = meta.title || path.basename(relPath, ".md");
    title = `${baseName.replace(/\.md$/, "")}.md`;
  }

  // Summary: frontmatter or first non-heading line
  const summary = meta.summary ||
    body.split("\n").find(l => l.trim() && !l.startsWith("#"))?.trim() || "";

  const content = mdToHmem(title, summary, body);

  if (DRY_RUN) {
    const lineCount = content.split("\n").length;
    console.log(`  [${prefix}] ${relPath} → "${title}" (${lineCount} lines)`);
    return;
  }

  store.write(prefix, content);
}

// ============================================================
// Main
// ============================================================

// Ensure hmem.config.json has both prefixes
const configPath = path.join(ROOT, "hmem.config.json");
const configData = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
  : {};
if (!configData.prefixes) configData.prefixes = {};
configData.prefixes.W = "Workspace Bootstrap";
configData.prefixes.O = "OpenClaw Documentation";
fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n");
const config = loadHmemConfig(ROOT);

// Validate file lists
let totalFiles = 0;
let missing = 0;

for (const rel of [...WORKSPACE_FILES, ...DOC_FILES]) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.warn(`  MISSING: ${rel}`);
    missing++;
  } else {
    totalFiles++;
  }
}

console.log(`Workspace files (W): ${WORKSPACE_FILES.length}`);
console.log(`Doc files (O):       ${DOC_FILES.length}`);
console.log(`Total valid:         ${totalFiles}`);
if (missing) console.log(`Missing:             ${missing}`);
console.log(`Target:              ${HMEM_PATH}`);
console.log(`Dry run:             ${DRY_RUN}`);
console.log();

if (DRY_RUN) {
  console.log("=== Workspace (W) ===");
  for (const rel of WORKSPACE_FILES) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) ingestFile(null, "W", full, rel);
  }
  console.log("\n=== Docs (O) ===");
  for (const rel of DOC_FILES) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) ingestFile(null, "O", full, rel);
  }
  console.log(`\n[DRY RUN] Would ingest ${totalFiles} files.`);
  process.exit(0);
}

// Remove old hmem
if (fs.existsSync(HMEM_PATH)) {
  fs.unlinkSync(HMEM_PATH);
  console.log("Removed old OPENCLAW.hmem\n");
}

// Create fresh store
const store = new HmemStore(HMEM_PATH, config);

let success = 0;
let errors = 0;

// Ingest workspace files (W prefix)
console.log("Ingesting workspace files (W)...");
for (const rel of WORKSPACE_FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  try {
    ingestFile(store, "W", full, rel);
    success++;
  } catch (err) {
    console.error(`  ERROR ${rel}: ${err.message}`);
    errors++;
  }
}

// Ingest doc files (O prefix)
console.log("Ingesting docs (O)...");
for (const rel of DOC_FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  try {
    ingestFile(store, "O", full, rel);
    success++;
    if (success % 20 === 0) process.stdout.write(`  ${success}/${totalFiles}...\r`);
  } catch (err) {
    console.error(`  ERROR ${rel}: ${err.message}`);
    errors++;
  }
}

store.close();

const stats = fs.statSync(HMEM_PATH);
console.log(`\nDone!`);
console.log(`  W entries: ${WORKSPACE_FILES.length}`);
console.log(`  O entries: ${DOC_FILES.length}`);
console.log(`  Success:   ${success}`);
console.log(`  Errors:    ${errors}`);
console.log(`  Size:      ${(stats.size / 1024).toFixed(0)} KB`);

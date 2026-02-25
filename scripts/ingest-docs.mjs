#!/usr/bin/env node
/**
 * Ingest OpenClaw docs/*.md into OPENCLAW.hmem using HmemStore.
 *
 * Mapping:
 *   - Each .md file → one root entry (prefix O)
 *   - Frontmatter title → hmem title
 *   - Frontmatter summary → L1 text
 *   - ## headings → L2 children
 *   - ### headings → L3 children
 *   - #### headings → L4 children
 *   - ```code blocks``` → child node of current section (language as title hint)
 *   - Prose between headings → content of that node
 *
 * Usage: node scripts/ingest-docs.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
// Use local hmem source directly (sibling directory)
import { HmemStore, loadHmemConfig } from "../../hmem/dist/index.js";

const DOCS_DIR = path.resolve(import.meta.dirname, "..", "docs");
const HMEM_PATH = path.resolve(import.meta.dirname, "..", "OPENCLAW.hmem");
const CONFIG_DIR = path.resolve(import.meta.dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

// ---- Frontmatter parser ----

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
  const body = content.substring(end + 4).trim();
  return { meta, body };
}

// ---- Markdown → hmem tree ----

/**
 * Parse markdown into a tree structure suitable for hmem write().
 * Returns tab-indented content string.
 *
 * Strategy:
 *   # H1 → title (part of L1)
 *   ## H2 → L2 (1 tab)
 *   ### H3 → L3 (2 tabs)
 *   #### H4 → L4 (3 tabs)
 *   ```lang ... ``` → child of current section (+1 tab from current heading)
 */
function mdToHmemContent(title, summary, body) {
  const lines = body.split("\n");
  const output = [];

  // L1: title + summary
  output.push(title);
  if (summary) {
    output.push(summary);
  }

  let currentDepth = 0; // 0 = root level (L1), 1 = ##, 2 = ###, 3 = ####
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines = [];
  let codeBlockDepth = 0;
  let currentProseLines = [];

  function flushProse() {
    const text = currentProseLines.join("\n").trim();
    if (text && currentDepth > 0) {
      // Append prose as content of current heading node
      const tabs = "\t".repeat(currentDepth);
      // Don't create a separate node for prose — it's part of the heading content
      // We'll merge it into the heading line
    }
    currentProseLines = [];
  }

  function flushCodeBlock() {
    if (codeBlockLines.length === 0) return;
    const depth = codeBlockDepth + 1; // one level deeper than the heading it's under
    const tabs = "\t".repeat(Math.min(depth, 4)); // max depth 5 (0-indexed 4)
    const langHint = codeBlockLang || "code";
    const code = codeBlockLines.join("\n");
    // Code block as child node — language as first line (becomes title)
    output.push(`${tabs}${langHint}\n${tabs}\t${code.split("\n").join("\n" + tabs + "\t")}`);
    codeBlockLines = [];
    codeBlockLang = "";
  }

  // Collect sections: heading + content pairs
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    // Skip H1 (already used as title)
    if (line.match(/^# [^#]/) && !inCodeBlock) continue;

    // Code block toggle
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.substring(3).trim();
        codeBlockDepth = currentDepth;
        codeBlockLines = [];
        continue;
      } else {
        inCodeBlock = false;
        flushCodeBlock();
        continue;
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Heading detection
    const h4 = line.match(/^#### (.+)/);
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);

    if (h2 || h3 || h4) {
      // Save previous section
      if (currentSection) sections.push(currentSection);

      let depth, heading;
      if (h2) { depth = 1; heading = h2[1]; }
      else if (h3) { depth = 2; heading = h3[1]; }
      else { depth = 3; heading = h4[1]; }

      currentDepth = depth;
      currentSection = { depth, heading, contentLines: [], codeBlocks: [] };
      continue;
    }

    // Content lines
    if (currentSection) {
      // Check for code block start within section
      currentSection.contentLines.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  // Build output from sections
  const result = [];
  result.push(title);
  if (summary) result.push(summary);

  for (const section of sections) {
    const tabs = "\t".repeat(section.depth);
    const content = section.contentLines.join("\n").trim();

    if (content) {
      // Heading with inline content — truncate content for the node
      const truncated = content.length > 2000 ? content.substring(0, 2000) : content;
      result.push(`${tabs}${section.heading}\n${tabs}${truncated.split("\n").join("\n" + tabs)}`);
    } else {
      result.push(`${tabs}${section.heading}`);
    }
  }

  return result.join("\n");
}

/**
 * Simpler approach: parse markdown into sections, build tab-indented hmem content.
 * Each heading becomes a node. Content between headings belongs to that node.
 * Code blocks are inlined (with spaces instead of tabs to avoid hmem depth confusion).
 */
/**
 * Convert markdown to hmem content string.
 *
 * Structure:
 *   L1 (0 tabs): frontmatter title — summary (≤118 chars)
 *   L2 (1 tab):  ## headings + prose
 *   L3 (2 tabs): ### headings
 *   L4 (3 tabs): #### headings
 *   Code blocks: +1 tab from current heading
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
  let headingDepth = 1; // ## = depth 1 (L2), ### = depth 2 (L3), #### = depth 3 (L4)
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

// ---- Main ----

// Ensure hmem.config.json has O prefix
const configPath = path.join(CONFIG_DIR, "hmem.config.json");
let config;
if (fs.existsSync(configPath)) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!raw.prefixes) raw.prefixes = {};
  raw.prefixes.O = "OpenClaw Documentation";
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
  config = loadHmemConfig(CONFIG_DIR);
} else {
  fs.writeFileSync(configPath, JSON.stringify({
    prefixes: { O: "OpenClaw Documentation" }
  }, null, 2) + "\n");
  config = loadHmemConfig(CONFIG_DIR);
}

console.log(`Prefixes: ${Object.keys(config.prefixes).join(", ")}`);
console.log(`Docs dir: ${DOCS_DIR}`);
console.log(`Target:   ${HMEM_PATH}`);
console.log(`Dry run:  ${DRY_RUN}`);
console.log();

// Collect all .md files (skip i18n/translations)
const mdFiles = [];
function walk(dir, rel = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip i18n directories
      if (entry.name.startsWith(".") || entry.name === "zh-CN" || entry.name === "node_modules") continue;
      walk(full, relPath);
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      mdFiles.push({ full, rel: relPath });
    }
  }
}
walk(DOCS_DIR);
mdFiles.sort((a, b) => a.rel.localeCompare(b.rel));

console.log(`Found ${mdFiles.length} .md files\n`);

if (DRY_RUN) {
  // Show first 5 as preview
  for (const f of mdFiles.slice(0, 5)) {
    const raw = fs.readFileSync(f.full, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const baseName = meta.title || path.basename(f.rel, ".md");
    const title = baseName.endsWith(".md") ? baseName : `${baseName}.md`;
    const summary = meta.summary || "";
    const content = mdToHmem(title, summary, body);
    const lineCount = content.split("\n").length;
    console.log(`--- ${f.rel} (${lineCount} lines) ---`);
    console.log(content.substring(0, 500));
    console.log("...\n");
  }
  console.log(`[DRY RUN] Would ingest ${mdFiles.length} files. Run without --dry-run to execute.`);
  process.exit(0);
}

// Remove old hmem if exists
if (fs.existsSync(HMEM_PATH)) {
  fs.unlinkSync(HMEM_PATH);
  console.log("Removed old OPENCLAW.hmem");
}

// Create fresh store
const store = new HmemStore(HMEM_PATH, config);

let success = 0;
let errors = 0;

for (const f of mdFiles) {
  try {
    const raw = fs.readFileSync(f.full, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const baseName = meta.title || path.basename(f.rel, ".md");
    const title = baseName.endsWith(".md") ? baseName : `${baseName}.md`;
    const summary = meta.summary || body.split("\n").find(l => l.trim() && !l.startsWith("#"))?.trim() || "";
    const content = mdToHmem(title, summary, body);

    store.write("O", content);
    success++;

    if (success % 50 === 0) {
      process.stdout.write(`  ${success}/${mdFiles.length}...\r`);
    }
  } catch (err) {
    console.error(`  ERROR ${f.rel}: ${err.message}`);
    errors++;
  }
}

store.close();

const stats = fs.statSync(HMEM_PATH);
console.log(`\nDone!`);
console.log(`  Ingested: ${success} files`);
console.log(`  Errors:   ${errors}`);
console.log(`  Size:     ${(stats.size / 1024).toFixed(0)} KB`);

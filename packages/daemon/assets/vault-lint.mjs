#!/usr/bin/env node
// Loom vault-lint PostToolUse hook (phase-2 Pillar D). Invoked by Claude Code as:
//   node vault-lint.mjs <vaultPath>
// Reads the PostToolUse payload on stdin. If a Write/Edit/MultiEdit touched a .md UNDER the
// project's vault, it runs the doc-hygiene skill's MECHANICALLY-checkable subset and surfaces an
// ADVISORY warning to the agent (never blocks — the agent self-corrects). Everything else (non-.md,
// a write outside the vault, a clean note) is a fast no-op. The LLM-judgment rules of doc-hygiene
// (contradictions, consolidation) are NOT checked here — that's the scheduled worker (#21b).
//
// False-positive guards (driven by real production noise):
//   - `doc-lint: false` in the note's leading YAML frontmatter → skip ALL checks, stay silent.
//   - Scar/correction patterns (UPDATE:/EDIT:, Note (YYYY):, ~~strike~~) inside a ```fenced code
//     block``` are legitimate quoting (meta-docs about doc-hygiene) and are NOT flagged.
//   - The broken-wikilink check is OPT-IN (default OFF): this vault uses intentional red-links and
//     cross-project links a single-subfolder index can't resolve. Enable per-note with
//     `doc-lint-links: true` in frontmatter. Append-scar + oversized checks stay default-on.
//
// Always exits 0. On a hit it writes a JSON object to stdout carrying the warning via both
// `systemMessage` and PostToolUse `hookSpecificOutput.additionalContext` (whichever the running
// Claude honors) — the non-blocking "flag" channel, NOT exit-2 (which is the blocking channel).
import fs from "node:fs";
import path from "node:path";

const MAX_LINES = 400; // doc-hygiene rule 4 (keep docs bounded) — advisory threshold

/** Parse the leading `---`…`---` YAML frontmatter (top of file only) into a flat lowercased key→value map. */
function parseFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().toLowerCase();
  }
  return fm;
}

/** All note keys in the vault for wikilink resolution: basenames + relative paths (lowercased, no .md). */
function listVaultNoteKeys(vaultPath) {
  const keys = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // skip .git / .obsidian / etc.
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        keys.add(e.name.slice(0, -3).toLowerCase());
        keys.add(path.relative(vaultPath, full).replace(/\\/g, "/").slice(0, -3).toLowerCase());
      }
    }
  };
  walk(vaultPath);
  return keys;
}

// rule 2 — rewrite in place, never append "UPDATE:" / "EDIT:" / "Note (YYYY):" / ~~struck-through~~.
// Patterns inside a ```fenced code block``` are exempt (legitimate quoting, e.g. a doc ABOUT scars).
function checkAppendScars(content) {
  const hits = [];
  let inFence = false, sawNote = false, sawStrike = false;
  content.split(/\r?\n/).forEach((line, i) => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) { inFence = !inFence; return; } // fence open/close
    if (inFence) return; // scars quoted inside a code block are legitimate, not a hit
    if (/^\s{0,3}>?\s*\*{0,2}(UPDATE|EDIT)\b\s*\*{0,2}\s*:/i.test(line)) {
      hits.push(`line ${i + 1}: append marker "${line.trim().slice(0, 48)}"`);
    }
    if (/\bNote\s*\(\d{4}\)\s*:/.test(line)) sawNote = true;
    if (/~~[^~\n]+~~/.test(line)) sawStrike = true;
  });
  if (sawNote) hits.push(`a "Note (YYYY):" correction marker`);
  if (sawStrike) hits.push(`a ~~struck-through~~ correction`);
  return hits;
}

// rule 3 (partial) — dead [[wikilinks]]. Excludes ![[embeds]] (may target non-md). Strips #headings + |aliases.
function checkBrokenWikilinks(content, vaultPath) {
  const targets = [...content.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)]
    .map((m) => m[1].split("|")[0].split("#")[0].trim())
    .filter(Boolean); // drop [[#heading]] same-file links
  if (targets.length === 0) return [];
  const keys = listVaultNoteKeys(vaultPath);
  const broken = [];
  for (const t of targets) {
    const key = t.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
    const base = key.split("/").pop();
    if (!keys.has(key) && !keys.has(base)) broken.push(t);
  }
  return broken.length ? [`broken wikilink(s): ${[...new Set(broken)].map((t) => `[[${t}]]`).join(", ")}`] : [];
}

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) return;

  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const tool = payload.tool_name;
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return;

  let filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string" || !/\.md$/i.test(filePath)) return;
  if (!path.isAbsolute(filePath)) filePath = path.resolve(payload.cwd || process.cwd(), filePath);

  const rel = path.relative(vaultPath, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return; // outside the project's vault → ignore

  let content;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return; } // tool already ran → file is on disk

  const fm = parseFrontmatter(content);
  if (fm["doc-lint"] === "false") return; // explicit per-note opt-out → stay silent regardless of content

  const warnings = [
    ...checkAppendScars(content),
    ...((content.split(/\r?\n/).length > MAX_LINES)
      ? [`oversized note: ${content.split(/\r?\n/).length} lines (doc-hygiene keeps notes bounded; aim < ${MAX_LINES})`]
      : []),
    // broken-wikilink check is opt-in (default OFF) — too noisy on intentional red-links + cross-project links.
    ...(fm["doc-lint-links"] === "true" ? checkBrokenWikilinks(content, vaultPath) : []),
  ];
  if (warnings.length === 0) return;

  const msg = `doc-hygiene (vault-lint) flagged ${path.basename(filePath)}:\n- ${warnings.join("\n- ")}\n`
    + `Advisory: rewrite in place (don't append UPDATE:/EDIT: notes), keep the note bounded, and fix or remove dead [[links]].`;
  process.stdout.write(JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));

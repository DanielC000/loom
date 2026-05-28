#!/usr/bin/env node
// Loom vault-lint PostToolUse hook (phase-2 Pillar D). Invoked by Claude Code as:
//   node vault-lint.mjs <vaultPath>
// Reads the PostToolUse payload on stdin. If a Write/Edit/MultiEdit touched a .md UNDER the
// project's vault, it runs the doc-hygiene skill's MECHANICALLY-checkable subset and surfaces an
// ADVISORY warning to the agent (never blocks — the agent self-corrects). Everything else (non-.md,
// a write outside the vault, a clean note) is a fast no-op. The LLM-judgment rules of doc-hygiene
// (contradictions, consolidation) are NOT checked here — that's the scheduled worker (#21b).
//
// Always exits 0. On a hit it writes a JSON object to stdout carrying the warning via both
// `systemMessage` and PostToolUse `hookSpecificOutput.additionalContext` (whichever the running
// Claude honors) — the non-blocking "flag" channel, NOT exit-2 (which is the blocking channel).
import fs from "node:fs";
import path from "node:path";

const MAX_LINES = 400; // doc-hygiene rule 4 (keep docs bounded) — advisory threshold

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
function checkAppendScars(content) {
  const hits = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (/^\s{0,3}>?\s*\*{0,2}(UPDATE|EDIT)\b\s*\*{0,2}\s*:/i.test(line)) {
      hits.push(`line ${i + 1}: append marker "${line.trim().slice(0, 48)}"`);
    }
  });
  if (/\bNote\s*\(\d{4}\)\s*:/.test(content)) hits.push(`a "Note (YYYY):" correction marker`);
  if (/~~[^~\n]+~~/.test(content)) hits.push(`a ~~struck-through~~ correction`);
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

  const warnings = [
    ...checkAppendScars(content),
    ...((content.split(/\r?\n/).length > MAX_LINES)
      ? [`oversized note: ${content.split(/\r?\n/).length} lines (doc-hygiene keeps notes bounded; aim < ${MAX_LINES})`]
      : []),
    ...checkBrokenWikilinks(content, vaultPath),
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

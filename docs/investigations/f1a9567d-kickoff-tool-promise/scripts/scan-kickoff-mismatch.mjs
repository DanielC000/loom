// Investigation f1a9567d — MEASUREMENT ONLY, re-runnable. No production code, no daemon writes.
//
// Scans every Loom WORKER transcript currently retained under
// ~/.claude/projects/C--Users-danie--loom-worktrees-* for mcp__<server>__ mentions in the session's
// kickoff (the first real user turn — base-brief + manager kickoff, combined, per the delivery model
// documented in CLAUDE.md) and compares each mentioned server against the set actually provisioned to
// that session, derived from its own `deferred_tools_delta` attachment record(s) — the same
// type=attachment tool-manifest signal card f1a9567d's own specimen verification used.
//
// Run: node scan-kickoff-mismatch.mjs   (reads only; writes mismatch-hits.json next to itself)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.homedir(), ".claude", "projects");
const dirs = fs.readdirSync(root).filter((d) => d.startsWith("C--Users-danie--loom-worktrees-"));

const MCP_RE = /mcp__([a-zA-Z0-9-]+)__/g;

let dirCount = 0;
let fileCount = 0;
let kickoffsWithMention = 0;
const rawHits = []; // {file, server, provisioned, snippet}

for (const dir of dirs) {
  dirCount++;
  const full = path.join(root, dir);
  let entries;
  try { entries = fs.readdirSync(full); } catch { continue; }
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  for (const jf of jsonlFiles) {
    fileCount++;
    const filePath = path.join(full, jf);
    let raw;
    try { raw = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const lines = raw.split("\n");

    let kickoffText = null;
    const provisioned = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }

      if (kickoffText === null && o.type === "user") {
        const content = o.message?.content;
        if (typeof content === "string") {
          kickoffText = content;
        } else if (Array.isArray(content)) {
          // Real human/kickoff turn: array of text/image blocks, never a tool_result-only array
          // (mirrors packages/daemon/src/sessions/transcript.ts's classifyRole discriminator).
          const isToolResultOnly = content.length > 0 && content.every((b) => b && typeof b === "object" && b.type === "tool_result");
          if (!isToolResultOnly) {
            kickoffText = content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
          }
        }
      }

      if (o.type === "attachment" && o.attachment && o.attachment.type === "deferred_tools_delta") {
        const names = o.attachment.addedNames || [];
        for (const n of names) {
          const m = /^mcp__([a-zA-Z0-9-]+)__/.exec(n);
          if (m) provisioned.add(m[1]);
        }
      }
    }

    if (!kickoffText) continue;

    const mentioned = new Set();
    let m;
    MCP_RE.lastIndex = 0;
    while ((m = MCP_RE.exec(kickoffText)) !== null) {
      mentioned.add(m[1]);
    }
    if (mentioned.size === 0) continue;
    kickoffsWithMention++;

    for (const server of mentioned) {
      if (!provisioned.has(server)) {
        const idx = kickoffText.indexOf(`mcp__${server}__`);
        const start = Math.max(0, idx - 150);
        const end = Math.min(kickoffText.length, idx + 150);
        rawHits.push({
          file: path.join(dir, jf),
          server,
          provisioned: [...provisioned].sort(),
          snippet: kickoffText.slice(start, end).replace(/\n/g, " \\n "),
        });
      }
    }
  }
}

console.log(JSON.stringify({
  scannedDirs: dirCount,
  scannedFiles: fileCount,
  kickoffsWithAnyMcpMention: kickoffsWithMention,
  rawMismatchHits: rawHits.length,
}, null, 2));

const outFile = path.join(scriptDir, "mismatch-hits.json");
fs.writeFileSync(outFile, JSON.stringify(rawHits, null, 2));
console.log("Wrote", outFile);

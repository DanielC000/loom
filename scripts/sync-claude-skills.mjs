#!/usr/bin/env node
// Refresh packages/daemon/assets/skills/** (canonical, tracked) → .claude/skills/** (this repo
// checkout's own project-local skills, used by dev/self-hosting Claude Code sessions — see CLAUDE.md
// "Self-hosting"). .claude/skills is gitignored and untracked; without this sync a canonical skill
// mirrored there silently drifts stale (a manager once verified a skill against a stale copy —
// card 1ed3c450). Run on every @loom/daemon build (see its package.json).
//
// IMPORTANT: .claude/skills is NOT exclusively a canonical mirror — the owner (and any dev session) may
// keep PERSONAL skill dirs there too (a skill deliberately never bundled into canonical, e.g. one that's
// specific to this machine/owner). This sync must never delete one of those. So it:
//   1. Refreshes (overwrite) every skill dir named in current canonical — this is the actual drift fix.
//   2. NEVER deletes a .claude/skills/<name> dir that isn't tracked in ITS OWN manifest of previously
//      loom-synced names (.claude/skills/.loom-managed-skills.json) — a personal dir was never written
//      by this script, so it's never in that manifest, so it's never a removal candidate.
//   3. To still clean up a DEPRECATED canonical skill (one this sync wrote before but that's since been
//      removed from assets/skills), it removes a dir ONLY if it's in the PREVIOUS manifest AND absent
//      from current canonical — never anything else.
// Also leaves the runtime injectSkills() per-session manifest (.claude/skills/.loom-skills.json — a
// different file; see packages/daemon/src/skills/inject.ts) and anything outside .claude/skills alone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(repoRoot, "packages", "daemon", "assets", "skills");
const destDir = path.join(repoRoot, ".claude", "skills");
const managedManifestPath = path.join(destDir, ".loom-managed-skills.json");

function dirNames(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function readManagedManifest() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(managedManifestPath, "utf8")); } catch { return []; }
  return Array.isArray(raw) ? raw.filter((n) => typeof n === "string") : [];
}

const canonical = dirNames(srcDir);
if (canonical.length === 0) {
  console.log(`[sync-claude-skills] no canonical skills found at ${srcDir}, skipping`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
const canonicalSet = new Set(canonical);

// Deprecated cleanup FIRST: only a dir THIS script previously placed (per the last manifest) and that is
// no longer canonical. A personal dir (never in the manifest) is untouched no matter what its name is.
for (const prevManaged of readManagedManifest()) {
  if (canonicalSet.has(prevManaged)) continue;
  fs.rmSync(path.join(destDir, prevManaged), { recursive: true, force: true });
}

// Refresh every current canonical skill — the actual drift fix.
for (const name of canonical) {
  const src = path.join(srcDir, name);
  const dest = path.join(destDir, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

const manifestTmp = `${managedManifestPath}.tmp`;
fs.writeFileSync(manifestTmp, JSON.stringify(canonical));
fs.renameSync(manifestTmp, managedManifestPath);

console.log(`[sync-claude-skills] refreshed ${canonical.length} skill(s) → ${path.relative(repoRoot, destDir)}`);

#!/usr/bin/env node
// Card f26339d7 — bakes the resolved `git rev-parse HEAD` into <dist-dir>/build-info.json at BUILD time,
// so a running daemon/web artifact's actual source commit is falsifiable independent of any clock. Run as
// the LAST step of each deployable package's own build script (after tsc/vite has produced dist/), so this
// file lands INSIDE turbo's cached `dist/**` output for that task — see deploy-staleness.ts's own doc for
// why that placement is load-bearing: a turbo cache-hit replay restores this file's ORIGINAL baked sha
// verbatim (even though the replay advances every file's mtime), which is exactly what lets a cache-replay
// be detected instead of silently invisible.
//
// Degrades to {"sha": null, "dirty": null} — NEVER a stale or fabricated sha — when this isn't a git
// checkout (e.g. a published npm tarball's own build), git isn't installed, or a call times out. An
// absent value must read as unknown, never wrong (card f26339d7 DoD #1).
//
// `dirty` (Code Review, made BLOCKING by the card owner): a build run from a checkout with uncommitted
// changes bakes HEAD's sha for an artifact that is NOT actually HEAD's content — without this flag, that
// reads as a confidently-CLEAN match (`processBuiltShaMatchesHead:true`), which is worse than no signal at
// all (DoD-1). `git status --porcelain` (default: INCLUDES untracked files, which is correct here — an
// uncommitted new file is just as much "not what HEAD says" as a modified tracked one) non-empty ⇒
// dirty:true; empty ⇒ dirty:false; the check itself failing (rare, since `rev-parse HEAD` above already
// succeeded) ⇒ dirty:null — deploy-staleness.ts treats null the SAME as true for "can this count as a
// clean match" (never assume clean without positive proof).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirArg = process.argv[2];
if (!distDirArg) {
  console.error("usage: write-build-info.mjs <dist-dir-relative-to-repo-root>");
  process.exit(1);
}
const distDir = path.resolve(repoRoot, distDirArg);

function runGit(args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function resolveSha() {
  try {
    const sha = runGit(["rev-parse", "HEAD"]).trim();
    return sha || null;
  } catch {
    // Not a git checkout, git unavailable, or the call timed out — degrade to null, never fabricate a sha.
    return null;
  }
}

function resolveDirty() {
  try {
    return runGit(["status", "--porcelain"]).trim().length > 0;
  } catch {
    // Couldn't determine — null, NOT false. A build that can't prove it's clean must never be treated as
    // clean (see deploy-staleness.ts's own "never a clean match without positive proof" rule).
    return null;
  }
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "build-info.json"), JSON.stringify({ sha: resolveSha(), dirty: resolveDirty() }) + "\n");

#!/usr/bin/env node
// Card f26339d7 — bakes the resolved `git rev-parse HEAD` into <dist-dir>/build-info.json, so a running
// daemon/web artifact's actual source commit is falsifiable independent of any clock.
//
// Card 3d7dccb9 — run as each deployable package's SEPARATE, UNCACHED `stamp` turbo task
// (`dependsOn: ["build"], cache: false` — see turbo.json), never as a step INSIDE the `build` script
// itself. `build`'s own output (dist/**) is cached by turbo, and — a deliberate turbo 2.x feature,
// confirmed live via `TURBO_LOG=debug`: "Using shared worktree cache" / `is_shared_worktree=true` — that
// cache is SHARED across every git worktree of this repo, not scoped to the checkout that populated it.
// Baking this file INSIDE the cached `build` output used to mean a cache HIT could replay a DIFFERENT
// worktree's own baked sha (e.g. a worker's merge-gate self-check build) into whichever checkout asked for
// a build next — content-correct (that's what makes a cache hit valid at all) but IDENTITY-wrong. Running
// this as its own uncached task means it re-executes on every build invocation, cache hit or miss, always
// stamping the sha of the checkout that is actually asking right now.
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

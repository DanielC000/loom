import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 356538ef) — every git call on the CANONICAL MERGE PATH goes through the shared
// `canonicalGit` factory (git/bounded.ts), never a bare `boundedSimpleGit(` / `simpleGit(` and never a raw child-process
// `git`. The shared `.git` is worker-writable (merge drivers, replace refs), so a sibling call that bypasses the helper
// silently reopens S11/S12 — the recurring defect class this card exists to stop.
//
// WHAT THIS ASSERTS (source-TEXT, comment-stripped; NOT a behaviour test — canonical-git-isolation.mjs is that):
//  (1) STRICT files — `git/worktrees.ts`, `git/batch-merge.ts` and `git/mainline-watch.ts` (the canonical merge path + the mainline tripwire, card 4fa36502): no `boundedSimpleGit(` /
//      `simpleGit(` call; every `spawn("git", [` carries `...CANONICAL_GIT_CONFIG_ARGS` as its first args; no other raw
//      child-process git (`execFile*`/`exec*`/`spawnSync`).
//  (2) WHOLE-TREE: any OTHER `packages/daemon/src/**/*.ts` file that constructs git directly must appear in ALLOWLIST below,
//      each with a one-line reason. A NEW bypass site therefore fails here until someone decides, in writing, that it is
//      genuinely off the canonical path (or routes it through the helper).
//
// GAPS, NAMED (this does NOT cover): a git call reached through a factory that returns a NON-canonical instance
// (e.g. an injected `gitFactory` test seam — used as-is by design); a `simple-git` import spelled differently (aliased
// import); `node:child_process` calls whose command is built dynamically (`spawn(cmd, …)` with `cmd === "git"`).
//
// Run: node packages/daemon/test/canonical-git-helper-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TEST_DIR, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const STRICT = ["git/worktrees.ts", "git/batch-merge.ts", "git/mainline-watch.ts"];

// Files that build git directly and are deliberately NOT the canonical merge path. Path (relative to src/) -> reason.
const ALLOWLIST = {
  "git/bounded.ts": "the helper module itself — the only place simpleGit() is constructed",
  "git/writer.ts": "human-only REST checkout/commit/push surface (a trust boundary of its own, card f7a80d76); not the daemon's merge path",
  "git/reader.ts": "read-only log/branches view for the UI; never merges or lands anything",
  "git/unanchored-comment-blocks.ts": "read-only diff scan for the comment-anchor advisory; never merges",
  "runs/snapshot.ts": "run snapshot of the project's own working tree; not a merge",
  "sessions/service.ts": "worktree GC/size probes via boundedGit(); no merge or content judgement",
  "setup/bootstrap.ts": "`git init` of a brand-new project dir; no shared worker-writable .git exists yet",
  "orchestration/restart.ts": "supervisor-liveness ancestry check; reads only",
  "vault/versioner.ts": "an ordinary (non-merge-eligible) vault is the human's OWN notes repo, never touched by a worker/merge, so plain boundedSimpleGit is fine there; a merge-eligible shared vault (card bf11ac3f) IS a real canonical repo a worker merge can touch, but that path's own add/commit already route through the shared killableCanonicalRaw — the canonical shape is never left unprotected, only the ordinary-vault construction is off-path",
  "deploy-staleness.ts": "deploy-time staleness diff over the running daemon's own checkout (execFileSync); reads only, not a merge",
  "skills/assets-git-status.ts": "reads the assets tree status for the Skills UI (execFileSync); not a merge",
  "mcp/decisions.ts": "resolves a cited `sha:` anchor via rev-parse --verify (execFileSync); a comment-anchor lookup, not a merge",
  "pty/codex-doctrine.ts": "read-only `git ls-files` tracked-status probe in a worker's own worktree (isAgentsMdTracked); off the canonical merge path",
};

// `canonicalRaw(` is the exported test seam that takes a caller-supplied prefix-builder: no production caller may use it (canonicalGit's own `raw` is the only one).
const BARE_SIMPLE_GIT = /\b(?:boundedSimpleGit|simpleGit|canonicalRaw)\s*\(/;
const SPAWN_GIT = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["'`]git["'`]/g;
const SPAWN_GIT_OK = /\bspawn\s*\(\s*["'`]git["'`]\s*,\s*\[\s*\.\.\.CANONICAL_GIT_CONFIG_ARGS\s*,/g;

/** Violations in a STRICT file's raw text. */
export function strictViolations(raw) {
  const t = stripComments(raw);
  const v = [];
  if (BARE_SIMPLE_GIT.test(t)) v.push("bare boundedSimpleGit(/simpleGit(/canonicalRaw( call — use canonicalGit");
  const all = (t.match(SPAWN_GIT) ?? []).length;
  const ok = (t.match(SPAWN_GIT_OK) ?? []).length;
  if (all !== ok) v.push(`${all - ok} raw child-process git call(s) without ...CANONICAL_GIT_CONFIG_ARGS`);
  return v;
}
/** Does a file (raw text) construct git directly at all? (the whole-tree trigger) */
export function constructsGit(raw) {
  const t = stripComments(raw);
  return BARE_SIMPLE_GIT.test(t) || new RegExp(SPAWN_GIT.source).test(t);
}

// ── Self-test: the scanner can FAIL (RED demo on known-bad text) and is quiet on known-good text.
check("(self) a bare boundedSimpleGit( call in a strict file is flagged", strictViolations("const g = boundedSimpleGit(p, 1);").length === 1);
check("(self) a canonicalRaw( call (the prefix-builder test seam) is flagged in a strict file", strictViolations("await canonicalRaw(g, args, () => []);").length === 1);
check("(self) a bare simpleGit( call is flagged", strictViolations("const g = simpleGit(p);").length === 1);
check("(self) a raw spawn(\"git\", [...]) without the canonical args is flagged", strictViolations('spawn("git", ["ls-tree"], {});').length === 1);
check("(self) execFileSync(\"git\") is flagged in a strict file", strictViolations('execFileSync("git", ["show"]);').length === 1);
check("(self) spawn(\"git\", [...CANONICAL_GIT_CONFIG_ARGS, …]) is accepted", strictViolations('spawn("git", [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree"], {});').length === 0);
check("(self) canonicalGit( is accepted", strictViolations("const g = canonicalGit(p, 1);").length === 0);
check("(self) a mention inside a comment is NOT a call", strictViolations("// boundedSimpleGit(x) and simpleGit(y)\n/* spawn(\"git\", []) */\nconst a = 1;").length === 0);

// ── (1) STRICT files.
for (const rel of STRICT) {
  const raw = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
  const v = strictViolations(raw);
  check(`(strict) ${rel}: every canonical-path git call routes through canonicalGit / CANONICAL_GIT_CONFIG_ARGS${v.length ? ` — ${v.join("; ")}` : ""}`, v.length === 0);
}

// ── (2) WHOLE-TREE: an unlisted file that constructs git directly fails.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const found = [];
for (const abs of walk(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, abs).replace(/\\/g, "/");
  if (STRICT.includes(rel)) continue;
  if (constructsGit(fs.readFileSync(abs, "utf8"))) found.push(rel);
}
const unlisted = found.filter((r) => !(r in ALLOWLIST));
check(`(tree) every OTHER file constructing git directly is in the allowlist with a reason${unlisted.length ? ` — UNLISTED: ${unlisted.join(", ")}` : ""}`, unlisted.length === 0);
const stale = Object.keys(ALLOWLIST).filter((r) => !found.includes(r));
check(`(tree) no STALE allowlist entry (each listed file still constructs git directly)${stale.length ? ` — STALE: ${stale.join(", ")}` : ""}`, stale.length === 0);
check("(tree) the scan is non-vacuous: it saw the helper module and at least 5 constructing files", found.includes("git/bounded.ts") && found.length >= 5);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

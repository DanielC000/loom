import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source-text scan
// STANDING GUARD (card 849acf9b) — a test file whose code path reaches the REAL `ensureTrusted`/
// `ensureTrustedResilient` (pty/claude-config.ts) — either a direct call, or a real (unsubclassed, or
// super-delegating) `PtyHost.createPty()` reached via a non-codex `.spawn(` call, using the
// `LOOM_CLAUDE_BIN` real-process-substitution technique `boot-mode-settings-argv-coupling.mjs` /
// `spawn-command-line-preflight.mjs` / `kickoff-real-spawn.mjs` already established — must redirect
// `claudeJsonPath()`'s target (via `CLAUDE_CONFIG_DIR`, or `HOME`+`USERPROFILE` together, since
// `claudeJsonPath()` falls back to `path.join(os.homedir(), ".claude.json")` when `CLAUDE_CONFIG_DIR` is
// unset) BEFORE that call can reach the OWNER'S REAL `~/.claude.json`.
//
// INCIDENT (card 849acf9b): `boot-mode-settings-argv-coupling.mjs` set only `LOOM_HOME`, never
// `CLAUDE_CONFIG_DIR`/`HOME`/`USERPROFILE` — its real `createPty()` spawn reached `ensureTrusted`
// unconditionally (host.ts) and wrote a trust entry for its own temp repo into the REAL `~/.claude.json`
// on every run (a read-only grep of the real file found 612+ leaked `loom-bmsac-*` keys). A structural
// sweep for the SAME shape (this guard's own real-corpus scan, not a hand count) found four more:
// `mcp-config-secret-lifecycle.mjs`, `loom-home-write-deny.mjs`, `transcript-root-deny-chokepoint.mjs`,
// `mcp-token-env-override.mjs` — all fixed in the same card. This guard is the backstop so a NEW file
// can't reintroduce the shape.
//
// WHAT THIS ASSERTS — PRESENCE + textual ORDER (NOT the value): every `packages/daemon/test/*.mjs` (not
// in NOT_HERMETIC — see below) whose comment-stripped text contains EITHER
//   (A) a REAL CALL to `ensureTrusted(`/`ensureTrustedResilient(` (never their own `export function`
//       declaration in claude-config.ts itself — out of scope here, this scans test/ only — and never a
//       `//`/`*` comment line merely mentioning the name), OR
//   (B) a `process.env.LOOM_CLAUDE_BIN\s*=` assignment AND at least one `.spawn(` call line (the
//       established real-spawn technique — see header above; codex-only files always dispatch through
//       `createCodexPty`/`spawnCodexProcess`, which never reaches `ensureTrusted` at all, and the two
//       `LOOM_CLAUDE_BIN`-setting files in this corpus that never call `.spawn(` at all —
//       `claude-version-prewarm.mjs`/`usage-status-cmdshim-real-spawn.mjs`, both probing `claude
//       --version` via a bare `execFile`, never `PtyHost` — are excluded by the `.spawn(` requirement)
// must have the redirect (a `process.env.CLAUDE_CONFIG_DIR =` assignment, OR BOTH `process.env.HOME =`
// AND `process.env.USERPROFILE =`) appear textually BEFORE the first triggering line.
//
// NOT_HERMETIC EXEMPTION: a file named in `scripts/test-daemon.mjs`'s own `NOT_HERMETIC` export — loaded
// live via a dynamic `import()` of that script for its export alone (same technique `git/worktrees.ts`'s
// `loadNotHermeticNames` already uses; `test-daemon.mjs`'s own `isMain` guard makes this side-effect-free)
// rather than a hand-copied list that would drift against it — is EXEMPT from this guard entirely. Those
// files (`loom-home-write-deny-real-spawn.mjs`, `claude-md-external-import-dialog-real-spawn.mjs`,
// `instructions-loaded-real-spawn.mjs`, `busy-flag.mjs`, `integration-e2e.mjs`,
// `disallow-harness-scheduling-tools-real-spawn.mjs`, …) spawn a REAL, authenticated `claude` CLI —
// their own header comments state plainly they CANNOT use an isolated `CLAUDE_CONFIG_DIR` (it needs the
// real login credentials) — and each already carries its OWN documented, surgical, single-entry
// add/remove around the real file instead (never a structural leak: they run manually, rarely, and clean
// up after themselves). Never widen this guard to cover them; see each file's own header for its specific
// cleanup contract.
//
// GAPS, NAMED (this check does NOT cover):
//  (i)   the VALUE — `process.env.CLAUDE_CONFIG_DIR = <anything>` (or `HOME`/`USERPROFILE` similarly)
//        passes; nothing here proves the assigned value is actually a temp dir (unlike `_guard.mjs`'s
//        LOOM_HOME exit-hook backstop, `CLAUDE_CONFIG_DIR`/`HOME`/`USERPROFILE` have no such runtime
//        proof anywhere in this suite).
//  (ii)  TRIGGER (B) is a PRESENCE heuristic, not a per-call-site semantic check — it does NOT verify
//        that a FUTURE file's particular `.spawn(` call(s) are non-codex before flagging it. In TODAY'S
//        corpus every `LOOM_CLAUDE_BIN`-setting file that calls `.spawn(` at all genuinely reaches the
//        real (non-codex) createPty at least once (hand-verified, card 849acf9b) — but a hypothetical
//        FUTURE file that sets `LOOM_CLAUDE_BIN` for an unrelated reason and calls `.spawn(` exclusively
//        with `harness: "codex"` would false-positive here. Cheap to resolve (add the trivial redirect
//        anyway, or extend this guard's judgment-curated exemption reasoning) — a false positive is far
//        cheaper than the false negative this guard exists to prevent.
//  (iii) INDIRECT reach one level further removed — a file that reaches `ensureTrusted` through some
//        OTHER real-process-substitution mechanism than `LOOM_CLAUDE_BIN` (e.g. a future `LOOM_CODEX_BIN`-
//        shaped var for a NON-codex harness, if one is ever added) is not scanned. Widen the trigger set
//        here, judgment-curated, if one is found — same posture as `createworktree-loom-home-guard.mjs`'s
//        own (ii).
//  (iv)  textual order is a single-line-position comparison, not a real call-expression AST walk — a
//        hoisted STATIC `import {...} from "../dist/..."` is irrelevant here (this guard's redirect check
//        is about a plain runtime assignment vs. a plain call line, neither of which hoists), but a
//        redirect assignment wrapped across multiple lines, or a trigger call whose own line doesn't
//        contain the literal token this scan matches, would not be found. True of every real file in this
//        corpus as of card 849acf9b (verified by hand).
// This guard's own source is excluded from the scan (its prose mentions the patterns).
//
// Run: node packages/daemon/test/ensure-trusted-config-dir-redirect-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const CLAUDE_CONFIG_DIR_SET_RE = /\bprocess\.env\.CLAUDE_CONFIG_DIR\s*=(?!=)/;
const HOME_SET_RE = /\bprocess\.env\.HOME\s*=(?!=)/;
const USERPROFILE_SET_RE = /\bprocess\.env\.USERPROFILE\s*=(?!=)/;
const LOOM_CLAUDE_BIN_SET_RE = /\bprocess\.env\.LOOM_CLAUDE_BIN\s*=(?!=)/;
const SPAWN_CALL_RE = /\.spawn\s*\(/;

/** Index of the first line (0-based) matching `re`, or -1. */
function firstMatchLine(lines, re) {
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** Every line index that is a REAL `ensureTrusted(`/`ensureTrustedResilient(` CALL — never a comment
 *  line (stripComments already removed whole-comment lines, but a trailing-comment-stripped line can
 *  still legitimately be a call), and never this scan's own prose (handled by excluding SELF below). */
function trustCallLineIndexes(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bensureTrusted(?:Resilient)?\s*\(/.test(lines[i])) out.push(i);
  }
  return out;
}

/**
 * @returns {{verdict: "n/a"|"pass"|"fail", reason?: string}} for ONE file's raw text.
 */
export function classify(raw) {
  const text = stripComments(raw);
  const lines = text.split("\n");

  const redirectLine = (() => {
    const cfgDir = firstMatchLine(lines, CLAUDE_CONFIG_DIR_SET_RE);
    const home = firstMatchLine(lines, HOME_SET_RE);
    const userProfile = firstMatchLine(lines, USERPROFILE_SET_RE);
    const homePair = home >= 0 && userProfile >= 0 ? Math.max(home, userProfile) : -1;
    if (cfgDir >= 0 && homePair >= 0) return Math.min(cfgDir, homePair);
    if (cfgDir >= 0) return cfgDir;
    return homePair; // -1 if neither form is present
  })();

  const trustCalls = trustCallLineIndexes(lines);
  const hasLoomClaudeBin = LOOM_CLAUDE_BIN_SET_RE.test(text);
  const firstSpawnLine = hasLoomClaudeBin ? firstMatchLine(lines, SPAWN_CALL_RE) : -1;

  const triggerLines = [...trustCalls];
  if (firstSpawnLine >= 0) triggerLines.push(firstSpawnLine);
  if (triggerLines.length === 0) return { verdict: "n/a" };

  const firstTrigger = Math.min(...triggerLines);
  if (redirectLine >= 0 && redirectLine < firstTrigger) return { verdict: "pass" };
  return {
    verdict: "fail",
    reason: redirectLine < 0
      ? "no CLAUDE_CONFIG_DIR / HOME+USERPROFILE redirect found anywhere in the file"
      : `redirect found at line ${redirectLine + 1}, but AFTER the first triggering call at line ${firstTrigger + 1}`,
  };
}

// ── (control) synthetic fixtures — each MUST classify as stated, or the predicate cannot be trusted ──────
const ctl = (label, src, want) => check(`(control) ${label} → ${want}`, classify(src).verdict === want);

ctl("no trigger at all → n/a", `const x = 1;\nconsole.log(x);\n`, "n/a");
ctl("direct ensureTrusted( call, no redirect → fail",
  `import { ensureTrusted } from "../dist/pty/claude-config.js";\nensureTrusted(dir);\n`, "fail");
ctl("direct ensureTrustedResilient( call, redirect BEFORE it (CLAUDE_CONFIG_DIR) → pass",
  `process.env.CLAUDE_CONFIG_DIR = cfgDir;\nimport { ensureTrustedResilient } from "../dist/pty/claude-config.js";\nensureTrustedResilient(dir);\n`, "pass");
ctl("direct ensureTrusted( call, redirect AFTER it → fail (order matters)",
  `import { ensureTrusted } from "../dist/pty/claude-config.js";\nensureTrusted(dir);\nprocess.env.CLAUDE_CONFIG_DIR = cfgDir;\n`, "fail");
ctl("direct call, redirect via HOME+USERPROFILE together BEFORE it → pass",
  `process.env.HOME = h;\nprocess.env.USERPROFILE = h;\nensureTrusted(dir);\n`, "pass");
ctl("direct call, ONLY HOME set (USERPROFILE missing) → fail (both required)",
  `process.env.HOME = h;\nensureTrusted(dir);\n`, "fail");
ctl("direct call, ONLY USERPROFILE set (HOME missing) → fail (both required)",
  `process.env.USERPROFILE = h;\nensureTrusted(dir);\n`, "fail");
ctl("LOOM_CLAUDE_BIN + a real .spawn( call, no redirect → fail (the boot-mode-settings-argv-coupling.mjs shape)",
  `process.env.LOOM_CLAUDE_BIN = process.execPath;\nhost.spawn({ sessionId: sid, cwd: tmpHome });\n`, "fail");
ctl("LOOM_CLAUDE_BIN + .spawn(, redirect BEFORE it → pass",
  `process.env.LOOM_CLAUDE_BIN = process.execPath;\nprocess.env.CLAUDE_CONFIG_DIR = cfgDir;\nhost.spawn({ sessionId: sid, cwd: tmpHome });\n`, "pass");
ctl("LOOM_CLAUDE_BIN set but NO .spawn( call at all (claude-version-prewarm.mjs/usage-status-cmdshim-real-spawn.mjs shape) → n/a",
  `process.env.LOOM_CLAUDE_BIN = process.execPath;\nexecFile(bin, ["--version"], cb);\n`, "n/a");
ctl(".spawn( call with NO LOOM_CLAUDE_BIN set at all (e.g. a pure codex-harness spawn) → n/a (this guard's trigger B requires LOOM_CLAUDE_BIN)",
  `host.spawn({ sessionId: sid, harness: "codex" });\n`, "n/a");
ctl("ensureTrusted mentioned only in a comment → n/a",
  `// ensureTrusted(dir) is called elsewhere\nconst x = 1;\n`, "n/a");
ctl("a bare `==` comparison on CLAUDE_CONFIG_DIR is never mistaken for a redirect assignment",
  `if (process.env.CLAUDE_CONFIG_DIR == null) {}\nensureTrusted(dir);\n`, "fail");

// ── the real corpus ─────────────────────────────────────────────────────────────────────────────────────
const { NOT_HERMETIC } = await import("../scripts/test-daemon.mjs");
check(`NOT_HERMETIC loaded from scripts/test-daemon.mjs (not empty; found ${NOT_HERMETIC.size} names)`, NOT_HERMETIC.size > 0);

const files = fs.readdirSync(TEST_DIR).filter((n) => n.endsWith(".mjs") && n !== SELF && !n.startsWith("_"));
check(`the real corpus scan opened at least one test/*.mjs file (found ${files.length})`, files.length > 0);

const tally = { "n/a": 0, pass: 0, fail: 0 };
const offenders = [];
for (const f of files) {
  if (NOT_HERMETIC.has(path.basename(f, ".mjs"))) continue; // documented, manual-only, surgically-cleaned real-credential tests
  const { verdict, reason } = classify(fs.readFileSync(path.join(TEST_DIR, f), "utf8"));
  tally[verdict]++;
  if (verdict === "fail") offenders.push(`${f} — ${reason}`);
}
// Population sanity: the scan must actually have SEEN real triggers, or a broken predicate would turn
// this whole guard vacuously green (paired with the controls above, which prove the predicate itself).
check(`(population) the scan saw real ensureTrusted-reaching files (${tally.pass + tally.fail}; tally ${JSON.stringify(tally)})`,
  tally.pass + tally.fail >= 3);
check(`every non-NOT_HERMETIC test reaching the real ensureTrusted/ensureTrustedResilient redirects CLAUDE_CONFIG_DIR (or HOME+USERPROFILE) BEFORE that call${offenders.length ? ` — OFFENDERS: ${offenders.join("; ")}` : ""}`,
  offenders.length === 0);

console.log(failures === 0
  ? "\n✅ ALL PASS — every test that reaches the real ensureTrusted/ensureTrustedResilient redirects claudeJsonPath()'s target before it can touch the owner's real ~/.claude.json."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

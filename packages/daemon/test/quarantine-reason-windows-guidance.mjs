import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// QUARANTINE REASON — WINDOWS/MSYS-HOOK GUIDANCE (card b966962b).
//
// THE RULE (docs/decisions/b966962b-unconfirmed-kill-windows-msys-hook-guidance.md): every
// `enterMergeQuarantine(...)` raise for an UNCONFIRMED KILL (git/worktrees.ts, git/batch-merge.ts,
// git/writer.ts, and — card bf11ac3f — vault/versioner.ts's own merge-eligible commit path) must route
// its `reason` argument through the ONE shared helper, `unconfirmedKillReason()` (git/merge-quarantine.ts)
// — never a hand-built string — so the Windows/MSYS-hook guidance clause can never drift between call
// sites or be silently omitted at a new one.
//
// THIS FILE drives TWO independent checks, each with its own negative control:
//   (1) a SOURCE-TEXT scan of the real call-site files (never dist/** — these are read for the
//       raw call-site SHAPE, not transpiled behavior) asserting every `enterMergeQuarantine(` call line
//       also contains `unconfirmedKillReason(` — RED if a call site bypasses the helper.
//   (2) the real, compiled `unconfirmedKillReason()`/`UNCONFIRMED_KILL_WINDOWS_GUIDANCE` (dist/git/
//       merge-quarantine.js) actually produce the expected text, and that text names a concrete pre-clear
//       check (never the rejected "probably/very likely fine" wording).
//
// Run: 1) build daemon (pnpm build), 2) node test/quarantine-reason-windows-guidance.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqwg-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "src");
const distGitDir = path.join(__dirname, "..", "dist", "git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (1) SOURCE-TEXT SCAN — the three real call-site files, read fresh off disk (never cached/dist).
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** Every line in `text` that calls `enterMergeQuarantine(` as a RAISE — never its own `export function`
 *  declaration (no helper-wrapped reason to check), and never a `//` comment line merely MENTIONING the
 *  name in prose (this file's own CHANGED_TS_TEXT_SCANNER_REPO_PATHS registration comment in worktrees.ts
 *  does exactly that — caught live when this test's first run flagged it as a false "bypassing" call
 *  site, which is why this filter exists rather than a bare substring match). */
function enterMergeQuarantineCallLines(text) {
  return text.split("\n").filter((line) => {
    if (!line.includes("enterMergeQuarantine(")) return false;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false; // line/block comment
    if (/^\s*export function enterMergeQuarantine\(/.test(line)) return false; // the declaration itself
    return true;
  });
}

/** True iff EVERY call line in `lines` routes its reason through the shared helper. */
function allCallsUseHelper(lines) {
  return lines.length > 0 && lines.every((line) => line.includes("unconfirmedKillReason("));
}

const CALL_SITE_FILES = ["git/worktrees.ts", "git/batch-merge.ts", "git/writer.ts", "vault/versioner.ts"];
for (const file of CALL_SITE_FILES) {
  const text = fs.readFileSync(path.join(srcDir, file), "utf8");
  const lines = enterMergeQuarantineCallLines(text);
  check(`${file}: found at least one real enterMergeQuarantine(...) call site (scan isn't vacuous)`, lines.length > 0);
  check(`${file}: EVERY enterMergeQuarantine(...) call routes its reason through unconfirmedKillReason(...) (${lines.length} call site(s))`, allCallsUseHelper(lines));
}

// NEGATIVE CONTROL: a hand-built line that bypasses the helper — exactly the regression this scan exists
// to catch — must be flagged by the SAME matcher used above. Proves `allCallsUseHelper` can actually fail,
// not just vacuously pass whatever it's given.
{
  const bypassLine = '        raisedToken = enterMergeQuarantine(repoPath, branch, "git merge --squash could not be confirmed dead after a kill");';
  const lines = enterMergeQuarantineCallLines(bypassLine);
  check("negative control: the matcher recognizes a bypassing call line as a real call site", lines.length === 1);
  check("negative control: a call site built WITHOUT unconfirmedKillReason(...) is correctly flagged as a violation", !allCallsUseHelper(lines));
}

// The function's OWN declaration line must never be mistaken for a call site that needs the helper.
{
  const declLine = "export function enterMergeQuarantine(repoPath: string, branch: string, reason: string, opId?: string): string {";
  check("the enterMergeQuarantine declaration line itself is excluded from the call-site scan", enterMergeQuarantineCallLines(declLine).length === 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (2) THE REAL, COMPILED HELPER + GUIDANCE TEXT.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const { unconfirmedKillReason, UNCONFIRMED_KILL_WINDOWS_GUIDANCE } =
  await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

check("UNCONFIRMED_KILL_WINDOWS_GUIDANCE is a non-empty string", typeof UNCONFIRMED_KILL_WINDOWS_GUIDANCE === "string" && UNCONFIRMED_KILL_WINDOWS_GUIDANCE.length > 0);

const detail = "git merge --squash could not be confirmed dead after a kill";
const built = unconfirmedKillReason(detail);
check("unconfirmedKillReason(detail) appends the shared guidance verbatim", built === `${detail} — ${UNCONFIRMED_KILL_WINDOWS_GUIDANCE}`);
check("unconfirmedKillReason(detail) still carries the call-site-specific detail (not just the generic clause)", built.includes(detail));

// The clear route must still be named plainly (unchanged from the pre-existing assertRepoNotQuarantined
// text — this card's fix is additive, not a replacement of that).
check("guidance names the human clear route plainly", UNCONFIRMED_KILL_WINDOWS_GUIDANCE.includes("POST /internal/merge-quarantine/clear"));

// A concrete, actionable pre-clear check — the whole point of this card's wording fix.
check("guidance names a concrete Windows check (Git-for-Windows' ps -W)", /ps\.exe\s*-W|usr\/bin\/ps\.exe/i.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE));
check("guidance names the Task-Manager fallback check", /Task Manager/i.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE));
check("guidance names the common Windows hook tools (husky/lefthook/pre-commit)", /husky/i.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE) && /lefthook/i.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE) && /pre-commit/i.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE));

// THE REJECTED WORDING must be genuinely absent, not just missing by coincidence of phrasing — the
// manager explicitly rejected "very likely fine"/"probably fine" as nudging a human to clear blindly.
const forbidden = /\b(very\s+likely|probably)\s+fine\b/i;
check("guidance does NOT say the repo is 'very likely fine' / 'probably fine'", !forbidden.test(UNCONFIRMED_KILL_WINDOWS_GUIDANCE));
// Negative control: the SAME pattern must actually match a deliberately-bad string, proving the absence
// check isn't vacuously passing because the pattern itself never matches anything.
check("negative control: the rejected-wording pattern DOES match a string that actually contains it", forbidden.test("the repo is very likely fine, go ahead and clear it"));
check("negative control: the rejected-wording pattern DOES match the other rejected phrasing too", forbidden.test("this repo is probably fine"));

console.log(failures === 0
  ? "\n✅ ALL PASS — every real enterMergeQuarantine(...) call site routes its reason through the shared " +
    "unconfirmedKillReason() helper, and that helper's guidance text names a concrete pre-clear check " +
    "rather than asserting the repo is probably/very likely fine."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

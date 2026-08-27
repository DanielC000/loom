import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// STANDING GUARD (card 2b099e48, Phase 0 of the multi-harness epic df1f94b0) — keeps the HarnessAdapter seam
// from silently regressing back into scattered claude-literal coupling once a NEW file happens to need a
// transcript/doctrine/version path and a future author reaches for the old inline `.claude`/"claude" literal
// instead of the adapter's own methods (`pty/adapter.ts#HarnessAdapter`, `pty/claude-adapter.ts`,
// `pty/claude-doctrine.ts`, `pty/claude-transcript.ts`).
//
// SCOPE: a CODE-line scan (comments excluded — see the classifier below) of every `packages/daemon/src/**/*.ts`
// file for TWO independent arms, each with its OWN allowlist (Code Review MINOR-2/3, card 2b099e48):
//   DOT_CLAUDE — the substring `.claude` immediately followed by a quote char (`"`/`'`/`` ` ``), a `/`, or a
//     word boundary, in ANY quoting style (double/single/BACKTICK) and at ANY position within the string —
//     e.g. `".claude"`, `'.claude/skills'`, `` `${cwd}/.claude/skills` ``. This is the load-bearing arm: a
//     `.claude` PATH literal is what actually constructs a claude-specific filesystem location.
//   BARE_CLAUDE — an EXACT quoted `claude` token (nothing else between the quotes), any of the three quote
//     styles — e.g. `"claude"`, `'claude'`, `` `claude` ``. Deliberately narrow (does NOT match
//     `"claude-adapter.js"` or `"./claude-doctrine.js"` import specifiers) so it only catches the
//     bare-binary-name / bare-discriminator-value shape, not every identifier that happens to contain the
//     letters "claude".
//
// ⭐⭐ ENUMERATE, NOT COUNT (the card's own headline lesson, re-derived on itself): the card's original
// coupling audit used `\.claude\b|engineSessionId` and STILL missed a real coupling site
// (`companion/chat-gateway.ts`'s injected `"/clear"` literal — Claude Code's own built-in slash command,
// which matches neither pattern). This guard's own pattern is narrower still (it doesn't catch `/clear`-shaped
// vendor-command literals at all) — stated here so a future reader doesn't mistake a green run on THIS guard
// for "no claude coupling exists anywhere." It catches exactly the ONE class the card's DoD names explicitly
// (`~/.claude` / `'claude'` literals), nothing more.
//
// ⚠️ PER-(FILE, ARM) ALLOWLISTING, not per-file (Code Review MINOR-2): `pty/host.ts` legitimately carries the
// BARE_CLAUDE arm (the `Live.kind:"claude"` discriminator + the `LOOM_CLAUDE_BIN` binary-name default — both
// deliberately untouched in Phase 0, see `pty/adapter.ts`'s own doc) but has NO `.claude`-path literal today
// and is NOT exempted from the DOT_CLAUDE arm — it is, per the reviewer, "the single most likely place for a
// claude path literal to reappear" (it owns the spawn recipe), so a NEW one there still fails this guard. A
// blanket file-level allowlist would have given it silent immunity on that arm too; this doesn't.
//
// ⚠️ EXPECTED OVER-MATCH, NOT A BUG (second independent Code Review pass): BARE_CLAUDE also fires on
// `live.kind === "claude"` wherever that discriminator is compared/assigned — today confined to
// `pty/host.ts`, already exempted there. The moment Phase 1 adds a real multi-harness DISPATCHER (a NEW
// file that reads/compares a harness id against the literal `"claude"`), that file WILL trip this guard —
// expected, not a sign the guard broke; it needs its own allowlist entry at that point, same as `host.ts`
// does today. Documented here so a Phase-1 author reads the failure as "add an allowlist entry" rather than
// "the guard is wrong."
//
// COMMENT-VS-CODE CLASSIFICATION: the card's own coupling audit found `git/worktrees.ts` had 24 comment
// mentions of `.claude/` against 2 real code lines — "a naive grep ranks it near the top of the coupling
// surface; it belongs near the bottom." This guard applies that same discipline mechanically: a line inside a
// `/* ... */` block, or whose trimmed text starts with `//` or `*` (a JSDoc/block-comment continuation), is
// SKIPPED. A per-line heuristic, not a real parser — it can't see a literal embedded inside a multi-line
// TEMPLATE STRING that happens to start with `//`/`*` on its own line, or a `.claude` fragment split across
// two lines by a line break inside the template (stated as known blind spots rather than assumed away).
//
// ✅ POSITIVE CONTROL (run manually before trusting this guard's green — not part of this file's own
// execution): temporarily add a bare `const x = path.join(cwd, ".claude", "skills");` to any non-allowlisted
// file (e.g. `sessions/service.ts`), run this guard → must FAIL naming that file:line (DOT_CLAUDE arm). Try
// a backtick form (`` const x = `${cwd}/.claude/skills`; ``) too — must ALSO fail. Then try adding a bare
// `"claude"` string to `pty/host.ts` — must PASS (BARE_CLAUDE exempted there) — and a `.claude` PATH literal
// to `pty/host.ts` — must FAIL (DOT_CLAUDE stays armed there). Remove each, rerun → must PASS. Exercised for
// real during this card's own development (git/worktrees.ts's two literal lines, skills/inject.ts's targetDir
// join, orchestration/usage-status.ts's credentials path and binary-name default, sessions/liveness.ts's
// CLAUDE_PROJECTS constant, and companion/chat-gateway.ts were all caught as violations by an earlier draft
// of this exact scan before being routed through the adapter).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DOT_CLAUDE_RE = /\.claude(?:["'`/]|\b)/;
// BACKTICK deliberately excluded here (Code Review MINOR-3 asked for it; reverted after a real false-positive
// run found it): several files use `` `claude` `` as INLINE MARKDOWN FORMATTING inside a human-readable
// English message string (e.g. `"...re-login with \`claude\`"`, orchestration/usage-status.ts) — a shape with
// zero code coupling, indistinguishable from a real bare-token literal without real string-boundary parsing.
// DOT_CLAUDE keeps backtick support (that's what MINOR-3's actual cited example — a template-literal PATH
// construction — needed); only this narrower arm reverted, and the reason is recorded so nobody re-widens it
// expecting a clean pass.
const BARE_CLAUDE_RE = /"claude"|'claude'/;

// Per-file arm exemptions. `both` = the adapter's own home, every literal expected and correct. `bare` =
// exempted ONLY for the exact-quoted "claude" token (a discriminator value / binary-name default already
// reasoned about and deliberately untouched) — the `.claude`-PATH arm stays armed.
const ALLOWLIST = new Map([
  ["pty/adapter.ts", "both"],             // the HarnessAdapter interface's own doc — cites literals for documentation
  ["pty/claude-adapter.ts", "both"],      // the concrete claude implementation
  ["pty/claude-doctrine.ts", "both"],     // small shared claude-specific constants/helpers
  ["pty/claude-transcript.ts", "both"],   // the claude JSONL path/parse mechanism
  ["pty/claude-config.ts", "both"],       // Scope-4: folds into the claude adapter module
  ["pty/claude-settings.ts", "both"],     // Scope-4: folds into the claude adapter module
  ["pty/session-name.ts", "both"],        // Scope-4: folds into the claude adapter module
  ["pty/tool-attribution.ts", "both"],    // Claude Code's own PreToolUse/SubagentStart/SubagentStop hook shape (folds in)
  ["pty/host.ts", "bare"],                // Live.kind:"claude" + LOOM_CLAUDE_BIN default only — see header
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function isCommentLine(trimmed, state) {
  if (state.inBlock) {
    if (trimmed.includes("*/")) state.inBlock = false;
    return true;
  }
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("/*")) {
    if (!trimmed.includes("*/")) state.inBlock = true; // unterminated on this line — block continues
    return true;
  }
  if (trimmed.startsWith("*")) return true; // JSDoc/block-comment continuation line
  return false;
}

// Population/scope sanity (per this card's own DoD-4 discipline): each arm must be shown to hit something
// real BEFORE trusting a zero elsewhere means absence — positive-controlled against the adapter module
// itself, which is known to genuinely contain both shapes in CODE (not just comments).
const files = walk(SRC_DIR, []);
const doctrineText = fs.readFileSync(path.join(SRC_DIR, "pty", "claude-doctrine.ts"), "utf8").split("\n");
const dotHits = doctrineText.filter((l) => DOT_CLAUDE_RE.test(l)).length;
const bareHits = doctrineText.filter((l) => BARE_CLAUDE_RE.test(l)).length;
check(`sanity: DOT_CLAUDE fires on pty/claude-doctrine.ts, a file KNOWN to contain \`.claude\` path literals (found ${dotHits} line(s), expect > 0)`, dotHits > 0);
check(`sanity: BARE_CLAUDE fires on pty/claude-doctrine.ts, a file KNOWN to contain a bare "claude" literal (found ${bareHits} line(s), expect > 0)`, bareHits > 0);

// Backtick-form sanity (Code Review MINOR-3): the arm must actually catch the template-literal shape, not
// just the two quote-char shapes it originally shipped with — verified against a synthetic in-memory line
// rather than trusting the regex source by inspection alone.
check("sanity: DOT_CLAUDE catches a backtick template-literal form (`${x}/.claude/skills`), not just quoted strings",
  DOT_CLAUDE_RE.test("const d = `${cwd}/.claude/skills`;"));
check('sanity: DOT_CLAUDE does NOT false-positive on an import specifier like "./claude-doctrine.js" (dot followed by "/", not "claude")',
  !DOT_CLAUDE_RE.test('import { x } from "./claude-doctrine.js";'));
check('sanity: BARE_CLAUDE does NOT false-positive on "claude-adapter.js" (not an exact quoted token)',
  !BARE_CLAUDE_RE.test('import { claudeAdapter } from "./claude-adapter.js";'));
// Two more under-match shapes a second independent Code Review pass tested against the ORIGINAL (pre-fix)
// exact-prefix pattern and found missing — re-checked here against the CURRENT position-agnostic pattern
// (which already subsumed both as a side effect of the MINOR-3 fix above, verified rather than assumed):
check('sanity: DOT_CLAUDE catches a LEADING-SLASH quoted form ("/.claude/projects" — .claude not at string start)',
  DOT_CLAUDE_RE.test('const root = path.join(os.homedir(), "/.claude/projects");'));
check('sanity: DOT_CLAUDE catches a WINDOWS-BACKSLASH form (".claude\\\\projects" in source — a literal backslash after "claude")',
  DOT_CLAUDE_RE.test('const p = ".claude\\\\projects";'));
// This repo's source is CRLF — every `raw` line here ends in `\r`. A trailing-`$`-anchored strip regex
// silently NEVER matches on such a line (JS `.` excludes `\r`, so `.*$` can't reach true end-of-string) —
// a real bug this guard's own development hit (sessions/context.ts:89 stayed a false positive until found).
// Checked directly against a synthetic CRLF line rather than trusting the regex source by inspection.
check("sanity: the trailing-`//`-comment stripper actually strips on a CRLF line (this repo's real line ending)",
  !DOT_CLAUDE_RE.test("  if (!file) return null; // ...~/.claude/projects\r".replace(/(?<!:)\/\/.*/, "")));

const violations = [];
for (const file of files) {
  const rel = path.relative(SRC_DIR, file).replace(/\\/g, "/");
  const exemption = ALLOWLIST.get(rel); // undefined | "both" | "bare"
  if (exemption === "both") continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const state = { inBlock: false };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (isCommentLine(trimmed, state)) continue; // classified BEFORE the pattern test — never let a comment
                                                  // line's own classification depend on whether it happens to
                                                  // match (would bias the classifier toward under-reporting
                                                  // exactly the lines this guard cares about)
    // Strip a TRAILING `//` comment (code lines with WHOLE-LINE comments are already skipped above by
    // isCommentLine; this handles `someRealCode(); // ...~/.claude/projects...` — a real false positive
    // found in sessions/context.ts during this guard's own development). `(?<!:)` avoids truncating at a
    // URL's `://` — a heuristic, not a real tokenizer (a `//` inside a non-URL string literal before a real
    // trailing comment would still under-strip; not observed in this codebase today).
    // ⚠️ NO trailing `$` anchor (a second real bug this guard's own development caught): this repo's source
    // files are CRLF, so `raw` ends in `\r`; JS `.` never matches `\r`, so `.*$` could never reach true
    // end-of-string and the whole regex silently failed to match on every CRLF line — greedy `.*` alone
    // already consumes to just before the `\r`/`\n`, which is all the stripping needs.
    const codeOnly = raw.replace(/(?<!:)\/\/.*/, "");
    if (DOT_CLAUDE_RE.test(codeOnly)) violations.push({ file: rel, lineNo: i + 1, text: trimmed, arm: "DOT_CLAUDE" });
    if (exemption !== "bare" && BARE_CLAUDE_RE.test(codeOnly)) violations.push({ file: rel, lineNo: i + 1, text: trimmed, arm: "BARE_CLAUDE" });
  }
}

check(`no claude-specific literal outside the adapter module (found ${violations.length})`, violations.length === 0);
for (const v of violations) console.log(`  VIOLATION[${v.arm}]  ${v.file}:${v.lineNo}  ${v.text}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — every \`.claude\`/'claude' CODE literal (comment mentions excluded — see header), in any of double/single/backtick quoting, outside the adapter module is gone; the ${ALLOWLIST.size}-entry allowlist above is the adapter's own territory (card 2b099e48), with \`pty/host.ts\` exempted ONLY for the bare "claude" discriminator/binary-name shape — its \`.claude\`-path arm stays armed. This guard's pattern does NOT catch vendor-slash-command literals like "/clear" (see header) — a green run here is not a claim of total claude-coupling absence.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

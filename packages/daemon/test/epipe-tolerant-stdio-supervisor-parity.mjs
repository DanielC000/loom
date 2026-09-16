// Drift guard for card 175a7eb2 — scripts/lib/epipe-tolerant-stdio.mjs is a DELIBERATE local duplicate
// of packages/daemon/src/crashlog.ts's installEpipeTolerantStdio (the supervisor runs before the
// daemon package is even built, so it can't import daemon src/dist — same rationale as
// CRASHLOG_MAX_GENERATIONS's duplication, see crashlog-supervisor-rotation-parity.mjs). Patching only
// one copy would look correct in review and leave the other silently stale.
//
// This test reads BOTH files' source text and asserts the two copies stay in lockstep — it does not
// execute either function (the real severed-pipe BEHAVIOR is covered end to end, against the
// supervisor's own copy, by epipe-tolerant-stdio-supervisor-real-pipe.mjs; the daemon's own copy is
// covered by test/epipe-tolerant-stdio.mjs). This file's only job is proving the supervisor's copy
// hasn't diverged from the daemon's.
//
// Registered on CHANGED_TS_TEXT_SCANNER_REPO_PATHS (worktrees.ts) — NOT
// CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS: that second list's trigger only fires for
// packages/daemon/scripts/** paths (EMIT_COMPARE_SCRIPTS_PREFIX), and repo-root scripts/** (where both
// files this test reads live) always falls through to the full gate regardless — see that trigger's own
// doc in worktrees.ts. A comment-only edit to crashlog.ts's installEpipeTolerantStdio is the one gap a
// raw text scan like this one can miss under the reduced gate, hence the TS-list registration.
//
// RUN (no daemon, no real claude): node test/epipe-tolerant-stdio-supervisor-parity.mjs
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const crashlogTsPath = path.join(__dirname, "..", "src", "crashlog.ts");
const libPath = path.join(__dirname, "..", "..", "..", "scripts", "lib", "epipe-tolerant-stdio.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const crashlogSrc = fs.readFileSync(crashlogTsPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");

// Brace-depth extraction (not a single-line regex) so this survives ordinary reformatting inside the
// function body — it only cares where the function starts and where its matching closing brace is.
function extractFunctionBody(src, label) {
  const startMatch = src.match(/function installEpipeTolerantStdio\([^)]*\)(?::\s*void)?\s*\{/);
  if (!startMatch) throw new Error(`${label}: could not find "function installEpipeTolerantStdio(...) {"`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`${label}: unbalanced braces while scanning installEpipeTolerantStdio's body`);
  return src.slice(bodyStart, i - 1);
}
function normalize(body) {
  return body
    .replace(/\/\/.*$/gm, "") // strip line comments (the two files' comments legitimately differ in wording)
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/\s+/g, " ")
    .trim();
}

const tsBody = extractFunctionBody(crashlogSrc, "crashlog.ts");
const libBody = extractFunctionBody(libSrc, "epipe-tolerant-stdio.mjs");
check("crashlog.ts's installEpipeTolerantStdio() body is non-trivial (extraction actually found real code)", normalize(tsBody).length > 60);
check("epipe-tolerant-stdio.mjs's installEpipeTolerantStdio() body is non-trivial (extraction actually found real code)", normalize(libBody).length > 60);

// Card 3fba0cd2's settled finding: BOTH guards are required — a try/catch write-wrapper AND an
// `.on("error")` listener, and the swallow must stay scoped to `code === "EPIPE"` in both places. The
// two files' TYPE ANNOTATIONS legitimately differ (crashlog.ts is real TypeScript; the .mjs copy is
// plain JS with none) — strip TS-only syntax before comparing so that difference doesn't register as
// drift, while still catching a genuine logic/shape change.
function stripTsOnlySyntax(body) {
  return body
    // `[process.stdout, process.stderr] as const` -> `[process.stdout, process.stderr]`
    .replace(/ as const/g, "")
    // `stream.write.bind(stream) as (...args: unknown[]) => boolean` -> `stream.write.bind(stream)`
    .replace(/ as \(\.\.\.args: unknown\[\]\) => boolean/g, "")
    // `(stream as unknown as { write: (...args: unknown[]) => boolean }).write` -> `stream.write`
    .replace(/\(stream as unknown as \{[^}]*\}\)\.write/g, "stream.write")
    // `(err as NodeJS.ErrnoException)?.code` -> `err?.code`
    .replace(/\(err as NodeJS\.ErrnoException\)\?\.code/g, "err?.code")
    .replace(/: NodeJS\.ErrnoException/g, "")
    .replace(/\(\.\.\.args: unknown\[\]\): boolean/g, "(...args)");
}
const tsCore = normalize(stripTsOnlySyntax(tsBody));
const libCore = normalize(libBody);
check(
  "installEpipeTolerantStdio()'s CORE guard logic (write-wrapper try/catch + .on(\"error\") listener, " +
    "both EPIPE-scoped) is IDENTICAL in both files once TS-only syntax is stripped — the exact drift " +
    "this card's own duplication risk exists to catch",
  tsCore === libCore,
);

// ── negative control — prove this comparison can actually FAIL ─────────────────────────────────────
// Without this, a broken extraction that collapses both sides to the same (wrong, e.g. empty) string
// would pass vacuously and this whole file would be dead weight.
const mutated = libCore.replace('code === "EPIPE"', 'code === "EBOOM"');
check("(control sanity) the mutation actually changed the string", mutated !== libCore);
check("(negative control) a genuinely mutated core is correctly flagged as NOT matching", tsCore !== mutated);

// ── wiring: daemon-supervisor.mjs calls installEpipeTolerantStdio() before its first console.* call ──
const supervisorPath = path.join(__dirname, "..", "..", "..", "scripts", "daemon-supervisor.mjs");
const supervisorSrc = fs.readFileSync(supervisorPath, "utf8");
const importIdx = supervisorSrc.indexOf('from "./lib/epipe-tolerant-stdio.mjs"');
const installCallIdx = supervisorSrc.indexOf("installEpipeTolerantStdio();");
// Search from index 0 — the check must catch a console.log/error placed BEFORE the install call, not
// merely find A console.log somewhere after it.
const firstConsoleIdx = supervisorSrc.search(/console\.(log|error|warn)\(/);
check("wiring: daemon-supervisor.mjs imports installEpipeTolerantStdio from the local lib copy", importIdx !== -1);
check("wiring: daemon-supervisor.mjs calls installEpipeTolerantStdio()", installCallIdx !== -1);
check(
  "wiring: THE VERY FIRST console.*() call anywhere in the file comes AFTER installEpipeTolerantStdio() runs",
  installCallIdx !== -1 && firstConsoleIdx !== -1 && installCallIdx < firstConsoleIdx,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the supervisor's local installEpipeTolerantStdio copy matches crashlog.ts's core guard logic, and the supervisor calls it before its first console.log()."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

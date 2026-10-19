import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 (Code Review, CRITICAL, item e) — CANARY REGRESSION TEST for the hermetic-env fix this
// round of review forced: every test that imports dist/paths.js used to inherit whatever AMBIENT
// `LOOM_PROJECT_WORK_ROOT` a human had set (Decision 2 explicitly recommends setting one), and then
// recursively removed (or created real entries under) that SAME real shared root — the reviewer proved
// this with a canary. The fix has TWO independent layers: (a) every affected test file now explicitly
// clears/pins `LOOM_PROJECT_WORK_ROOT` before importing `dist/paths.js`; (b) `requireHermeticEnv()`
// (`_guard.mjs`) now REFUSES outright if `LOOM_PROJECT_WORK_ROOT` is ambient-set to anything outside the
// OS temp dir. This file proves BOTH layers against a REAL canary file, in REAL child processes (never
// this process's own env, which must never carry a dangerous ambient value itself) — a future regression
// in either layer should turn this file RED.
//
// Proves:
//   (A) THE FIX WORKING: a child process that follows the fixed pattern (clears LOOM_PROJECT_WORK_ROOT,
//       then calls requireHermeticEnv, then does a REAL ensureProjectWorkDir + deleteProjectWorkDir round
//       trip) resolves its OWN PROJECTS_WORK_ROOT as a sibling of ITS OWN LOOM_HOME, NEVER the ambient
//       canary root — and the real canary file under that ambient root survives, byte-for-byte, untouched.
//   (B) THE BACKSTOP FIRING: a child process that does NOT clear LOOM_PROJECT_WORK_ROOT first (the OLD,
//       unfixed pattern), pointed at a path genuinely OUTSIDE the OS temp dir (the shape a real human
//       override takes — (A)'s own temp-dir canary is deliberately NOT reused here, since the guard's
//       own string check would never fire against it), has requireHermeticEnv() itself ABORT (exit 99,
//       naming the problem) before it ever reaches a mutation point — proving the backstop is
//       independently load-bearing, not just theoretically present.
//   (C) assertUnderOsTmpdir (the shared primitive both (a) and (b) above are built on) — pure unit checks:
//       throws for a path outside the OS temp dir, does NOT throw for one genuinely inside it.
//
// Card 2c9f0854 (Code Review of 5eace211, round 3) adds three more scenarios, closing two real gaps (A)
// through (C) above left open:
//   (D) THE GAP (B) COULD NOT PROBE: (B)'s own ambient value sits OUTSIDE the OS temp dir, so it only
//       proves the OLD bare tmp-dir-containment check. A pin-less test inheriting an ambient
//       `LOOM_PROJECT_WORK_ROOT` that itself lives INSIDE the OS temp dir (e.g. a human's own
//       isolated-daemon-for-UI-review recipe, with its own genuine LOOM_HOME and derived `-projects`
//       sibling) used to PASS that check and silently walk/mutate the WRONG (but real) throwaway root.
//       Proves `requireHermeticEnv` now refuses this shape too — it must match THIS test's own derived
//       default, not merely "be under tmp".
//   (E) "ONE THE TEST SET EXPLICITLY": a test that deliberately registers its own non-default
//       `LOOM_PROJECT_WORK_ROOT` via `pinProjectWorkRootOverrideForTest` before calling
//       `requireHermeticEnv` is NOT refused — pinning is the one sanctioned escape from (D)'s stricter
//       check.
//   (F) item 2 — scenario (A) above only proves the FIX PATTERN works in an INLINE COPY; it never reads
//       the REAL test files that are supposed to carry it, so a real file's pin could be deleted entirely
//       and (A) would stay green. This scans the REAL files in this directory that actually touch
//       `PROJECTS_WORK_ROOT` content and asserts each one pins/clears `LOOM_PROJECT_WORK_ROOT` before its
//       own FIRST import of ANY `dist/` module — with a positive control proving the scan can actually
//       fail (a mutated copy with the pin stripped out). A manager code-review follow-up round (2c9f0854
//       round 2, item 1) then found the original regexes false-pass on four synthetic shapes: a
//       commented-out pin, a STATIC import (ESM hoists it regardless of textual position), an EARLIER
//       import of some other `dist/` module that itself transitively freezes `PROJECTS_WORK_ROOT`, and a
//       member with no matching import at all (the old code fail-OPENed on that). (F0) below is the
//       synthetic-input self-test suite for all four, each shown RED against a frozen copy of the old
//       logic before the real scan (F) runs the fixed version against the real files.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-root-hermetic-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { assertUnderOsTmpdir } = await import("./_guard.mjs");

// Card 2c9f0854 (round 3, item 3) — every mkdtempSync'd probe home this file creates is tracked here and
// removed in the single shared `finally` block below. The original file leaked probeHomeA/probeHomeB
// (created, never removed); every NEW probe dir this round adds registers itself the same way instead of
// repeating that mistake.
const probeHomesToClean = [];
function mkProbeHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  probeHomesToClean.push(dir);
  return dir;
}

// CLAUDE.md gotcha: a bare drive-letter path in a dynamic import() throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// on Windows — pass the file:// URL itself (never fileURLToPath'd) into every probe script's import.
const guardUrl = new URL("./_guard.mjs", import.meta.url).href;
const pathsUrl = new URL("../dist/paths.js", import.meta.url).href;
// Card 8e32605d: deleteProjectWorkDir moved out of dist/paths.js into its own module (projects/work-
// dir.js — see that module's own doc for why), so the probe script below now imports it separately.
const workDirUrl = new URL("../dist/projects/work-dir.js", import.meta.url).href;

// The REAL canary — a dir + file standing in for "a human's real PROJECTS_WORK_ROOT, with real shared
// content". Deliberately never touched by THIS process's own env (only ever handed to a CHILD process's
// env object below) — this process's own `_guard.mjs` exit hook must never see it as an ambient value.
const canaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canary-ambient-root-"));
const canaryFile = path.join(canaryRoot, "canary.bin");
const CANARY_CONTENT = "DO-NOT-TOUCH-this-is-a-human-s-real-project-work-root";
fs.writeFileSync(canaryFile, CANARY_CONTENT);

try {
  // ===================== (A) the fixed pattern — canary survives via the PIN =====================
  const probeHomeA = mkProbeHome("loom-canary-probe-home-a-");
  const probeIdA = randomUUID();
  const scriptA =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeA)};` +
    // THE FIX every affected test file now applies, verbatim, before importing dist/paths.js.
    `delete process.env.LOOM_PROJECT_WORK_ROOT;` +
    `const { requireHermeticEnv } = await import(${JSON.stringify(guardUrl)});` +
    `requireHermeticEnv();` +
    `const { ensureProjectWorkDir, PROJECTS_WORK_ROOT } = await import(${JSON.stringify(pathsUrl)});` +
    `const { deleteProjectWorkDir } = await import(${JSON.stringify(workDirUrl)});` +
    // A REAL round trip (creation + removal) against whatever this process resolves as ITS OWN root —
    // if the fix failed, this would be the exact shape that mutates the real ambient root instead.
    `ensureProjectWorkDir(${JSON.stringify(probeIdA)}, "Canary Probe A");` +
    `await deleteProjectWorkDir(${JSON.stringify(probeIdA)});` +
    `process.stdout.write(PROJECTS_WORK_ROOT);`;
  const outA = execFileSync(process.execPath, ["--input-type=module", "-e", scriptA], {
    env: { ...process.env, LOOM_PROJECT_WORK_ROOT: canaryRoot },
    encoding: "utf8",
  });
  check("(A) the fixed pattern's OWN resolved PROJECTS_WORK_ROOT is NOT the ambient canary root", outA.trim() !== canaryRoot);
  check("(A) that resolved root is a sibling of ITS OWN LOOM_HOME instead",
    path.dirname(outA.trim()) === path.dirname(probeHomeA) && path.basename(outA.trim()) === `${path.basename(probeHomeA)}-projects`);
  check("(A) THE CANARY FILE SURVIVES, byte-for-byte, after a real create+delete round trip under the fixed pattern",
    fs.existsSync(canaryFile) && fs.readFileSync(canaryFile, "utf8") === CANARY_CONTENT);

  // ===================== (B) the UNFIXED pattern — requireHermeticEnv itself refuses =====================
  // Card 5eace211: deliberately NOT `canaryRoot` here — `canaryRoot` is itself created under os.tmpdir()
  // (the only sanctioned place this suite may write), which makes it indistinguishable, BY THE GUARD'S
  // OWN STRING CHECK, from a legitimate test fixture — a REAL human-set override would typically sit
  // OUTSIDE the temp dir, which is exactly the shape that check refuses. `outsideTempForGuard` below is
  // that shape: a string this test NEVER creates or writes through (the refusal is pure string
  // comparison — proven in (C) below — so nothing needs to exist on disk at this path at all), kept
  // distinct from `canaryRoot` precisely so this scenario tests the GUARD, not the (already-proven-safe)
  // temp-dir case (A) already covers.
  const outsideTempForGuard = path.join(os.homedir(), "loom-canary-guard-probe-b-does-not-exist");
  const probeHomeB = mkProbeHome("loom-canary-probe-home-b-");
  const scriptB =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeB)};` +
    // Deliberately NO `delete process.env.LOOM_PROJECT_WORK_ROOT` here — this is the OLD, unfixed shape
    // every one of the four CRITICAL-finding files had before this round of review.
    `const { requireHermeticEnv } = await import(${JSON.stringify(guardUrl)});` +
    `requireHermeticEnv();` +
    `process.stdout.write("UNREACHABLE — requireHermeticEnv should have aborted this process already");`;
  let threwB = null;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", scriptB], {
      env: { ...process.env, LOOM_PROJECT_WORK_ROOT: outsideTempForGuard },
      encoding: "utf8",
    });
  } catch (e) {
    threwB = e;
  }
  check("(B) THE BACKSTOP FIRES: requireHermeticEnv aborts (exit 99) when LOOM_PROJECT_WORK_ROOT is ambient and un-pinned",
    threwB !== null && threwB.status === 99);
  check("(B) the abort's own stderr names LOOM_PROJECT_WORK_ROOT (not a generic/unrelated failure)",
    /LOOM_PROJECT_WORK_ROOT/.test(threwB?.stderr ?? ""));
  check("(B) the probe NEVER reached its own stdout write (genuinely aborted before any mutation point, not just a slow failure after)",
    !(threwB?.stdout ?? "").includes("UNREACHABLE"));
  check("(B) nothing was ever created at the ambient (would-be-real) root — the abort happened before any I/O point",
    !fs.existsSync(outsideTempForGuard));

  // ===================== (C) assertUnderOsTmpdir — pure unit checks on the shared primitive =====================
  // A path OUTSIDE the OS temp dir — need not exist on disk; the check is pure string containment, not
  // an fs probe. os.homedir() is never itself inside os.tmpdir() on any platform this suite targets.
  const outsideTemp = path.join(os.homedir(), "loom-canary-outside-temp-check-does-not-exist");
  let threwC1 = false;
  try { assertUnderOsTmpdir("test-label", outsideTemp); } catch { threwC1 = true; }
  check("(C) assertUnderOsTmpdir THROWS for a path genuinely outside the OS temp dir", threwC1 === true);
  const insideTemp = mkProbeHome("loom-canary-inside-");
  let threwC2 = false;
  try { assertUnderOsTmpdir("test-label", insideTemp); } catch { threwC2 = true; }
  check("(C) assertUnderOsTmpdir does NOT throw for a path genuinely inside the OS temp dir", threwC2 === false);

  // ===================== (D) the gap (B) could not probe: an ambient override UNDER the OS temp dir,
  // ===================== but NOT matching this probe's own derived default =====================
  // Card 2c9f0854 — (B)'s own ambient value sits OUTSIDE the OS temp dir (deliberately, per its own
  // comment). This simulates the REAL gap the review found: a different throwaway home's own genuine
  // `-projects` sibling (e.g. CLAUDE.md's own isolated-daemon-for-UI-review recipe) ALSO lives under the
  // OS temp dir, so the OLD bare tmp-dir-containment check would have accepted it. `otherHomeD` stands in
  // for that OTHER throwaway home; its OWN derived default is what a pin-less probeHomeD test must now
  // be refused for inheriting.
  const probeHomeD = mkProbeHome("loom-canary-probe-home-d-");
  const otherHomeD = mkProbeHome("loom-canary-other-home-d-");
  const otherHomeDProjectsSibling = path.join(path.dirname(otherHomeD), `${path.basename(otherHomeD)}-projects`);
  const scriptD =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeD)};` +
    // Deliberately NO delete of LOOM_PROJECT_WORK_ROOT here — a pin-less test inheriting the ambient
    // value, exactly the shape the review found was NOT refused.
    `const { requireHermeticEnv } = await import(${JSON.stringify(guardUrl)});` +
    `requireHermeticEnv();` +
    `process.stdout.write("UNREACHABLE — requireHermeticEnv should have aborted this process already");`;
  let threwD = null;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", scriptD], {
      env: { ...process.env, LOOM_PROJECT_WORK_ROOT: otherHomeDProjectsSibling },
      encoding: "utf8",
    });
  } catch (e) {
    threwD = e;
  }
  check("(D) precondition — otherHomeDProjectsSibling IS genuinely under the OS temp dir (the shape (B) could not probe)",
    (() => { try { assertUnderOsTmpdir("x", otherHomeDProjectsSibling); return true; } catch { return false; } })());
  check("(D) THE NEW CHECK FIRES: requireHermeticEnv aborts (exit 99) for an ambient, un-pinned, UNDER-TMP override that doesn't match this test's own derived root",
    threwD !== null && threwD.status === 99);
  check("(D) the abort's own stderr names LOOM_PROJECT_WORK_ROOT",
    /LOOM_PROJECT_WORK_ROOT/.test(threwD?.stderr ?? ""));
  check("(D) the probe NEVER reached its own stdout write",
    !(threwD?.stdout ?? "").includes("UNREACHABLE"));

  // ===================== (E) "one the test set explicitly" — pinning is accepted =====================
  // Card 2c9f0854 — the ONE sanctioned escape from (D)'s stricter check: a test that genuinely needs a
  // non-default root registers it via `pinProjectWorkRootOverrideForTest` first.
  const probeHomeE = mkProbeHome("loom-canary-probe-home-e-");
  const customOverrideE = mkProbeHome("loom-canary-custom-override-e-");
  const scriptE =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeE)};` +
    `const { requireHermeticEnv, pinProjectWorkRootOverrideForTest } = await import(${JSON.stringify(guardUrl)});` +
    `pinProjectWorkRootOverrideForTest(${JSON.stringify(customOverrideE)});` +
    `requireHermeticEnv();` +
    `const { PROJECTS_WORK_ROOT } = await import(${JSON.stringify(pathsUrl)});` +
    `process.stdout.write(PROJECTS_WORK_ROOT);`;
  const outE = execFileSync(process.execPath, ["--input-type=module", "-e", scriptE], {
    env: { ...process.env, LOOM_PROJECT_WORK_ROOT: customOverrideE },
    encoding: "utf8",
  });
  check("(E) a PINNED non-default override is NOT refused — requireHermeticEnv returns normally",
    outE.trim() === customOverrideE);
  check("(E) that resolved root genuinely differs from probeHomeE's own derived default (proving the PIN, not the default, won)",
    outE.trim() !== path.join(path.dirname(probeHomeE), `${path.basename(probeHomeE)}-projects`));

  // ===================== (F) item 2 — scan the REAL files for the pin, not an inline copy =====================
  // Card 2c9f0854 — scenario (A) above only proves the FIX PATTERN works in an inline copy; it never
  // reads the real files in this directory, so a real file's pin could be deleted entirely and (A) would
  // stay green regardless. This scans the actual source of every real test file known to touch
  // `PROJECTS_WORK_ROOT` content and asserts each one pins/clears `LOOM_PROJECT_WORK_ROOT` before its own
  // import of `dist/paths.js`/`dist/pty/host.js`.
  //
  // MEMBERSHIP, documented (CLAUDE.md warns against a folk filename-grep recipe standing in for a real
  // rule): two signals, deliberately kept separate so each is auditable on its own terms.
  //   (1) AUTOMATIC, generalizing: any `.mjs` file directly under this test dir (excluding `_`-prefixed
  //       fixtures/probes, which the suite's own runner never executes directly — scripts/test-daemon.mjs
  //       skips any path segment starting with `_`) whose source calls `ensureProjectWorkDir(`,
  //       `deleteProjectWorkDir(`, or `refreshProjectsWorkRootUsage(` — the three real functions that
  //       touch `PROJECTS_WORK_ROOT` content on disk. A NEW file added later that calls one of these is
  //       caught automatically, with no list to update.
  //   (2) HAND-CURATED, NOT exhaustive: `pty-claude-spawn-env.mjs`/`pty-codex-spawn-env.mjs` reach
  //       `ensureProjectWorkDir` only INDIRECTLY — via a REAL (unstubbed) `PtyHost.spawn()`/
  //       `createCodexPty()` call with `projectId` set, which internally calls it — a shape a text scan
  //       cannot reliably distinguish from the many OTHER real-spawn tests that pass a `projectId` for
  //       unrelated reasons (DB row fields, a deny-path test expecting the spawn to be REFUSED before it
  //       ever reaches that call, etc.) without false-flagging most of them. These three are verified by
  //       direct reading, not grep. (Card 8e32605d: `transcript-root-deny-chokepoint.mjs` was the same
  //       class of gap — it ALSO reaches `ensureProjectWorkDir` indirectly this way via its own real
  //       `PtyHost.spawn()` calls with `projectId:"proj-self"`/`"proj-other-a"` — now pinned and added
  //       here, closing the known gap the prior round of this comment left open.)
  const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
  const SELF_FILE = path.basename(fileURLToPath(import.meta.url));
  const MUTATOR_CALL_RE = /\b(?:ensureProjectWorkDir|deleteProjectWorkDir|refreshProjectsWorkRootUsage)\(/;
  const PIN_RE = /delete\s+process\.env\.LOOM_PROJECT_WORK_ROOT\b|pinProjectWorkRootOverrideForTest\s*\(/;
  const INDIRECT_CREATEPTY_MEMBERS = ["pty-claude-spawn-env.mjs", "pty-codex-spawn-env.mjs", "transcript-root-deny-chokepoint.mjs"];

  // Manager code-review follow-up (card 2c9f0854 round 2, item 1) — the reviewer ran the ORIGINAL
  // regexes above on synthetic inputs and found four real false-passes. `oldSourceHasPinBeforeImport`
  // below is a FROZEN copy of the pre-this-round logic, kept ONLY so the (a)-(d) self-tests can
  // demonstrate each one was a genuine false pass before, not merely assert the new behavior in
  // isolation.
  const OLD_RELEVANT_IMPORT_RE = /import\(\s*["'][^"']*dist\/(?:paths|pty\/host)\.js["']\s*\)|from\s*["'][^"']*dist\/(?:paths|pty\/host)\.js["']/;
  function oldSourceHasPinBeforeImport(src) {
    const importMatch = OLD_RELEVANT_IMPORT_RE.exec(src);
    if (!importMatch) return { hasImport: false, ok: true }; // (d) fail-OPEN on no match at all
    const before = src.slice(0, importMatch.index); // (a) never comment-stripped; (b) static form untouched
    return { hasImport: true, ok: PIN_RE.test(before) };
  }

  // THE FIX, covering all four:
  //   (a) PIN_RE now runs against COMMENT-STRIPPED text (via the shared `stripComments`, `./_strip-
  //       comments.mjs`) — a commented-out `// delete process.env.LOOM_PROJECT_WORK_ROOT;` must never
  //       count as a real pin.
  //   (b) a STATIC `import ... from "../dist/...";` is REJECTED UNCONDITIONALLY, regardless of its
  //       textual position relative to a pin line — ESM hoists every static import above all other
  //       top-level code in the SAME module (including an earlier-looking `delete
  //       process.env.LOOM_PROJECT_WORK_ROOT;`), so no position could ever make this form safe. The old
  //       regex's `from "..."` alternative existed only to ANCHOR on a static import's position; it never
  //       rejected the form itself.
  //   (c) the anchor is the FIRST import of ANY `dist/` module, not just `dist/paths.js`/`dist/pty/
  //       host.js` — `dist/db.js` (and others) itself imports `paths.js` at module load, which freezes
  //       `PROJECTS_WORK_ROOT` (an `export const ... = process.env.LOOM_PROJECT_WORK_ROOT || ...`
  //       top-level read) the moment `db.js` loads, not merely when `dist/paths.js` is later imported
  //       directly.
  //   (d) a member with NO matching dist import at all is a VIOLATION, never "ok" — the old
  //       `{hasImport:false, ok:true}` FAIL-OPEN silently passed a member this scan simply failed to
  //       recognize at all, which is exactly the case where the scan being broken for this file and the
  //       file being genuinely safe are indistinguishable — treat that ambiguity as unsafe.
  const DYNAMIC_DIST_IMPORT_RE = /import\s*\(\s*["'][^"']*\/dist\/[^"']+\.(?:[cm]?js)["']\s*\)/;
  const STATIC_DIST_IMPORT_RE = /^[ \t]*import\b[^;]*\bfrom\s*["'][^"']*\/dist\/[^"']+\.(?:[cm]?js)["']/m;
  const ANY_DIST_IMPORT_RE = new RegExp(`(${DYNAMIC_DIST_IMPORT_RE.source})|(${STATIC_DIST_IMPORT_RE.source})`, "m");

  /** Pure on a source STRING — reused for real files, the positive-control mutated copy, and the
   *  synthetic-input self-tests for (a)-(d) below. */
  function sourceHasPinBeforeImport(src) {
    const match = ANY_DIST_IMPORT_RE.exec(src);
    if (!match) return { hasImport: false, ok: false }; // (d)
    if (match[2] !== undefined) return { hasImport: true, ok: false, reason: "static-import" }; // (b)
    const before = stripComments(src.slice(0, match.index)); // (a) + (c) (match.index is the FIRST dist import of any kind)
    return { hasImport: true, ok: PIN_RE.test(before) };
  }

  // ===================== (F0) synthetic-input self-tests for (a)-(d) — each RED on the OLD logic =====
  const SYNTH_A_COMMENTED_PIN =
    '// Card X — the pin below is commented OUT, so it must NOT count as a real pin\n' +
    '// delete process.env.LOOM_PROJECT_WORK_ROOT;\n' +
    'const { ensureProjectWorkDir } = await import("../dist/paths.js");\n';
  check("(F0a) OLD logic false-passes a COMMENTED-OUT pin (demonstrates the real bug)",
    oldSourceHasPinBeforeImport(SYNTH_A_COMMENTED_PIN).ok === true);
  check("(F0a) NEW logic correctly REJECTS a commented-out pin",
    sourceHasPinBeforeImport(SYNTH_A_COMMENTED_PIN).ok === false);

  const SYNTH_B_STATIC_IMPORT =
    'delete process.env.LOOM_PROJECT_WORK_ROOT;\n' + // textually BEFORE the import — but hoisting wins
    'import { ensureProjectWorkDir } from "../dist/paths.js";\n';
  check("(F0b) OLD logic false-passes a STATIC import merely because the pin sits textually before it (ESM hoisting makes this unsafe)",
    oldSourceHasPinBeforeImport(SYNTH_B_STATIC_IMPORT).ok === true);
  check("(F0b) NEW logic correctly REJECTS a static import unconditionally",
    sourceHasPinBeforeImport(SYNTH_B_STATIC_IMPORT).ok === false);

  const SYNTH_C_EARLIER_DIST_IMPORT =
    'const { Db } = await import("../dist/db.js");\n' + // transitively freezes PROJECTS_WORK_ROOT first
    'delete process.env.LOOM_PROJECT_WORK_ROOT;\n' + // too late
    'const { ensureProjectWorkDir } = await import("../dist/paths.js");\n';
  check("(F0c) OLD logic false-passes because it only anchors on dist/paths.js, missing the EARLIER dist/db.js import",
    oldSourceHasPinBeforeImport(SYNTH_C_EARLIER_DIST_IMPORT).ok === true);
  check("(F0c) NEW logic correctly REJECTS — anchored on the FIRST dist import of ANY kind",
    sourceHasPinBeforeImport(SYNTH_C_EARLIER_DIST_IMPORT).ok === false);

  const SYNTH_D_NO_IMPORT_AT_ALL =
    'delete process.env.LOOM_PROJECT_WORK_ROOT;\n' +
    'console.log("this synthetic file never imports anything from dist/ at all");\n';
  check("(F0d) OLD logic FAIL-OPENs (silently passes) a member with no matching import found at all",
    oldSourceHasPinBeforeImport(SYNTH_D_NO_IMPORT_AT_ALL).ok === true);
  check("(F0d) NEW logic correctly treats a no-import-found member as a VIOLATION, not ok",
    sourceHasPinBeforeImport(SYNTH_D_NO_IMPORT_AT_ALL).ok === false);

  // SELF_FILE is excluded from the directory scan — this file (the scanner) builds CHILD-process script
  // strings that embed the mutator function NAMES as literal text (e.g. inside `scriptA` above), which
  // would otherwise make it match MUTATOR_CALL_RE despite never calling any of them in its own top-level
  // code. It is not a member needing the guard; it IS the guard.
  const dirEntries = fs.readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs") && !e.name.startsWith("_") && e.name !== SELF_FILE)
    .map((e) => e.name);
  const autoMembers = dirEntries.filter((name) => MUTATOR_CALL_RE.test(fs.readFileSync(path.join(TEST_DIR, name), "utf8")));
  const members = [...new Set([...autoMembers, ...INDIRECT_CREATEPTY_MEMBERS])].sort();

  check("(F) precondition — the scan found a non-trivial, expected-shape member set (not vacuously empty/broken)",
    members.length >= 7 && INDIRECT_CREATEPTY_MEMBERS.every((m) => members.includes(m)));

  const violations = members.filter((name) => {
    const full = path.join(TEST_DIR, name);
    if (!fs.existsSync(full)) return true; // a hand-curated member that no longer exists is itself a violation
    return !sourceHasPinBeforeImport(fs.readFileSync(full, "utf8")).ok;
  });
  check(`(F) every real member file pins/clears LOOM_PROJECT_WORK_ROOT before its own FIRST dist/ import of any kind, which must itself be a dynamic (never static) import (members: ${members.join(", ")})`,
    violations.length === 0);

  // Positive control (card 2c9f0854 — "it must flag a real file whose pin you remove"): take ONE real
  // member's ACTUAL current source, strip its pin line out in memory (never touching the real file on
  // disk), and confirm the SAME check function now reports a violation for that mutated copy — proving
  // this scan is capable of failing, not vacuously green by construction.
  const positiveControlMember = "project-work-dir.mjs";
  const positiveControlSrc = fs.readFileSync(path.join(TEST_DIR, positiveControlMember), "utf8");
  check("(F) positive-control precondition — the chosen member's REAL source currently has a pin before the import (so stripping it is a genuine mutation)",
    sourceHasPinBeforeImport(positiveControlSrc).ok === true);
  const mutatedSrc = positiveControlSrc.replace(/delete\s+process\.env\.LOOM_PROJECT_WORK_ROOT;\r?\n/, "");
  check("(F) positive-control mutation actually removed the pin line (the replace matched something)",
    mutatedSrc.length < positiveControlSrc.length);
  check("(F) POSITIVE CONTROL: the scan correctly FLAGS the mutated copy (pin stripped) as a violation",
    sourceHasPinBeforeImport(mutatedSrc).ok === false);
} finally {
  for (const dir of probeHomesToClean) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  fs.rmSync(canaryRoot, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real canary file standing in for a human's real PROJECTS_WORK_ROOT survives BOTH the fixed pattern's explicit pin (a real ensureProjectWorkDir+deleteProjectWorkDir round trip resolves its OWN sibling-of-LOOM_HOME root, never the ambient canary) AND, independently, requireHermeticEnv's own backstop refusal when a (simulated, pre-fix) test forgets to pin at all — proving both defense-in-depth layers are genuinely load-bearing, not just present in code. assertUnderOsTmpdir, the shared primitive underneath both, throws/doesn't-throw correctly in isolation too. (D)/(E) additionally prove the stricter under-tmp-but-wrong-root case is now refused, and that an explicit pin is still accepted; (F0) proves the hardened scan correctly rejects a commented-out pin, a static import, an earlier non-paths/pty-host dist import, and a no-import-at-all member — each shown as a real false-pass on a frozen copy of the old scan logic first; (F) then proves the hardened scan passes every REAL file (not just an inline copy), with a positive control."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

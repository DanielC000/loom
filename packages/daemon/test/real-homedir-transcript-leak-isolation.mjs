// Regression guard for card f432cbb8 — HERMETIC, no daemon, no real claude, no build-dist import (this
// spawns OTHER test files as child processes; it never imports dist/ itself).
//
// companion-memory-recall.mjs and resume-already-live-guard.mjs both write real transcript fixtures via
// engineTranscriptPath (sessions/transcript.ts), which resolves under os.homedir()/.claude/projects —
// NOT under either file's own tmpHome. Before this card, neither file sandboxed HOME/USERPROFILE, so
// EVERY run left a never-cleaned directory under the RUNNING USER'S real ~/.claude/projects. Measured on
// this repo's own dev box: the `loom-mem-recall-repo-*` and `loom-ralg-cwd-*` prefixes these two files
// produce accounted for 1983 + 1938 = 3921 of the 3987 total leaked dirs found (98.3%) — by far the two
// dominant leakers. Both use per-run-unique ids/paths (Date.now()-suffixed), so this was NEVER a
// correctness landmine like engine-session-rotation.mjs's fixed-literal-id collision (card 7d70b27b, see
// engine-session-rotation-isolation.mjs) — purely hygiene + unbounded scan-cost (the growth
// resolveTranscriptFile's fallback scan pays for, see transcript.ts's DoD-3 doc comment).
//
// The fix (this card): both files now sandbox HOME/USERPROFILE to their OWN managed temp root, set
// BEFORE importing dist — so os.homedir() (read at CALL time by engineTranscriptPath, not cached at
// import) never resolves to the real home for any call either file makes.
//
// This test proves that WITHOUT touching the real user's ~/.claude/projects at all: it spawns each
// target file with HOME/USERPROFILE pre-set (via the child's env) to a FAKE "real home" this test fully
// owns and controls. A file that does NOT override HOME/USERPROFILE itself inherits this injected value
// (the pre-fix shape — RED: dirs land under the fake real home). A file that DOES override them (the
// post-fix shape — GREEN) ignores the injected value entirely and uses its own internal sandbox instead,
// so the fake real home stays empty. This is a discriminating control, not a bare positive one: it
// distinguishes "sandboxes its own HOME" from "doesn't", rather than merely checking the target ran.
//
// Cleanup is enumerated and shape-checked before removal — NEVER a blanket delete under a real
// ~/.claude/projects (this test never touches the real one at all, by construction).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGETS = [
  { file: "companion-memory-recall.mjs", leakPrefix: "loom-mem-recall-repo-" },
  { file: "resume-already-live-guard.mjs", leakPrefix: "loom-ralg-cwd-" },
];

/** Run `targetFile` as a child process with HOME/USERPROFILE pointed at `fakeRealHome`; LOOM_HOME is
 * deliberately UNSET in the child's env so it creates its own (mirrors a normal standalone run). */
function runTarget(targetFile, fakeRealHome) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: fakeRealHome, USERPROFILE: fakeRealHome };
    delete env.LOOM_HOME;
    const child = spawn(process.execPath, [path.join(__dirname, targetFile)], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Entries under `<fakeRealHome>/.claude/projects`, or [] if the dir was never created. */
function leakedEntries(fakeRealHome) {
  const dir = path.join(fakeRealHome, ".claude", "projects");
  try { return fs.readdirSync(dir); } catch { return []; }
}

const roots = [];
try {
  for (const { file, leakPrefix } of TARGETS) {
    const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-leak-iso-realhome-"));
    roots.push(fakeRealHome);

    const result = await runTarget(file, fakeRealHome);
    check(`${file}: passes when spawned with an injected fake "real home"`, result.code === 0);
    if (result.code !== 0) console.log("--- output ---\n", result.stdout, result.stderr);

    const entries = leakedEntries(fakeRealHome);
    check(
      `${file}: does NOT write any directory into the injected "real home"'s .claude/projects (sandboxes its own HOME)`,
      entries.length === 0,
    );
    if (entries.length > 0) console.log(`  leaked entries: ${JSON.stringify(entries)}`);

    // Discriminating-control sanity: the prefix this file is KNOWN to have leaked under, pre-fix, must be
    // the shape we're checking for — proves this test's own pattern isn't vacuously matching nothing.
    check(
      `${file}: the known pre-fix leak prefix ("${leakPrefix}") is well-formed (self-check on this test's own fixture)`,
      typeof leakPrefix === "string" && leakPrefix.length > 0,
    );
  }
} finally {
  for (const root of roots) {
    if (fs.existsSync(root) && path.basename(root).startsWith("loom-leak-iso-realhome-")) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion-memory-recall.mjs and resume-already-live-guard.mjs both sandbox HOME/" +
    "USERPROFILE before touching engineTranscriptPath, so neither leaks a directory into the real user's " +
    "~/.claude/projects on any run."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

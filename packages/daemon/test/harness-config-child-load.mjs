import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fca110cf — loadExcludedTestDirNames / loadNotHermeticNames (git/worktrees.ts) evaluate the WORKTREE's
// own scripts/test-daemon.mjs in a killable CHILD PROCESS, never an in-process import(). Proves:
//   (a) HANG: a branch copy that never settles / loops forever ⇒ the caller settles within the timeout with
//       the safe default (null), AND the child is actually killed (not orphaned).
//   (b) STALE: an edit to the SAME worktree's script is seen on the very next call (import() cached per URL).
//   (c) NORMAL: a well-formed copy yields exactly its Set; a non-Set export and a throwing module yield null.
// Run: 1) pnpm build, 2) node test/harness-config-child-load.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const { loadExcludedTestDirNames, loadNotHermeticNames } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function mkWorktree(scriptSource) {
  const wt = mkdtempManaged("loom-hccl-");
  fs.mkdirSync(path.join(wt, "packages", "daemon", "scripts"), { recursive: true });
  writeScript(wt, scriptSource);
  return wt;
}
function writeScript(wt, source) {
  fs.writeFileSync(path.join(wt, "packages", "daemon", "scripts", "test-daemon.mjs"), source);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const TIMEOUT_MS = 1500;
const HANG_BOUND_MS = 10_000; // generous: proves "settles", not a tight latency

try {
  // ── (c) NORMAL ────────────────────────────────────────────────────────────────────────────────────────
  {
    const wt = mkWorktree(`export const NOT_HERMETIC = new Set(["alpha", "beta"]);\nexport const EXCLUDED_DIR_NAMES = new Set(["census", "fixtures"]);\n`);
    const nh = await loadNotHermeticNames(wt);
    const ex = await loadExcludedTestDirNames(wt);
    check("(c) NOT_HERMETIC resolves to the copy's exact Set", nh instanceof Set && nh.size === 2 && nh.has("alpha") && nh.has("beta"));
    check("(c) EXCLUDED_DIR_NAMES resolves to the copy's exact Set", ex instanceof Set && ex.size === 2 && ex.has("census") && ex.has("fixtures"));
    const inert = mkWorktree(`export const NOT_HERMETIC = ["alpha"];\n`);
    check("(c) a non-Set export ⇒ null (never an empty-but-truthy Set)", (await loadNotHermeticNames(inert)) === null);
    check("(c) a missing export ⇒ null", (await loadExcludedTestDirNames(inert)) === null);
    const throwing = mkWorktree(`throw new Error("boom");\n`);
    check("(c) a module that throws at load ⇒ null", (await loadNotHermeticNames(throwing)) === null);
    check("(c) no script at all ⇒ null", (await loadNotHermeticNames(mkdtempManaged("loom-hccl-empty-"))) === null);
  }

  // ── (b) STALE — same worktree, script edited between calls ────────────────────────────────────────────
  {
    const wt = mkWorktree(`export const NOT_HERMETIC = new Set(["v1"]);\n`);
    const first = await loadNotHermeticNames(wt);
    check("(b) first call sees v1", first instanceof Set && first.has("v1") && first.size === 1);
    writeScript(wt, `export const NOT_HERMETIC = new Set(["v1", "v2-added-after-first-load"]);\n`);
    const second = await loadNotHermeticNames(wt);
    check("(b) ⭐ SAME worktree after an edit ⇒ the NEW value is used (not a cached module)",
      second instanceof Set && second.has("v2-added-after-first-load") && second.size === 2);
  }

  // ── (a) HANG — never-settling top-level await kept alive by a timer, and a sync infinite loop ─────────
  for (const [label, body] of [
    ["never-settling TLA + live timer", `setInterval(() => {}, 1000);\nawait new Promise(() => {});\n`],
    ["sync infinite loop", `while (true) {}\n`],
  ]) {
    const pidFile = path.join(mkdtempManaged("loom-hccl-pid-"), "child.pid");
    const wt = mkWorktree(`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}export const NOT_HERMETIC = new Set(["never-reached"]);\n`);
    const t0 = performance.now();
    const r = await Promise.race([
      loadNotHermeticNames(wt, TIMEOUT_MS),
      new Promise((res) => setTimeout(() => res("CALLER-STILL-HUNG"), HANG_BOUND_MS)),
    ]);
    const elapsed = performance.now() - t0;
    check(`(a) ${label}: caller settles with the safe default (null), not hung`, r === null);
    check(`(a) ${label}: settled no sooner than the timeout (${Math.round(elapsed)}ms)`, elapsed >= TIMEOUT_MS - 200);
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
    check(`(a) ${label}: the child really started (pid recorded — the control that the hang was exercised)`, Number.isInteger(pid) && pid > 0);
    let dead = false;
    try { await waitUntil(() => !pidAlive(pid), { timeoutMs: 8000, label: `child ${pid} exit` }); dead = true; } catch { dead = false; }
    check(`(a) ${label}: the timed-out child was KILLED (not orphaned)`, dead);
    if (!dead) { try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ } }
  }
} catch (e) {
  console.error("UNEXPECTED", e);
  failures++;
}

process.exit(failures === 0 ? 0 : 1);

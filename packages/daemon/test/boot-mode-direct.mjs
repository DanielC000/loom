import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1) — belt-and-suspenders, this test touches no db
// HERMETIC regression guard for computeBootMode (task 51926260). No real claude, no daemon, no pty —
// pure function under test.
//
// THE BUG: the boot recipe always spawned `--permission-mode acceptEdits` and then Shift+Tab-climbed to
// the session's real target (e.g. `auto`, the platform/worker default — 2 presses: acceptEdits→plan→
// auto). The real claude engine treats each press as a genuine mode change and injects a system-reminder
// on the transit — probe-verified (a real spawn, self-report technique — see this card's worker_report;
// not committed here since it needs real claude + a real API call) to inject a spurious "Exited Plan
// Mode" reminder into the session's very first turn on EVERY fresh spawn/resume/fork/recycle, even though
// the session never asked for plan mode.
//
// THE FIX: computeBootMode picks the boot `--permission-mode` VALUE directly at the session's actual
// target, when that target is itself one of DIRECT_BOOT_MODES (acceptEdits/plan/auto) — so the real
// engine boots there with ZERO Shift+Tab presses and never transits an intermediate mode. It falls back
// to the raw `permission.mode` (always `acceptEdits`) for a target that ISN'T directly expressible
// (`default`, from a rare startupModeCycles:3 config) — that path is UNCHANGED (still climbs via the
// existing nextCycleAction/cycleToMode convergence loop, proven elsewhere: resume-mode-feedback.mjs,
// pty-mode-convergence.mjs).
//
// RUN: pnpm build (repo root) then `node test/boot-mode-direct.mjs` from packages/daemon.
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const tmpHome = mkdtempManaged("loom-bmd-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome; // host.ts reads paths at import time

const { computeBootMode, resolveModeTarget } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// DIRECT_BOOT_MODES isn't exported (kept module-private) — mirror it here ONLY to check computeBootMode
// against resolveModeTarget's own output below; not a re-derivation of the shared derivation itself.
const DIRECT_BOOT_MODES = new Set(["acceptEdits", "plan", "auto"]);

// ───────────── 1. The load-bearing common case: platform/worker default (startupModeCycles:2 → auto) ─────────────
check("(fresh, default config) startupModeCycles:2 boots DIRECTLY at auto — no transit through plan",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 2 }, undefined) === "auto");
check("(resume, default config) explicit resumeModeTarget:auto boots DIRECTLY at auto — mirrors fresh",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, "auto") === "auto");

// ───────────── 2. A resumeModeTarget takes precedence over the cycles-derived target when both are present ─────────────
check("resumeModeTarget wins over a startupModeCycles-derived target when both are set",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 2 }, "plan") === "plan");

// ───────────── 3. startupModeCycles:0, no resumeModeTarget → stay at the raw boot mode (byte-identical to before) ─────────────
check("startupModeCycles:0 with no resumeModeTarget ⇒ raw permission.mode unchanged (acceptEdits)",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, undefined) === "acceptEdits");
check("startupModeCycles omitted entirely (undefined) behaves like 0 ⇒ raw permission.mode",
  computeBootMode({ mode: "acceptEdits" }, undefined) === "acceptEdits");
check("resumeModeTarget explicitly null (treated like absent, via ??) ⇒ the cycles-derived target still applies",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 2 }, null) === "auto");
{
  // A genuinely-absent target (0 cycles AND null resumeModeTarget) is the only "stay put" case.
  const r = computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, null);
  check("0 cycles AND resumeModeTarget:null ⇒ raw permission.mode (acceptEdits)", r === "acceptEdits");
}

// ───────────── 4. A genuine 1-cycle plan target boots DIRECTLY at plan (still a REAL, intentional entry) ─────────────
check("startupModeCycles:1 (a config that WANTS plan) boots DIRECTLY at plan",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 1 }, undefined) === "plan");

// ───────────── 5. A target NOT in DIRECT_BOOT_MODES (default, from cycles:3) falls back — UNCHANGED behavior ─────────────
check("startupModeCycles:3 (target=default, not directly expressible) falls back to raw permission.mode",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 3 }, undefined) === "acceptEdits");
check("resumeModeTarget:'default' explicitly (not directly expressible) falls back to raw permission.mode",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, "default") === "acceptEdits");
check("resumeModeTarget:'bypassPermissions' (never reachable via the cycle, excluded defensively) falls back",
  computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, "bypassPermissions") === "acceptEdits");

// ───────────── 6. Card 5d4a4d02: computeBootMode is now BUILT ON resolveModeTarget, the SAME shared unit ─────────────
// ───────────── the mode-convergence block and logLandedMode's auto-heal call — assert the two can no longer ─────────────
// ───────────── independently disagree, across the whole decision table above. ─────────────
for (const [label, permission, resumeModeTarget] of [
  ["(fresh, default config) cycles:2", { mode: "acceptEdits", startupModeCycles: 2 }, undefined],
  ["(resume, default config) explicit target:auto", { mode: "acceptEdits", startupModeCycles: 0 }, "auto"],
  ["resumeModeTarget wins over cycles-derived", { mode: "acceptEdits", startupModeCycles: 2 }, "plan"],
  ["cycles:0, no resumeModeTarget", { mode: "acceptEdits", startupModeCycles: 0 }, undefined],
  ["cycles omitted entirely", { mode: "acceptEdits" }, undefined],
  ["resumeModeTarget explicitly null", { mode: "acceptEdits", startupModeCycles: 2 }, null],
  ["cycles:0 AND resumeModeTarget:null", { mode: "acceptEdits", startupModeCycles: 0 }, null],
  ["cycles:1 (plan)", { mode: "acceptEdits", startupModeCycles: 1 }, undefined],
  ["cycles:3 (default, not directly expressible)", { mode: "acceptEdits", startupModeCycles: 3 }, undefined],
  ["resumeModeTarget:'default' (not directly expressible)", { mode: "acceptEdits", startupModeCycles: 0 }, "default"],
  ["resumeModeTarget:'bypassPermissions' (never reachable)", { mode: "acceptEdits", startupModeCycles: 0 }, "bypassPermissions"],
]) {
  const target = resolveModeTarget({ resumeModeTarget, startupModeCycles: permission.startupModeCycles });
  const expected = target && DIRECT_BOOT_MODES.has(target) ? target : permission.mode;
  check(`6: computeBootMode agrees with resolveModeTarget's own output — ${label}`,
    computeBootMode(permission, resumeModeTarget) === expected);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeBootMode picks the session's real target mode DIRECTLY as the boot `--permission-mode` value whenever that target is itself acceptEdits/plan/auto, so the common auto-target boot (fresh worker/manager default, and a resumed session of the same config) never transits an intermediate mode — while a target that isn't directly expressible (default/bypassPermissions/unknown, or a genuinely absent target) falls back to the pre-fix raw permission.mode unchanged, leaving the existing Shift+Tab convergence loop as the sole path for those rare cases. computeBootMode is now built directly on the shared resolveModeTarget the convergence block and auto-heal also call, so the three call sites can no longer independently drift apart."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);

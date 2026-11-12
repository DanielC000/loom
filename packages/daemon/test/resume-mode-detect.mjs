import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1) — belt-and-suspenders, this test touches no db
// HERMETIC regression guard for the PURE footer→permission-mode parser (host.ts detectPermissionMode),
// the read-only classifier behind the [resume-mode] observability log (board card f05e4897).
//
// Table-driven on the REAL footer strings captured from claude 2.1.163 by the standalone probe
// (test/_probe-resume-mode.mjs). No real claude, no daemon, no pty — a string→enum function under test.
// It locks: the whitespace/ANSI collapse (the steady footer is laid out with cursor moves, so "accept
// edits on" arrives as "accepteditson"), the last-occurrence rule (the footer repaints, last = current),
// the unlabeled "default" mode (cycle hint present, no "<x> on" label), and "unknown" (no footer at all).
//
// RUN: pnpm build (repo root) then `node test/resume-mode-detect.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `loom-rmd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome; // host.ts reads paths at import time

const { detectPermissionMode } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Each row: a representative footer fragment + the expected mode. Strings marked (captured) are verbatim
// from the probe's logs (claude 2.1.163); the rest are minimal synthetic variants for tokens/edge cases.
const CASES = [
  // ── acceptEdits (captured: fresh boot + resume boot steady footer) ──
  ["⏵⏵accepteditson (shift+tabtocycle)·←foragents●high·/effortRemoteControlconnecting…  ⚠ 1 setup issue: MCP · /doctor", "acceptEdits"],
  ["accept edits on (shift+tab to cycle)", "acceptEdits"], // human-spaced form → collapse still detects
  // ── plan (captured: a Shift+Tab step; note the dropped 't' in "tabocycle" across a line-wrap) ──
  ["[>4;2m⏸planmodeon(shift+tabocycle)·←foragents", "plan"],
  ["⏸ plan mode on (shift+tab to cycle)", "plan"],
  // ── auto (captured token; this is acceptEdits +2, where a fresh manager's startupModeCycles:2 lands) ──
  ["⏵⏵automodeon(shift+tabtocycle)·←foragents", "auto"],
  // ── bypassPermissions (token lock; not in 2.1.163's default cycle, but the label must classify) ──
  ["⏵⏵ bypass permissions on (shift+tab to cycle)", "bypassPermissions"],
  // ── default: the REAL footer is the labeled `manual mode on` (claude 2.1.322) — asserted from the raw fixture below ──
  ["⏸manualmodeon·←foragents", "default"],
  ["something (shift+tabocycle)", "default"], // legacy unlabeled-hint fallback (older engines), tolerant of the dropped char
  // ── unknown: no footer read yet (still booting / no cycle hint, no label) ──
  ["", "unknown"],
  ["✳ Claude Code v2.1.163  Opus 4.8 (1M context) · Claude Max  Initializing…", "unknown"],
  // ── last-occurrence rule: footer repainted acceptEdits→plan during a cycle → current = plan (last) ──
  ["⏵⏵accepteditson(shift+tabtocycle) ... later repaint ... ⏸planmodeon(shift+tabtocycle)", "plan"],
  // ── ANSI-laden real CSI around the label still classifies after the collapse ──
  ["[2m[38;5;244m⏵⏵ accept edits on [0m(shift+tab to cycle)", "acceptEdits"],
];

for (const [input, expected] of CASES) {
  const { mode } = detectPermissionMode(input);
  check(`mode=${expected.padEnd(18)} ← ${JSON.stringify(input.length > 56 ? input.slice(0, 56) + "…" : input)}`, mode === expected);
}

// matchedToken is the collapsed label for labeled modes, null for default/unknown.
check("matchedToken is the label for a labeled mode", detectPermissionMode("⏵⏵accepteditson(shift+tabtocycle)").matchedToken === "accepteditson");
check("matchedToken is null for default", detectPermissionMode("x (shift+tab to cycle)").matchedToken === null);
check("matchedToken is null for unknown", detectPermissionMode("").matchedToken === null);
// ── REAL raw bytes (claude 2.1.322, card 13ab48c5): the three footer repaints of a real acceptEdits→plan→auto→default climb ──
const { detectPermissionModeSince } = await import("../dist/pty/host.js");
const real = JSON.parse(fs.readFileSync(new URL("./fixtures/13ab48c5-real-default-footer-claude-2.1.322.json", import.meta.url), "utf8")).repaints;
for (const mode of ["plan", "auto", "default"]) {
  check(`real ${mode} repaint → detectPermissionMode = ${mode}`, detectPermissionMode(real[mode]).mode === mode);
  check(`real ${mode} repaint → detectPermissionModeSince = ${mode}`, detectPermissionModeSince(real[mode]).mode === mode);
}
// The real default footer is LABELED and carries no cycle hint — the old unlabeled-hint shape was wrong.
check("real default repaint has no '(shift+tab to cycle)' hint", !/shift\+tab/.test(real.default));
// Post-press window semantics: a default press after an auto footer reads default (last wins); a dropped press still reads auto.
check("auto repaint then default repaint → default (post-press window)", detectPermissionModeSince(real.auto + real.default).mode === "default");
check("default repaint then auto repaint → auto", detectPermissionModeSince(real.default + real.auto).mode === "auto");
// Fail toward unknown: a truncated default label is never read as default.
check("truncated real default label → unknown", detectPermissionModeSince(real.default.replace("manual mode on", "manual mo")).mode === "unknown");
// never throws on odd input
check("does not throw on non-footer garbage", (() => { try { detectPermissionMode("\x00[junk￿"); return true; } catch { return false; } })());

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — footer→mode parser classifies the real claude 2.1.163 footer strings (acceptEdits/plan/auto/bypass/default/unknown), honours last-occurrence, and never throws."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

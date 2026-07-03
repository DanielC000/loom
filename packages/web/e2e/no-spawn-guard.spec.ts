// Regression guard for the hermetic fixture's no-spawn assertion (fixtures/daemon.ts). The whole e2e
// harness depends on `assertNoRealClaudeSpawn` catching a REAL (metered) claude spawn in the daemon log —
// but the first pattern was NARROWED from a bare `/[pty] spawn/` to `/[pty] spawn\b/` so that a benign
// LOCAL host shell (`[pty] spawnShell …`, exercised as a live ShellTile in sessions-terminals.spec.ts) no
// longer trips it. This spec pins BOTH sides of that narrowing so a future edit can't silently widen the
// guard (re-flagging shells) OR loosen it (letting a real claude slip through) without turning red.
//
// Pure-logic only: it imports the guard + patterns directly and feeds them SYNTHETIC log lines (the exact
// shapes pty/host.ts emits) — so it uses @playwright/test's base `test`, NOT the daemon fixture, and boots
// no daemon.
import { expect, test } from "@playwright/test";
import { FORBIDDEN_LOG_PATTERNS, assertNoRealClaudeSpawn } from "./fixtures/daemon";

// The exact log shapes the daemon emits (pty/host.ts):
//   claude  → `[pty] spawn ${sessionId} bin=… cwd=… resume=… args=…`
//   shell   → `[pty] spawnShell ${id} bin=… cwd=…`
//   boot    → `[boot] first-run: auto-launched …`
const CLAUDE_SPAWN_LINE =
  '[pty] spawn 1f0e-9a2b bin=/usr/local/bin/claude cwd=/repo resume=none args=["--permission-mode","acceptEdits"]';
const SHELL_SPAWN_LINE = "[pty] spawnShell 7c3d-4e10 bin=/bin/bash cwd=/repo";
const FIRST_RUN_LINE = "[boot] first-run: auto-launched the Setup Assistant";

test.describe("no-spawn guard (fixture) — narrowed [pty] spawn pattern", () => {
  test("a real claude spawn line is STILL caught by the narrowed pattern", () => {
    // The load-bearing half: narrowing must not let a metered claude spawn slip through.
    expect(FORBIDDEN_LOG_PATTERNS.some((p) => p.test(CLAUDE_SPAWN_LINE))).toBe(true);
    expect(() => assertNoRealClaudeSpawn(CLAUDE_SPAWN_LINE, "unit")).toThrow(/forbidden pattern/);
    // The word boundary is what does it: `spawn ` (space) matches, so the claude line is caught by the
    // FIRST pattern specifically (not merely by some other pattern coincidentally).
    expect(/\[pty\] spawn\b/.test(CLAUDE_SPAWN_LINE)).toBe(true);
  });

  test("a benign local shell spawn line is NOT caught (the whole point of the narrowing)", () => {
    expect(FORBIDDEN_LOG_PATTERNS.some((p) => p.test(SHELL_SPAWN_LINE))).toBe(false);
    expect(() => assertNoRealClaudeSpawn(SHELL_SPAWN_LINE, "unit")).not.toThrow();
    // A bare `/[pty] spawn/` (the OLD pattern) WOULD have matched `spawnShell` — proving the narrowing is
    // what fixed the over-match, so a regression back to it would re-break this case.
    expect(/\[pty\] spawn/.test(SHELL_SPAWN_LINE)).toBe(true);
    expect(/\[pty\] spawn\b/.test(SHELL_SPAWN_LINE)).toBe(false);
  });

  test("the first-run auto-launch line is still caught (guard otherwise intact)", () => {
    expect(FORBIDDEN_LOG_PATTERNS.some((p) => p.test(FIRST_RUN_LINE))).toBe(true);
    expect(() => assertNoRealClaudeSpawn(FIRST_RUN_LINE, "unit")).toThrow(/forbidden pattern/);
  });

  test("a mixed log with both a shell AND a claude spawn is caught (claude wins)", () => {
    const mixed = `${SHELL_SPAWN_LINE}\nsome other line\n${CLAUDE_SPAWN_LINE}\n`;
    expect(() => assertNoRealClaudeSpawn(mixed, "unit")).toThrow(/forbidden pattern/);
  });
});

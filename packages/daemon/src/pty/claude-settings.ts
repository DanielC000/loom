import fs from "node:fs";
import path from "node:path";
import type { PermissionPolicy } from "@loom/shared";
import { SETTINGS_DIR, RELAY_SCRIPT, VAULT_LINT_SCRIPT, PORT } from "../paths.js";

/**
 * Loom NEVER wants Claude Code's "resume from summary / as-is" gate (isResumeSummaryGate in host.ts) to
 * render at all — the DEFAULT option silently compacts a resumed session's full context, which is
 * exactly what happened to three managers simultaneously in the 2026-07-10 incident when the pty-side
 * Down/Enter guard raced and lost. The gate (`Ifa`/`U1p` in the shipped CLI, confirmed against 2.1.206 by
 * inspecting the bundled binary) only renders when BOTH the session's age exceeds
 * `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) AND its estimated tokens exceed
 * `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100_000) — both read via `process.env` at the moment the
 * gate would show. Overriding either to a value no real session will ever reach suppresses it
 * unconditionally; both are overridden for defense-in-depth. This is settings.json's documented `env`
 * key (confirmed in the same binary: `env:v.record(v.string())`, merged into `process.env` at CLI
 * startup — the exact mechanism Claude Code itself uses to apply per-session env), so it rides the
 * SAME per-session `--settings` file this function already writes — no new spawn plumbing. The pty-side
 * `resolveResumeGate` verify-retry (host.ts) stays as a belt-and-suspenders fallback in case a future
 * CLI version changes this threshold logic.
 */
const RESUME_GATE_ENV_OVERRIDE: Record<string, string> = {
  // ~100 years — no real session is ever that old; suppresses the gate via the age check alone.
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: String(60 * 24 * 365 * 100),
  // Comfortably above any real context window; suppresses the gate via the token check too.
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
};

/**
 * BEST-EFFORT suppression of Claude Code's "auto mode" first-run entry-warning dialog (card 9c03f5a6) —
 * a SEPARATE interactive gate from the `--dangerously-skip-permissions`/bypassPermissions acceptance
 * dialog this file already avoids (see `writeSessionSettings`'s own doc comment: acceptEdits + allowlist
 * over `--dangerously-skip-permissions` specifically to dodge THAT gate). Loom's workers already boot
 * gate-free at `acceptEdits` and feedback-cycle to `auto` post-boot (host.ts's `cycleToMode`); this key
 * closes the residual risk that auto mode's OWN one-time consent dialog could fire the first time a
 * machine/profile ever reaches auto, which would be exactly the kind of unattended boot hang this whole
 * card exists to eliminate — now that the widened auto-heal (host.ts's `logLandedMode`) reliably drives
 * every Loom-driven role all the way to auto, this residual risk is reachable more often than before.
 *
 * UNVERIFIED / reverse-engineered (found by inspecting the installed CLI binary's own gating logic:
 * `skipAutoPermissionPrompt===true` on ANY of a few named settings scopes suppresses the dialog) — the
 * exact settings-SCOPE our per-session `--settings <file>` maps to was NOT confirmed live (no real-CLI
 * harness to probe it against in the environment this was written in). Purely ADDITIVE and safe even if
 * the guess is wrong: an unrecognized settings key is simply ignored by both an older CLI and (if the
 * scope mapping turns out wrong) this CLI too — worst case is a no-op, never a regression. Does NOT touch
 * the spawn argv or the `--permission-mode acceptEdits` boot flag — settings-file key only. Treat as a
 * belt on top of the proven acceptEdits-then-cycle recipe, not a replacement for it.
 */
const AUTO_MODE_ENTRY_WARNING_OVERRIDE = { skipAutoPermissionPrompt: true } as const;

/**
 * Write the per-session --settings file: the hooks that relay back to the daemon, plus the
 * resolved permission policy. SessionStart captures the engine id; UserPromptSubmit/Stop/
 * StopFailure drive the busy state machine (rising/falling edges). acceptEdits + allowlist
 * avoids the "Bypass Permissions mode" acceptance gate that --dangerously-skip-permissions
 * triggers. (All behaviors validated in the spike.)
 *
 * When `vaultPath` is given (docLint on), a PostToolUse hook (matcher Write|Edit) runs the
 * mechanical vault-lint on .md writes under that vault (Pillar D). Advisory only — it never blocks.
 */
export function writeSessionSettings(
  sessionId: string,
  permission: PermissionPolicy,
  vaultPath?: string,
): string {
  const hookCmd = {
    hooks: [{ type: "command", command: `node "${RELAY_SCRIPT}" ${sessionId} ${PORT}` }],
  };
  const hooks: Record<string, unknown> = {
    SessionStart: [hookCmd],
    UserPromptSubmit: [hookCmd],
    Stop: [hookCmd],
    StopFailure: [hookCmd],
  };
  const postToolUse: unknown[] = [];
  if (vaultPath) {
    postToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: `node "${VAULT_LINT_SCRIPT}" "${vaultPath}"` }],
    });
  }
  if (postToolUse.length) hooks.PostToolUse = postToolUse;
  const settings = {
    hooks,
    permissions: {
      defaultMode: permission.mode,
      allow: permission.allow,
      deny: permission.deny,
    },
    includeCoAuthoredBy: false,
    env: RESUME_GATE_ENV_OVERRIDE,
    ...AUTO_MODE_ENTRY_WARNING_OVERRIDE,
  };
  const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Write the per-session `--mcp-config` FILE (agent-tooling P4 credential-tie hardening). Used ONLY when
 * the assembled mcpServers map carries a capability secret (see `mcpConfigHasSecret` in host.ts) —
 * diverting to a 0600 file keeps the secret off the `claude` process's OWN argv, which is otherwise
 * world-readable (`/proc/PID/cmdline`, `ps`, Windows WMI CommandLine). Every secret-FREE spawn (every
 * session today, incl. the whole self-hosting orchestration fleet) keeps the DEFAULT inline
 * `--mcp-config <json>` form byte-identical — this file is written ONLY on that one, rare, secret-bearing
 * path (see buildSpawnArgs' `mcpConfigPath` branch). Same per-session lifecycle + atomic tmp+rename as
 * writeSessionSettings above — rewritten on every respawn since createPty rebuilds the map fresh each time.
 * 0600 at create (`{mode}`) + a best-effort chmodSync belt-and-suspenders (mirrors keys/envelope.ts;
 * a no-op on win32, where POSIX modes don't apply — NTFS ACLs are out of scope for this fix).
 */
export function writeSessionMcpConfig(sessionId: string, mcpServers: Record<string, unknown>): string {
  const file = path.join(SETTINGS_DIR, `${sessionId}.mcp-config.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on win32 */ }
  return file;
}

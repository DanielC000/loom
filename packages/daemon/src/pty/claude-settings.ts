import fs from "node:fs";
import path from "node:path";
import type { PermissionPolicy } from "@loom/shared";
import { SETTINGS_DIR, RELAY_SCRIPT, VAULT_LINT_SCRIPT, DEJA_CAPTURE_SCRIPT, PORT, isLoomDev } from "../paths.js";

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
 * Write the per-session --settings file: the hooks that relay back to the daemon, plus the
 * resolved permission policy. SessionStart captures the engine id; UserPromptSubmit/Stop/
 * StopFailure drive the busy state machine (rising/falling edges). acceptEdits + allowlist
 * avoids the "Bypass Permissions mode" acceptance gate that --dangerously-skip-permissions
 * triggers. (All behaviors validated in the spike.)
 *
 * When `vaultPath` is given (docLint on), a PostToolUse hook (matcher Write|Edit) runs the
 * mechanical vault-lint on .md writes under that vault (Pillar D). Advisory only — it never blocks.
 *
 * When `dejaCapture` is on AND this is a `LOOM_DEV` build (card b3bd4841), a SECOND PostToolUse(Write|Edit)
 * hook group runs the deja-capture.mjs relay, which auto-ingests an agent-written .html mockup into Deja
 * with the driving prompt as `origin_prompt` — resolved DAEMON-SIDE by the relay itself (sessionId + port,
 * mirroring the hook-relay.mjs invocation shape). Opt-in, advisory-only, never blocks. Deja is a PRIVATE
 * product, so the hook stays a no-op on a non-dev build even when `dejaCapture:true` is stored on a project
 * (same gate as the "deja-corpus" MCP grant in pty/host.ts).
 */
export function writeSessionSettings(
  sessionId: string,
  permission: PermissionPolicy,
  vaultPath?: string,
  dejaCapture?: boolean,
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
  if (dejaCapture && isLoomDev()) {
    postToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: `node "${DEJA_CAPTURE_SCRIPT}" ${sessionId} ${PORT}` }],
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

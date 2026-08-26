import fs from "node:fs";
import path from "node:path";
import type { PermissionPolicy } from "@loom/shared";
import { SETTINGS_DIR, RELAY_SCRIPT, VAULT_LINT_SCRIPT, PORT } from "../paths.js";

/**
 * Card cd0c7fee: matcher for the correlation-only `PreToolUse` hook below. Deliberately scoped to the
 * exact `mcp__<server>__<tool>` names of the two tools `tool-attribution.ts`'s `WATCHED_TOOL_NAMES`
 * tracks (`worker_report`, `memory_write`) — mirrors the existing vault-lint `PostToolUse` matcher's own
 * narrow-scoping precedent (Write|Edit, not every tool) rather than firing this hook on every tool call
 * in every turn.
 *
 * ⚠️ NOT hand-sync-only any more (round-2 review): if this ever drifts from `WATCHED_TOOL_NAMES` — e.g. a
 * tool gets added to one and not the other — the failure is SILENT and fails toward the reassuring side:
 * the un-matched tool's PreToolUse hook simply never fires, `consume()` reads "unknown" for it forever,
 * and nothing breaks or logs. `test/tool-attribution.mjs` has a mechanical assertion (not just this
 * comment) that derives this matcher's alternatives, strips the `mcp__<server>__` prefix from each, and
 * asserts the resulting set equals `WATCHED_TOOL_NAMES` exactly — run it after editing either side.
 * Exported for exactly that test to import; still no PRODUCTION-code coupling between the two files (the
 * daemon itself never cross-references them at runtime — only the test does).
 */
export const PRE_TOOL_USE_ATTRIBUTION_MATCHER = "mcp__loom-orchestration__worker_report|mcp__loom-tasks__memory_write";

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
 * dialog this file already avoids (see `writeSessionSettings`'s own doc comment: a gate-free boot +
 * allowlist over `--dangerously-skip-permissions` specifically to dodge THAT gate). This key closes the
 * residual risk that auto mode's OWN one-time consent dialog could fire the first time a machine/profile
 * ever reaches auto, which would be exactly the kind of unattended boot hang this whole card exists to
 * eliminate — now that the widened auto-heal (host.ts's `logLandedMode`) reliably drives every
 * Loom-driven role all the way to auto, this residual risk is reachable more often than before.
 *
 * Card 51926260: WHEN a session reaches auto has changed — `computeBootMode` (host.ts) now boots most
 * Loom-driven roles (the platform/worker default) DIRECTLY at `--permission-mode auto`, rather than
 * booting gate-free at `acceptEdits` and feedback-cycling to `auto` POST-boot (host.ts's `cycleToMode`,
 * still the fallback for a target that isn't directly expressible). This key is written to the settings
 * file BEFORE either kind of boot, so it's positioned to matter either way — but whether the underlying
 * CLI's entry-warning dialog is gated on a runtime TRANSITION into auto (the case this key was
 * originally reasoned about) versus firing identically for a COLD boot already sitting in auto has not
 * been separately re-verified against the new direct-boot shape; that live-probe gap is tracked
 * separately, not resolved here.
 *
 * UNVERIFIED / reverse-engineered (found by inspecting the installed CLI binary's own gating logic:
 * `skipAutoPermissionPrompt===true` on ANY of a few named settings scopes suppresses the dialog) — the
 * exact settings-SCOPE our per-session `--settings <file>` maps to was NOT confirmed live (no real-CLI
 * harness to probe it against in the environment this was written in). Purely ADDITIVE and safe even if
 * the guess is wrong: an unrecognized settings key is simply ignored by both an older CLI and (if the
 * scope mapping turns out wrong) this CLI too — worst case is a no-op, never a regression. Does NOT touch
 * the spawn argv or whichever `--permission-mode` value this session actually boots with (see
 * `computeBootMode`) — settings-file key only. Treat as a belt on top of the proven gate-free boot
 * (direct-at-target or acceptEdits-then-cycle) recipe, not a replacement for it.
 */
const AUTO_MODE_ENTRY_WARNING_OVERRIDE = { skipAutoPermissionPrompt: true } as const;

/**
 * Card ea2fbcca — the CLASS fix for the cd0c7fee/8d158088 double-wrap incident (that ONE-LINE instance
 * fix is already on main; see `PreToolUse` below, which is correctly shaped). Loom generates a settings
 * file the `claude` CLI must accept, and nothing checked that it does — the only detector was the CLI's
 * OWN runtime rejection, which raises a BLOCKING INTERACTIVE DIALOG inside an unattended session nobody
 * is watching, presenting as a spawn hanging forever with an empty transcript and `SessionStart` never
 * firing (indistinguishable from a PTY/spawn fault).
 *
 * ⛔ Deliberately NOT a shell-out to `claude doctor`: measured, in a controlled probe (card ea2fbcca,
 * 3 CLI versions × 2 arms, 2026-08-25), to REPORT an invalid settings file and still EXIT 0 in all six
 * arms. An rc-based check
 * would pass every malformed file forever — silently, confidently, indistinguishable from a genuinely
 * clean one. This instead asserts the OBJECT SHAPE directly, in-process: every hook-event key must map
 * to an array of "matcher groups", `{matcher?: string, hooks: [{type: "command", command: string}, ...]}`
 * — the exact invariant the 2026-08-25 incident violated (a well-formed JSON document with the wrong
 * NESTING DEPTH; a bare "is it JSON" check would have passed it clean).
 *
 * Returns a list of violations (empty ⇒ valid). ONE definition, shared by production
 * (`assertValidHooksShape`/`writeSessionSettings` below) and its regression test
 * (`test/settings-hooks-shape.mjs`, which imports this from `dist/`) — a hand-duplicated second copy is
 * exactly the drift risk `PRE_TOOL_USE_ATTRIBUTION_MATCHER`'s own doc comment above warns about.
 *
 * 📌 MOVING TARGET (card DoD item 6): this models the ONE nesting-depth invariant the 2026-08-25 incident
 * actually violated, reverse-engineered from the CLI's own observed rejection message — not the CLI's
 * full settings schema, which is undocumented and can tighten on any auto-update (the CLI auto-updates on
 * a schedule nobody controls — see the card's own timeline). It WILL miss a future CLI-side tightening
 * this shape doesn't cover (e.g. a new required field, a stricter `matcher` type): that is a known,
 * accepted gap, not an oversight — hand-mirroring the CLI's full upstream schema would chase a target
 * this daemon doesn't own and would itself drift silently. When the CLI changes what it accepts in a way
 * this check doesn't model, the failure mode reverts to today's (a blocking dialog nobody sees) until
 * this validator is deliberately widened against the NEW rejection message — the same way this one was
 * built from the 2026-08-25 incident's exact error string (`hooks.PreToolUse.0.hooks.0.type: Invalid
 * input`).
 */
export function hooksShapeViolations(hooksObj: unknown): string[] {
  const errors: string[] = [];
  if (typeof hooksObj !== "object" || hooksObj === null) return ["settings.hooks is not an object"];
  for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) { errors.push(`${event}: not an array of groups (got ${typeof groups})`); continue; }
    groups.forEach((group, gi) => {
      if (typeof group !== "object" || group === null) {
        errors.push(`${event}[${gi}]: group is not an object`);
        return;
      }
      const g = group as Record<string, unknown>;
      if ("matcher" in g && typeof g.matcher !== "string") {
        errors.push(`${event}[${gi}]: matcher present but not a string`);
      }
      if (!Array.isArray(g.hooks)) {
        errors.push(`${event}[${gi}]: group.hooks is not an array (got ${JSON.stringify(g.hooks)})`);
        return;
      }
      g.hooks.forEach((h: unknown, hi: number) => {
        const shapeOk = typeof h === "object" && h !== null
          && (h as Record<string, unknown>).type === "command"
          && typeof (h as Record<string, unknown>).command === "string";
        if (!shapeOk) {
          errors.push(`${event}[${gi}].hooks[${hi}]: not { type: "command", command: <string> } (got ${JSON.stringify(h)})`);
        }
      });
    });
  }
  return errors;
}

/**
 * Enforce `hooksShapeViolations` — logs distinctively (`[pty][settings-invalid]`, so this never reads as
 * generic PTY/spawn noise — DoD item 4) and throws (DoD item 5) when the shape is invalid. Called TWICE by
 * `writeSessionSettings` below: once on the in-memory object BEFORE it reaches disk (DoD item 1), and once
 * on a READ-BACK of what actually landed on disk (DoD item 4's "read-back check") — the second catches
 * anything that could go wrong between construction and disk (a stray JSON.stringify replacer added
 * later, a corrupted write) that the first can't see, and validates the exact bytes the CLI will read.
 *
 * ⚠️ FAIL POSTURE, decided deliberately (DoD item 5): REFUSE (throw) rather than write/hand back a bad
 * file. Today's only detector for this defect class is the CLI's own blocking dialog — the process never
 * crashes, `SessionStart` never fires, and the transcript stays empty forever, indistinguishable from a
 * hung PTY/spawn fault until a human happens to attach and see the dialog. Throwing HERE instead converts
 * that SILENT hang into an immediate, loud, SYNCHRONOUS failure — and this throw shape already has a
 * graceful landing spot: `writeSessionSettings` is called from `PtyHost.createPty`, which is called from
 * `PtyHost.spawn()`, which `SessionsService.spawnWorker` wraps in a try/catch that reconciles a
 * synchronous `createPty` throw to `processState:'exited'` + a logged `lastError` (see that catch's own
 * doc in sessions/service.ts — the SAME reconciliation an OS-level process-creation failure already gets).
 * So refusing here doesn't introduce a new failure mode; it converts an INVISIBLE one (a hang with nothing
 * to grep) into the SAME visible one every other hard spawn failure already produces. The alternative —
 * writing the bad file anyway and letting the CLI's own dialog eventually catch it — is strictly worse:
 * it's the exact failure this card exists to eliminate. (Not every spawn call site has that same catch —
 * an uncaught throw elsewhere still surfaces as a loud MCP/REST error rather than a silent daemon crash,
 * since Node's async/request error boundaries catch it; still preferable to a silent hang either way.)
 */
export function assertValidHooksShape(hooksObj: unknown, context: string): void {
  const violations = hooksShapeViolations(hooksObj);
  if (violations.length) {
    console.error(`[pty][settings-invalid] ${context} — refusing: settings.hooks failed shape validation:\n  ${violations.join("\n  ")}`);
    throw new Error(`${context}: generated settings.hooks is invalid — refusing to hand a spawn a file the CLI would silently reject (see daemon log): ${violations.join("; ")}`);
  }
}

/**
 * Write the per-session --settings file: the hooks that relay back to the daemon, plus the
 * resolved permission policy. SessionStart captures the engine id; UserPromptSubmit/Stop/
 * StopFailure drive the busy state machine (rising/falling edges). A gate-free `mode` (see
 * `computeBootMode`, host.ts, for which one) + allowlist avoids the "Bypass Permissions mode"
 * acceptance gate that --dangerously-skip-permissions triggers. (All behaviors validated in the spike.)
 *
 * PreToolUse (card cd0c7fee) is ALWAYS wired too, matcher-scoped to `worker_report`/`memory_write`
 * only (see `PRE_TOOL_USE_ATTRIBUTION_MATCHER`) — feeds PtyHost's sub-agent-call correlation queue.
 * Advisory/observational only, same as the vault-lint PostToolUse below — it never blocks or denies.
 *
 * SubagentStart/SubagentStop (card 8d158088, cross-check redesigned by card e6ef5062) are ALSO ALWAYS
 * wired, with NO matcher (their matcher field filters by `agent_type`; the drift cross-check wants every
 * subagent, regardless of type) — together they give PtyHost a per-session LIVE sub-agent count, which is
 * what makes the drift tell actually discriminate (see SubagentDriftTracker's own doc in
 * tool-attribution.ts for the mechanism). Advisory/observational only, same posture as PreToolUse above:
 * neither blocks a subagent from starting or stopping.
 *
 * When `vaultPath` is given (docLint on), a PostToolUse hook (matcher Write|Edit) runs the
 * mechanical vault-lint on .md writes under that vault (Pillar D). Advisory only — it never blocks.
 *
 * `hookToken` (card a2407ed4) rides as a 4th argv on the relay command, alongside the sessionId/port
 * already there — `hook-relay.mjs` forwards it in the POST body, and `/internal/hook` requires it to
 * match the target session's own `Live.hookToken` before a hook is processed. It is REQUIRED (not
 * optional) so a caller can never accidentally omit it and silently reopen the zero-token gap; see
 * `PtyHost.verifyHookToken`'s doc for exactly what this does and does not close. Placed BEFORE the
 * optional `vaultPath` — TypeScript disallows a required param after an optional one.
 */
export function writeSessionSettings(
  sessionId: string,
  // Card 51926260: `mode` is `string`, not the narrower `PermissionPolicy["mode"]` — the caller may pass
  // the session's DIRECTLY-computed boot target (e.g. "auto", not one of PermissionPolicy.mode's 4
  // literals) here, and this must stay byte-consistent with whatever `--permission-mode` value the same
  // call's `buildSpawnArgs` receives (see host.ts's createPty, computeBootMode). This function only ever
  // reads `.mode`/`.allow`/`.deny` off it (see `defaultMode`/`allow`/`deny` below), so narrowing to
  // exactly those three fields — rather than requiring the full `PermissionPolicy` — costs nothing.
  permission: { mode: string; allow: PermissionPolicy["allow"]; deny: PermissionPolicy["deny"] },
  hookToken: string,
  vaultPath?: string,
): string {
  const hookCmd = {
    hooks: [{ type: "command", command: `node "${RELAY_SCRIPT}" ${sessionId} ${PORT} ${hookToken}` }],
  };
  const hooks: Record<string, unknown> = {
    SessionStart: [hookCmd],
    UserPromptSubmit: [hookCmd],
    Stop: [hookCmd],
    StopFailure: [hookCmd],
    // Card cd0c7fee: correlation-only, narrowly matcher-scoped (see PRE_TOOL_USE_ATTRIBUTION_MATCHER's
    // own doc) — reuses the SAME generic relay command as every other hook here (hook-relay.mjs forwards
    // whatever JSON Claude Code hands it, unfiltered; no new relay script needed). This hook does NOT
    // block/deny anything — it only lets PtyHost's ToolAttributionTracker observe `agent_id`/`agent_type`
    // (present only for a subagent's own call) before the matched tool's own MCP request arrives.
    PreToolUse: [{ matcher: PRE_TOOL_USE_ATTRIBUTION_MATCHER, hooks: hookCmd.hooks }],
    // Card e6ef5062: no matcher on either — every subagent start/stop, regardless of agent_type, feeds the
    // live-count drift cross-check (SubagentDriftTracker).
    SubagentStart: [hookCmd],
    SubagentStop: [hookCmd],
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
  // Card ea2fbcca DoD item 1: validate BEFORE this reaches disk. See assertValidHooksShape's own doc for
  // the shape asserted and the deliberate fail-loud-and-refuse posture.
  assertValidHooksShape(hooks, `writeSessionSettings(${sessionId}) pre-write`);
  const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
  const tmp = `${file}.tmp`;
  // 0600 at create, mirroring writeSessionMcpConfig's own discipline now that this file carries a
  // credential (the hook token, baked into the relay command above) — best-effort on win32 (a no-op;
  // NTFS ACLs are out of scope), so this buys something against a different-user co-resident on POSIX
  // and nothing on this daemon's own self-hosting Windows box. Not mitigation for the stated ceiling
  // (same-OS-user co-residency can already read this file regardless) — land it anyway, for parity.
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on win32 */ }
  // Card ea2fbcca DoD item 4: read back what's actually ON DISK — the exact bytes the CLI will read —
  // not just re-trust the in-memory object validated above. See assertValidHooksShape's own doc.
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: unknown };
  assertValidHooksShape(onDisk.hooks, `writeSessionSettings(${sessionId}) read-back from ${file}`);
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

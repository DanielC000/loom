import fs from "node:fs";
import path from "node:path";
import type { PermissionPolicy } from "@loom/shared";
import { SETTINGS_DIR, RELAY_SCRIPT, VAULT_LINT_SCRIPT, DECISION_RECORDS_SCRIPT, DECISION_RECORDS_DEDUPE_DIR, COMMENT_ANCHOR_LINT_SCRIPT, PORT } from "../paths.js";

/** @decision cd0c7fee — narrow-scoped to `worker_report`/`memory_write` (`WATCHED_TOOL_NAMES`); a
 *  drift between the two fails SILENTLY (the un-matched tool's hook just never fires) —
 *  `test/tool-attribution.mjs` asserts they stay in sync, run it after editing either side. */
export const PRE_TOOL_USE_ATTRIBUTION_MATCHER = "mcp__loom-orchestration__worker_report|mcp__loom-tasks__memory_write";

/** @decision sha:29b22e7e — both resume-gate env thresholds are overridden so Claude Code's "resume
 *  from summary" gate (whose DEFAULT option force-compacted three managers at once, 2026-07-10) never
 *  renders; keep the pty-side `resolveResumeGate` verify-retry (host.ts) as a fallback, don't rely on
 *  this alone — see docs/decisions/29b22e7e-resume-gate-confirms-down-before-risking-enter.md */
const RESUME_GATE_ENV_OVERRIDE: Record<string, string> = {
  // ~100 years — no real session is ever that old; suppresses the gate via the age check alone.
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: String(60 * 24 * 365 * 100),
  // Comfortably above any real context window; suppresses the gate via the token check too.
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
};

/** @decision 9c03f5a6 — BEST-EFFORT, reverse-engineered suppression of Claude Code's auto-mode
 *  first-run entry-warning dialog (`skipAutoPermissionPrompt`); the settings-scope mapping was never
 *  confirmed against a real CLI. Purely additive — a wrong guess is a no-op, never a regression. Treat
 *  as a belt on the proven gate-free boot recipe, not a replacement for it — see
 *  docs/decisions/9c03f5a6-auto-mode-entry-warning-suppressed-via-reverse-engineered-flag.md */
const AUTO_MODE_ENTRY_WARNING_OVERRIDE = { skipAutoPermissionPrompt: true } as const;

/** @decision ea2fbcca — validates settings.hooks OBJECT SHAPE in-process rather than shelling out to
 *  `claude doctor` (measured to REPORT an invalid file and still EXIT 0, 3 CLI versions × 2 arms,
 *  2026-08-25). Models only the ONE nesting-depth invariant the 2026-08-25 double-wrap incident
 *  violated — a known, accepted gap against the CLI's undocumented, auto-updating full schema, not an
 *  oversight. Returns a list of violations (empty ⇒ valid); ONE definition shared with
 *  `test/settings-hooks-shape.mjs`. See
 *  docs/decisions/ea2fbcca-settings-hooks-shape-validated-fail-closed.md */
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

/** @decision ea2fbcca — REFUSE (throw), never write/hand back a bad settings file: the only other
 *  detector is the CLI's own BLOCKING dialog inside an unattended session, indistinguishable from a
 *  hung PTY/spawn fault until a human happens to attach. `SessionsService.spawnWorker`'s existing
 *  try/catch around `createPty` already reconciles this throw the same way an OS-level spawn failure
 *  is reconciled. Called TWICE: pre-write on the in-memory object, and on a read-back of what actually
 *  landed on disk. See docs/decisions/ea2fbcca-settings-hooks-shape-validated-fail-closed.md */
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
 * When `vaultPath` is given, a PostToolUse hook (matcher Write|Edit) runs the mechanical vault-lint on
 * .md writes under that vault (Pillar D). `vaultPath` genuinely needs a real vault to lint, so this stays
 * gated on the path itself rather than on the `docLint` flag below — a project with docLint on but no
 * vault configured correctly never gets this hook (nothing to lint). Advisory only — it never blocks.
 *
 * Card 67621894: a SEPARATE PostToolUse Write|Edit hook runs `comment-anchor-lint.mjs` in its per-file
 * `--hook` mode (never a repo-wide scan — see that script's own doc for the whole-repo cost this
 * deliberately avoids), scoped to just the ONE file a Write/Edit just touched — gated on the explicit
 * `docLint` param (see {@link SpawnOpts.docLint} in host.ts) AND `repoPath` (a caller that omits
 * `repoPath` entirely never gets this hook wired). @decision d92ec82b — do not re-couple this gate to
 * `vaultPath` truthiness, a proxy that silently skipped a docLint-on/no-vault project even though this
 * hook targets source, not vault content — see
 * docs/decisions/d92ec82b-comment-anchor-lint-gated-on-explicit-doclint.md. Advisory only — never blocks.
 *
 * A PostToolUse hook (matcher Read) runs `decision-records.mjs`, which appends any complete,
 * out-of-band decision record anchored in the range a `Read` call actually returned, so a range that
 * slices through a long comment block never delivers a fragment of a record without the rest of it.
 * Advisory only, same posture as vault-lint above — it never blocks a `Read`.
 *
 * Card 5244adc2 (the remaining half of `661b7d46` DoD-2's "no injection, no overhead"): this hook group
 * is wired ONLY when `repoPath` resolves to a project that has adopted at least one of the three record
 * stores (see `anyDecisionRecordStoreExists` below, which mirrors `decision-records.mjs`'s own runtime
 * `anyStoreExists` bail — keep both in sync). `repoPath` OMITTED falls back to the pre-5244adc2 behavior
 * of always wiring the hook, so every existing caller stays byte-identical. @decision 5244adc2 — a
 * session already LIVE when the first store appears will NOT get this hook wired until its own next
 * resume; this is an accepted, documented gap, not a bug — see
 * docs/decisions/5244adc2-decision-records-hook-gated-on-store-existence.md
 *
 * `hookToken` (card a2407ed4) rides as a 4th argv on the relay command, alongside the sessionId/port
 * already there — `hook-relay.mjs` forwards it in the POST body, and `/internal/hook` requires it to
 * match the target session's own `Live.hookToken` before a hook is processed. It is REQUIRED (not
 * optional) so a caller can never accidentally omit it and silently reopen the zero-token gap; see
 * `PtyHost.verifyHookToken`'s doc for exactly what this does and does not close. Placed BEFORE the
 * optional `vaultPath`/`repoPath` — TypeScript disallows a required param after an optional one.
 */
/** @decision 016ee373 — the CLI's ACTUALLY-accepted `--permission-mode` values, probe-verified against
 *  the installed CLI (2.1.246); VERSION-PINNED, re-verify against `claude --help` on a newer CLI. Do
 *  NOT hand-copy this list anywhere else — `writeSessionSettings` below and host.ts's
 *  `DIRECT_BOOT_MODES`/`computeBootMode` both import this type. See
 *  docs/decisions/016ee373-direct-boot-modes-typed-as-compile-time-guard.md */
export type CliPermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";

/**
 * Card 016ee373 — `PermissionPolicy["mode"]` still permits `"default"` (Loom's own config-facing name for
 * the CLI's unlabeled normal mode), but the CLI itself has no `"default"` choice — its own name for that
 * mode is `"manual"` (confirmed via `claude --help`, see {@link CliPermissionMode}'s own doc). Decision
 * recorded here (card 016ee373 DoD-2, option (a)): map at THIS boundary rather than removing `"default"`
 * from `PermissionPolicy["mode"]` — removing it would be a config-contract change, and a live write path
 * already accepts `"default"` today (`packages/daemon/src/mcp/platform.ts`'s `permissionOverride` zod
 * schema), so a stored project config carrying `"default"` cannot be ruled out. Every other
 * `PermissionPolicy["mode"]` value already IS a {@link CliPermissionMode} member and passes through
 * unchanged.
 */
export function toCliPermissionMode(mode: PermissionPolicy["mode"]): CliPermissionMode {
  return mode === "default" ? "manual" : mode;
}

/**
 * Card 5244adc2 — the decision-record store kinds this daemon-side gate checks for under `docs/<kind>`.
 * Deliberately duplicated from `decision-records.mjs`'s own `anyStoreExists` (assets/decision-records.mjs)
 * rather than imported: that script ships as a standalone asset invoked via a bare `node <path>` spawn
 * (see DECISION_RECORDS_SCRIPT), independent of this package's compiled `dist/` — it has no way to import
 * from here, and this daemon-side copy exists purely to decide whether to WIRE the hook at all, not to
 * replace that script's own runtime bail (which stays, see its own doc, as the backstop for a store
 * deleted mid-session — DoD-5 on card 5244adc2). Same shape-drift risk as `PRE_TOOL_USE_ATTRIBUTION_MATCHER`
 * above — and card 0635f545's `test/decision-records.mjs` pins this list against the asset's own literal
 * store-kind checks (parsed out of `anyStoreExists`'s source text, since that asset can't be imported —
 * see the test's own comment) so a divergence fails loudly instead of silently. Exported for exactly that
 * test to import; still no PRODUCTION-code coupling between the two files. Keep in sync with that script's
 * own `FLAT_STORES` + investigations-dir check if either ever changes.
 */
export const DECISION_RECORD_STORE_KINDS: readonly string[] = ["adr", "decisions", "investigations"];

function anyDecisionRecordStoreExists(repoRoot: string): boolean {
  return DECISION_RECORD_STORE_KINDS.some((kind) => fs.existsSync(path.join(repoRoot, "docs", kind)));
}

export function writeSessionSettings(
  sessionId: string,
  // Card 51926260: `mode` is the CLI-accepted `CliPermissionMode`, not the narrower `PermissionPolicy["mode"]`
  // — the caller may pass the session's DIRECTLY-computed boot target (e.g. "auto", not one of
  // PermissionPolicy.mode's literals) here, and this must stay byte-consistent with whatever
  // `--permission-mode` value the same call's `buildSpawnArgs` receives (see host.ts's createPty,
  // computeBootMode). Card 016ee373 narrowed this from a bare `string` to `CliPermissionMode` so an
  // unaccepted value is now a compile-time error, not just a documented invariant — callers normalize a
  // raw `PermissionPolicy["mode"]` through {@link toCliPermissionMode} first. This function only ever reads
  // `.mode`/`.allow`/`.deny` off it (see `defaultMode`/`allow`/`deny` below), so narrowing to exactly those
  // three fields — rather than requiring the full `PermissionPolicy` — costs nothing.
  permission: { mode: CliPermissionMode; allow: PermissionPolicy["allow"]; deny: PermissionPolicy["deny"] },
  hookToken: string,
  vaultPath?: string,
  // Card 5244adc2: the session's own repo root (host.ts's `createPty` passes `opts.cwd` — the session's
  // ACTUAL working directory, e.g. a worker's own worktree — never `opts.repoPath`, which is documented
  // elsewhere as "ALWAYS the project's main checkout, never a worker's own worktree"; the decision-records
  // hook must agree with what `decision-records.mjs` itself checks at runtime, which walks up from the
  // session's own cwd, not the main checkout). OMITTED ⇒ the Read hook is always wired (the pre-5244adc2
  // behavior) — every caller that doesn't thread this (see the test population) stays byte-identical.
  repoPath?: string,
  // Card d92ec82b: the EXPLICIT "docLint is on" signal, threaded through SpawnOpts.docLint (host.ts) from
  // sessions/service.ts's own `config.docLint` — gates the comment-anchor-lint hook below independently of
  // `vaultPath`. OMITTED/false ⇒ that hook is never wired, same as before this param existed; every caller
  // that doesn't thread it (see the test population) stays byte-identical.
  docLint?: boolean,
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
  // Card 5244adc2: wire the decision-records Read hook only when this project could possibly have
  // anything for it to find — `repoPath` omitted (pre-5244adc2 callers) keeps the old always-wired
  // behavior; given, it's wired only when `anyDecisionRecordStoreExists` finds at least one store. A
  // repo with none pays ZERO per-`Read` node-spawn cost, meeting 661b7d46 DoD-2's "no overhead" literally
  // rather than via the script's own in-process bail (that bail stays as the mid-session-deletion backstop).
  if (repoPath === undefined || anyDecisionRecordStoreExists(repoPath)) {
    postToolUse.push({
      matcher: "Read",
      hooks: [{ type: "command", command: `node "${DECISION_RECORDS_SCRIPT}" "${DECISION_RECORDS_DEDUPE_DIR}"` }],
    });
  }
  if (vaultPath) {
    postToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: `node "${VAULT_LINT_SCRIPT}" "${vaultPath}"` }],
    });
  }
  // Card d92ec82b: independent of vaultPath — gated on the explicit `docLint` signal (see this function's
  // own doc comment above for why vaultPath-as-proxy was replaced). Requires `repoPath` too — the lint
  // needs the session's actual repo root, not the vault — so a caller that omits it (pre-5244adc2 shape)
  // never wires this hook; every other caller threads `repoPath` today (see its own param doc below).
  if (docLint && repoPath !== undefined) {
    postToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: `node "${COMMENT_ANCHOR_LINT_SCRIPT}" --hook "${repoPath}"` }],
    });
  }
  hooks.PostToolUse = postToolUse;
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

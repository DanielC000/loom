// Card 961da6c6 — the ONE source for "what a profile/project can ask for that codex cannot honour".
// Consumed by profiles/validate.ts (save-time rejection of an EXPLICIT harness:"codex" profile), by
// sessions/service.ts (skip a DEFAULT-derived codex harness — the default layer never passes validateProfile),
// and by pty/host.ts (the spawn-time `onCodexUnsupportedCapability` report). Pure: no imports except the
// SessionRole type below, no I/O.
// The project-level (non-profile) reason lives with its own spawn-time report in pty/host.ts, not here.

import type { SessionRole } from "@loom/shared";

export interface CodexIncompatibility { id: string; reason: string }

/** The profile/project facts codex compatibility depends on. */
export interface CodexCompatInput {
  restrictedTools?: boolean;
  browserTesting?: boolean;
  documentConversion?: boolean;
  capabilities?: readonly unknown[];
  /**
   * @decision 7955458e — the AUTHORED PROJECT `permission.deny` value (PROJECT-only; no profile/platform
   * layer exists). codex drops any deny rule silently, so this is a codex-incompatibility (skip to
   * claude), never disclosed-and-run.
   */
  permissionDeny?: readonly string[];
}

/**
 * Card 7955458e — the roles that get claude's BLANKET transcript-root read-deny (card ac90ca8e,
 * `pty/host.ts`'s `withTranscriptRootDenyForSpawn` + `claude-transcript.ts`'s
 * `TRANSCRIPT_ROOT_READ_DENY_RULE`): denies `Read(~/.claude/projects/**)`, closing a cross-project/
 * cross-session Claude-transcript read bypass. `worker` is deliberately EXCLUDED — it gets the separate,
 * narrower, already-best-effort `d78f8217` per-other-project pair instead (see `otherProjectTranscriptDenyRules`),
 * never this blanket rule.
 *
 * SINGLE SOURCE OF TRUTH for BOTH consumers — `pty/host.ts` (re-exports this binding under the SAME name
 * for the claude-side deny application) and `profiles/validate.ts` (the codex-side HARD REJECTION below).
 * Do not fork a second copy of this role list in either file — that is exactly the kind of independently-
 * drifting duplicate CLAUDE.md's own "point at a source of truth, never restate" rule exists to prevent.
 */
export const TRANSCRIPT_ROOT_DENY_ROLES: ReadonlySet<SessionRole> = new Set(["assistant", "auditor", "workspace-auditor", "manager", "platform", "setup"]);

/**
 * @decision a4c5f234 — THE one place this shape is computed; `resume()` and `isDurablyResumable` both
 * call it instead of each keeping their own copy, so the two can never classify a row differently. See
 * the full record for why a bare duplicate of this expression was a real bug.
 */
export function isForcedRoleFreshStart(session: { harness?: "claude" | "codex"; role?: SessionRole | null }): boolean {
  return session.harness === "codex" && session.role != null && TRANSCRIPT_ROOT_DENY_ROLES.has(session.role);
}

/**
 * Card 7955458e, owner ruling — the HARD-REJECT reason for an explicit `harness:"codex"` profile whose
 * role is in {@link TRANSCRIPT_ROOT_DENY_ROLES}. `HARNESS_FLEET_ROLES` (`packages/shared/src/config.ts`)
 * already limits a DEFAULT-derived codex harness to `worker`, because codex has no parity for any other
 * role; an EXPLICIT profile can bypass that restriction onto one of these roles, and the blast radius —
 * every other project's and every other session's Claude transcripts become readable, with no codex-side
 * lever to close it (createCodexPty never enforces opts.permission) — is too large to leave to a loud
 * spawn-time warning the way `restrictedTools`/`browserTesting`/`documentConversion` are below. Reject at
 * profile-validation time instead, where the human editing the profile sees it.
 */
export function codexTranscriptRoleUnsupportedReason(role: SessionRole): string {
  return `harness "codex" is not supported for role "${role}" — this role gets claude's blanket cross-project transcript-root read-deny (card ac90ca8e: denies reading every OTHER project's and session's Claude Code transcript files, so this role can never read them), and codex has no equivalent enforcement lever. Running this role on harness "codex" would silently drop that isolation entirely. Use harness "claude" for this role (card 7955458e), or a role not in this set.`;
}

/**
 * Card 7955458e, Code Review CRITICAL fix — the structural SPAWN-TIME backstop `codexTranscriptRoleUnsupportedReason`
 * above cannot be: that reason is validateProfile's forward-looking rejection, keyed off the PROFILE's own
 * `role` field. An explicit-role start (e.g. `startManager`) can hand a profile a DIFFERENT resolved
 * session role than the one it was saved with (a `{role:"worker", harness:"codex"}` profile spawned via
 * `startManager` resolves role:"manager" + harness:"codex"), which `validateProfile` never sees. This past-
 * tense reason is for the forced-to-claude event filed at that spawn-time backstop instead.
 */
export function codexTranscriptRoleForcedClaudeReason(role: SessionRole): string {
  return `resolved harness codex was FORCED to claude for role "${role}" — this role gets claude's blanket cross-project transcript-root read-deny (card ac90ca8e: denies reading every OTHER project's and session's Claude Code transcript files), and codex has no equivalent enforcement lever. Running this role on codex would silently drop that isolation, so the spawn was forced onto harness "claude" instead of refused (card 7955458e).`;
}

/**
 * Card 7955458e, SECOND Code Review MAJOR fix — the FAIL-CLOSED backstop reason, thrown by `PtyHost.spawn`
 * itself when asked to spawn codex for a {@link TRANSCRIPT_ROOT_DENY_ROLES} role. `resolveAgentSpawn`'s
 * force (above) and `resume()`'s graceful redirect are the two known callers that should never reach this
 * — it exists for whatever bypasses both, present or future; see the decision record for why a third,
 * independent check is warranted here rather than trusting the other two alone.
 */
export function codexRoleSpawnRefusedReason(role: SessionRole): string {
  return `refusing to spawn harness "codex" for role "${role}" — this role gets claude's blanket cross-project transcript-root read-deny (card ac90ca8e), and codex has no equivalent enforcement lever. This is the fail-closed PtyHost.spawn backstop (card 7955458e) — every known caller should have already forced this to "claude" before reaching here; if you see this, that force was bypassed somewhere and needs fixing, not this check relaxed.`;
}

/** Thrown by {@link codexRoleSpawnRefusedReason}'s caller (`PtyHost.spawn`) — a clearly-named class so a caught error is unambiguous. */
export class CodexRoleSpawnRefusedError extends Error {
  constructor(role: SessionRole) {
    super(codexRoleSpawnRefusedReason(role));
    this.name = "CodexRoleSpawnRefusedError";
  }
}

/**
 * Card 7955458e — the reason an authored PROJECT `permission.deny` rule set is codex-incompatible. See
 * {@link CodexCompatInput.permissionDeny}'s own doc for the scope (the project config override is the
 * ONLY authored source — a Profile has no `deny` field, and there is no platform permission layer).
 */
export function codexPermissionDenyReason(denyCount: number): string {
  return `this project has ${denyCount} authored permission.deny rule${denyCount === 1 ? "" : "s"} that codex cannot honour — codex never enforces opts.permission (createCodexPty has no filesystem-deny lever compatible with its \`-s workspace-write\` sandbox mode; the lever that exists, codex's own config.toml \`[permissions]\` profile system, is beta and explicitly mutually exclusive with sandbox_mode/-s — see docs/decisions/7955458e), so these rules would be silently dropped. Leave this project's permission.deny empty, or keep this agent's profile on harness "claude".`;
}

/** Card `0770d916`: codex has no per-native-tool disallow lever, so `restrictedTools` would be FAIL-OPEN there. */
export const CODEX_RESTRICTED_TOOLS_REASON = `restrictedTools is not supported on harness "codex" — codex has no per-native-tool disallow mechanism (only coarse sandbox_mode/approval_policy session-wide levers), so this combination cannot be honoured. Leave restrictedTools unset/false for a codex profile, or use harness "claude".`;

/** @decision 7fa73e2c — browserTesting/documentConversion/capabilities all resolve to stdio MCP; codex mounts only http. */
export function codexStdioCapabilityReason(offending: readonly string[]): string {
  return `${offending.join(" and ")} ${offending.length > 1 ? "are" : "is"} not supported on harness "codex" — ${offending.length > 1 ? "these all resolve" : "this resolves"} to a stdio MCP server (Playwright/markitdown/any registry capability), and codex can only mount {type:"http"} servers, so this combination cannot be honoured. Leave ${offending.join(" and ")} unset/false/empty for a codex profile, or use harness "claude".`;
}

/** The stdio-capability field names set in `input` (ordering fixed: browserTesting, documentConversion, capabilities). */
export function codexStdioOffenders(input: CodexCompatInput): string[] {
  return [
    input.browserTesting === true ? "browserTesting" : null,
    input.documentConversion === true ? "documentConversion" : null,
    input.capabilities && input.capabilities.length > 0 ? "capabilities" : null,
  ].filter((f): f is string => f !== null);
}

/**
 * Every reason `input` cannot run on codex, one item per field (empty ⇒ codex-compatible). NOT a fork check:
 * fork is a runtime action on an already-pinned session, never a resolve-time fact (see forkSession).
 */
export function codexIncompatibilities(input: CodexCompatInput): CodexIncompatibility[] {
  const items: CodexIncompatibility[] = [];
  if (input.restrictedTools === true) items.push({ id: "restrictedTools", reason: CODEX_RESTRICTED_TOOLS_REASON });
  for (const field of codexStdioOffenders(input)) items.push({ id: field, reason: codexStdioCapabilityReason([field]) });
  if (input.permissionDeny && input.permissionDeny.length > 0) {
    items.push({ id: "permissionDeny", reason: codexPermissionDenyReason(input.permissionDeny.length) });
  }
  return items;
}

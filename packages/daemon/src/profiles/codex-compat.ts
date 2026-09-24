// Card 961da6c6 — the ONE source for "what a profile/project can ask for that codex cannot honour".
// Consumed by profiles/validate.ts (save-time rejection of an EXPLICIT harness:"codex" profile), by
// sessions/service.ts (skip a DEFAULT-derived codex harness — the default layer never passes validateProfile),
// and by pty/host.ts (the spawn-time `onCodexUnsupportedCapability` report). Pure: no imports, no I/O.
// The project-level (non-profile) reason lives with its own spawn-time report in pty/host.ts, not here.

export interface CodexIncompatibility { id: string; reason: string }

/** The profile/project facts codex compatibility depends on. */
export interface CodexCompatInput {
  restrictedTools?: boolean;
  browserTesting?: boolean;
  documentConversion?: boolean;
  capabilities?: readonly unknown[];
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
  return items;
}

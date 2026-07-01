// Loom Companion — pure, dependency-free helpers behind the companion management UI (pages/Companion).
//
// These are extracted OUT of the React component so they can be unit-tested hermetically (test/
// companion.mjs imports THIS source via Node type-stripping and asserts on plain objects — the same
// pattern as lib/diff.ts). The security-load-bearing rule lives here and is asserted there:
//   • the bot token is WRITE-ONLY — a masked read never carries the token, only `tokenLast4`, and the
//     display helper can only ever render that (there is no token field to leak);
//   • a config UPDATE with a BLANK token OMITS `botToken` from the request body entirely, so the daemon
//     keeps the stored encrypted token (a "replace token" is the ONLY way a new token is ever sent).

import type { CompanionConfigMasked } from "@loom/shared";

// Mirror of the daemon's COMPANION_ID_MAX (gateway/server.ts) — the max length the REST surface accepts
// for chat/sender ids + sender labels. Kept in sync here so the UI rejects an over-long value inline
// instead of round-tripping to a 400.
export const COMPANION_ID_MAX = 200;

// The write-side form state for creating/configuring a companion. `botToken` is write-only: blank on an
// EDIT means "keep the stored token"; on a CREATE it is required. `heartbeatIntervalMinutes` is a text
// field (blank = 0 = off). The proactive HOME is DAEMON-GLOBAL (app_meta), so it is deliberately NOT on
// this per-companion form — it is managed on its own global control (PL ruling 2026-07-01).
export interface CompanionConfigForm {
  sessionId: string;
  botToken: string;
  channel: string;
  allowedChatId: string;
  chatScope: "dm" | "group";
  heartbeatIntervalMinutes: string;
  heartbeatPrompt: string;
  enabled: boolean;
}

// A blank form for the create flow, pre-seeded with a session id + the telegram default channel.
export function emptyConfigForm(sessionId = ""): CompanionConfigForm {
  return {
    sessionId,
    botToken: "",
    channel: "telegram",
    allowedChatId: "",
    chatScope: "dm",
    heartbeatIntervalMinutes: "",
    heartbeatPrompt: "",
    enabled: true,
  };
}

// Seed the EDIT form from a masked config. Note: `botToken` is deliberately left BLANK — the stored
// token is never returned, so the field starts empty and only a typed value replaces it.
export function formFromMasked(cfg: CompanionConfigMasked): CompanionConfigForm {
  return {
    sessionId: cfg.sessionId,
    botToken: "",
    channel: cfg.channel,
    allowedChatId: cfg.allowedChatId,
    chatScope: cfg.chatScope,
    heartbeatIntervalMinutes: cfg.heartbeatIntervalMinutes ? String(cfg.heartbeatIntervalMinutes) : "",
    heartbeatPrompt: cfg.heartbeatPrompt ?? "",
    enabled: cfg.enabled,
  };
}

// The ONLY way the UI renders a token: a fixed dot run plus the last-4 (never the token — a masked
// config carries no token). An empty last-4 (a corrupt/undecryptable blob on the daemon) reads as
// "unreadable" rather than a bare mask, so a broken key isn't silently indistinguishable from a good one.
export function maskedToken(cfg: Pick<CompanionConfigMasked, "tokenLast4">): string {
  const last4 = (cfg.tokenLast4 ?? "").trim();
  return last4 ? `••••••••••${last4}` : "•••••••••• (unreadable)";
}

export type ConfigBodyResult = { error: string } | { body: Record<string, unknown> };

// Validate + assemble the POST/PUT body from the form. `mode` gates the required-on-create fields
// (sessionId + token + allowedChatId). The token is included ONLY when the user typed one — a blank
// token on an edit is a no-op that keeps the daemon's stored encrypted token (the masked-token contract).
export function buildConfigBody(form: CompanionConfigForm, mode: "create" | "edit"): ConfigBodyResult {
  const sessionId = form.sessionId.trim();
  if (mode === "create" && !sessionId) return { error: "Select or paste the companion session id." };

  const token = form.botToken.trim();
  if (mode === "create" && !token) return { error: "A bot token is required to create a companion." };

  const allowedChatId = form.allowedChatId.trim();
  if (mode === "create" && !allowedChatId) return { error: "An allowed chat id is required." };

  let heartbeatIntervalMinutes = 0;
  const cadence = form.heartbeatIntervalMinutes.trim();
  if (cadence !== "") {
    const n = Number(cadence);
    if (!Number.isInteger(n) || n < 0) return { error: "Heartbeat cadence must be a whole number of minutes (0 = off)." };
    heartbeatIntervalMinutes = n;
  }

  const body: Record<string, unknown> = {
    channel: form.channel.trim() || "telegram",
    chatScope: form.chatScope,
    heartbeatIntervalMinutes,
    heartbeatPrompt: form.heartbeatPrompt.trim() || null,
    enabled: form.enabled,
  };
  if (mode === "create") body.sessionId = sessionId;
  // allowedChatId: always send on create; on edit send only when non-blank (blank keeps the stored value).
  if (allowedChatId) body.allowedChatId = allowedChatId;
  // botToken: WRITE-ONLY. Only ever attach a user-typed token; a blank field never sends one.
  if (token) body.botToken = token;
  // NOTE: the proactive HOME is intentionally NOT written here — it is daemon-global (app_meta), owned by
  // the dedicated global-home control, so a per-companion config write can never clobber the shared value.

  return { body };
}

// ── Simple in-app-first create ────────────────────────────────────────────────────────────────────────
// The new "New companion" flow provisions a working IN-APP-ONLY companion with ZERO external config — no
// session id, no bot token, no chat binding — via POST /api/companion/provision. The only input is an
// optional friendly name.

// Assemble the provision request body from the name field. The name is optional (the endpoint accepts an
// empty body and defaults the rig); a blank name sends `{}` rather than an empty string, keeping the wire
// minimal. Trims so a whitespace-only name is treated as unset.
export function provisionBody(name: string): { name?: string } {
  const trimmed = name.trim();
  return trimmed ? { name: trimmed } : {};
}

// Map a failed provision to a friendly, non-alarming message for the create flow. The single-companion
// guard (HTTP 409) is an expected PRECONDITION, not a failure — surface a calm "you already have one" with
// a clear pointer, never the raw server string. Any other status falls back to the server's own message.
// (Multi-companion support is a pending follow-up; until then one enabled companion is the ceiling.)
export function provisionErrorMessage(status: number, serverMessage: string): string {
  if (status === 409) return "You already have a companion. Delete it under Manage first, then create a new one.";
  return serverMessage;
}

// Derive the create-time DM binding from a create form. Per the PL bindings-authoritative ruling
// (2026-07-01), the config row alone provisions TRANSPORT but does NOT make the companion reachable —
// the gateway routes ONLY off bindings. So the create flow ALSO writes a binding (via the existing
// human-only POST /api/companion/bindings) using the form's allowedChatId + chatScope, arming transport
// AND routing from one form. Returns null when no chat id was supplied (a valid "provisioned, not yet
// reachable" companion). Mirrors buildConfigBody's channel defaulting so the two writes agree.
export function bindingFromCreateForm(
  form: CompanionConfigForm,
): { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" } | null {
  const chatId = form.allowedChatId.trim();
  if (!chatId) return null;
  return {
    sessionId: form.sessionId.trim(),
    channel: form.channel.trim() || "telegram",
    chatId,
    scope: form.chatScope,
  };
}

// Binding (access route) validation — mirrors the daemon's POST /api/companion/bindings guards so the UI
// catches a bad binding before the round-trip. `scope` is REQUIRED (a human binding a GROUP chat must
// consciously declare it — a silent "dm" default would admit every member of a group by chatId alone).
export function validateBinding(b: { sessionId: string; channel: string; chatId: string; scope: string }): string | null {
  if (!b.sessionId.trim()) return "A companion session id is required.";
  if (!b.channel.trim()) return "A channel is required.";
  if (!b.chatId.trim()) return "A chat id is required.";
  if (b.scope !== "dm" && b.scope !== "group") return "Scope must be 'dm' or 'group'.";
  return null;
}

// Allowed-sender (group allowlist) validation — mirrors the daemon's POST /api/companion/allowed-senders
// guards: the sender id is non-blank and at most COMPANION_ID_MAX chars, and the optional label is at
// most COMPANION_ID_MAX chars (the daemon bounds the raw length before trimming, so we match on `.length`).
export function validateSender(b: { senderId: string; label?: string | null }): string | null {
  if (!b.senderId.trim()) return "A sender id is required.";
  if (b.senderId.length > COMPANION_ID_MAX) return `The sender id must be at most ${COMPANION_ID_MAX} characters.`;
  if (b.label != null && b.label.length > COMPANION_ID_MAX) return `The label must be at most ${COMPANION_ID_MAX} characters.`;
  return null;
}

// Pairing-mint validation — grantType is one of the two enrollment grants.
export function validatePairing(grantType: string): string | null {
  if (grantType !== "dm-bind" && grantType !== "group-sender") return "Pick a grant type.";
  return null;
}

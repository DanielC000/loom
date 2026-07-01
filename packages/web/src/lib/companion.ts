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

// The write-side form state for creating/configuring a companion. `botToken` is write-only: blank on an
// EDIT means "keep the stored token"; on a CREATE it is required. `heartbeatIntervalMinutes` is a text
// field (blank = 0 = off). `home*` sets the daemon-global proactive home target (both or neither).
export interface CompanionConfigForm {
  sessionId: string;
  botToken: string;
  channel: string;
  allowedChatId: string;
  chatScope: "dm" | "group";
  heartbeatIntervalMinutes: string;
  heartbeatPrompt: string;
  homeChannel: string;
  homeChatId: string;
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
    homeChannel: "",
    homeChatId: "",
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
    homeChannel: cfg.home?.channel ?? "",
    homeChatId: cfg.home?.chatId ?? "",
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

  const homeChannel = form.homeChannel.trim();
  const homeChatId = form.homeChatId.trim();
  if ((homeChannel === "") !== (homeChatId === "")) {
    return { error: "Set both the home channel and the home chat id, or leave both blank." };
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
  // home: both-or-neither (validated above). Attach only when set — omitting it leaves the global home.
  if (homeChannel && homeChatId) body.home = { channel: homeChannel, chatId: homeChatId };

  return { body };
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

// Allowed-sender (group allowlist) validation.
export function validateSender(b: { senderId: string }): string | null {
  if (!b.senderId.trim()) return "A sender id is required.";
  return null;
}

// Pairing-mint validation — grantType is one of the two enrollment grants.
export function validatePairing(grantType: string): string | null {
  if (grantType !== "dm-bind" && grantType !== "group-sender") return "Pick a grant type.";
  return null;
}

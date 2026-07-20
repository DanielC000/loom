// Loom Companion — pure, dependency-free helpers behind the companion management UI (pages/Companion).
//
// These are extracted OUT of the React component so they can be unit-tested hermetically (test/
// companion.mjs imports THIS source via Node type-stripping and asserts on plain objects — the same
// pattern as lib/diff.ts). The security-load-bearing rule lives here and is asserted there:
//   • the bot token is WRITE-ONLY — a masked read never carries the token, only `tokenLast4`, and the
//     display helper can only ever render that (there is no token field to leak);
//   • a config UPDATE with a BLANK token OMITS `botToken` from the request body entirely, so the daemon
//     keeps the stored encrypted token (a "replace token" is the ONLY way a new token is ever sent).

import type { CompanionBinding, CompanionConfigMasked } from "@loom/shared";
// Type-only (erased under the strip-types test runner, so it pulls NO runtime code from api.ts) — the
// reminder helpers below format a CompanionReminderEntry for display.
import type { CompanionReminderEntry } from "./api";

// Mirror of the daemon's COMPANION_ID_MAX (gateway/server.ts) — the max length the REST surface accepts
// for chat/sender ids + sender labels. Kept in sync here so the UI rejects an over-long value inline
// instead of round-tripping to a 400.
export const COMPANION_ID_MAX = 200;

// Mirror of IN_APP_CHANNEL (the canonical export lives in lib/companionChat) — duplicated as a local
// literal so this pure, hermetically unit-tested module keeps NO sibling VALUE import: the node
// --experimental-strip-types test runner can't resolve an extensionless sibling, and bundler-mode tsc
// forbids the `.ts` extension. Same import-light convention as the daemon-constant mirrors above/below.
const IN_APP_CHANNEL = "in-app";

// Mirror of the daemon's COMPANION_TOKEN_MAX (gateway/server.ts) — the max bot-token length the config
// REST accepts. Kept in sync so the guided connect flow rejects an over-long token inline, not at a 400.
export const COMPANION_TOKEN_MAX = 4096;

// Mirror of the daemon's COMPANION_PROMPT_MAX (gateway/server.ts) — the max length the persona-prompt PUT
// accepts for the companion's editable startupPrompt. Kept in sync so the Manage persona editor rejects an
// over-long prompt inline instead of round-tripping to a 400.
export const COMPANION_PROMPT_MAX = 10_000;

// Validate the persona prompt before the PUT — bounds only (an EMPTY prompt is allowed; the read-only base
// brief still layers under it). Returns an error string or null. Mirrors the daemon's `.length` guard.
export function validatePersonaPrompt(startupPrompt: string): string | null {
  if (typeof startupPrompt !== "string") return "The persona prompt must be text.";
  if (startupPrompt.length > COMPANION_PROMPT_MAX) return `The persona prompt must be at most ${COMPANION_PROMPT_MAX} characters.`;
  return null;
}

// The default external channel label (matches the daemon's TELEGRAM_CHANNEL). The guided connect flow is
// Telegram-specific; a custom channel still goes through the manual "Add binding" advanced control.
export const TELEGRAM_CHANNEL = "telegram";

// The write-side form state for creating/configuring a companion. `botToken` is write-only: blank on an
// EDIT means "keep the stored token"; on a CREATE it is required. `heartbeatIntervalMinutes` is a text
// field (blank = 0 = off). The proactive HOME is per-session (app_meta), so it is deliberately NOT on
// this per-companion form — it is managed on its own dedicated control (PL ruling 2026-07-01).
export interface CompanionConfigForm {
  sessionId: string;
  botToken: string;
  channel: string;
  allowedChatId: string;
  chatScope: "dm" | "group";
  heartbeatIntervalMinutes: string;
  heartbeatPrompt: string;
  enabled: boolean;
  // The companion's given (human-friendly) name — baked into its base-brief identity line on its NEXT
  // spawn (composeAssistantStartupPrompt), not re-injected by a bare resume. Blank = unnamed.
  name: string;
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
    name: "",
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
    name: cfg.name ?? "",
  };
}

// The ONLY way the UI renders a token: a fixed dot run plus the last-4 (never the token — a masked
// config carries no token). An empty last-4 (a corrupt/undecryptable blob on the daemon) reads as
// "unreadable" rather than a bare mask, so a broken key isn't silently indistinguishable from a good one.
export function maskedToken(cfg: Pick<CompanionConfigMasked, "tokenLast4">): string {
  const last4 = (cfg.tokenLast4 ?? "").trim();
  return last4 ? `••••••••••${last4}` : "•••••••••• (unreadable)";
}

// The companion's DISPLAY NAME — authoritative from its own `config.name` (the field the user sets at
// create or in the Manage tab). When that's empty (never named), fall back to a friendly "Companion" —
// NEVER the raw session id, which is meaningless to a human. A companion is deliberately hidden from the
// session list (lib/sessions.ts), so the session-lookup that other rows use is the WRONG source here;
// config.name is the right one. Feeds the detail header AND the chat placeholder / bubbles / empty state.
export const COMPANION_DEFAULT_NAME = "Companion";
export function companionDisplayName(config?: Pick<CompanionConfigMasked, "name"> | null): string {
  return (config?.name ?? "").trim() || COMPANION_DEFAULT_NAME;
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

  const name = form.name.trim();
  if (name.length > COMPANION_ID_MAX) return { error: `Name must be at most ${COMPANION_ID_MAX} characters.` };

  const body: Record<string, unknown> = {
    channel: form.channel.trim() || "telegram",
    chatScope: form.chatScope,
    heartbeatIntervalMinutes,
    heartbeatPrompt: form.heartbeatPrompt.trim() || null,
    enabled: form.enabled,
    name,
  };
  if (mode === "create") body.sessionId = sessionId;
  // allowedChatId: always send on create; on edit send only when non-blank (blank keeps the stored value).
  if (allowedChatId) body.allowedChatId = allowedChatId;
  // botToken: WRITE-ONLY. Only ever attach a user-typed token; a blank field never sends one.
  if (token) body.botToken = token;
  // NOTE: the proactive HOME is intentionally NOT written here — it is per-session (app_meta, keyed
  // companion_home:<sessionId>), owned by the dedicated per-companion home control, so this config write
  // can never clobber another companion's home value.

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

// Map a failed provision to a friendly, non-alarming message for the create flow. Multi-companion is now
// supported (the daemon arms every enabled config concurrently — 55f1b62), so provisioning an additional
// companion no longer 409s. The 409 branch is kept only as DEFENSIVE handling: if the daemon ever returns
// one, surface a calm pointer rather than the raw server string. Any other status falls back to the server's
// own message.
export function provisionErrorMessage(status: number, serverMessage: string): string {
  if (status === 409) return "That companion couldn't be created right now — try again in a moment.";
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

// ── Guided "Connect Telegram" to an EXISTING companion (multi-channel, d23b4e32) ─────────────────────────
// The Manage view lets a user connect Telegram to a companion that already exists (typically an in-app-only
// one). Per the multi-binding schema, this ADDS a Telegram binding ALONGSIDE the in-app one — both channels
// coexist on the same session, unified context — rather than replacing the in-app route. The wire is the
// EXISTING human-only REST: PUT/POST /api/companion/config (stores the ENCRYPTED bot token + telegram target)
// then POST /api/companion/bindings (adds the telegram route). The companion NEVER writes any of this itself.

// The guided connect form. Both fields are required. `botToken` is WRITE-ONLY end to end — like the config
// token it is only ever SENT, never read back (a masked config carries no token, only its last-4).
export interface CompanionTelegramForm {
  botToken: string;
  chatId: string;
}

export function emptyTelegramForm(): CompanionTelegramForm {
  return { botToken: "", chatId: "" };
}

// Validate the guided connect form — mirrors the daemon guards so a bad form never round-trips to a 400:
// the token is non-blank and ≤ COMPANION_TOKEN_MAX, and the chat id is non-blank and ≤ COMPANION_ID_MAX (a
// token with no chat to reach is the daemon's GUARD 2). Bounds match the daemon's `.length` checks.
export function validateTelegramConnect(form: CompanionTelegramForm): string | null {
  const token = form.botToken.trim();
  if (!token) return "Paste the bot token from BotFather.";
  if (form.botToken.length > COMPANION_TOKEN_MAX) return `The bot token must be at most ${COMPANION_TOKEN_MAX} characters.`;
  if (!form.chatId.trim()) return "Enter the chat id the bot should message.";
  if (form.chatId.length > COMPANION_ID_MAX) return `The chat id must be at most ${COMPANION_ID_MAX} characters.`;
  return null;
}

// Assemble the TWO writes the guided connect performs, or an { error } for an invalid form (so the caller
// never fires a half write):
//   • configBody → the companion config write (PUT when a config row already exists, else POST create):
//     the ENCRYPTED bot token + the telegram transport channel + the chat it DMs. botToken is WRITE-ONLY —
//     it is sent ONLY here, from a value the human typed, never read back.
//   • bindingBody → POST /api/companion/bindings: the authoritative telegram route, ADDED alongside the
//     session's in-app binding (the daemon upserts on (session_id, channel), so the in-app row is untouched).
// A DM scope: the guided flow binds the owner's private chat (a group binding is the manual advanced path,
// which must consciously declare group scope + an allowlist).
export function buildTelegramConnect(
  sessionId: string,
  form: CompanionTelegramForm,
): { error: string } | {
  configBody: Record<string, unknown>;
  bindingBody: { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" };
} {
  const err = validateTelegramConnect(form);
  if (err) return { error: err };
  const chatId = form.chatId.trim();
  return {
    configBody: { botToken: form.botToken.trim(), channel: TELEGRAM_CHANNEL, allowedChatId: chatId, chatScope: "dm" },
    bindingBody: { sessionId: sessionId.trim(), channel: TELEGRAM_CHANNEL, chatId, scope: "dm" },
  };
}

// ── Per-channel display (which channels a companion is reachable on) ──────────────────────────────────────
// A companion may now hold MANY bindings (one per channel). The Manage view lists each as a channel row.
// These pure helpers order + label them so the display logic stays testable and out of the component.

// Order a companion's bindings for display: the in-app channel ALWAYS first (a companion's default face),
// then the rest alphabetically by channel. Does not mutate the input.
export function bindingsForDisplay(bindings: CompanionBinding[]): CompanionBinding[] {
  return [...bindings].sort((a, b) => {
    if (a.channel === IN_APP_CHANNEL) return b.channel === IN_APP_CHANNEL ? 0 : -1;
    if (b.channel === IN_APP_CHANNEL) return 1;
    return a.channel.localeCompare(b.channel);
  });
}

// A friendly display name for a channel row. Known channels get a proper-cased label; anything else shows
// verbatim (never invents a name for a channel the daemon added that the UI hasn't been taught). The SINGLE
// OWNER of channel → display label: both the Manage channel row and the chat-bubble provenance badge (via
// channelBadgeLabel) resolve through this, so they can never diverge for any channel — known OR unknown.
export function channelDisplayName(channel: string): string {
  if (channel === IN_APP_CHANNEL) return "In-app";
  if (channel === TELEGRAM_CHANNEL) return "Telegram";
  return channel;
}

// The chat-bubble provenance badge label — reuses channelDisplayName (the single owner above) but returns
// null for the in-app channel to SUPPRESS the badge entirely: in-app is the default, unlabeled web chat, so
// its bubbles show no channel badge. A thin wrapper so the badge and the Manage row agree for every channel.
export function channelBadgeLabel(channel: string): string | null {
  return channel === IN_APP_CHANNEL ? null : channelDisplayName(channel);
}

// Whether a companion already has a binding on the given channel — used to hide the "Connect Telegram" flow
// once Telegram is connected (and to keep the connect idempotent from the UI's side).
export function hasChannelBinding(bindings: CompanionBinding[], channel: string): boolean {
  return bindings.some((b) => b.channel === channel);
}

// ── Companion reminders: pure display helpers behind the Manage → Reminders section ──────────────────
// VIEW-only formatting for a CompanionReminderEntry (the companion authors reminders itself over MCP; the
// UI only lists + prunes). Extracted here so the row's rendering logic — the label fallback, the cheap
// cron humanizing, and the enabled-gated next-fire — is hermetically testable (test/companion-manage.mjs).

// The row's title: the reminder's own label when it set one, else a sensible fallback derived from the
// first non-empty line of its prompt (trimmed to a readable length), else a plain "Reminder". A reminder
// with neither a label nor a prompt still renders a stable, non-empty title.
export function reminderTitle(rem: Pick<CompanionReminderEntry, "label" | "prompt">): string {
  const label = rem.label?.trim();
  if (label) return label;
  const firstLine = (rem.prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  if (!firstLine) return "Reminder";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

// A cheap human rendering of a 5-field cron (min hour dom mon dow) for the common cadences a companion
// tends to author; anything outside these patterns falls back to the RAW cron string verbatim (never a
// wrong guess). Kept deliberately small — a full cron humanizer is not worth a dep here.
export function humanCron(cron: string): string {
  const raw = (cron ?? "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw; // not a 5-field cron — show it as-is
  const [min = "", hour = "", dom = "", mon = "", dow = ""] = parts;
  const everyField = (f: string) => f === "*";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = (h: string, m: string) => {
    const hn = Number(h), mn = Number(m);
    if (!Number.isInteger(hn) || !Number.isInteger(mn) || hn < 0 || hn > 23 || mn < 0 || mn > 59) return null;
    return `${pad(hn)}:${pad(mn)}`;
  };
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // every minute
  if (parts.every(everyField)) return "every minute";
  // every N minutes (*/N * * * *)
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return `every ${stepMin[1]} minutes`;
  }
  // hourly at :MM (M * * * *)
  if (/^\d+$/.test(min) && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return Number(min) === 0 ? "every hour" : `hourly at :${pad(Number(min))}`;
  }
  // daily at HH:MM (M H * * *)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    const t = time(hour, min);
    if (t) return `daily at ${t}`;
  }
  // weekly on <day> at HH:MM (M H * * D)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && everyField(dom) && everyField(mon) && /^\d+$/.test(dow)) {
    const d = Number(dow) % 7; // cron allows 0 or 7 for Sunday
    const t = time(hour, min);
    if (t && days[d]) return `weekly on ${days[d]} at ${t}`;
  }
  return raw; // uncommon shape — fall back to the raw cron
}

// The next-fire ISO to display, GATED on enabled: the server populates nextFireAt even for a disabled
// row (it's just the theoretical next tick), but a disabled reminder never actually fires, so the UI must
// not imply an upcoming fire. Returns null when disabled or when the cron couldn't be parsed server-side.
export function reminderNextFireAt(rem: Pick<CompanionReminderEntry, "enabled" | "nextFireAt">): string | null {
  return rem.enabled ? rem.nextFireAt : null;
}

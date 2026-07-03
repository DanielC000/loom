// Hermetic unit test for the web-side companion-management logic in src/lib/companion.ts — the pure,
// dependency-free helpers behind pages/Companion.tsx (form→request-body assembly, the WRITE-ONLY token
// contract, the masked-token display, and the binding/sender/pairing validators). No daemon, no claude,
// no fs/db: it imports the TS source directly via Node's type stripping and asserts on plain objects, so
// it exercises the REAL shipped helpers and can't drift from a copy.
//
// Like diff.mjs, the web package has no test runner, so this is a self-contained node script. It is wired
// into @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/companion.mjs
import assert from "node:assert/strict";
import {
  COMPANION_ID_MAX, COMPANION_TOKEN_MAX, TELEGRAM_CHANNEL, bindingFromCreateForm, bindingsForDisplay,
  buildConfigBody, buildTelegramConnect, channelDisplayName, emptyConfigForm, emptyTelegramForm,
  formFromMasked, hasChannelBinding, maskedToken, provisionBody, provisionErrorMessage, validateBinding,
  validateSender, validatePairing, validateTelegramConnect,
} from "../src/lib/companion.ts";
// api.ts has only a type-only `@loom/shared` import (erased under --experimental-strip-types), so it loads
// here with no daemon/build — letting us drive api.provisionCompanion against a mocked global fetch.
import { api } from "../src/lib/api.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A full, valid form the individual cases mutate. Keeps each case readable.
const baseForm = () => ({
  ...emptyConfigForm("sess-123"),
  botToken: "123456:ABC-DEF",
  allowedChatId: "999",
});

// ── The WRITE-ONLY bot-token contract (the load-bearing security invariant) ─────────────────────────

// 1) A CREATE sends the typed token exactly once, plus the required fields.
check("create: a typed token is sent in the body along with sessionId + allowedChatId", () => {
  const res = buildConfigBody(baseForm(), "create");
  assert.ok(!("error" in res), "valid create should not error");
  assert.equal(res.body.sessionId, "sess-123");
  assert.equal(res.body.botToken, "123456:ABC-DEF");
  assert.equal(res.body.allowedChatId, "999");
  assert.equal(res.body.enabled, true);
});

// 2) THE MASKED-TOKEN CONTRACT: an EDIT with a BLANK token OMITS botToken entirely, so the daemon keeps
//    its stored encrypted token. A "replace" is the ONLY way a new token is ever sent. This is the exact
//    behavior the security-lens review checks — a blank field must never blank/overwrite the stored token.
check("edit: a blank token OMITS botToken from the body (keeps the stored token)", () => {
  const form = { ...formFromMasked(maskedRow()), botToken: "" };
  const res = buildConfigBody(form, "edit");
  assert.ok(!("error" in res), "a tokenless edit is valid");
  assert.ok(!("botToken" in res.body), "botToken must be ABSENT so the daemon keeps the stored token");
});

// 3) An EDIT with a typed replacement DOES send the new token.
check("edit: a typed replacement token IS sent as botToken", () => {
  const form = { ...formFromMasked(maskedRow()), botToken: "  new:TOKEN  " };
  const res = buildConfigBody(form, "edit");
  assert.equal(res.body.botToken, "new:TOKEN", "the replacement token is trimmed and sent");
});

// 4) formFromMasked NEVER seeds a token from a read (the masked row carries none) — the field starts blank.
check("formFromMasked leaves botToken blank (a read never carries the token)", () => {
  const form = formFromMasked(maskedRow());
  assert.equal(form.botToken, "");
});

// 5) maskedToken renders ONLY the last-4 behind a dot run, never a full token; an empty last-4 reads
//    "unreadable" (a corrupt daemon-side blob) rather than a bare mask.
check("maskedToken shows only the last-4, and flags an empty last-4 as unreadable", () => {
  assert.match(maskedToken({ tokenLast4: "1234" }), /1234$/);
  assert.ok(!maskedToken({ tokenLast4: "1234" }).includes("123456"), "never the full token");
  assert.match(maskedToken({ tokenLast4: "" }), /unreadable/);
  assert.match(maskedToken({ tokenLast4: "   " }), /unreadable/, "whitespace-only last-4 is unreadable too");
});

// ── Required-field + numeric + home validation ──────────────────────────────────────────────────────

check("create: missing sessionId / token / allowedChatId each error", () => {
  assert.ok("error" in buildConfigBody({ ...baseForm(), sessionId: "" }, "create"));
  assert.ok("error" in buildConfigBody({ ...baseForm(), botToken: "" }, "create"));
  assert.ok("error" in buildConfigBody({ ...baseForm(), allowedChatId: "" }, "create"));
});

check("edit: omitting sessionId/token/allowedChatId is fine (partial update keeps stored values)", () => {
  const res = buildConfigBody({ ...emptyConfigForm(), botToken: "", allowedChatId: "" }, "edit");
  assert.ok(!("error" in res), "an edit needs none of the create-required fields");
  assert.ok(!("sessionId" in res.body), "edit does not send sessionId in the body");
  assert.ok(!("allowedChatId" in res.body), "a blank allowedChatId is omitted (kept)");
});

check("heartbeat cadence: blank = 0, a whole number passes, a fraction/negative errors", () => {
  assert.equal(buildConfigBody({ ...baseForm(), heartbeatIntervalMinutes: "" }, "create").body.heartbeatIntervalMinutes, 0);
  assert.equal(buildConfigBody({ ...baseForm(), heartbeatIntervalMinutes: "30" }, "create").body.heartbeatIntervalMinutes, 30);
  assert.ok("error" in buildConfigBody({ ...baseForm(), heartbeatIntervalMinutes: "1.5" }, "create"));
  assert.ok("error" in buildConfigBody({ ...baseForm(), heartbeatIntervalMinutes: "-5" }, "create"));
});

check("heartbeat prompt: blank sends null (default), text is trimmed", () => {
  assert.equal(buildConfigBody({ ...baseForm(), heartbeatPrompt: "  " }, "create").body.heartbeatPrompt, null);
  assert.equal(buildConfigBody({ ...baseForm(), heartbeatPrompt: " hi " }, "create").body.heartbeatPrompt, "hi");
});

check("home is never written by a config body — it is the daemon-global store, not per-companion", () => {
  assert.ok(!("home" in buildConfigBody(baseForm(), "create").body), "create must not carry a home key");
  assert.ok(!("home" in buildConfigBody(baseForm(), "edit").body), "edit must not carry a home key either");
});

check("channel defaults to telegram when left blank", () => {
  assert.equal(buildConfigBody({ ...baseForm(), channel: "" }, "create").body.channel, "telegram");
});

// ── The Manage-tab rename field: name flows form ↔ body, trimmed, bounded ───────────────────────────
check("formFromMasked seeds `name` from the masked config (blank when never named)", () => {
  assert.equal(formFromMasked(maskedRow()).name, "", "maskedRow() carries no name by default");
  assert.equal(formFromMasked({ ...maskedRow(), name: "Ada" }).name, "Ada");
});

check("buildConfigBody: name is trimmed and always sent (edit sends '' to clear, not omit)", () => {
  assert.equal(buildConfigBody({ ...baseForm(), name: "  Ada  " }, "create").body.name, "Ada");
  assert.equal(buildConfigBody({ ...baseForm(), name: "" }, "edit").body.name, "", "a blank name is sent as '' — an intentional clear, unlike the write-only token");
});

check("buildConfigBody: an over-long name errors, at-the-max passes", () => {
  assert.ok("error" in buildConfigBody({ ...baseForm(), name: "x".repeat(COMPANION_ID_MAX + 1) }, "create"));
  assert.ok(!("error" in buildConfigBody({ ...baseForm(), name: "x".repeat(COMPANION_ID_MAX) }, "create")));
});

// ── Access binding + sender + pairing validators ────────────────────────────────────────────────────

check("validateBinding: requires sessionId/channel/chatId and a real scope", () => {
  assert.equal(validateBinding({ sessionId: "s", channel: "telegram", chatId: "1", scope: "dm" }), null);
  assert.equal(validateBinding({ sessionId: "s", channel: "telegram", chatId: "1", scope: "group" }), null);
  assert.ok(validateBinding({ sessionId: "", channel: "telegram", chatId: "1", scope: "dm" }));
  assert.ok(validateBinding({ sessionId: "s", channel: "", chatId: "1", scope: "dm" }));
  assert.ok(validateBinding({ sessionId: "s", channel: "telegram", chatId: "", scope: "dm" }));
  assert.ok(validateBinding({ sessionId: "s", channel: "telegram", chatId: "1", scope: "" }), "a missing scope is rejected");
  assert.ok(validateBinding({ sessionId: "s", channel: "telegram", chatId: "1", scope: "public" }), "an unknown scope is rejected");
});

check("validateSender: non-blank sender id, sender id + label both bounded by COMPANION_ID_MAX", () => {
  assert.equal(validateSender({ senderId: "42" }), null);
  assert.equal(validateSender({ senderId: "42", label: "me" }), null);
  assert.equal(validateSender({ senderId: "42", label: null }), null, "a null label is fine");
  assert.ok(validateSender({ senderId: "   " }), "a blank sender id is rejected");
  assert.ok(validateSender({ senderId: "x".repeat(COMPANION_ID_MAX + 1) }), "an over-long sender id is rejected");
  assert.ok(validateSender({ senderId: "42", label: "y".repeat(COMPANION_ID_MAX + 1) }), "an over-long label is rejected");
  assert.equal(validateSender({ senderId: "x".repeat(COMPANION_ID_MAX), label: "y".repeat(COMPANION_ID_MAX) }), null, "exactly-max passes");
});

// ── Create-flow binding derivation (the bindings-authoritative routing arm) ───────────────────────────

check("bindingFromCreateForm: derives a dm binding, carries scope, defaults channel, null on no chat id", () => {
  assert.deepEqual(bindingFromCreateForm(baseForm()), { sessionId: "sess-123", channel: "telegram", chatId: "999", scope: "dm" });
  assert.equal(bindingFromCreateForm({ ...baseForm(), allowedChatId: "" }), null, "no chat id → no binding (provisioned, not reachable)");
  assert.equal(bindingFromCreateForm({ ...baseForm(), allowedChatId: "   " }), null, "a blank chat id → no binding");
  assert.deepEqual(
    bindingFromCreateForm({ ...baseForm(), chatScope: "group", channel: "" }),
    { sessionId: "sess-123", channel: "telegram", chatId: "999", scope: "group" },
    "scope is carried through and a blank channel defaults to telegram (matching the config write)",
  );
});

check("validatePairing: only the two enrollment grant types pass", () => {
  assert.equal(validatePairing("dm-bind"), null);
  assert.equal(validatePairing("group-sender"), null);
  assert.ok(validatePairing(""));
  assert.ok(validatePairing("admin"));
});

// ── Guided "Connect Telegram" to an existing companion (multi-channel: ADDS a channel, never replaces) ──

check("validateTelegramConnect: token + chatId both required, both bounded", () => {
  assert.equal(validateTelegramConnect({ botToken: "123:ABC", chatId: "999" }), null);
  assert.ok(validateTelegramConnect({ botToken: "   ", chatId: "999" }), "a blank token is rejected");
  assert.ok(validateTelegramConnect({ botToken: "123:ABC", chatId: "  " }), "a blank chat id is rejected (a token needs a chat to reach)");
  assert.ok(validateTelegramConnect({ botToken: "x".repeat(COMPANION_TOKEN_MAX + 1), chatId: "999" }), "an over-long token is rejected");
  assert.ok(validateTelegramConnect({ botToken: "123:ABC", chatId: "9".repeat(COMPANION_ID_MAX + 1) }), "an over-long chat id is rejected");
});

// THE CONNECT CONTRACT: the guided connect assembles EXACTLY two writes — a config body carrying the typed
// bot token + the telegram target, and a telegram binding on the SAME chat. The token is only ever SENT here
// (write-only), and the binding is on channel telegram so the daemon ADDS it alongside the in-app one.
check("buildTelegramConnect: assembles the config token write + the telegram binding (dm)", () => {
  const built = buildTelegramConnect("sess-1", { botToken: "  123:ABC  ", chatId: "  999  " });
  assert.ok(!("error" in built), "a valid form assembles both writes");
  assert.equal(built.configBody.botToken, "123:ABC", "the typed token is trimmed and carried on the config write");
  assert.equal(built.configBody.channel, TELEGRAM_CHANNEL, "the config points at the telegram transport");
  assert.equal(built.configBody.allowedChatId, "999", "the config's boot-seed chat is the pasted chat id");
  assert.equal(built.configBody.chatScope, "dm");
  assert.deepEqual(built.bindingBody, { sessionId: "sess-1", channel: TELEGRAM_CHANNEL, chatId: "999", scope: "dm" },
    "the authoritative route is a telegram dm binding — ADDED alongside in-app, never replacing it");
});

check("buildTelegramConnect: an invalid form errors and assembles NO write", () => {
  const built = buildTelegramConnect("sess-1", { botToken: "", chatId: "999" });
  assert.ok("error" in built, "a blank token yields an error, so the caller never fires a half write");
  assert.ok(!("configBody" in built) && !("bindingBody" in built));
});

check("emptyTelegramForm is blank (a fresh connect form seeds no token or chat id)", () => {
  assert.deepEqual(emptyTelegramForm(), { botToken: "", chatId: "" });
});

// ── Per-channel display helpers (a companion may be reachable on MANY channels at once) ────────────────

check("bindingsForDisplay: in-app ALWAYS first, then channels alphabetically; input not mutated", () => {
  const bs = [
    { sessionId: "s", channel: "telegram", chatId: "t", scope: "dm", createdAt: "" },
    { sessionId: "s", channel: "in-app", chatId: "s", scope: "dm", createdAt: "" },
    { sessionId: "s", channel: "discord", chatId: "d", scope: "dm", createdAt: "" },
  ];
  const out = bindingsForDisplay(bs);
  assert.deepEqual(out.map((b) => b.channel), ["in-app", "discord", "telegram"], "in-app first, rest alphabetical");
  assert.equal(bs[0].channel, "telegram", "the original array order is untouched");
});

check("channelDisplayName: known channels get friendly names, unknown ones show verbatim", () => {
  assert.equal(channelDisplayName("in-app"), "In-app");
  assert.equal(channelDisplayName("telegram"), "Telegram");
  assert.equal(channelDisplayName("discord"), "discord", "an unknown channel is never renamed");
});

check("hasChannelBinding: detects whether a companion already holds a binding on a channel", () => {
  const bs = [{ sessionId: "s", channel: "in-app", chatId: "s", scope: "dm", createdAt: "" }];
  assert.equal(hasChannelBinding(bs, "telegram"), false, "telegram not connected yet");
  assert.equal(hasChannelBinding(bs, "in-app"), true);
  assert.equal(hasChannelBinding([], "in-app"), false);
});

// ── Simple in-app-first create: provisionBody + the graceful single-companion (409) message ───────────

check("provisionBody: a name sends { name } (trimmed); a blank name sends {} (no external config either way)", () => {
  assert.deepEqual(provisionBody("Ada"), { name: "Ada" });
  assert.deepEqual(provisionBody("  Ada  "), { name: "Ada" }, "the name is trimmed");
  assert.deepEqual(provisionBody(""), {}, "a blank name sends an empty body (name is optional)");
  assert.deepEqual(provisionBody("   "), {}, "a whitespace-only name is treated as unset");
});

check("provisionErrorMessage: 409 → a calm 'you already have one' precondition; anything else → the server message", () => {
  assert.match(provisionErrorMessage(409, "a companion is already active — delete it first"), /already have a companion/i);
  assert.doesNotMatch(provisionErrorMessage(409, "raw server string"), /raw server string/, "the 409 raw string is never shown");
  assert.equal(provisionErrorMessage(500, "companion provision failed and was rolled back"), "companion provision failed and was rolled back");
  assert.equal(provisionErrorMessage(0, "network down"), "network down", "a non-HTTP failure falls back to its own message");
});

// ── The create flow over a MOCKED fetch: POST provision called with { name }; a 409 surfaces status ────
// Drives the real api.provisionCompanion (the exact call the create button makes) against a stubbed global
// fetch, asserting the request shape and that a 409 body is surfaced status-tagged so the UI can render the
// graceful message. No daemon, no network.

const realFetch = globalThis.fetch;
async function acheck(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); }
  finally { globalThis.fetch = realFetch; }
}

await acheck("provision: POSTs { name } to /api/companion/provision and returns the masked companion", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 201, json: async () => ({ sessionId: "sess-new", configured: true, tokenConfigured: false, provisioned: true, channel: "in-app" }) };
  };
  const row = await api.provisionCompanion(provisionBody("Ada"));
  assert.equal(captured.url, "/api/companion/provision");
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captured.opts.body), { name: "Ada" }, "the body carries exactly { name }");
  assert.equal(row.sessionId, "sess-new");
  assert.equal(row.tokenConfigured, false, "the in-app default has no token");
});

await acheck("provision: a 409 throws an error tagged with status 409, which maps to the graceful message", async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 409,
    json: async () => ({ error: "a companion is already active — delete it first, or multi-companion support is not yet available" }),
  });
  let threw = null;
  try { await api.provisionCompanion({}); } catch (e) { threw = e; }
  assert.ok(threw, "a 409 rejects");
  assert.equal(threw.status, 409, "the status is carried on the error so the UI can branch on the guard");
  assert.match(provisionErrorMessage(threw.status, threw.message), /already have a companion/i);
});

// ── Per-channel remove targets ONLY that channel (the daemon `?channel=` contract) ────────────────────
await acheck("deleteCompanionBinding(sessionId, channel): hits the ?channel= endpoint (removes only that channel)", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  await api.deleteCompanionBinding("sess 1", "telegram");
  assert.equal(captured.opts.method, "DELETE");
  assert.equal(captured.url, "/api/companion/bindings/sess%201?channel=telegram", "the channel is a query param so only that channel's binding is removed");
});

await acheck("deleteCompanionBinding(sessionId): with NO channel omits the query param (delete-all, unchanged)", async () => {
  let captured = null;
  globalThis.fetch = async (url) => { captured = { url }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  await api.deleteCompanionBinding("sess-1");
  assert.equal(captured.url, "/api/companion/bindings/sess-1", "no ?channel= → the daemon's delete-ALL behavior (byte-identical)");
});

// ── The guided connect fires the config token write, THEN the binding POST — in order, both to the right endpoint ──
await acheck("connect Telegram: PUTs the config (token) then POSTs the telegram binding, in that order", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const built = buildTelegramConnect("sess-1", { botToken: "123:ABC", chatId: "999" });
  assert.ok(!("error" in built));
  // Mirror the ConnectTelegram mutation for an EXISTING config: PUT config, then POST binding.
  await api.updateCompanionConfig("sess-1", built.configBody);
  await api.createCompanionBinding(built.bindingBody);
  assert.equal(calls.length, 2, "exactly two writes");
  assert.equal(calls[0].url, "/api/companion/config/sess-1");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.botToken, "123:ABC", "the token is sent on the config write (encrypted daemon-side)");
  assert.equal(calls[1].url, "/api/companion/bindings");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].body, { sessionId: "sess-1", channel: "telegram", chatId: "999", scope: "dm" }, "the telegram route is bound after the token lands");
});

// A representative masked config row (as the REST GET returns it) — NEVER carries the token, only last-4.
function maskedRow() {
  return {
    sessionId: "sess-123",
    configured: true,
    tokenLast4: "6789",
    channel: "telegram",
    allowedChatId: "999",
    chatScope: "dm",
    heartbeatIntervalMinutes: 30,
    heartbeatPrompt: "Check in",
    home: { channel: "telegram", chatId: "999" },
    enabled: true,
    envPinned: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

console.log(`\n${pass} passed`);

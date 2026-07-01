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
  buildConfigBody, emptyConfigForm, formFromMasked, maskedToken,
  validateBinding, validateSender, validatePairing,
} from "../src/lib/companion.ts";

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

check("home: both-or-neither — one side alone errors, both send a home object, neither omits it", () => {
  assert.ok("error" in buildConfigBody({ ...baseForm(), homeChannel: "telegram", homeChatId: "" }, "create"));
  assert.ok("error" in buildConfigBody({ ...baseForm(), homeChannel: "", homeChatId: "42" }, "create"));
  const both = buildConfigBody({ ...baseForm(), homeChannel: "telegram", homeChatId: "42" }, "create");
  assert.deepEqual(both.body.home, { channel: "telegram", chatId: "42" });
  const neither = buildConfigBody(baseForm(), "create");
  assert.ok(!("home" in neither.body), "no home fields → no home key");
});

check("channel defaults to telegram when left blank", () => {
  assert.equal(buildConfigBody({ ...baseForm(), channel: "" }, "create").body.channel, "telegram");
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

check("validateSender: requires a non-blank sender id", () => {
  assert.equal(validateSender({ senderId: "42" }), null);
  assert.ok(validateSender({ senderId: "   " }));
});

check("validatePairing: only the two enrollment grant types pass", () => {
  assert.equal(validatePairing("dm-bind"), null);
  assert.equal(validatePairing("group-sender"), null);
  assert.ok(validatePairing(""));
  assert.ok(validatePairing("admin"));
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

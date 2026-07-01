import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the DM-PAIRING enrollment layer (SECURITY-CRITICAL). Fully hermetic: a REAL Db on a
// temp LOOM_HOME + the platform-agnostic ChatGateway driven with a FAKE submit-turn spy + an INJECTED
// clock; NO live network, NO real claude, NO daemon. An owner-minted, single-use, short-TTL code enrolls a
// NEW chat/sender into the EXISTING binding/allowlist records WITHOUT hand-entering numeric ids. Pairing
// NEVER spawns a session and the bound id ALWAYS comes from the AUTHENTICATED inbound metadata. These
// assert the threat model:
//   A. mint = human-only loopback REST; returns the plaintext ONCE + stores only a salted hash+salt.
//   B. dm-bind: a code redeemed from a NEW DM binds the AUTHENTICATED chat.id → session and routes
//      thereafter; single-use (2nd redemption fails); the code text NEVER reaches submitTurn.
//   C. group-sender: a code adds the AUTHENTICATED sender to the group allowlist (then authorized); a code
//      minted for session A cannot grant into group B (cross-session guard).
//   D. rate-limit: N wrong attempts lock out (channel, sender) — even a VALID code is then rejected; the
//      lock is time-bounded (unlocks after the lockout window).
//   E. TTL-expiry rejects; NO pairing oracle (wrong/expired/consumed → the SAME reject as any unallowlisted
//      inbound); anti-spoof (a body can only ever bind the authenticated metadata id); injection sweep (no
//      code plaintext ever reached the submit spy).
// Run: 1) build (turbo builds shared first), 2) node test/companion-pairing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-pairing-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { createDbCompanionPairing } = await import("../dist/companion/pairing.js");
const { buildServer } = await import("../dist/gateway/server.js");

const TTL_MS = 10 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const fakeAdapter = (name, sent) => ({ name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } });
const dbFile = (name) => path.join(tmpHome, name);
const toBinding = (b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope });

// Every submit text observed across the whole run — the injection sweep asserts NO pairing code plaintext
// ever reached the turn-submit primitive on ANY redemption path.
const allSubmittedTexts = [];
// Build a gateway wired to `db` with an INJECTED clock (`clock.t`, mutable) + a small attempt budget so the
// lockout is quick to exercise. Returns the submit + ack spies.
function makeGateway(db, clock, policy = {}) {
  const submitted = [];
  const submit = (sid, text) => { submitted.push({ sid, text }); allSubmittedTexts.push(text); return { delivered: true }; };
  const sent = [];
  const pairing = createDbCompanionPairing(db, { now: () => clock.t, maxAttempts: 3, windowMs: 10 * 60_000, lockoutMs: LOCKOUT_MS, ...policy });
  const gw = new ChatGateway(submit, db.listCompanionBindings().map(toBinding), createDbCompanionAuth(db), pairing);
  gw.registerAdapter(fakeAdapter("telegram", sent));
  return { gw, submitted, sent };
}

try {
  // ============ Part A — MINT: human-only REST, plaintext ONCE, hash+salt at rest ============
  {
    const db = new Db(dbFile("A.db"));
    const app = await buildServer({ db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, companion: null });

    const minted = await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "sess-D", grantType: "dm-bind" } });
    check("mint: valid POST → 201", minted.statusCode === 201);
    const body = JSON.parse(minted.payload);
    check("mint: response carries codeId + plaintext code + expiresAt", typeof body.codeId === "string" && typeof body.code === "string" && typeof body.expiresAt === "string");
    check("mint: the plaintext code uses the distinct pair_ prefix", body.code.startsWith("pair_"));

    // The DB row stores only a SALTED HASH + salt — never the plaintext (the 'plaintext once' invariant).
    const row = db.getPairingCodeById(body.codeId);
    check("mint: row persisted with a hash + salt", !!row && typeof row.code_hash === "string" && row.code_hash.length > 0 && typeof row.code_salt === "string" && row.code_salt.length > 0);
    check("mint: NO column stores the plaintext code", !!row && Object.values(row).every((v) => v !== body.code));
    check("mint: the stored hash is not the code/secret itself", !!row && row.code_hash !== body.code && !body.code.includes(row.code_hash));
    check("mint: grant_type + session captured; unconsumed", row.grant_type === "dm-bind" && row.session_id === "sess-D" && row.consumed_at == null);

    // Validation.
    check("mint: missing sessionId → 400", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { grantType: "dm-bind" } })).statusCode === 400);
    check("mint: bad grantType → 400", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "nope" } })).statusCode === 400);
    check("mint: ttlMinutes ≤ 0 → 400", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "dm-bind", ttlMinutes: 0 } })).statusCode === 400);
    check("mint: ttlMinutes just over the 15-min cap → 400", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "dm-bind", ttlMinutes: 16 } })).statusCode === 400);
    check("mint: ttlMinutes far over the max → 400", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "dm-bind", ttlMinutes: 999 } })).statusCode === 400);
    check("mint: ttlMinutes at the 15-min cap → 201", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "dm-bind", ttlMinutes: 15 } })).statusCode === 201);
    check("mint: group-sender grantType accepted → 201", (await app.inject({ method: "POST", url: "/api/companion/pairing", payload: { sessionId: "s", grantType: "group-sender" } })).statusCode === 201);

    await app.close();
    db.close();
  }

  // ============ Part B — dm-bind: bind the AUTHENTICATED chat.id, route thereafter, single-use, TTL ============
  {
    const db = new Db(dbFile("B.db"));
    const clock = { t: 1_000_000 };
    const { gw, submitted, sent } = makeGateway(db, clock);

    // Owner mints a dm-bind code for sess-D (via the db path, so the fake clock governs TTL).
    const code = db.mintPairingCode({ sessionId: "sess-D", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, clock.t).code;
    const codeId = code.slice("pair_".length).split(".")[0];

    // A brand-new DM (no binding) redeems it → binds the AUTHENTICATED chat.id, acks "paired", NO submit.
    const r = await gw.handleInbound({ channel: "telegram", chatId: "dm-new", body: code, sender: { id: "user-9" } });
    check("dm-bind: redemption → paired-dm for the targeted session", r.accepted === false && r.reason === "paired-dm" && r.sessionId === "sess-D");
    check("dm-bind: the code text was NOT submitted as a turn", submitted.length === 0);
    check("dm-bind: a 'paired' ack was sent to the authenticated chat", r.acked === true && sent.length === 1 && sent[0].chatId === "dm-new" && /paired/i.test(sent[0].text));
    const bound = db.listCompanionBindings().find((b) => b.sessionId === "sess-D");
    check("dm-bind: the durable binding uses the AUTHENTICATED chat.id (dm scope)", !!bound && bound.chatId === "dm-new" && bound.scope === "dm");
    check("dm-bind: the code is now consumed (single-use)", db.getPairingCodeById(codeId)?.consumed_at != null && db.getPairingCodeById(codeId)?.consumed_by === "user-9");

    // The SAME chat now ROUTES a normal message to sess-D (pairing took effect live, no restart).
    const r2 = await gw.handleInbound({ channel: "telegram", chatId: "dm-new", body: "hello there", sender: { id: "user-9" } });
    check("dm-bind: the paired chat now routes a normal turn to the bound session", r2.accepted === true && r2.sessionId === "sess-D" && submitted.length === 1 && submitted[0].text === "hello there");

    // Single-use: the same code redeemed from a DIFFERENT unbound chat is rejected (already consumed).
    const r3 = await gw.handleInbound({ channel: "telegram", chatId: "dm-other", body: code, sender: { id: "user-x" } });
    check("dm-bind: single-use — a 2nd redemption of the same code is rejected", r3.accepted === false && r3.reason === "chat-not-allowlisted");
    check("dm-bind: the rejected 2nd redemption bound nothing new", !db.listCompanionBindings().some((b) => b.chatId === "dm-other"));
    check("dm-bind: the reused code text was NOT submitted", submitted.length === 1);

    // TTL: a FRESH dm-bind code redeemed AFTER its TTL is rejected (clock advanced past expiry).
    const expiring = db.mintPairingCode({ sessionId: "sess-T", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, clock.t).code;
    clock.t += TTL_MS + 1;
    const rTtl = await gw.handleInbound({ channel: "telegram", chatId: "dm-late", body: expiring, sender: { id: "late" } });
    check("dm-bind: an expired code is rejected (same silent reject)", rTtl.accepted === false && rTtl.reason === "chat-not-allowlisted");
    check("dm-bind: the expired code bound nothing", !db.listCompanionBindings().some((b) => b.chatId === "dm-late"));

    db.close();
  }

  // ============ Part C — group-sender: add the AUTHENTICATED sender; cross-session guard ============
  {
    const db = new Db(dbFile("C.db"));
    const clock = { t: 2_000_000 };
    // Two group bindings so the cross-session guard has a wrong target to try.
    db.upsertCompanionBinding({ sessionId: "sess-G", channel: "telegram", chatId: "group-1", scope: "group" });
    db.upsertCompanionBinding({ sessionId: "sess-H", channel: "telegram", chatId: "group-2", scope: "group" });
    const { gw, submitted, sent } = makeGateway(db, clock);

    const gcode = db.mintPairingCode({ sessionId: "sess-G", channel: "telegram", grantType: "group-sender", ttlMs: TTL_MS }, clock.t).code;
    const gcodeId = gcode.slice("pair_".length).split(".")[0];

    // An unlisted sender in group-1 redeems the group-sender code → added to sess-G's allowlist, NO submit.
    const r = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: gcode, sender: { id: "bob" } });
    check("group-sender: redemption → paired-sender for the group's session", r.accepted === false && r.reason === "paired-sender" && r.sessionId === "sess-G");
    check("group-sender: the code text was NOT submitted", submitted.length === 0);
    check("group-sender: a 'paired' ack was sent", r.acked === true && sent.length === 1 && /paired/i.test(sent[0].text));
    check("group-sender: the AUTHENTICATED sender is now allowlisted", db.isSenderAllowed("sess-G", "telegram", "bob") === true);
    check("group-sender: the code is consumed", db.getPairingCodeById(gcodeId)?.consumed_at != null);

    // That sender is now authorized: a normal message from bob submits to sess-G.
    const r2 = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: "hi team", sender: { id: "bob" } });
    check("group-sender: the newly-allowlisted sender now drives the session", r2.accepted === true && r2.sessionId === "sess-G" && submitted.length === 1 && submitted[0].text === "hi team");

    // Cross-session guard: a code minted for sess-G must NOT grant into group-2/sess-H.
    const gcode2 = db.mintPairingCode({ sessionId: "sess-G", channel: "telegram", grantType: "group-sender", ttlMs: TTL_MS }, clock.t).code;
    const gcode2Id = gcode2.slice("pair_".length).split(".")[0];
    const rX = await gw.handleInbound({ channel: "telegram", chatId: "group-2", body: gcode2, sender: { id: "carol" } });
    check("group-sender: a code for session A cannot grant into group B", rX.accepted === false && rX.reason === "sender-not-authorized");
    check("group-sender: carol was NOT added to the wrong group's allowlist", db.isSenderAllowed("sess-H", "telegram", "carol") === false);
    check("group-sender: the cross-session mismatch left the code UNCONSUMED", db.getPairingCodeById(gcode2Id)?.consumed_at == null);

    db.close();
  }

  // ============ Part D — rate-limit / lockout keyed per (channel, sender.id) ============
  {
    const db = new Db(dbFile("D.db"));
    const clock = { t: 3_000_000 };
    const { gw, submitted } = makeGateway(db, clock, { maxAttempts: 3 });

    // A genuinely valid dm-bind code exists the whole time — the lockout must reject it too once tripped.
    const valid = db.mintPairingCode({ sessionId: "sess-L", channel: "telegram", grantType: "dm-bind", ttlMs: 24 * 60 * TTL_MS }, clock.t).code;
    // Three WRONG (but code-shaped) guesses from the same sender → lock out. Nonexistent code id ⇒ invalid.
    const wrong = "pair_00000000-0000-0000-0000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (let i = 0; i < 3; i++) {
      const rw = await gw.handleInbound({ channel: "telegram", chatId: "atk", body: wrong, sender: { id: "attacker" } });
      check(`lockout: wrong guess #${i + 1} rejected (chat-not-allowlisted)`, rw.accepted === false && rw.reason === "chat-not-allowlisted");
    }
    // Now locked: even the VALID code from the SAME sender is rejected without binding anything.
    const rLocked = await gw.handleInbound({ channel: "telegram", chatId: "atk", body: valid, sender: { id: "attacker" } });
    check("lockout: a VALID code is rejected while locked out", rLocked.accepted === false && rLocked.reason === "chat-not-allowlisted");
    check("lockout: nothing was bound while locked", !db.listCompanionBindings().some((b) => b.chatId === "atk"));
    check("lockout: the valid code stayed UNCONSUMED under lockout", db.getPairingCodeById(valid.slice("pair_".length).split(".")[0])?.consumed_at == null);

    // A DIFFERENT sender is NOT locked — the lockout is keyed per (channel, sender.id).
    const other = db.mintPairingCode({ sessionId: "sess-L2", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, clock.t).code;
    const rOther = await gw.handleInbound({ channel: "telegram", chatId: "atk2", body: other, sender: { id: "innocent" } });
    check("lockout: a different sender is unaffected (per-sender key)", rOther.accepted === false && rOther.reason === "paired-dm");

    // The lock is time-bounded: after the lockout window the SAME sender's valid code redeems.
    clock.t += LOCKOUT_MS + 1;
    const rUnlocked = await gw.handleInbound({ channel: "telegram", chatId: "atk", body: valid, sender: { id: "attacker" } });
    check("lockout: unlocks after the lockout window (valid code then redeems)", rUnlocked.accepted === false && rUnlocked.reason === "paired-dm");
    check("lockout: never submitted a code body as a turn", submitted.length === 0);

    db.close();
  }

  // ============ Part E — NO pairing oracle + anti-spoof ============
  {
    const db = new Db(dbFile("E.db"));
    const clock = { t: 4_000_000 };
    db.upsertCompanionBinding({ sessionId: "sess-G", channel: "telegram", chatId: "grp", scope: "group" });
    const { gw, submitted } = makeGateway(db, clock);

    // No oracle (dm path): a wrong code to an UNBOUND chat yields the SAME reason as a plain message.
    const plain = await gw.handleInbound({ channel: "telegram", chatId: "unbound", body: "just chatting", sender: { id: "x" } });
    const wrongCode = await gw.handleInbound({ channel: "telegram", chatId: "unbound", body: "pair_11111111-1111-1111-1111-111111111111.ZZZZZZZZZZZZZZZZZZZZZZ", sender: { id: "x" } });
    check("no-oracle(dm): a wrong code and a plain message give the IDENTICAL reject", plain.reason === "chat-not-allowlisted" && wrongCode.reason === plain.reason);

    // No oracle (group path): an unlisted sender's wrong code == a plain unauthorized message.
    const plainG = await gw.handleInbound({ channel: "telegram", chatId: "grp", body: "hello", sender: { id: "stranger" } });
    const wrongG = await gw.handleInbound({ channel: "telegram", chatId: "grp", body: "pair_22222222-2222-2222-2222-222222222222.ZZZZZZZZZZZZZZZZZZZZZZ", sender: { id: "stranger" } });
    check("no-oracle(group): a wrong code and a plain message give the IDENTICAL reject", plainG.reason === "sender-not-authorized" && wrongG.reason === plainG.reason);

    // Anti-spoof: the bound id is ALWAYS the authenticated metadata id — a redeemer enrolls only THEMSELVES.
    const spoofCode = db.mintPairingCode({ sessionId: "sess-S", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, clock.t);
    const rSpoof = await gw.handleInbound({ channel: "telegram", chatId: "authentic-chat", body: spoofCode.code, sender: { id: "authentic-sender" } });
    check("anti-spoof: redemption paired the AUTHENTICATED chat", rSpoof.reason === "paired-dm");
    const bound = db.listCompanionBindings().find((b) => b.sessionId === "sess-S");
    check("anti-spoof: the binding is the authenticated chat.id, not any body content", !!bound && bound.chatId === "authentic-chat");
    check("anti-spoof: consumed_by records the authenticated sender.id", db.getPairingCodeById(spoofCode.codeId)?.consumed_by === "authentic-sender");

    check("no-oracle/anti-spoof: not one code body was submitted as a turn", submitted.length === 0);
    db.close();
  }

  // ============ Part F — dm-bind SILENT-TAKEOVER refusal + idempotent same-chat re-pair ============
  // A dm-bind code must never rebind a session that is ALREADY bound to a DIFFERENT chat (that would lock
  // out the current owner). Exercised directly against the db redemption unit for precision.
  {
    const db = new Db(dbFile("F.db"));
    const NOW = 5_000_000;
    const policy = { maxAttempts: 5, windowMs: 10 * 60_000, lockoutMs: LOCKOUT_MS };
    const parse = (plain) => ({ codeId: plain.slice("pair_".length, plain.indexOf(".")), secret: plain.slice(plain.indexOf(".") + 1) });
    const redeemDm = (plain, chatId, senderId, sessionOverride) => {
      const { codeId, secret } = parse(plain);
      return db.redeemPairingCode({ codeId, secret, channel: "telegram", senderId, chatId, expectedGrantType: "dm-bind", bindingSessionId: sessionOverride, ...policy }, NOW);
    };

    // (a) Takeover attempt: sess-A already bound to orig-chat; a valid code redeemed from a DIFFERENT chat.
    db.upsertCompanionBinding({ sessionId: "sess-A", channel: "telegram", chatId: "orig-chat", scope: "dm" });
    const cA = db.mintPairingCode({ sessionId: "sess-A", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, NOW);
    const rTakeover = redeemDm(cA.code, "attacker-chat", "mallory");
    check("takeover: a dm-bind code for an already-bound session (different chat) is REFUSED", rTakeover.outcome === "rejected");
    check("takeover: the existing binding is UNCHANGED", db.listCompanionBindings().find((b) => b.sessionId === "sess-A")?.chatId === "orig-chat");
    check("takeover: the refused code is NOT consumed", db.getPairingCodeById(cA.codeId)?.consumed_at == null);
    // …and after the human clears the old binding via admin, the SAME code legitimately rebinds.
    db.deleteCompanionBinding("sess-A");
    const rMoved = redeemDm(cA.code, "attacker-chat", "mallory");
    check("takeover: after the old binding is removed, the same code rebinds to the new chat", rMoved.outcome === "bound" && rMoved.chatId === "attacker-chat");
    check("takeover: that legit redemption consumed the code", db.getPairingCodeById(cA.codeId)?.consumed_at != null);

    // (b) Exact-same-chat re-pair is idempotent (allowed): sess-B bound to same-chat, code redeemed there.
    db.upsertCompanionBinding({ sessionId: "sess-B", channel: "telegram", chatId: "same-chat", scope: "dm" });
    const cB = db.mintPairingCode({ sessionId: "sess-B", channel: "telegram", grantType: "dm-bind", ttlMs: TTL_MS }, NOW);
    const rSame = redeemDm(cB.code, "same-chat", "owner");
    check("re-pair: an exact-same-chat re-pair succeeds (idempotent)", rSame.outcome === "bound" && rSame.chatId === "same-chat");
    check("re-pair: the binding is unchanged + the code consumed", db.listCompanionBindings().find((b) => b.sessionId === "sess-B")?.chatId === "same-chat" && db.getPairingCodeById(cB.codeId)?.consumed_at != null);

    db.close();
  }

  // ============ Injection sweep — NO pairing code plaintext EVER reached the submit primitive ============
  check("injection: no `pair_`-shaped body ever reached submitTurn across the whole run", allSubmittedTexts.every((t) => !t.startsWith("pair_")));
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Companion DM-pairing holds: mint is human-only REST (plaintext once, salted hash at rest); a dm-bind code binds the AUTHENTICATED chat.id and routes thereafter; a group-sender code allowlists the AUTHENTICATED sender; codes are single-use + TTL-bounded; a code for one session can't grant into another; N wrong guesses lock out (per sender, time-bounded) even a valid code; failures are an indistinguishable silent reject (no oracle); and no code body ever reached the agent turn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

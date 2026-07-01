import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion (SECURITY): unbind ALSO CASCADE-clears unconsumed companion_pairing_codes — the
// two-path-asymmetry fix vs the full-teardown `deleteCompanionConfig` (which already cleared codes).
// Concrete threat closed: owner mints a group-sender code for (S, telegram) → unbinds → re-binds → a
// sender redeems the still-unexpired/unconsumed code (redeemPairingCode requires no active binding for
// dm-bind, and for group-sender only checks the code's own session match) → the freshly-emptied allowlist
// gets re-populated. Fully hermetic: a REAL Db, no live network, no real claude, no daemon.
//   (1) PER-CHANNEL unbind deletes the unconsumed pairing code for that (session, channel) — it can no
//       longer be redeemed, and a re-bind of the SAME (session, channel) still starts with an EMPTY
//       allowlist even though the code was minted before the unbind.
//   (2) A per-channel unbind leaves the OTHER channel's (and another session's) pairing codes untouched.
//   (3) Delete-ALL (channel omitted) clears every pairing code for the session, across every channel —
//       other sessions' codes untouched.
//   (4) companion_pairing_attempts is DELIBERATELY LEFT — a lockout row for (channel, sender) SURVIVES
//       both a per-channel and a delete-all unbind (mirrors deleteCompanionConfig).
// Sibling coverage: the companion_allowed_senders cascade (this same fix's earlier half, ff0a3368) is in
// companion-unbind-cascade.mjs; the pairing-code lifecycle (mint/redeem/lockout) is in companion-pairing.mjs.
// Run: 1) build (turbo builds shared first), 2) node test/companion-unbind-pairing-codes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-unbind-pairing-codes-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

const TELEGRAM = "telegram";
const TTL_MS = 10 * 60_000;
const dbFile = (name) => path.join(tmpHome, name);
const parse = (plain) => ({ codeId: plain.slice("pair_".length, plain.indexOf(".")), secret: plain.slice(plain.indexOf(".") + 1) });
const policy = { maxAttempts: 5, windowMs: 10 * 60_000, lockoutMs: 15 * 60_000 };

try {
  // ============ Part 1 — per-channel unbind deletes the unconsumed code; re-bind stays empty ============
  {
    const db = new Db(dbFile("p1.db"));
    const sid = "sess-code-cascade";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "group-1", scope: "group" });
    const minted = db.mintPairingCode({ sessionId: sid, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, 1_000_000);
    check("(1) the code row exists before unbind", !!db.getPairingCodeById(minted.codeId));

    db.deleteCompanionBinding(sid, TELEGRAM);
    check("(1) the code row is GONE after per-channel unbind", db.getPairingCodeById(minted.codeId) === undefined);

    const { codeId, secret } = parse(minted.code);
    const r = db.redeemPairingCode(
      { codeId, secret, channel: TELEGRAM, senderId: "bob", chatId: "group-1", expectedGrantType: "group-sender", bindingSessionId: sid, ...policy },
      1_000_001,
    );
    check("(1) the deleted code can no longer be redeemed", r.outcome === "rejected");

    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "group-1-new", scope: "group" });
    check("(1) a re-bind of the SAME (session, channel) starts EMPTY despite the prior outstanding code", db.listAllowedSenders(sid).filter((s) => s.channel === TELEGRAM).length === 0);
    db.close();
  }

  // ============ Part 2 — the OTHER channel's (and another session's) pairing codes are UNTOUCHED ============
  {
    const db = new Db(dbFile("p2.db"));
    const sid = "sess-code-other-channel";
    const other = "sess-code-other-session";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat", scope: "group" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "group" });
    db.upsertCompanionBinding({ sessionId: other, channel: TELEGRAM, chatId: "tg-chat-other", scope: "group" });
    const codeTelegram = db.mintPairingCode({ sessionId: sid, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, 2_000_000);
    const codeInApp = db.mintPairingCode({ sessionId: sid, channel: IN_APP_CHANNEL, grantType: "group-sender", ttlMs: TTL_MS }, 2_000_000);
    const codeOtherSession = db.mintPairingCode({ sessionId: other, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, 2_000_000);

    db.deleteCompanionBinding(sid, TELEGRAM);
    check("(2) the unbound channel's code is gone", db.getPairingCodeById(codeTelegram.codeId) === undefined);
    check("(2) the OTHER channel's (in-app) code on the SAME session survives", !!db.getPairingCodeById(codeInApp.codeId));
    check("(2) the SAME channel's code on a DIFFERENT session survives", !!db.getPairingCodeById(codeOtherSession.codeId));
    db.close();
  }

  // ============ Part 3 — delete-ALL clears every code for the session; other sessions untouched ============
  {
    const db = new Db(dbFile("p3.db"));
    const sid = "sess-code-delete-all";
    const other = "sess-code-delete-all-other";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat-3", scope: "group" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "group" });
    db.upsertCompanionBinding({ sessionId: other, channel: TELEGRAM, chatId: "tg-chat-3-other", scope: "group" });
    const c1 = db.mintPairingCode({ sessionId: sid, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, 3_000_000);
    const c2 = db.mintPairingCode({ sessionId: sid, channel: IN_APP_CHANNEL, grantType: "group-sender", ttlMs: TTL_MS }, 3_000_000);
    const cOther = db.mintPairingCode({ sessionId: other, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, 3_000_000);

    db.deleteCompanionBinding(sid);
    check("(3) delete-ALL clears every pairing code for the session (telegram)", db.getPairingCodeById(c1.codeId) === undefined);
    check("(3) delete-ALL clears every pairing code for the session (in-app)", db.getPairingCodeById(c2.codeId) === undefined);
    check("(3) a DIFFERENT session's code is untouched by delete-ALL", !!db.getPairingCodeById(cOther.codeId));

    // Idempotent: re-running delete-all (or a per-channel unbind) on an already-cleared session is a safe no-op.
    let threw = false;
    try { db.deleteCompanionBinding(sid); db.deleteCompanionBinding(sid, TELEGRAM); } catch { threw = true; }
    check("(3) re-running the cascade delete on an already-cleared session is a safe no-op (no throw)", threw === false);
    db.close();
  }

  // ============ Part 4 — companion_pairing_attempts lockout SURVIVES unbind (deliberately left) ============
  {
    const db = new Db(dbFile("p4.db"));
    const sid = "sess-code-lockout-survives";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "group-lock", scope: "group" });
    const NOW = 4_000_000;
    const attackerPolicy = { maxAttempts: 3, windowMs: 10 * 60_000, lockoutMs: 15 * 60_000 };
    const wrong = { codeId: "00000000-0000-0000-0000-000000000000", secret: "wrong-secret" };

    // Three wrong attempts from the same (channel, sender) trip the lockout.
    for (let i = 0; i < 3; i++) {
      const rw = db.redeemPairingCode(
        { ...wrong, channel: TELEGRAM, senderId: "attacker", chatId: "group-lock", expectedGrantType: "group-sender", bindingSessionId: sid, ...attackerPolicy },
        NOW + i,
      );
      check(`(4) seeding lockout — wrong guess #${i + 1} rejected`, rw.outcome === "rejected");
    }

    // Per-channel unbind of a DIFFERENT (session, channel) must not disturb the lockout row (different table/key).
    db.deleteCompanionBinding(sid, TELEGRAM);

    // A genuinely VALID fresh code from the SAME locked-out (channel, sender) is still rejected — the
    // companion_pairing_attempts row survived the unbind and is still enforcing.
    const fresh = db.mintPairingCode({ sessionId: sid, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, NOW);
    const { codeId, secret } = parse(fresh.code);
    const rLocked = db.redeemPairingCode(
      { codeId, secret, channel: TELEGRAM, senderId: "attacker", chatId: "group-lock", expectedGrantType: "group-sender", bindingSessionId: sid, ...attackerPolicy },
      NOW + 3,
    );
    check("(4) the lockout SURVIVES the unbind — even a valid fresh code from the locked-out sender is rejected", rLocked.outcome === "rejected");

    // Delete-ALL must not disturb it either.
    db.deleteCompanionBinding(sid);
    const fresh2 = db.mintPairingCode({ sessionId: sid, channel: TELEGRAM, grantType: "group-sender", ttlMs: TTL_MS }, NOW);
    const parsed2 = parse(fresh2.code);
    const rLocked2 = db.redeemPairingCode(
      { codeId: parsed2.codeId, secret: parsed2.secret, channel: TELEGRAM, senderId: "attacker", chatId: "group-lock", expectedGrantType: "group-sender", bindingSessionId: sid, ...attackerPolicy },
      NOW + 4,
    );
    check("(4) the lockout also SURVIVES a delete-ALL unbind", rLocked2.outcome === "rejected");
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbind ALSO cascade-clears unconsumed companion_pairing_codes: a per-channel unbind deletes that (session, channel)'s outstanding code (it can no longer be redeemed, and a re-bind starts EMPTY despite it), the other channel's/session's codes are untouched, delete-ALL clears every code for the session (other sessions untouched), and a companion_pairing_attempts lockout row SURVIVES both unbind shapes (deliberately left, unlike pairing_codes)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

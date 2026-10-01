import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — a RUNTIME-set `flagged_non_private` must survive a SAME-ROUTE re-bind (card c7d7b43a,
// part B; from the ddf08614 delta review, reviewer 030f7f60). `db.upsertCompanionBinding`'s ON CONFLICT
// used to recompute `flagged_non_private` from the chatId SHAPE alone on EVERY write — but the flag can
// also be set at RUNTIME (`flagCompanionBindingNonPrivate`, called when an inbound arrives that the channel
// did NOT confirm as private), independent of chatId shape: a perfectly numeric-looking dm chatId can still
// turn out to be a group in practice. Since the shape recompute ran unconditionally, re-submitting the
// EXACT SAME (chatId, scope) — nothing about the route actually changing — silently LAUNDERED a
// runtime-observed flag. `validateHomeTarget`'s advice text implied a deliberate fix was needed, but ANY
// re-bind, even a no-op resubmission, used to clear it.
//
// Fully hermetic: a REAL Db (proves persistence) — NO gateway, NO network, NO real claude, NO daemon.
//
// Covers:
//   1. THE BUG, reproduced directly: a positive-chatId dm binding (shape says NOT flagged) is flagged at
//      RUNTIME, then re-bound to the EXACT SAME (chatId, scope) — the flag must survive. This is the
//      assertion that was RED before this card's db.ts fix (see worker report for the revert/rebuild proof).
//   2. REMEDY A: re-binding the SAME flagged route to a genuinely DIFFERENT chatId clears the flag — an
//      actual chat change IS the "explicit human action" that resets it.
//   3. REMEDY B: re-binding the SAME flagged route (same chatId) to a DIFFERENT scope ("group") clears the
//      flag — an actual scope change is ALSO an explicit human action.
//   4. NEGATIVE CONTROL: an UNFLAGGED binding re-bound to the exact same (chatId, scope) stays unflagged —
//      this path never spuriously introduces a flag.
//   5. NEGATIVE CONTROL: a FRESH bind (no existing row at all) is unaffected by this logic — computed from
//      shape alone, exactly as before.
//   6. Idempotent: repeated same-route re-binds of an already-runtime-flagged route stay flagged across
//      MULTIPLE re-binds, not just one.
// Run: 1) build (turbo builds shared first), 2) node test/companion-runtime-flag-survives-rebind.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-runtime-flag-rebind-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

try {
  // ============ 1 — THE BUG: a runtime-set flag on a POSITIVE chatId must survive a SAME-ROUTE re-bind ====
  {
    const sess = "sess-runtime-flag";
    const b0 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "123123123", scope: "dm" });
    check("(1 setup) a fresh positive-chatId dm bind starts unflagged (shape alone)", b0.flaggedNonPrivate === false);

    // Simulate a runtime-observed non-private inbound (chat-gateway.ts's warnUnconfirmedDirectInbound would
    // call this) — independent of chatId shape.
    db.flagCompanionBindingNonPrivate(sess, TELEGRAM_CHANNEL);
    check("(1 setup) the runtime flag is now set", db.listCompanionBindings().find((b) => b.sessionId === sess)?.flaggedNonPrivate === true);

    // THE EXACT LAUNDERING THIS CARD CLOSES: re-submit the IDENTICAL (chatId, scope) — nothing about the
    // route actually changed. Before the fix, upsertCompanionBinding always recomputed flagged_non_private
    // from shape alone, silently clearing this to false.
    const b1 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "123123123", scope: "dm" });
    check("(1) a SAME-ROUTE re-bind (identical chatId + scope) does NOT clear a runtime-set flag", b1.flaggedNonPrivate === true);
    check("(1) persisted: the re-bound row is still flagged", db.listCompanionBindings().find((b) => b.sessionId === sess)?.flaggedNonPrivate === true);
  }

  // ============ 2 — REMEDY A: re-binding to a genuinely DIFFERENT chatId clears the flag =================
  {
    const sess = "sess-remedy-new-chat";
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "222222222", scope: "dm" });
    db.flagCompanionBindingNonPrivate(sess, TELEGRAM_CHANNEL);
    check("(2 setup) the runtime flag is set", db.listCompanionBindings().find((b) => b.sessionId === sess)?.flaggedNonPrivate === true);

    const b1 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "999999999", scope: "dm" });
    check("(2) re-binding to a DIFFERENT chatId clears the flag (a genuine chat change is explicit enough)", b1.flaggedNonPrivate === false);
  }

  // ============ 3 — REMEDY B: re-binding the SAME chatId to a DIFFERENT scope clears the flag ============
  {
    const sess = "sess-remedy-new-scope";
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "333333333", scope: "dm" });
    db.flagCompanionBindingNonPrivate(sess, TELEGRAM_CHANNEL);
    check("(3 setup) the runtime flag is set", db.listCompanionBindings().find((b) => b.sessionId === sess)?.flaggedNonPrivate === true);

    const b1 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "333333333", scope: "group" });
    check("(3) re-binding the SAME chatId to scope \"group\" clears the flag (an explicit scope change)", b1.flaggedNonPrivate === false);
  }

  // ============ 4 — NEGATIVE CONTROL: an UNFLAGGED same-route re-bind never introduces a flag ============
  {
    const sess = "sess-ordinary-no-flag";
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "444444444", scope: "dm" });
    const b1 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "444444444", scope: "dm" });
    check("(4 control) an ordinary same-route re-bind with no runtime flag stays unflagged", b1.flaggedNonPrivate === false);
  }

  // ============ 5 — NEGATIVE CONTROL: a FRESH bind (no existing row) is unaffected by this logic =========
  {
    const sess = "sess-fresh-bind-only";
    const b0 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "-1005554443332", scope: "dm" });
    check("(5 control) a FRESH dm bind with a negative chatId is still flagged from shape alone (61e33b99 unaffected)", b0.flaggedNonPrivate === true);
  }

  // ============ 6 — IDEMPOTENT: the runtime flag survives MULTIPLE consecutive same-route re-binds =======
  {
    const sess = "sess-multi-rebind";
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "555555555", scope: "dm" });
    db.flagCompanionBindingNonPrivate(sess, TELEGRAM_CHANNEL);
    const b1 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "555555555", scope: "dm" });
    const b2 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "555555555", scope: "dm" });
    const b3 = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "555555555", scope: "dm" });
    check("(6) the runtime flag survives THREE consecutive same-route re-binds", b1.flaggedNonPrivate === true && b2.flaggedNonPrivate === true && b3.flaggedNonPrivate === true);
  }
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — db.upsertCompanionBinding now preserves a RUNTIME-set flagged_non_private flag across a SAME-ROUTE (identical chatId + scope) re-bind, instead of silently recomputing it from chatId shape alone on every write; a genuine chatId change OR an explicit scope change still clears it in the same write (the real remedy, unchanged), an unflagged route re-bound to the same route stays unflagged, a fresh bind is still computed from shape alone, and the preserved flag survives repeated consecutive re-binds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

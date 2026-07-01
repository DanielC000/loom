import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion (SECURITY): unbind CASCADE-clears companion_allowed_senders (PL + Lead ruling:
// least-privilege on an auth boundary — a re-bind of the same (session, channel) must start with an
// EMPTY allowlist, never inherit a prior grant). Fully hermetic: a REAL Db, no live network, no real
// claude, no daemon.
//   (1) PER-CHANNEL unbind (db.deleteCompanionBinding(sid, channel)) cascade-clears ONLY that channel's
//       allowlist rows — the OTHER channel's allowlist is untouched.
//   (2) A re-bind of the SAME (session, channel) after unbind starts with an EMPTY allowlist — it never
//       resurrects the cleared grant.
//   (3) Delete-ALL (channel omitted) cascade-clears every allowlist row for the session, across every
//       channel it was bound on.
// Sibling coverage: per-channel unbind leaving the OTHER channel's binding/routing/authz intact is in
// companion-multichannel.mjs (Part 5); the durable binding/allowlist round-trip + unique route index is
// in companion-authz.mjs.
// Run: 1) build (turbo builds shared first), 2) node test/companion-unbind-cascade.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-unbind-cascade-${Date.now()}-${process.pid}`);
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
const dbFile = (name) => path.join(tmpHome, name);

try {
  // ============ Part 1 — per-channel unbind cascade-clears ONLY that channel's allowlist ============
  {
    const db = new Db(dbFile("p1.db"));
    const sid = "sess-allowlist-cascade";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat", scope: "group" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "group" });
    db.addAllowedSender({ sessionId: sid, channel: TELEGRAM, senderId: "alice", label: "Alice" });
    db.addAllowedSender({ sessionId: sid, channel: IN_APP_CHANNEL, senderId: "bob", label: "Bob" });
    check("both channels' allowlists seeded before unbind", db.listAllowedSenders(sid).length === 2);
    check("telegram allowlist admits alice pre-unbind", db.isSenderAllowed(sid, TELEGRAM, "alice") === true);

    db.deleteCompanionBinding(sid, TELEGRAM);
    check("(1) telegram allowlist row is GONE after per-channel unbind", db.isSenderAllowed(sid, TELEGRAM, "alice") === false);
    check("(1) the OTHER channel's (in-app) allowlist is UNTOUCHED", db.isSenderAllowed(sid, IN_APP_CHANNEL, "bob") === true);
    check("(1) only the in-app allowlist row remains", db.listAllowedSenders(sid).length === 1 && db.listAllowedSenders(sid)[0].channel === IN_APP_CHANNEL);
    db.close();
  }

  // ============ Part 2 — a re-bind of the SAME (session, channel) starts with an EMPTY allowlist ============
  {
    const db = new Db(dbFile("p2.db"));
    const sid = "sess-rebind-empty";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat-2", scope: "group" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "group" });
    db.addAllowedSender({ sessionId: sid, channel: TELEGRAM, senderId: "alice", label: "Alice" });
    db.addAllowedSender({ sessionId: sid, channel: IN_APP_CHANNEL, senderId: "bob", label: "Bob" });

    db.deleteCompanionBinding(sid, TELEGRAM);
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat-2b", scope: "group" });
    check("(2) re-bind of telegram starts EMPTY (no allowlist rows for that channel)", db.listAllowedSenders(sid).filter((s) => s.channel === TELEGRAM).length === 0);
    check("(2) re-bind does not resurrect the old grant", db.isSenderAllowed(sid, TELEGRAM, "alice") === false);
    check("(2) the untouched in-app allowlist survived the telegram re-bind", db.isSenderAllowed(sid, IN_APP_CHANNEL, "bob") === true);
    db.close();
  }

  // ============ Part 3 — delete-ALL (channel omitted) cascade-clears every allowlist row for the session ============
  {
    const db = new Db(dbFile("p3.db"));
    const sid = "sess-delete-all-cascade";
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "tg-chat-3", scope: "group" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "group" });
    db.addAllowedSender({ sessionId: sid, channel: TELEGRAM, senderId: "alice", label: "Alice" });
    db.addAllowedSender({ sessionId: sid, channel: IN_APP_CHANNEL, senderId: "bob", label: "Bob" });
    check("(3) allowlist has rows on both channels before delete-all", db.listAllowedSenders(sid).length === 2);

    db.deleteCompanionBinding(sid);
    check("(3) delete-ALL clears every allowlist row for the session", db.listAllowedSenders(sid).length === 0);

    // Idempotent: re-running delete-all (or a per-channel unbind) on an already-cleared session is a safe no-op.
    let threw = false;
    try { db.deleteCompanionBinding(sid); db.deleteCompanionBinding(sid, TELEGRAM); } catch { threw = true; }
    check("(3) re-running the cascade delete on an already-cleared session is a safe no-op (no throw)", threw === false);
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbind CASCADE-clears companion_allowed_senders: a per-channel unbind clears ONLY that channel's allowlist rows (the other channel's untouched), a re-bind of the SAME (session, channel) starts EMPTY (never resurrects the cleared grant), and delete-ALL clears every allowlist row for the session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — auto-revive (bug 4cc7826d): an enabled+provisioned companion has no human viewer to
// notice a dead bound session and click "Resume" (unlike a manager/worker), so it would otherwise stay
// dead across every restart/crash — every inbound permanently drawing "session isn't currently running".
// Fully hermetic: pure functions over an INJECTED {isAlive, resume} seam (reviveCompanionSessionAtBoot) /
// {resume} seam (withCompanionSelfHeal) — mirrors HeartbeatPty's pty seam — NO real db/pty/claude/daemon.
// Asserts the card DoD:
//   1. reviveCompanionSessionAtBoot: a null config is a no-op (default-OFF byte-identical); an ALREADY-LIVE
//      session's bound resume is never called (resume() itself also short-circuits — this asserts the
//      caller doesn't even try); a DEAD session gets exactly one resume() call + an info log; a resume that
//      THROWS (deleted project / missing worktree / superseded row) is swallowed with a warn log, never
//      thrown up (must never gate boot).
//   2. withCompanionSelfHeal: a delivered or queued (position defined) result passes through with NO resume
//      call — the ONLY trigger is the exact dead-session signal ({delivered:false, position:undefined});
//      on that signal it resumes exactly once then retries submit exactly once more. The retry is NOT
//      guaranteed to deliver synchronously — a freshly-(re)spawned pty is alive-but-not-ready, so a
//      successful revive can retry into EITHER an immediate deliver OR a queued (position defined) hold;
//      both are asserted, and either way the caller sees the RETRY's result verbatim. A resume that throws
//      returns the ORIGINAL dead result unchanged with NO second submit call.
// Run: 1) build (turbo builds shared first), 2) node test/companion-revive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (not actually touched by this module, but every daemon test sets it). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-revive-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { reviveCompanionSessionAtBoot, withCompanionSelfHeal } = await import("../dist/companion/revive.js");

const cfg = { sessionId: "s1" };

// --- 1. reviveCompanionSessionAtBoot ---

{
  let resumeCalls = 0;
  const log = { info: () => {}, warn: () => {} };
  reviveCompanionSessionAtBoot(null, { isAlive: () => { throw new Error("must not be called"); }, resume: () => resumeCalls++ }, log);
  check("boot-revive: null config never touches isAlive/resume", resumeCalls === 0);
}

{
  let resumeCalls = 0;
  const log = { info: () => {}, warn: () => {} };
  reviveCompanionSessionAtBoot(cfg, { isAlive: () => true, resume: () => resumeCalls++ }, log);
  check("boot-revive: an already-live session's resume is never called", resumeCalls === 0);
}

{
  const calls = { info: [], warn: [] };
  const log = { info: (m) => calls.info.push(m), warn: (m) => calls.warn.push(m) };
  let resumeCalls = 0;
  let resumedId = null;
  reviveCompanionSessionAtBoot(cfg, { isAlive: () => false, resume: (id) => { resumeCalls++; resumedId = id; } }, log);
  check("boot-revive: a dead session's resume is called exactly once", resumeCalls === 1);
  check("boot-revive: resume is called with the config's sessionId", resumedId === "s1");
  check("boot-revive: a successful revive logs info, not warn", calls.info.length === 1 && calls.warn.length === 0);
}

{
  const calls = { info: [], warn: [] };
  const log = { info: (m) => calls.info.push(m), warn: (m) => calls.warn.push(m) };
  let threw = false;
  try {
    reviveCompanionSessionAtBoot(cfg, { isAlive: () => false, resume: () => { throw new Error("worktree/cwd missing"); } }, log);
  } catch {
    threw = true;
  }
  check("boot-revive: a throwing resume never escapes (must not gate boot)", threw === false);
  check("boot-revive: a failed revive logs warn, not info", calls.warn.length === 1 && calls.info.length === 0);
  check("boot-revive: the warn log names the underlying failure", calls.warn[0].includes("worktree/cwd missing"));
}

// --- 2. withCompanionSelfHeal ---

function fakeSubmit(results) {
  const calls = [];
  let i = 0;
  const submit = (sessionId, text, route) => {
    calls.push({ sessionId, text, route });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
  return { submit, calls };
}

{
  const { submit, calls } = fakeSubmit([{ delivered: true }]);
  let resumeCalls = 0;
  const healed = withCompanionSelfHeal(submit, { resume: () => resumeCalls++ });
  const result = healed("s1", "hi");
  check("self-heal: a delivered result passes through unchanged", result.delivered === true);
  check("self-heal: a delivered result never triggers a resume", resumeCalls === 0);
  check("self-heal: a delivered result submits exactly once", calls.length === 1);
}

{
  const { submit, calls } = fakeSubmit([{ delivered: false, position: 3 }]);
  let resumeCalls = 0;
  const healed = withCompanionSelfHeal(submit, { resume: () => resumeCalls++ });
  const result = healed("s1", "hi");
  check("self-heal: a QUEUED result (position defined) never triggers a resume", resumeCalls === 0);
  check("self-heal: a queued result passes through unchanged", result.delivered === false && result.position === 3);
  check("self-heal: a queued result submits exactly once", calls.length === 1);
}

{
  // A successful revive's retry can deliver IMMEDIATELY (a rare fast-ready pty) — asserted here; the more
  // realistic "revive then QUEUE" case (a freshly-(re)spawned pty is alive-but-not-ready) is the next block.
  const { submit, calls } = fakeSubmit([{ delivered: false }, { delivered: true }]);
  let resumeCalls = 0;
  let resumedId = null;
  const healed = withCompanionSelfHeal(submit, { resume: (id) => { resumeCalls++; resumedId = id; } });
  const result = healed("s1", "hi", { channel: "telegram", chatId: "42" });
  check("self-heal: a DEAD result (no position) triggers exactly one resume", resumeCalls === 1);
  check("self-heal: the resume targets the inbound's sessionId", resumedId === "s1");
  check("self-heal: a successful revive retries submit exactly once more (2 total)", calls.length === 2);
  check("self-heal: the retry carries the SAME text + route (not a new turn shape)", calls[1].text === "hi" && calls[1].route?.chatId === "42");
  check("self-heal: the caller sees the RETRY's result, not the original dead one", result.delivered === true);
}

{
  // The REALISTIC production outcome: a resumed session's pty is alive-but-not-ready yet, so the retry
  // QUEUES ({delivered:false, position:N}) rather than delivering synchronously — chat-gateway acks this
  // as "held", not "session-dead". The wrapper must surface the QUEUED result verbatim, not paper over it.
  const { submit, calls } = fakeSubmit([{ delivered: false }, { delivered: false, position: 1 }]);
  let resumeCalls = 0;
  const healed = withCompanionSelfHeal(submit, { resume: () => resumeCalls++ });
  const result = healed("s1", "hi");
  check("self-heal (post-resume queue): resume is called exactly once", resumeCalls === 1);
  check("self-heal (post-resume queue): submit runs exactly twice (original + retry)", calls.length === 2);
  check("self-heal (post-resume queue): the caller sees the RETRY's QUEUED result unchanged", result.delivered === false && result.position === 1);
}

{
  const { submit, calls } = fakeSubmit([{ delivered: false }]);
  const healed = withCompanionSelfHeal(submit, { resume: () => { throw new Error("session was recycled"); } });
  const result = healed("s1", "hi");
  check("self-heal: an unresumable dead session submits only ONCE (no wasted retry)", calls.length === 1);
  check("self-heal: an unresumable dead session returns the ORIGINAL dead result", result.delivered === false && result.position === undefined);
}

console.log(failures === 0 ? "\n✅ ALL PASS — an enabled companion's dead session is revived at boot and self-heals on inbound, with no gate ordering regression." : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

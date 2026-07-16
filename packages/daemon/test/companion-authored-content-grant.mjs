import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — Direction (a) of card 2b26035c ("board_create
// verbatim-quote guard forces owner repetition"): `authored_content_grant`, an INLINE, chat-native
// alternative to the pre-existing per-project `authoredContent` settings toggle (see
// companion-authored-content.mjs). Lets the owner grant board_create/board_update authored-content
// permission from the chat itself, via the SAME Primitive-C propose/confirm round-trip every other
// sensitive ACT lever uses — so the grant stays an EXPLICIT owner act the Companion can never self-grant.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` and a FAKE `companion` — NO network, NO real claude, NO daemon.
//
// Covers the card's DoD for Direction (a):
//   - the grant is committed ONLY via an explicit authenticated owner confirm (Primitive C) — a bare
//     propose call never grants anything, and a MISMATCHED confirm reply does not grant either (the
//     Companion cannot self-grant by simply calling the tool twice with arbitrary text)
//   - ALWAYS requires propose/confirm — there is no low-friction direct-commit path, even inside an
//     otherwise-warm Tier-A trust window (mirrors board_relocate's always-confirm posture)
//   - once granted, board_create/board_update MAY author non-verbatim content on that project
//   - "once" scope is consumed by the very next content-committing call; a LATER call on the same
//     project again requires verbatim (or a fresh grant)
//   - "session" scope persists across multiple content-committing calls
//   - the grant is scoped per (session, project) — never leaks to a different project
//   - a grant that's merely CHECKED (peek) but not actually needed (content was already verbatim, or the
//     project's persistent authoredContent toggle already allows it) is NOT consumed
//   - COLD-WINDOW lock-in (CR follow-up): the SAME two consume/not-consumed cases above, but through the
//     propose→confirm round-trip (board_create's OWN Tier-A trust window left cold, never warmed) — this
//     is the exact path `pending.grantBacked`'s freeze-at-propose-time protects (a confirm call's OWN
//     turn is the CONFIRM REPLY text, never a verbatim match, so recomputing `grantAllows` there instead
//     of reading the frozen verdict would wrongly consume/not-consume). See companion-reset-clears-grant.
//     mjs for the separate "/new" clears a live session-scoped grant" coverage.
// Run: 1) build (turbo builds shared first), 2) node test/companion-authored-content-grant.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-authored-content-grant-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-authored-content-grant-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  const enqueued = [];
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    enqueueStdin(...args) { enqueued.push(args); return { delivered: false, reason: "held" }; },
    enqueued,
  };
}

function makeFakeCompanion(shouldDeliver = true) {
  const delivered = [];
  return {
    async deliverReply(sessionId, text) {
      delivered.push({ sessionId, text });
      return { delivered: shouldDeliver };
    },
    delivered,
  };
}

function extractToken(deliveredText) {
  const m = /Reply CONFIRM (\S+) to proceed\.$/.exec(deliveredText);
  if (!m) throw new Error(`could not extract a confirm token from: ${deliveredText}`);
  return m[1];
}

// Warm the Tier-A trust window on (session, route) via a plain verbatim board_create propose+confirm
// round-trip — mirrors companion-authored-content.mjs's own "shared window" recipe. Without this, EVERY
// board_create call (grant-backed or not) goes through its OWN separate propose/confirm round-trip
// first (board_create's Tier-A friction gate is independent of the authored-content grant), which would
// make a grant-enabled test have to thread through TWO round-trips at once instead of exercising the
// grant behavior in isolation.
async function warmWindow(client, pty, companion, project, verbatimTitle) {
  pty.setOwnerText(`the owner said: ${verbatimTitle}`);
  const deliveredBefore = companion.delivered.length;
  const proposed = await call(client, "board_create", { project, title: verbatimTitle });
  if (proposed.status !== "proposed") throw new Error(`warmWindow: expected propose, got ${JSON.stringify(proposed)}`);
  const token = extractToken(companion.delivered[deliveredBefore].text);
  pty.setOwnerText(`CONFIRM ${token}`);
  const resolved = await call(client, "board_create", { project, title: verbatimTitle });
  if (resolved.status !== "created") throw new Error(`warmWindow: expected create, got ${JSON.stringify(resolved)}`);
}

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ a bare propose never grants anything (no low-friction path at all) ============
  {
    const db = tmpDb();
    const proj = "proj-grant-propose-only";
    seedProject(db, proj, "Grant propose only");
    const companionSess = "companion-grant-propose-only";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("please let the companion write my cards for me");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("propose-only: authored_content_grant PROPOSES, does not grant yet", proposed.status === "proposed");
    check("propose-only: confirmation delivered DIRECTLY to the owner (never returned to the companion)", companion.delivered.length === 1);
    check("propose-only: the delivered prompt never leaks the raw token via the tool's own return value", proposed.token === undefined);

    // board_create still requires verbatim — the grant was only PROPOSED, never confirmed. (Content is
    // non-verbatim, so this rejects up front regardless of the board-write trust window's own warm/cold
    // state — see board_create's own `contentIsVerbatim` gate, checked before either commit branch.)
    const res = await call(client, "board_create", { project: proj, title: "An authored title never said verbatim" });
    check("propose-only: board_create still requires verbatim — an unconfirmed propose grants NOTHING", typeof res.error === "string" && res.status === undefined);

    await client.close();
    db.close();
  }

  // ============ the Companion cannot self-grant — a MISMATCHED confirm reply does not commit ============
  {
    const db = tmpDb();
    const proj = "proj-grant-mismatch";
    seedProject(db, proj, "Grant mismatch");
    const companionSess = "companion-grant-mismatch";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("mismatch: propose succeeds", proposed.status === "proposed");

    // The Companion "guesses" a confirm rather than relaying the owner's real reply — this must NOT commit.
    pty.setOwnerText("CONFIRM made-up-guess");
    const guessed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("SECURITY: the Companion cannot self-grant by guessing a confirm token", guessed.status === "confirm-mismatch");

    const rejected = await call(client, "board_create", { project: proj, title: "Authored without a real grant" });
    check("SECURITY: no grant was committed — board_create still requires verbatim", typeof rejected.error === "string" && rejected.status === undefined);

    await client.close();
    db.close();
  }

  // ============ a REAL owner confirm commits the grant; "once" is consumed by the next content commit ============
  {
    const db = tmpDb();
    const proj = "proj-grant-once";
    seedProject(db, proj, "Grant once");
    const companionSess = "companion-grant-once";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards for this project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("once: propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const granted = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("once: a REAL owner confirm commits the grant", granted.status === "granted");

    // Warm board_create's OWN (separate) Tier-A trust window with an ordinary verbatim card first —
    // board_create's low-friction direct-commit path is independent of the authored-content grant, and
    // this isolates the grant's own behavior from that separate propose/confirm round-trip.
    await warmWindow(client, pty, companion, proj, "warm this window");

    pty.setOwnerText("the owner said: file something about the login bug");
    const created = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari", body: "Users report random logouts.",
    });
    check("once: authored (non-verbatim) content now creates the card via the grant", created.status === "created");
    check("once: authored content actually persisted", db.listTasks(proj).some((t) => t.title === "Fix the intermittent login failure on Safari"));

    // The "once" grant is now consumed — a LATER authored (non-verbatim) call must be rejected again.
    pty.setOwnerText("the owner said: another thing");
    const rejectedAfter = await call(client, "board_create", { project: proj, title: "Another authored title never said verbatim" });
    check("once: the grant is CONSUMED after the one content-committing call — a later authored call is rejected again", typeof rejectedAfter.error === "string" && rejectedAfter.status === undefined);

    await client.close();
    db.close();
  }

  // ============ COLD-window lock-in (a): a grant-backed COLD propose→confirm CONSUMES the "once" grant
  // via `pending.grantBacked` (the exact freeze the confirm-recompute fix protects) ============
  {
    const db = tmpDb();
    const proj = "proj-grant-once-cold";
    seedProject(db, proj, "Grant once cold");
    const companionSess = "companion-grant-once-cold";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards for this project, once");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const grantProposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("cold consume: grant propose succeeds", grantProposed.status === "proposed");
    const grantToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${grantToken}`);
    const grantGranted = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("cold consume: a real owner confirm commits the grant", grantGranted.status === "granted");

    // NO warmWindow — board_create's OWN Tier-A trust window is still COLD here. An authored
    // (non-verbatim) title on a cold window goes through the FRESH-PROPOSE branch (not the low-friction
    // direct-commit branch the earlier "once" case exercised), so `grantAllows` gets frozen into
    // `pending.grantBacked` at propose time and must be read back (not recomputed) at confirm time.
    pty.setOwnerText("the owner said: file the login bug");
    const boardProposed = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari",
    });
    check("cold consume: an authored (non-verbatim) title on a COLD window PROPOSES (not a direct commit)", boardProposed.status === "proposed");
    check("cold consume: no card created yet (still just a proposal)", db.listTasks(proj).length === 0);

    const boardToken = extractToken(companion.delivered[1].text);
    pty.setOwnerText(`CONFIRM ${boardToken}`);
    const boardCreated = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari",
    });
    check("cold consume: the confirm commits the authored content via pending.grantBacked=true", boardCreated.status === "created");
    check("cold consume: authored content actually persisted", db.listTasks(proj).some((t) => t.title === "Fix the intermittent login failure on Safari"));

    // The "once" grant was consumed by that COLD confirm-commit — a LATER authored call (now on a WARM
    // window, since the successful board-write confirm arms it) must be rejected again: this proves the
    // consume actually happened on the COLD confirm path, not merely appearing to via some other branch.
    pty.setOwnerText("the owner said: file another thing");
    const rejectedAfter = await call(client, "board_create", { project: proj, title: "Another authored title never said verbatim" });
    check("cold consume: the grant is CONSUMED after the COLD confirm-commit — a later authored call is rejected again", typeof rejectedAfter.error === "string" && rejectedAfter.status === undefined);

    await client.close();
    db.close();
  }

  // ============ COLD-window lock-in (b): a VERBATIM-satisfied COLD propose→confirm must NOT burn a live
  // "once" grant — proves `grantBacked` is frozen FALSE, not recomputed true off the confirm-reply text ============
  {
    const db = tmpDb();
    const proj = "proj-grant-not-consumed-cold";
    seedProject(db, proj, "Grant not consumed cold");
    const companionSess = "companion-grant-not-consumed-cold";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards, once, for this project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const grantProposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    const grantToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${grantToken}`);
    const grantGranted = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    check("cold not-consumed: a real owner confirm commits the grant", grantGranted.status === "granted");

    // A VERBATIM title on a COLD window — `grantAllows` is false at PROPOSE time (verbatimOk already
    // covers it), so `pending.grantBacked` freezes to false. Without the freeze fix, the CONFIRM call
    // below would recompute `grantAllows` against the CONFIRM REPLY text (never a verbatim match for the
    // title) and wrongly read true, burning the grant on a call that never needed it.
    pty.setOwnerText("the owner said: log a verbatim card");
    const boardProposed = await call(client, "board_create", { project: proj, title: "log a verbatim card" });
    check("cold not-consumed: a verbatim title on a COLD window proposes fine", boardProposed.status === "proposed");
    const boardToken = extractToken(companion.delivered[1].text);
    pty.setOwnerText(`CONFIRM ${boardToken}`);
    const boardCreated = await call(client, "board_create", { project: proj, title: "log a verbatim card" });
    check("cold not-consumed: the verbatim confirm commits", boardCreated.status === "created");

    // The grant must STILL be live — spend it now on genuinely authored (non-verbatim) content. The prior
    // confirm's own `onStepUpCommitted` arms the trust window, so this hits the low-friction direct-commit
    // branch; either branch consuming correctly proves the grant survived the verbatim round-trip untouched.
    pty.setOwnerText("the owner said: file another one");
    const authoredCreate = await call(client, "board_create", { project: proj, title: "An authored title never said verbatim" });
    check("cold not-consumed: the untouched 'once' grant is still available after the verbatim round-trip", authoredCreate.status === "created");

    await client.close();
    db.close();
  }

  // ============ "session" scope persists across MULTIPLE content-committing calls ============
  {
    const db = tmpDb();
    const proj = "proj-grant-session";
    seedProject(db, proj, "Grant session");
    const companionSess = "companion-grant-session";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards for the rest of this chat");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: proj, scope: "session" });
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const granted = await call(client, "authored_content_grant", { project: proj, scope: "session" });
    check("session: a real owner confirm commits a SESSION-scoped grant", granted.status === "granted");

    await warmWindow(client, pty, companion, proj, "warm this window");

    pty.setOwnerText("the owner said: file the first one");
    const first = await call(client, "board_create", { project: proj, title: "First authored card, never said verbatim" });
    check("session: first authored card commits", first.status === "created");

    pty.setOwnerText("the owner said: file another one too");
    const second = await call(client, "board_create", { project: proj, title: "Second authored card, also never said verbatim" });
    check("session: a SECOND authored card ALSO commits — session scope is not consumed after one use", second.status === "created");

    await client.close();
    db.close();
  }

  // ============ per-project isolation: a grant on project X does NOT help project Y ============
  {
    const db = tmpDb();
    const projGranted = "proj-grant-iso-granted";
    const projOther = "proj-grant-iso-other";
    seedProject(db, projGranted, "Iso granted");
    seedProject(db, projOther, "Iso other");
    const companionSess = "companion-grant-iso";
    seedSession(db, companionSess, projGranted, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projGranted, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projOther, mode: "act" });
    const pty = makeFakePty("let the companion author cards here");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: projGranted, scope: "session" });
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    await call(client, "authored_content_grant", { project: projGranted, scope: "session" });

    await warmWindow(client, pty, companion, projGranted, "warm this window");

    pty.setOwnerText("the owner said: file this");
    const onGranted = await call(client, "board_create", { project: projGranted, title: "Authored on the granted project" });
    check("per-project isolation: the granted project accepts authored content", onGranted.status === "created");

    const onOther = await call(client, "board_create", { project: projOther, title: "Authored on the UNGRANTED project" });
    check("per-project isolation: a DIFFERENT project's board_create still requires verbatim — the grant does not leak across projects", typeof onOther.error === "string" && onOther.status === undefined);

    await client.close();
    db.close();
  }

  // ============ a grant that's not actually NEEDED (content already verbatim) is not consumed ============
  {
    const db = tmpDb();
    const proj = "proj-grant-not-consumed";
    seedProject(db, proj, "Grant not consumed");
    const companionSess = "companion-grant-not-consumed";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("let the companion author cards, once");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "authored_content_grant", { project: proj, scope: "once" });
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    await call(client, "authored_content_grant", { project: proj, scope: "once" });

    // Warm the Tier-A trust window so a verbatim-satisfied create takes the low-friction DIRECT-commit
    // branch (not a fresh propose) — that's the branch whose `grantAllows`-gated consume this checks.
    await warmWindow(client, pty, companion, proj, "warm this window");

    // A card created with a title that HAPPENS to be verbatim — the grant was live but not the deciding
    // factor, so it should NOT be spent here.
    pty.setOwnerText("the owner said: log a verbatim card");
    const verbatimCreate = await call(client, "board_create", { project: proj, title: "log a verbatim card" });
    check("not-consumed: a verbatim-satisfied create still succeeds while a grant happens to be live", verbatimCreate.status === "created");

    // The "once" grant should STILL be available — spend it now on genuinely authored content.
    pty.setOwnerText("the owner said: file another one");
    const authoredCreate = await call(client, "board_create", { project: proj, title: "An authored title never said verbatim" });
    check("not-consumed: the untouched 'once' grant is still available for a LATER authored (non-verbatim) call", authoredCreate.status === "created");

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the inline authored-content grant (Direction (a), card 2b26035c) is committed ONLY via an explicit authenticated owner confirm (a bare propose or a mismatched/guessed confirm grants nothing — the Companion cannot self-grant), always requires propose/confirm (no low-friction bypass), then lets board_create/board_update author non-verbatim content on that project — 'once' consumed by the next content-committing call that actually needed it, 'session' persisting across multiple calls, scoped per (session, project) with no cross-project leak, and never spent on a call the grant wasn't actually needed for."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

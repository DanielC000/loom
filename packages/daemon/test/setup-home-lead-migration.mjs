import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f437d4e9 C5 — migrateSetupHomeToLead (the end-user Platform agent → full Platform Lead upgrade).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db over an isolated LOOM_HOME, no pty/daemon.
//
// Per project memory ("verify schema/migration changes against an upgraded DB, not only a fresh
// LOOM_HOME"): every phase below builds its own CONSTRUCTED pre-migration DB shape by hand — the reserved
// setup home + an operator agent bound to the bundled "Setup Assistant" profile running the EXACT shipped
// SETUP_ASSISTANT_PROMPT, no SETUP_HOME_LEAD_AGENT_ID_KEY / SETUP_LEAD_UPGRADE_MIGRATION_KEY /
// SETUP_LEAD_UPGRADE_OFFER_CARD_KEY stamped — i.e. exactly what an install seeded BEFORE this card shipped
// looks like, never a fresh install that already seeds the Lead shape directly (that path is covered by
// setup-home.mjs's own phase (1)). Never uses or copies the real ~/.loom.
//
// Proves (docs/decisions/be9cb999-setup-home-lead-upgrade-migration.md's four cases):
//   (1) PRISTINE: rebinds to "Platform-lead", overwrites the prompt, stamps the Lead marker onto that
//       agent's id, and the migration is a marker-guarded one-shot (a second run is a no-op even after
//       re-dirtying the row).
//   (2) CUSTOMIZED (edited prompt): never auto-applies, but STILL stamps the Lead marker onto that SAME
//       agent's id (the Decision-4/be9cb999 fix) — and the offer card is filed exactly once, surviving a
//       simulated dismiss/delete.
//   (3) NO RESOLVABLE AGENT (renamed/deleted): files the generic offer card; the Lead marker is NOT
//       stamped (nothing to point it at).
//   (4) DEV install (LOOM_DEV=1): no-op entirely — the Getting-Started agent is never touched (§1c).
//   (5) INTEGRATION: after the pristine migration (1), `startPlatformLead`'s Decision-5 "exactly one
//       Lead" guard ACCEPTS the migrated agent's id and REFUSES every other agent, on a non-dev install;
//       AND (round 2, item 1c) the marker alone is never enough — re-dirtying the SAME marked agent back
//       to role "setup" now REFUSES it too, until it's rebound to Platform-lead again.
//   (6) guard 2: no setup home at all → returns without stamping (retries on a later boot once seeded).
//   (7) ONE LIVE LEAD singleton (round 2, item 6): startPlatformLead refuses a second concurrent start
//       on the SAME sanctioned agent while the first is still live, and succeeds again once retired.
//   (8) ALL FOUR historical shipped SETUP_ASSISTANT_PROMPT values (round 2, item 3) are accepted as a
//       pristine match, not just the current constant.
//   (9)/(10) LOCKOUT REPAIR (round 2, item 4): a renamed-then-rebound agent, and a deleted-marker-agent
//       with a DIFFERENT agent rebound in its place, are both resolvable again via resolveHomeLeadAgent's
//       lockout-repair fallback — no permanent "no startable Lead, ever" dead end.
//   (11) DUPLICATE "Platform" names (round 2, item 10): the marker resolves deterministically even when
//       a second agent shares the SAME name — never a bare `.find()` first-match.
//   (12)/(13)/(14) ROUND 3 M4(a)/(b)/(c): a role:"platform" row whose agent was rebound AWAY from
//       platform (after mint) is refused by resume() (12) and by recyclePlatformLead — leaving the
//       live predecessor untouched (13); and the J1 repro (start A, hard-stop A, start B, resume(A))
//       is refused by the SAME live-Lead singleton resume() now enforces (14).
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-home-lead-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

const tmpHome = path.join(os.tmpdir(), `loom-shlm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Round 3 (M4 a/c): resume()-shaped tests need a genuinely resumable engine transcript, which
// engineTranscriptExists resolves under os.homedir() — sandbox HOME/USERPROFILE so that NEVER touches
// the real ~/.claude, mirroring platform-lead-multi.mjs's own pattern.
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV; // every phase below defaults to non-dev; phase (4) sets it explicitly

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { isLoomDev } = await import("../dist/paths.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");

/** Write a stub engine transcript so a given engine id is genuinely RESUMABLE (engineTranscriptExists
 *  resolves <sandboxHome>/.claude/projects/<encodeProjectDir(cwd)>/<eng>.jsonl) — mirrors
 *  platform-lead-multi.mjs's own helper. */
const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};
const {
  resolveLiveSetupHome,
  migrateSetupHomeToLead,
  SETUP_PROJECT_NAME,
  SETUP_AGENT_NAME,
  SETUP_HOME_LEAD_AGENT_ID_KEY,
  SETUP_LEAD_UPGRADE_MIGRATION_KEY,
  SETUP_LEAD_UPGRADE_OFFER_CARD_KEY,
  SETUP_ASSISTANT_PROMPT_PRIOR_VALUES,
} = await import("../dist/setup/seed.js");
const { resolveHomeLeadAgent } = await import("../dist/projects/live-lead-home.js");
const { randomUUID } = await import("node:crypto");

// The EXACT shipped Setup Assistant prompt is a private constant in setup/seed.ts — recover it by reading
// it back off a real seed rather than re-transcribing a copy here, which would rot the moment it changes.
const setupSeedMod = await import("../dist/setup/seed.js");

/** Build ONE throwaway Db under LOOM_DEV=1 purely to recover the real shipped SETUP_ASSISTANT_PROMPT text
 *  (a private constant) — mirrors how setup-home.mjs's own "fresh install" phase reads it back off a real
 *  seed rather than re-transcribing it. Closed immediately; never reused for an actual test phase. */
function recoverShippedSetupAssistantPrompt() {
  const probeHome = path.join(tmpHome, "prompt-probe.db");
  const prevDev = process.env.LOOM_DEV;
  process.env.LOOM_DEV = "1"; // seedSetupHome's dev branch still seeds the OLD Setup Assistant shape (§1c)
  try {
    const probeDb = new Db(probeHome);
    seedDefaultProfiles(probeDb);
    setupSeedMod.seedSetupHome(probeDb);
    const home = setupSeedMod.resolveLiveSetupHome(probeDb);
    const agent = probeDb.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME);
    const prompt = agent.startupPrompt;
    probeDb.close();
    return prompt;
  } finally {
    if (prevDev === undefined) delete process.env.LOOM_DEV; else process.env.LOOM_DEV = prevDev;
  }
}
const REAL_SETUP_ASSISTANT_PROMPT = recoverShippedSetupAssistantPrompt();

/** Build a CONSTRUCTED pre-migration DB shape by hand: the reserved setup home + a SINGLE operator agent
 *  bound to the bundled "Setup Assistant" profile, running the exact shipped prompt — no Lead/migration/
 *  offer-card markers stamped at all. This is what a REAL install seeded before card f437d4e9 C5 shipped
 *  looks like; every phase below gets its OWN fresh one (never shared, never mutated cross-phase). */
function buildPreMigrationDb(dbPath) {
  const db = new Db(dbPath);
  seedDefaultProfiles(db); // "Setup Assistant" + "Platform-lead" profiles both exist, as on any real boot
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(), name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {},
    createdAt: now, archivedAt: null, reserved: true, referenceRepos: [], noGateByDesign: false,
    denyGlobs: [], repos: [], vaultOnly: true,
  };
  db.insertProject(project);
  db.setMeta("setup.homeProjectId", project.id); // the SAME marker key resolveSetupHome resolves by
  const setupProfile = db.listProfiles().find((p) => p.name === "Setup Assistant");
  const agent = {
    id: randomUUID(), projectId: project.id, name: SETUP_AGENT_NAME, startupPrompt: REAL_SETUP_ASSISTANT_PROMPT,
    position: 0, profileId: setupProfile.id, endpoint: false, ioSchema: null,
  };
  db.insertAgent(agent);
  return { db, project, agent };
}

const worktrees = [];
try {
  // ===================== (6) guard 2 — no setup home at all → no-op, no stamp =====================
  const dbNoHome = new Db(path.join(tmpHome, "no-home.db"));
  const resNoHome = migrateSetupHomeToLead(dbNoHome);
  check("(6) migration on a DB with no setup home returns {migrated:false, offered:false}", resNoHome.migrated === false && resNoHome.offered === false);
  check("(6) ...and did NOT stamp the migration marker (a later boot that seeds the home still migrates)",
    dbNoHome.getMeta(SETUP_LEAD_UPGRADE_MIGRATION_KEY) === undefined);
  dbNoHome.close();

  // ===================== (1) PRISTINE — rebind + prompt overwrite + Lead marker =====================
  const { db: db1, agent: agent1 } = buildPreMigrationDb(path.join(tmpHome, "pristine.db"));
  check("(1, precondition) isLoomDev() is FALSE", isLoomDev() === false);
  check("(1, precondition) the constructed agent is bound to 'Setup Assistant' running the real shipped prompt",
    db1.listProfiles().find((p) => p.id === db1.getAgent(agent1.id).profileId)?.name === "Setup Assistant" &&
    db1.getAgent(agent1.id).startupPrompt === REAL_SETUP_ASSISTANT_PROMPT);
  const res1a = migrateSetupHomeToLead(db1);
  check("(1) migration reports migrated:true", res1a.migrated === true && res1a.offered === false);
  const migratedAgent1 = db1.getAgent(agent1.id);
  const migratedProfile1 = db1.listProfiles().find((p) => p.id === migratedAgent1.profileId);
  check("(1) the agent is now bound to 'Platform-lead' (role platform)", migratedProfile1?.name === "Platform-lead" && migratedProfile1?.role === "platform");
  check("(1) the prompt is overwritten (no longer the Setup Assistant text)", migratedAgent1.startupPrompt !== REAL_SETUP_ASSISTANT_PROMPT);
  check("(1) the new prompt loads the /platform-lead doctrine skill", migratedAgent1.startupPrompt.includes("/platform-lead"));
  check("(1) the Lead marker is stamped onto THIS agent's id", db1.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === agent1.id);
  check("(1) the migration marker is stamped (one-shot)", typeof db1.getMeta(SETUP_LEAD_UPGRADE_MIGRATION_KEY) === "string");

  // ===================== (5) INTEGRATION — startPlatformLead's Decision-5 guard interlocks with (1) =====
  // Round 2, item 1(a): the guard now requires BOTH id-equality against the sanctioned marker AND that
  // the agent's CURRENT bound profile role is "platform" — so this must run BEFORE the re-dirty below,
  // while agent1 is still genuinely migrated, or it would (correctly) refuse.
  class SeamHost extends createSeamHost(PtyHost) { createPty(opts) { return super.createPty(opts); } }
  const events1 = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const svc1 = new SessionService(db1, new SeamHost(events1), new OrchestrationControl());
  const leadStart = svc1.startPlatformLead(agent1.id, { spawnHumanAuthorized: true });
  check("(5) startPlatformLead ACCEPTS the migrated agent's id and mints role:'platform'", leadStart.role === "platform");
  // Round 2, item 6's "ONE LIVE LEAD" singleton is a SEPARATE guard from the one under test here —
  // immediately retire this row (as a real "Stop" would) so the later start attempts below exercise
  // only the sanctioned-agent check, not the singleton (covered by its own dedicated phase (7) below).
  // Round 3 (J1): the singleton now checks VERIFIED pty liveness, so a bare DB flag flip is no longer
  // enough — stopSession() actually kills the fake pty too.
  svc1.stopSession(leadStart.id, "hard");
  db1.setProcessState(leadStart.id, "exited");
  const otherAgentId = randomUUID();
  db1.insertAgent({ id: otherAgentId, projectId: agent1.projectId, name: "Some Other Agent", startupPrompt: "x", position: 1, profileId: null });
  await rejects("(5) startPlatformLead REFUSES a DIFFERENT agent (never stamped on the Lead marker)",
    () => svc1.startPlatformLead(otherAgentId, { spawnHumanAuthorized: true }), "restricted to the seeded end-user Platform Lead");

  // Re-dirty the row, then re-run: the marker guard must skip entirely (exactly-once, ever).
  db1.updateAgent(agent1.id, { profileId: db1.listProfiles().find((p) => p.name === "Setup Assistant").id, startupPrompt: REAL_SETUP_ASSISTANT_PROMPT });
  const res1b = migrateSetupHomeToLead(db1);
  check("(1) a second migration run is a no-op (marker-guarded one-shot)", res1b.migrated === false && res1b.offered === false);
  check("(1) ...so the re-dirtied row is left as-is (the migration did NOT re-run)", db1.getAgent(agent1.id).startupPrompt === REAL_SETUP_ASSISTANT_PROMPT);

  // Round 2, item 1(c) NEGATIVE TEST: the marker alone is never enough — a re-dirtied agent (back to
  // role "setup") must now be REFUSED even though it's still the marked id, until it's rebound again.
  const svc1b = new SessionService(db1, new SeamHost(events1), new OrchestrationControl());
  await rejects("(5) NEGATIVE: startPlatformLead now REFUSES the SAME marked agent once its profile role reverted to 'setup'",
    () => svc1b.startPlatformLead(agent1.id, { spawnHumanAuthorized: true }), "restricted to the seeded end-user Platform Lead");
  // Then rebind it back to Platform-lead by hand (the opt-in path) — start succeeds again.
  const leadProfile1 = db1.listProfiles().find((p) => p.name === "Platform-lead");
  db1.updateAgent(agent1.id, { profileId: leadProfile1.id, startupPrompt: migratedAgent1.startupPrompt });
  const svc1c = new SessionService(db1, new SeamHost(events1), new OrchestrationControl());
  const rebound1 = svc1c.startPlatformLead(agent1.id, { spawnHumanAuthorized: true });
  check("(5) ...and after rebinding it back to Platform-lead, startPlatformLead succeeds again", rebound1.role === "platform");
  db1.close();

  // ===================== (2) CUSTOMIZED — never auto-applied, but Lead marker STILL stamped =====================
  const { db: db2, agent: agent2 } = buildPreMigrationDb(path.join(tmpHome, "customized.db"));
  const editedPrompt = `${REAL_SETUP_ASSISTANT_PROMPT}\n\nMy own appended house rule — do not touch.`;
  db2.updateAgent(agent2.id, { startupPrompt: editedPrompt });
  const res2a = migrateSetupHomeToLead(db2);
  check("(2) migration reports migrated:false, offered:true", res2a.migrated === false && res2a.offered === true);
  check("(2) the agent's prompt is left EXACTLY as the user wrote it", db2.getAgent(agent2.id).startupPrompt === editedPrompt);
  check("(2) the agent is STILL bound to 'Setup Assistant' (never auto-rebound)",
    db2.listProfiles().find((p) => p.id === db2.getAgent(agent2.id).profileId)?.name === "Setup Assistant");
  check("(2) the Lead marker IS stamped onto this agent's id anyway (be9cb999 — so a later manual opt-in isn't refused)",
    db2.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === agent2.id);
  const home2 = resolveLiveSetupHome(db2);
  const offerCards2a = db2.listTasks(home2.id).filter((t) => t.title === "Upgrade Platform to a full Platform Lead");
  check("(2) exactly ONE offer card filed, naming the customized agent", offerCards2a.length === 1 && offerCards2a[0].body.includes(agent2.name));
  check("(2) the offer-card body gives the concrete opt-in steps (rebind + the literal new prompt text)",
    offerCards2a[0].body.includes("Platform-lead") && offerCards2a[0].body.includes("/platform-lead"));

  // Simulate the user opting in by hand (per the card's own instructions) — startPlatformLead must now
  // accept THIS agent, proving the pre-stamped marker is what makes a manual opt-in actually work.
  const leadProfile2 = db2.listProfiles().find((p) => p.name === "Platform-lead");
  db2.updateAgent(agent2.id, { profileId: leadProfile2.id, startupPrompt: migratedAgent1.startupPrompt });
  const svc2 = new SessionService(db2, new SeamHost(events1), new OrchestrationControl());
  const manualOptIn = svc2.startPlatformLead(agent2.id, { spawnHumanAuthorized: true });
  check("(2) after a MANUAL opt-in on the SAME agent, startPlatformLead now succeeds (the marker was pre-stamped)", manualOptIn.role === "platform");

  // Simulate the user dismissing/deleting the card, then re-running the migration: it must NOT resurface.
  db2.deleteTask(offerCards2a[0].id);
  const res2b = migrateSetupHomeToLead(db2);
  check("(2) re-running after the card was deleted is a no-op (migration marker already stamped)", res2b.migrated === false && res2b.offered === false);
  const offerCards2b = db2.listTasks(home2.id).filter((t) => t.title === "Upgrade Platform to a full Platform Lead");
  check("(2) the deleted card is NOT re-seeded", offerCards2b.length === 0);
  db2.close();

  // ===================== (3) NO RESOLVABLE AGENT — generic offer card, Lead marker NOT stamped =====================
  const { db: db3, project: project3, agent: agent3 } = buildPreMigrationDb(path.join(tmpHome, "no-agent.db"));
  db3.updateAgent(agent3.id, { name: "Renamed By The User" }); // no agent now resolves under SETUP_AGENT_NAME
  const res3 = migrateSetupHomeToLead(db3);
  check("(3) migration reports migrated:false, offered:true", res3.migrated === false && res3.offered === true);
  check("(3) the Lead marker is NOT stamped (nothing to point it at)", db3.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === undefined);
  const offerCards3 = db3.listTasks(project3.id).filter((t) => t.title === "Upgrade Platform to a full Platform Lead");
  check("(3) exactly ONE generic offer card filed", offerCards3.length === 1);
  check("(3) the generic card does NOT name a specific agent (none could be identified)", !offerCards3[0].body.includes("Renamed By The User"));
  db3.close();

  // ===================== (4) DEV install — no-op entirely, agent untouched (§1c) =====================
  const { db: db4, agent: agent4 } = buildPreMigrationDb(path.join(tmpHome, "dev.db"));
  process.env.LOOM_DEV = "1";
  try {
    check("(4, precondition) isLoomDev() now reads TRUE", isLoomDev() === true);
    const res4 = migrateSetupHomeToLead(db4);
    check("(4) migration on a DEV install no-ops (migrated:false, offered:false)", res4.migrated === false && res4.offered === false);
    check("(4) the agent is left as Setup Assistant / role setup, untouched", db4.getAgent(agent4.id).startupPrompt === REAL_SETUP_ASSISTANT_PROMPT);
    check("(4) no marker of any kind was stamped on a DEV install", db4.getMeta(SETUP_LEAD_UPGRADE_MIGRATION_KEY) === undefined && db4.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === undefined);
  } finally {
    delete process.env.LOOM_DEV;
  }
  check("(4, postcondition) isLoomDev() reads FALSE again", isLoomDev() === false);
  db4.close();

  // ===================== (7) ONE LIVE LEAD singleton (round 2, item 6) =====================
  const { db: db7, agent: agent7 } = buildPreMigrationDb(path.join(tmpHome, "singleton.db"));
  const res7 = migrateSetupHomeToLead(db7);
  check("(7, precondition) migration succeeded for a fresh pristine agent", res7.migrated === true);
  const svc7 = new SessionService(db7, new SeamHost(events1), new OrchestrationControl());
  const first7 = svc7.startPlatformLead(agent7.id, { spawnHumanAuthorized: true });
  check("(7) first startPlatformLead succeeds", first7.role === "platform");
  await rejects("(7) a SECOND startPlatformLead on the SAME sanctioned agent is REFUSED while the first is still live (singleton, mirrors startSetup)",
    () => svc7.startPlatformLead(agent7.id, { spawnHumanAuthorized: true }), "only one may run at a time");
  svc7.stopSession(first7.id, "hard"); // simulate a real "Stop" of the first Lead (kills the fake pty too — round 3 J1 checks VERIFIED liveness)
  db7.setProcessState(first7.id, "exited");
  const second7 = svc7.startPlatformLead(agent7.id, { spawnHumanAuthorized: true });
  check("(7) ...and succeeds again once the first is retired (\"never two LIVE\", not \"one row ever\")", second7.role === "platform");
  db7.close();

  // ===================== (8) ALL FOUR historical prompt values are accepted as pristine (round 2, item 3) =====================
  check("(8, precondition) exactly 4 historical prompt values are recorded (the current one, kept for the record, plus 3 genuinely distinct)",
    SETUP_ASSISTANT_PROMPT_PRIOR_VALUES.length === 4);
  SETUP_ASSISTANT_PROMPT_PRIOR_VALUES.forEach((priorPrompt, i) => {
    const db8 = new Db(path.join(tmpHome, `prior-prompt-${i}.db`));
    seedDefaultProfiles(db8);
    const now8 = new Date().toISOString();
    const project8 = {
      id: randomUUID(), name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {},
      createdAt: now8, archivedAt: null, reserved: true, referenceRepos: [], noGateByDesign: false,
      denyGlobs: [], repos: [], vaultOnly: true,
    };
    db8.insertProject(project8);
    db8.setMeta("setup.homeProjectId", project8.id);
    const setupProfile8 = db8.listProfiles().find((p) => p.name === "Setup Assistant");
    const agent8 = {
      id: randomUUID(), projectId: project8.id, name: SETUP_AGENT_NAME, startupPrompt: priorPrompt,
      position: 0, profileId: setupProfile8.id, endpoint: false, ioSchema: null,
    };
    db8.insertAgent(agent8);
    const res8 = migrateSetupHomeToLead(db8);
    check(`(8, prior value #${i}) a pristine agent running HISTORICAL prompt #${i} migrates (migrated:true)`, res8.migrated === true);
    check(`(8, prior value #${i}) ...and is rebound to Platform-lead (role platform)`,
      db8.listProfiles().find((p) => p.id === db8.getAgent(agent8.id).profileId)?.role === "platform");
    db8.close();
  });

  // ===================== (9) LOCKOUT REPAIR — rename then rebind (round 2, item 4) =====================
  // A pristine agent is renamed BEFORE the migration ever runs (so the migration's own name lookup never
  // finds it under SETUP_AGENT_NAME at all — case (3) "no resolvable agent"). The user then manually
  // rebinds the SAME (still-renamed) agent to Platform-lead — resolveHomeLeadAgent's lockout-repair
  // fallback (the single platform-role agent in the home) must find it, and startPlatformLead must then
  // succeed, with no second manual step beyond the rebind itself.
  const { db: db9, project: project9, agent: agent9 } = buildPreMigrationDb(path.join(tmpHome, "lockout-rename.db"));
  db9.updateAgent(agent9.id, { name: "Renamed Before Migration Ever Ran" });
  const res9a = migrateSetupHomeToLead(db9);
  check("(9, precondition) migration offers the generic card (no agent resolvable under SETUP_AGENT_NAME)", res9a.migrated === false && res9a.offered === true);
  check("(9, precondition) the Lead marker is NOT stamped yet", db9.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === undefined);
  await rejects("(9, precondition) startPlatformLead on the renamed agent is REFUSED (no marker, no sanctioned agent)",
    async () => { const svc9pre = new SessionService(db9, new SeamHost(events1), new OrchestrationControl()); return svc9pre.startPlatformLead(agent9.id, { spawnHumanAuthorized: true }); },
    "restricted to the seeded end-user Platform Lead");
  // The user follows the generic offer card's steps: rebind the renamed agent to Platform-lead by hand.
  const leadProfile9 = db9.listProfiles().find((p) => p.name === "Platform-lead");
  db9.updateAgent(agent9.id, { profileId: leadProfile9.id, startupPrompt: migratedAgent1.startupPrompt });
  check("(9) resolveHomeLeadAgent now finds the renamed-but-rebound agent via the lockout-repair fallback (exactly one platform-role agent in the home)",
    resolveHomeLeadAgent(db9)?.id === agent9.id);
  const svc9 = new SessionService(db9, new SeamHost(events1), new OrchestrationControl());
  const rebound9 = svc9.startPlatformLead(agent9.id, { spawnHumanAuthorized: true });
  check("(9) ...and startPlatformLead now succeeds, with no second manual step beyond the rebind", rebound9.role === "platform");
  check("(9) the marker is now stamped onto this agent's id (repaired, not just resolved in-memory)", db9.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === agent9.id);
  db9.close();

  // ===================== (10) LOCKOUT REPAIR — delete the marker agent, rebind a DIFFERENT one =====================
  // A pristine agent migrates normally (marker stamped onto it), then the user DELETES that agent
  // outright (agent_delete) and rebinds a DIFFERENT, pre-existing agent in the home to Platform-lead.
  // The dangling marker must not wrongly refuse the new agent — resolveHomeLeadAgent's lockout-repair
  // fallback must find it.
  const { db: db10, project: project10, agent: agent10 } = buildPreMigrationDb(path.join(tmpHome, "lockout-delete.db"));
  const res10a = migrateSetupHomeToLead(db10);
  check("(10, precondition) the first agent migrates normally", res10a.migrated === true);
  check("(10, precondition) the marker points at the first agent", db10.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === agent10.id);
  // A second, DIFFERENT agent in the SAME home, bound to an ordinary (non-platform) profile for now.
  const otherAgent10 = { id: randomUUID(), projectId: project10.id, name: "A Different Agent", startupPrompt: "y", position: 1, profileId: null };
  db10.insertAgent(otherAgent10);
  db10.deleteAgent(agent10.id); // simulate agent_delete on the original (marked) agent
  check("(10, precondition) the marker now dangles (points at a deleted agent)", db10.getAgent(db10.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY)) === undefined);
  check("(10, precondition) resolveHomeLeadAgent resolves nothing yet (no platform-role agent exists)", resolveHomeLeadAgent(db10) === undefined);
  // The user rebinds the DIFFERENT, surviving agent to Platform-lead.
  const leadProfile10 = db10.listProfiles().find((p) => p.name === "Platform-lead");
  db10.updateAgent(otherAgent10.id, { profileId: leadProfile10.id, startupPrompt: migratedAgent1.startupPrompt });
  check("(10) resolveHomeLeadAgent now finds the DIFFERENT agent via the lockout-repair fallback", resolveHomeLeadAgent(db10)?.id === otherAgent10.id);
  const svc10 = new SessionService(db10, new SeamHost(events1), new OrchestrationControl());
  const rebound10 = svc10.startPlatformLead(otherAgent10.id, { spawnHumanAuthorized: true });
  check("(10) ...and startPlatformLead succeeds for the DIFFERENT agent, with no second manual step beyond the rebind", rebound10.role === "platform");
  check("(10) the marker is repaired onto the NEW agent's id", db10.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === otherAgent10.id);
  db10.close();

  // ===================== (11) DUPLICATE "Platform" NAMES — marker wins, never a bare name .find() (round 2, item 10) =====================
  const { db: db11, project: project11, agent: agent11 } = buildPreMigrationDb(path.join(tmpHome, "duplicate-name.db"));
  const res11a = migrateSetupHomeToLead(db11);
  check("(11, precondition) the first agent migrates normally and the marker points at it", res11a.migrated === true && db11.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) === agent11.id);
  // A SECOND agent, also named SETUP_AGENT_NAME ("Platform") — e.g. a stray duplicate created by hand.
  // A bare `db.listAgents(home.id).find(a => a.name === SETUP_AGENT_NAME)` would non-deterministically
  // (insertion-order) match EITHER row; the marker must make this deterministic regardless.
  const duplicateAgent11 = { id: randomUUID(), projectId: project11.id, name: SETUP_AGENT_NAME, startupPrompt: "z", position: 1, profileId: null };
  db11.insertAgent(duplicateAgent11);
  check("(11) resolveHomeLeadAgent still resolves the MARKED agent, never the duplicate, despite the name collision",
    resolveHomeLeadAgent(db11)?.id === agent11.id);
  const svc11 = new SessionService(db11, new SeamHost(events1), new OrchestrationControl());
  const lead11 = svc11.startPlatformLead(agent11.id, { spawnHumanAuthorized: true });
  check("(11) startPlatformLead succeeds for the MARKED agent", lead11.role === "platform");
  await rejects("(11) startPlatformLead REFUSES the duplicate-named, unsanctioned agent",
    () => svc11.startPlatformLead(duplicateAgent11.id, { spawnHumanAuthorized: true }), "restricted to the seeded end-user Platform Lead");
  db11.close();

  // ===================== (12) ROUND 3 M4(a): rebind away ⇒ resume() REFUSED =====================
  const { db: db12, project: project12, agent: agent12 } = buildPreMigrationDb(path.join(tmpHome, "m4a-resume.db"));
  const res12 = migrateSetupHomeToLead(db12);
  check("(12, precondition) migration succeeded", res12.migrated === true);
  const eng12 = "eng-m4a-0000-0000-000000000000";
  writeTranscript(tmpHome, eng12);
  const now12 = new Date().toISOString();
  const sess12 = {
    id: randomUUID(), projectId: project12.id, agentId: agent12.id, engineSessionId: eng12, title: null,
    cwd: tmpHome, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now12, lastActivity: now12, lastError: null, role: "platform", parentSessionId: null,
  };
  db12.insertSession(sess12);
  // Rebind the agent AWAY from Platform-lead while the ROW still claims role:"platform" — mirrors a
  // user rebinding the operator's profile after it was migrated.
  const setupProfile12 = db12.listProfiles().find((p) => p.name === "Setup Assistant");
  db12.updateAgent(agent12.id, { profileId: setupProfile12.id });
  const svc12 = new SessionService(db12, new SeamHost(events1), new OrchestrationControl());
  await rejects("(12) M4(a): resume() REFUSES a role:'platform' row once its agent's profile was rebound away from platform",
    () => svc12.resume(sess12.id), "restricted to the seeded end-user Platform Lead");
  db12.close();

  // ===================== (13) ROUND 3 M4(b): rebind away ⇒ recyclePlatformLead REFUSED, predecessor stays live =====================
  const { db: db13, agent: agent13 } = buildPreMigrationDb(path.join(tmpHome, "m4b-recycle.db"));
  const res13 = migrateSetupHomeToLead(db13);
  check("(13, precondition) migration succeeded", res13.migrated === true);
  const svc13 = new SessionService(db13, new SeamHost(events1), new OrchestrationControl());
  const lead13 = svc13.startPlatformLead(agent13.id, { spawnHumanAuthorized: true });
  check("(13, precondition) the Lead is live", lead13.processState === "live");
  // Rebind the agent AWAY from Platform-lead WHILE this session is still live.
  const setupProfile13 = db13.listProfiles().find((p) => p.name === "Setup Assistant");
  db13.updateAgent(agent13.id, { profileId: setupProfile13.id });
  await rejects("(13) M4(b): recyclePlatformLead REFUSES once the agent has been rebound away from platform",
    () => svc13.recyclePlatformLead(lead13.id, "continue"), "restricted to the seeded end-user Platform Lead");
  check("(13) ...and the predecessor is STILL live (never torn down by the refused recycle)",
    db13.getSession(lead13.id)?.processState === "live");
  check("(13) ...with no successor row created", db13.hasSuccessor(lead13.id) === false);
  svc13.stopSession(lead13.id, "hard");
  db13.close();

  // ===================== (14) ROUND 3 M4(c)/J1 — start A, hard-stop A, start B, resume(A) REFUSED =====================
  const { db: db14, agent: agent14 } = buildPreMigrationDb(path.join(tmpHome, "m4c-j1.db"));
  const res14 = migrateSetupHomeToLead(db14);
  check("(14, precondition) migration succeeded", res14.migrated === true);
  const svc14 = new SessionService(db14, new SeamHost(events1), new OrchestrationControl());
  const leadA = svc14.startPlatformLead(agent14.id, { spawnHumanAuthorized: true });
  check("(14, precondition) Lead A is live", leadA.processState === "live");
  svc14.stopSession(leadA.id, "hard"); // hard-stop A
  db14.setProcessState(leadA.id, "exited");
  // A needs engineSessionId + a real transcript to be resumable — the fake pty never fires
  // onEngineSessionId in this fixture, so stamp it directly (mirrors a real SessionStart hook capture).
  const engA = "eng-m4c-0000-0000-000000000000";
  db14.setEngineSessionId(leadA.id, engA);
  writeTranscript(tmpHome, engA);
  const leadB = svc14.startPlatformLead(agent14.id, { spawnHumanAuthorized: true }); // singleton allows this — A isn't live
  check("(14, precondition) Lead B is live (A's retirement freed the singleton)", leadB.processState === "live");
  await rejects("(14) M4(c)/J1: resume(A) is REFUSED while B is live — the exact J1 repro that used to mint TWO live Leads",
    () => svc14.resume(leadA.id), "a live Platform Lead session already exists");
  svc14.stopSession(leadB.id, "hard");
  db14.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — migrateSetupHomeToLead, run against CONSTRUCTED pre-migration DB shapes (never the real ~/.loom, never a fresh LOOM_HOME): upgrades a pristine Setup Assistant operator to the full Platform Lead exactly once (against all four historical shipped prompt values, not just the current one); never auto-applies onto a customized agent but still stamps the Lead marker onto it so a later manual opt-in is accepted by startPlatformLead's Decision-5 guard (which also now REFUSES the marker alone once the agent's CURRENT profile reverts off platform); the offer card itself survives a dismiss/delete without resurfacing; startPlatformLead enforces a live-Lead singleton; a renamed-or-deleted marker agent is never a permanent lockout (resolveHomeLeadAgent's lockout-repair fallback); and the whole migration is a complete no-op on a DEV install — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

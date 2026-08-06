import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e8697dd3 — `served_status`'s `deployStaleness.stale`/`commitsBehind` are CORRECTLY scoped to
// `packages/daemon/src`/`packages/shared/src` only (a daemon-PROCESS restart signal). But that leaves a
// gap: a merged `packages/daemon/assets/skills/**` change reaches ZERO agents until the next daemon
// boot/restart (`seedGlobalSkills()`), since bundled skills are delivered from the STORE
// (`<LOOM_HOME>/skills/<name>/SKILL.md`), never read live from `assets/` — yet `deployStaleness` reads
// fully clean for exactly that merge. `skillStoreStaleness()` (skills/store.ts) is the missing standing
// signal, wired onto `served_status` as its own field.
//
// Proves BOTH directions the card's DoD #2/#3 requires:
//   (A) clean store (no skill diverges from shipped) ⇒ stale:false, both lists empty — the negative control.
//   (B) a PRISTINE bundled skill (store == last-synced base, base now behind shipped) ⇒ stale:true, named
//       in `pendingRestart` (a daemon_restart auto-advances it), NOT in `pendingAdopt`.
//   (C) a CUSTOMIZED bundled skill (store diverges from its own base) with the same shipped update ⇒
//       stale:true, named in `pendingAdopt` (a restart will NOT advance it — needs an explicit adopt),
//       NOT in `pendingRestart`. Read from the REAL store customized flag, mirroring
//       merge-skill-liveness-warning.mjs's discipline of never guessing this.
//   (D) an in-sync bundled skill (store == base == shipped) ⇒ not counted in either list.
//   (E) a non-bundled (user-created) skill in the store, even one that LOOKS stale-shaped, is never
//       counted — `bundled:false` short-circuits it.
//   (F) THE OTHER HALF OF THE PATH SPLIT (card DoD "get the classification right"): a change to a file
//       living OUTSIDE the skills subtree (standing in for `assets/hook-relay.mjs`/`assets/vault-lint/**`,
//       real siblings of `assets/skills/` in the repo) has ZERO effect on this signal — `skillStoreStaleness`
//       reads ONLY `LOOM_ASSET_SKILLS` (the `assets/skills/` subtree), structurally incapable of reacting
//       to a sibling path. This is the "hook-relay-only merge must NOT report restart-needed" half of the
//       card's DoD #3, proved by asserting the result is byte-identical before/after touching that sibling.
//   (G) wired end-to-end through the REAL `served_status` MCP tool (not just the unit-level function) —
//       mirrors served-status.mjs's own end-to-end proof for `deployStaleness`.
//
// REAL fs fixtures, LOOM_ASSET_SKILLS + LOOM_HOME test seams (mirrors merge-skill-liveness-warning.mjs).
// Run: 1) build (turbo builds shared first), 2) node test/skill-store-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-sss-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// The store-side "bundled asset" stand-in — a temp dir standing in for the daemon's own
// `packages/daemon/assets/skills/`. Must be set BEFORE skills/store.js is first imported (a
// module-load-time const).
const ASSET_SKILLS_DIR = path.join(os.tmpdir(), `loom-sss-assets-skills-${Date.now()}-${process.pid}`);
fs.mkdirSync(ASSET_SKILLS_DIR, { recursive: true });
process.env.LOOM_ASSET_SKILLS = ASSET_SKILLS_DIR;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { skillStoreStaleness } = await import("../dist/skills/store.js");

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const homeSkillsDir = path.join(process.env.LOOM_HOME, "skills");
const homeBaseDir = path.join(process.env.LOOM_HOME, "skill-base");

try {
  // ===================== (A) clean store — negative control =====================
  {
    const result = skillStoreStaleness();
    check("(A) clean store: stale:false", result.stale === false);
    check("(A) clean store: pendingRestart empty", Array.isArray(result.pendingRestart) && result.pendingRestart.length === 0);
    check("(A) clean store: pendingAdopt empty", Array.isArray(result.pendingAdopt) && result.pendingAdopt.length === 0);
  }

  // ===================== (B) PRISTINE bundled skill with a pending shipped update =====================
  mkdirp(path.join(ASSET_SKILLS_DIR, "pristine-skill"));
  fs.writeFileSync(path.join(ASSET_SKILLS_DIR, "pristine-skill", "SKILL.md"), "# pristine v2 (shipped)\n");
  mkdirp(homeBaseDir);
  fs.writeFileSync(path.join(homeBaseDir, "pristine-skill.md"), "# pristine v1 (last synced base)\n");
  mkdirp(path.join(homeSkillsDir, "pristine-skill"));
  fs.writeFileSync(path.join(homeSkillsDir, "pristine-skill", "SKILL.md"), "# pristine v1 (last synced base)\n");
  {
    const result = skillStoreStaleness();
    check("(B) pristine-with-update: stale:true", result.stale === true);
    check("(B) pristine-with-update: named in pendingRestart", result.pendingRestart.includes("pristine-skill"));
    check("(B) pristine-with-update: NOT in pendingAdopt", !result.pendingAdopt.includes("pristine-skill"));
  }

  // ===================== (C) CUSTOMIZED bundled skill with the same shipped-update shape =====================
  mkdirp(path.join(ASSET_SKILLS_DIR, "customized-skill"));
  fs.writeFileSync(path.join(ASSET_SKILLS_DIR, "customized-skill", "SKILL.md"), "# custom v2 (shipped)\n");
  fs.writeFileSync(path.join(homeBaseDir, "customized-skill.md"), "# custom v1 (last synced base)\n");
  mkdirp(path.join(homeSkillsDir, "customized-skill"));
  // mine != base: the user edited their store copy after the last sync.
  fs.writeFileSync(path.join(homeSkillsDir, "customized-skill", "SKILL.md"), "# custom v1 (last synced base), plus a user edit\n");
  {
    const result = skillStoreStaleness();
    check("(C) customized-with-update: stale:true", result.stale === true);
    check("(C) customized-with-update: named in pendingAdopt", result.pendingAdopt.includes("customized-skill"));
    check("(C) customized-with-update: NOT in pendingRestart", !result.pendingRestart.includes("customized-skill"));
  }

  // ===================== (D) an in-sync bundled skill — never counted =====================
  mkdirp(path.join(ASSET_SKILLS_DIR, "insync-skill"));
  fs.writeFileSync(path.join(ASSET_SKILLS_DIR, "insync-skill", "SKILL.md"), "# in sync\n");
  fs.writeFileSync(path.join(homeBaseDir, "insync-skill.md"), "# in sync\n");
  mkdirp(path.join(homeSkillsDir, "insync-skill"));
  fs.writeFileSync(path.join(homeSkillsDir, "insync-skill", "SKILL.md"), "# in sync\n");
  {
    const result = skillStoreStaleness();
    check("(D) in-sync skill: not in pendingRestart", !result.pendingRestart.includes("insync-skill"));
    check("(D) in-sync skill: not in pendingAdopt", !result.pendingAdopt.includes("insync-skill"));
  }

  // ===================== (E) non-bundled (user-created) skill — never counted =====================
  mkdirp(path.join(homeSkillsDir, "user-created-skill"));
  fs.writeFileSync(path.join(homeSkillsDir, "user-created-skill", "SKILL.md"), "# a user's own skill, no matching bundled asset\n");
  {
    const result = skillStoreStaleness();
    check("(E) non-bundled skill: not in pendingRestart", !result.pendingRestart.includes("user-created-skill"));
    check("(E) non-bundled skill: not in pendingAdopt", !result.pendingAdopt.includes("user-created-skill"));
  }

  // ===================== (F) a sibling-path change (standing in for hook-relay/vault-lint) is invisible =====================
  const beforeSibling = skillStoreStaleness();
  const siblingFile = path.join(path.dirname(ASSET_SKILLS_DIR), "hook-relay.mjs");
  fs.writeFileSync(siblingFile, "// stand-in for assets/hook-relay.mjs — a live-read asset, NOT in the skills subtree\n");
  const afterSibling = skillStoreStaleness();
  check(
    "(F) a change to a path OUTSIDE the skills subtree (hook-relay/vault-lint stand-in) leaves skillStoreStaleness byte-identical",
    JSON.stringify(beforeSibling) === JSON.stringify(afterSibling),
  );
  check("(F) that sibling change still does not flip stale to true on its own", afterSibling.stale === beforeSibling.stale);

  // ===================== (G) wired end-to-end through the real served_status MCP tool =====================
  {
    const { Db } = await import("../dist/db.js");
    const { SessionService } = await import("../dist/sessions/service.js");
    const { OrchestrationControl } = await import("../dist/orchestration/control.js");
    const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const now = new Date().toISOString();
    const db = new Db(path.join(process.env.LOOM_HOME, "loom.db"));
    db.insertProject({ id: "sssProj", name: "SSS", repoPath: process.env.LOOM_HOME, vaultPath: process.env.LOOM_HOME, config: {}, createdAt: now, archivedAt: null, reserved: false });
    db.insertAgent({ id: "sssAgent", projectId: "sssProj", name: "Dev", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "sssMgr", projectId: "sssProj", agentId: "sssAgent", engineSessionId: null, title: null, cwd: process.env.LOOM_HOME,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const router = new OrchestrationMcpRouter(db, svc);
    const server = router.buildServer("sssMgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "skill-store-staleness-test", version: "0" });
    await client.connect(clientT);
    try {
      const status = JSON.parse((await client.callTool({ name: "served_status", arguments: {} })).content[0].text);
      check("(G) served_status returns a skillStoreStaleness field", status.skillStoreStaleness !== undefined);
      check("(G) served_status.skillStoreStaleness.stale:true (pristine + customized fixtures from (B)/(C) still on disk)", status.skillStoreStaleness?.stale === true);
      check("(G) served_status.skillStoreStaleness.pendingRestart names pristine-skill", status.skillStoreStaleness?.pendingRestart?.includes("pristine-skill"));
      check("(G) served_status.skillStoreStaleness.pendingAdopt names customized-skill", status.skillStoreStaleness?.pendingAdopt?.includes("customized-skill"));
      check("(G) served_status.deployStaleness is still present and unaffected (two independent signals)", status.deployStaleness !== undefined);
    } finally {
      db.close();
    }
  }
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(ASSET_SKILLS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — skillStoreStaleness() (and served_status's own field) correctly distinguishes pristine (restart-fixable) from customized (needs explicit adopt) bundled skills with a pending shipped update, is scoped strictly to the skills subtree (never reacting to a hook-relay/vault-lint-shaped sibling change), and ignores non-bundled skills."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

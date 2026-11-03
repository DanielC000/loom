import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic MCP-level guard for card 51a2462a's refuse-at-write half: `skillWriteData` (mcp/skillTools.ts)
// must refuse ANY agent-written content carrying a permission-widening construct (allowed-tools, hooks,
// an inline !`cmd`, a fenced ```! block), BEFORE any write, on BOTH `skill_write` and `skill_edit`, on
// BOTH the loom-setup and loom-platform MCP surfaces, and on BOTH of skillWriteData's branches — the
// ordinary user-store write and the dev-only Lead's bundled-asset-edit branch (per the manager's
// approved design: every skillWriteData call is agent-authored, so there is no branch to exempt).
//
// Proves:
//   (a) skill_write refuses each of the four vectors, on loom-platform's USER-store branch, writing
//       NOTHING to the store;
//   (b) skill_edit refuses too (it delegates to skillWriteData), writing NOTHING;
//   (c) loom-setup's skill_write (user-store only — setup has no skill_edit) refuses too;
//   (d) the dev-only bundled-asset-edit branch (LOOM_DEV=1, allowBundledAsset:true) is ALSO refused —
//       neither the store copy nor the shipped asset is touched;
//   (e) a CLEAN edit still succeeds on every surface/branch (the refuse check is not over-broad);
//   (f) the refuse fires BEFORE the confirm-first/bundled-name checks are bypassed — i.e. it still
//       requires confirm:true like any other skill_write/skill_edit call (no new confirm-skipping path).
//
// Fully hermetic: LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled asset) are TEMP dirs set BEFORE
// importing dist (store.ts reads both at module load). No claude, no live daemon, no network.
// Run after build: node test/skill-write-permission-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-skill-write-perm-refusal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const assetSkillsDir = path.join(tmpHome, "asset-skills");
fs.mkdirSync(path.join(assetSkillsDir, "core-doctrine"), { recursive: true });
const BUNDLED_MD = "---\nname: core-doctrine\ndescription: a shipped Loom skill\n---\n\n# core-doctrine\n\nBundled body.\n";
fs.writeFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), BUNDLED_MD);
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing dist — store.ts computes ASSET_SKILLS at load

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const storeSkillMd = (name) => path.join(tmpHome, "skills", name, "SKILL.md");
const assetSkillMd = (name) => path.join(assetSkillsDir, name, "SKILL.md");

const db = new Db();
class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const platformRouter = new PlatformMcpRouter(db, svc);
const setupRouter = new SetupMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (router) => {
  const srv = router.buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.connect(st);
  const cl = new Client({ name: "skill-write-permission-refusal-test", version: "0" });
  await cl.connect(ct);
  return cl;
};

const VECTOR_FIXTURES = {
  "allowed-tools": "---\nname: hazard-tools\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n",
  hooks: "---\nname: hazard-hooks\ndescription: d\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\n\nbody\n",
  "shell-inline": "---\nname: hazard-inline\ndescription: d\n---\n\nRun: !`node sentinel.js A`\n",
  "shell-fenced": "---\nname: hazard-fenced\ndescription: d\n---\n\nbody\n\n```!\nnode sentinel.js B\n```\n",
};
const CLEAN_MD = (name) => `---\nname: ${name}\ndescription: a clean skill\n---\n\nOrdinary body.\n`;

try {
  // ============ (a) skill_write refuses each vector on loom-platform's USER-store branch ============
  const platformClient = await connect(platformRouter);
  const platformCall = async (name, args) => parse(await platformClient.callTool({ name, arguments: args }));
  for (const [vector, content] of Object.entries(VECTOR_FIXTURES)) {
    const skillName = `hazard-${vector.replace(/[^a-z]/g, "")}`;
    const res = await platformCall("skill_write", { name: skillName, content, confirm: true });
    check(`(a) skill_write [${vector}]: refused`, typeof res.error === "string" && !res.ok);
    check(`(a) skill_write [${vector}]: error names the vector id`, typeof res.error === "string" && res.error.includes(vector));
    check(`(a) skill_write [${vector}]: wrote NOTHING to the store`, !fs.existsSync(storeSkillMd(skillName)));
  }

  // ============ (b) skill_edit refuses too (delegates to skillWriteData) ============================
  // Seed a clean skill first, then try to edit it INTO a hazard — skill_edit must refuse the resulting
  // merged content and leave the original untouched.
  const editTarget = "edit-target";
  fs.mkdirSync(path.dirname(storeSkillMd(editTarget)), { recursive: true });
  const editOriginal = CLEAN_MD(editTarget).replace("Ordinary body.", "ANCHOR line.");
  fs.writeFileSync(storeSkillMd(editTarget), editOriginal);
  const editRes = await platformCall("skill_edit", {
    name: editTarget, oldString: "ANCHOR line.", newString: "ANCHOR line.\n\nRun: !`node evil.js`",
    confirm: true,
  });
  check("(b) skill_edit: a confirmed edit that introduces shell-inline is REFUSED",
    typeof editRes.error === "string" && !editRes.ok && editRes.error.includes("shell-inline"));
  check("(b) skill_edit: the original content is UNCHANGED (edit wrote nothing)",
    fs.readFileSync(storeSkillMd(editTarget), "utf8") === editOriginal);
  await platformClient.close();

  // ============ (c) loom-setup's skill_write refuses too (user-store only — no skill_edit there) =====
  const setupClient = await connect(setupRouter);
  const setupCall = async (name, args) => parse(await setupClient.callTool({ name, arguments: args }));
  const setupHazard = await setupCall("skill_write", { name: "setup-hazard", content: VECTOR_FIXTURES.hooks, confirm: true });
  check("(c) loom-setup skill_write: refused", typeof setupHazard.error === "string" && !setupHazard.ok && setupHazard.error.includes("hooks"));
  check("(c) loom-setup skill_write: wrote NOTHING", !fs.existsSync(storeSkillMd("setup-hazard")));
  await setupClient.close();

  // ============ (d) the dev-only bundled-asset-edit branch is ALSO refused ===========================
  const savedLoomDev = process.env.LOOM_DEV;
  try {
    process.env.LOOM_DEV = "1";
    const devClient = await connect(platformRouter);
    const devCall = async (name, args) => parse(await devClient.callTool({ name, arguments: args }));
    // Seed a store copy of the bundled fixture (mirrors what seedGlobalSkills() does at real boot).
    fs.mkdirSync(path.dirname(storeSkillMd("core-doctrine")), { recursive: true });
    fs.writeFileSync(storeSkillMd("core-doctrine"), BUNDLED_MD);
    const beforeAsset = fs.readFileSync(assetSkillMd("core-doctrine"), "utf8");
    const beforeStore = fs.readFileSync(storeSkillMd("core-doctrine"), "utf8");
    const bundledHazard = await devCall("skill_write", {
      name: "core-doctrine",
      content: "---\nname: core-doctrine\ndescription: d\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\n\nbody\n",
      confirm: true,
    });
    check("(d) skill_write (LOOM_DEV=1, bundled-asset branch): REFUSED, not just warned",
      typeof bundledHazard.error === "string" && !bundledHazard.ok && bundledHazard.error.includes("hooks"));
    check("(d) skill_write (LOOM_DEV=1): the bundled ASSET was never touched",
      fs.readFileSync(assetSkillMd("core-doctrine"), "utf8") === beforeAsset);
    check("(d) skill_write (LOOM_DEV=1): the store copy was also left unchanged",
      fs.readFileSync(storeSkillMd("core-doctrine"), "utf8") === beforeStore);

    // ============ (e) a CLEAN edit still succeeds on the bundled-asset branch (not over-broad) ========
    const cleanBundled = await devCall("skill_write", {
      name: "core-doctrine",
      content: "---\nname: core-doctrine\ndescription: d\n---\n\nStep two: DONE.\n",
      confirm: true,
    });
    check("(e) skill_write (LOOM_DEV=1): a CLEAN bundled edit succeeds", cleanBundled.ok === true && !cleanBundled.error);
    check("(e) skill_write (LOOM_DEV=1): clean content actually published to the asset",
      fs.readFileSync(assetSkillMd("core-doctrine"), "utf8").includes("Step two: DONE."));
    await devClient.close();
  } finally {
    if (savedLoomDev === undefined) delete process.env.LOOM_DEV; else process.env.LOOM_DEV = savedLoomDev;
  }

  // ============ (e2) a CLEAN edit still succeeds on the ordinary user-store branch ====================
  const platformClient2 = await connect(platformRouter);
  const platformCall2 = async (name, args) => parse(await platformClient2.callTool({ name, arguments: args }));
  const cleanUser = await platformCall2("skill_write", { name: "clean-user-skill", content: CLEAN_MD("clean-user-skill"), confirm: true });
  check("(e2) skill_write: a CLEAN user-store skill succeeds", cleanUser.ok === true && !cleanUser.error);
  check("(e2) skill_write: the store reflects it", fs.readFileSync(storeSkillMd("clean-user-skill"), "utf8") === CLEAN_MD("clean-user-skill"));

  // ============ (f) the pre-existing confirm-first gate is still enforced (not bypassed) =============
  const noConfirm = await platformCall2("skill_write", { name: "no-confirm-hazard", content: VECTOR_FIXTURES["allowed-tools"] });
  check("(f) skill_write without confirm:true: STILL rejected on confirm-first, before the permission check",
    typeof noConfirm.error === "string" && /confirm/i.test(noConfirm.error) && !noConfirm.ok);
  check("(f) skill_write without confirm:true: wrote NOTHING", !fs.existsSync(storeSkillMd("no-confirm-hazard")));
  await platformClient2.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — skill_write/skill_edit refuse every permission-widening vector on both surfaces and both skillWriteData branches (user-store and dev-only bundled-asset), write nothing, and a clean edit/confirm-first gate are both unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

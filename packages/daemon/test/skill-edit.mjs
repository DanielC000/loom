import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic guard for skill_edit — the patch/anchor-based alternative to skill_write on the Platform
// Lead's `loom-platform` MCP surface (card a95d49c9): exact-string replace (oldString -> newString)
// against a skill's CURRENT SKILL.md, mirroring the Edit tool's contract, so a small doctrine tweak
// doesn't require reprinting the entire file through skill_write.
//
// Proves:
//   (a) a unique-match replace on a USER skill succeeds and the store file reflects it;
//   (b) a zero-match oldString errors ("not found") and writes nothing;
//   (c) a non-unique oldString errors (names the match count) and writes nothing, UNLESS
//       replaceAll:true, which replaces every occurrence;
//   (d) oldString === newString errors; a missing/nonexistent skill errors; an invalid (path-
//       traversal) name errors; CONFIRM-FIRST is enforced exactly like skill_write (missing/false
//       confirm is rejected and writes nothing);
//   (e) the BUNDLED-skill path is identical to skill_write's: it edits the store copy then publishes
//       store->asset (store == asset afterwards, customized:false);
//   (f) NO DIVERGENCE — skill_edit and skill_write produce byte-identical output for the same final
//       content (cross-checked by diffing a skill_edit result against an equivalent full-content
//       skill_write on a twin fixture), and the skill_edit source calls skillWriteData() for its
//       actual write rather than duplicating any write logic.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService against a FAKE pty,
// the REAL PlatformMcpRouter over an in-process MCP InMemoryTransport (mirrors setup-surface.mjs /
// platform-mgmt-surface.mjs). Fully hermetic — sets LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled
// asset) to TEMP dirs BEFORE importing (store.ts reads both at load).
//
// Run: 1) build (turbo builds shared first), 2) node test/skill-edit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME, and a controlled bundled-asset set. Set BEFORE importing
// dist (paths.ts/store.ts read env at module load). ---
const tmpHome = path.join(os.tmpdir(), `loom-skill-edit-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const assetSkillsDir = path.join(tmpHome, "asset-skills");
fs.mkdirSync(path.join(assetSkillsDir, "core-doctrine"), { recursive: true });
const BUNDLED_MD = "---\nname: core-doctrine\ndescription: a shipped Loom skill\n---\n\n# core-doctrine\n\nStep one.\nStep two: TODO.\nStep three.\n";
fs.writeFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), BUNDLED_MD);
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing dist — store.ts computes ASSET_SKILLS at load

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const storeSkillMd = (name) => path.join(tmpHome, "skills", name, "SKILL.md");
const assetSkillMd = (name) => path.join(assetSkillsDir, name, "SKILL.md");
const writeStoreFile = (name, content) => { fs.mkdirSync(path.dirname(storeSkillMd(name)), { recursive: true }); fs.writeFileSync(storeSkillMd(name), content); };

const db = new Db();
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "skill-edit-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("(0) loom-platform registers skill_edit alongside skill_write/skill_list", ["skill_list", "skill_write", "skill_edit"].every((t) => tools.includes(t)));

  // ============ (a) USER skill — unique-match replace succeeds ============
  const MD1 = "---\nname: my-skill\ndescription: my onboarding helper\n---\n\n# my-skill\n\nDo the user's thing.\n";
  writeStoreFile("my-skill", MD1);
  const edited1 = await call("skill_edit", { name: "my-skill", oldString: "Do the user's thing.", newString: "Do the user's UPDATED thing.", confirm: true });
  check("(a) skill_edit: a confirmed unique-match edit succeeds", edited1.ok === true && edited1.bundled === false && !edited1.error);
  const MD1_EXPECTED = MD1.replace("Do the user's thing.", "Do the user's UPDATED thing.");
  check("(a) skill_edit: the store SKILL.md reflects the replacement", fs.readFileSync(storeSkillMd("my-skill"), "utf8") === MD1_EXPECTED);
  const listed1 = await call("skill_list", {});
  check("(a) skill_list: reflects the edit", listed1.skills.find((s) => s.name === "my-skill")?.content === MD1_EXPECTED);

  // ============ (b) zero-match oldString errors, writes nothing ============
  const before1 = fs.readFileSync(storeSkillMd("my-skill"), "utf8");
  const noMatch = await call("skill_edit", { name: "my-skill", oldString: "this text does not appear anywhere", newString: "x", confirm: true });
  check("(b) skill_edit: a zero-match oldString errors", typeof noMatch.error === "string" && /not found/i.test(noMatch.error) && !noMatch.ok);
  check("(b) skill_edit: the zero-match rejection wrote NOTHING", fs.readFileSync(storeSkillMd("my-skill"), "utf8") === before1);

  // ============ (c) non-unique oldString errors (names the count); replaceAll replaces every occurrence ============
  const MD2 = "---\nname: dup-skill\ndescription: has repeats\n---\n\n# dup-skill\n\nTODO: step one.\nTODO: step two.\n";
  writeStoreFile("dup-skill", MD2);
  const notUnique = await call("skill_edit", { name: "dup-skill", oldString: "TODO:", newString: "DONE:", confirm: true });
  check("(c) skill_edit: a non-unique oldString (no replaceAll) errors", typeof notUnique.error === "string" && /not unique/i.test(notUnique.error) && /2/.test(notUnique.error) && !notUnique.ok);
  check("(c) skill_edit: the non-unique rejection wrote NOTHING", fs.readFileSync(storeSkillMd("dup-skill"), "utf8") === MD2);
  const replacedAll = await call("skill_edit", { name: "dup-skill", oldString: "TODO:", newString: "DONE:", replaceAll: true, confirm: true });
  check("(c) skill_edit: replaceAll:true succeeds", replacedAll.ok === true && !replacedAll.error);
  check("(c) skill_edit: replaceAll:true replaced EVERY occurrence", fs.readFileSync(storeSkillMd("dup-skill"), "utf8") === MD2.split("TODO:").join("DONE:"));

  // ============ (d) validation + confirm-first ============
  const sameString = await call("skill_edit", { name: "my-skill", oldString: "x", newString: "x", confirm: true });
  check("(d) skill_edit: oldString === newString errors", typeof sameString.error === "string" && /differ/i.test(sameString.error) && !sameString.ok);

  const noSuchSkill = await call("skill_edit", { name: "does-not-exist", oldString: "a", newString: "b", confirm: true });
  check("(d) skill_edit: an unknown skill name errors ('not found')", typeof noSuchSkill.error === "string" && /not found/i.test(noSuchSkill.error) && !noSuchSkill.ok);
  check("(d) skill_edit: no store dir was created for the unknown skill", !fs.existsSync(path.join(tmpHome, "skills", "does-not-exist")));

  const traversal = await call("skill_edit", { name: "../evil", oldString: "a", newString: "b", confirm: true });
  check("(d) skill_edit: a path-traversal / invalid name errors", typeof traversal.error === "string" && !traversal.ok);

  const before2 = fs.readFileSync(storeSkillMd("my-skill"), "utf8");
  const noConfirm = await call("skill_edit", { name: "my-skill", oldString: "UPDATED", newString: "HACKED", replaceAll: true });
  check("(d) skill_edit: rejected without confirm:true (CONFIRM-FIRST, same as skill_write)", typeof noConfirm.error === "string" && /confirm/i.test(noConfirm.error) && !noConfirm.ok);
  const confirmFalse = await call("skill_edit", { name: "my-skill", oldString: "UPDATED", newString: "HACKED", replaceAll: true, confirm: false });
  check("(d) skill_edit: rejected with confirm:false", typeof confirmFalse.error === "string" && !confirmFalse.ok);
  check("(d) skill_edit: the unconfirmed edits wrote NOTHING", fs.readFileSync(storeSkillMd("my-skill"), "utf8") === before2);

  // ============ (e) BUNDLED skill — identical WRITE TARGET behavior to skill_write ============
  // Seed a store copy of the bundled fixture (mirrors what seedGlobalSkills() does at real boot).
  writeStoreFile("core-doctrine", BUNDLED_MD);
  const bundledEdit = await call("skill_edit", { name: "core-doctrine", oldString: "Step two: TODO.", newString: "Step two: DONE.", confirm: true });
  check("(e) skill_edit: a confirmed bundled-name edit succeeds", bundledEdit.ok === true && bundledEdit.bundled === true && bundledEdit.target === "asset" && !bundledEdit.error);
  const BUNDLED_EXPECTED = BUNDLED_MD.replace("Step two: TODO.", "Step two: DONE.");
  check("(e) skill_edit: the store copy was updated", fs.readFileSync(storeSkillMd("core-doctrine"), "utf8") === BUNDLED_EXPECTED);
  check("(e) skill_edit: the SOURCE-OF-TRUTH bundled asset was ALSO published (store == asset)", fs.readFileSync(assetSkillMd("core-doctrine"), "utf8") === BUNDLED_EXPECTED);
  check("(e) skill_edit: after publish, customized:false (base advanced, same as skill_write)", bundledEdit.skill?.customized === false);

  // ============ (f) NO DIVERGENCE — skill_edit and skill_write agree byte-for-byte ============
  // Twin USER-skill fixtures seeded with the SAME initial content: one edited via skill_edit, the
  // other via a full-content skill_write carrying the SAME manually-computed final text. If the two
  // handlers ever diverge in how they persist, this fails.
  const TWIN = "---\nname: twin\ndescription: parity check\n---\n\n# twin\n\nThe original line.\n";
  const TWIN_FINAL = TWIN.replace("The original line.", "The EDITED line.");
  writeStoreFile("twin-via-edit", TWIN);
  writeStoreFile("twin-via-write", TWIN);
  const viaEdit = await call("skill_edit", { name: "twin-via-edit", oldString: "The original line.", newString: "The EDITED line.", confirm: true });
  const viaWrite = await call("skill_write", { name: "twin-via-write", content: TWIN_FINAL, confirm: true });
  check("(f) skill_edit and skill_write both report ok:true for the equivalent edit", viaEdit.ok === true && viaWrite.ok === true);
  check("(f) skill_edit and skill_write produce BYTE-IDENTICAL store output for the same final content",
    fs.readFileSync(storeSkillMd("twin-via-edit"), "utf8") === fs.readFileSync(storeSkillMd("twin-via-write"), "utf8"));
  check("(f) both twins equal the expected final content", fs.readFileSync(storeSkillMd("twin-via-edit"), "utf8") === TWIN_FINAL);

  await client.close();

  // ============ (f2) SOURCE-LEVEL — skill_edit has NO independent write path ============
  const skillToolsSrc = fs.readFileSync(path.join(__dirname, "..", "src", "mcp", "skillTools.ts"), "utf8");
  const editFnMatch = skillToolsSrc.match(/export function skillEditData\([\s\S]*?\n\}/);
  check("(f2) skillEditData() is defined in mcp/skillTools.ts", !!editFnMatch);
  const editFnBody = editFnMatch ? editFnMatch[0] : "";
  check("(f2) skillEditData() delegates its actual write to skillWriteData(...)", /skillWriteData\(/.test(editFnBody));
  check("(f2) skillEditData() calls NO independent persistence primitive (writeSkill/publishSkillToBundled)", !/\bwriteSkill\(/.test(editFnBody) && !/publishSkillToBundled\(/.test(editFnBody));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — skill_edit applies unique-match/replaceAll replacements, rejects zero-match/non-unique/unconfirmed/invalid edits, matches skill_write's bundled-asset WRITE TARGET, and shares ONE persistence path with skill_write (byte-identical output, no independent write logic)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 74f27ab5 — the TOP-LEVEL human-only project-config key `harness` was checked only as a WRITTEN
// key: mcp/platform.ts's elevated Platform-Lead `project_configure` rejected `config:{harness:...}` but
// let `unset:["harness"]` and a `replace:true` that omitted `harness` both silently CLEAR a stored
// human-only default straight through. The existing "human-only means BOTH directions" guard
// (card e8df2659) only ever iterated HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS, so a TOP-LEVEL human-only key
// was never in its loop at all.
//
// Fix: the guard now iterates ONE combined list (HUMAN_ONLY_PROJECT_CONFIG_KEYS +
// HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS) — this file proves the top-level case (harness) is now covered;
// merge-gate-off-config.mjs already covers the nested case (orchestration.mergeGate) and is re-affirmed
// here only as a one-line non-regression check that migrating it onto the combined list didn't break it.
//
// FOLLOW-UP (same card, manager-directed): commit ca2fc9c8 above closed the exact-path and ancestor-prefix
// cases but missed a DESCENDANT one — unlike the leaf-valued nested keys, `harness` is an OBJECT
// ({default, scope}), so `unset:["harness.default"]` dropped just that sub-field with the identical
// end effect (no default present) while matching neither "nu === k" nor "k startsWith nu.". Section (4b)
// below proves this RED on ca2fc9c8 and GREEN after `unsetDropsNestedKey` also checks the descendant
// direction (nu startsWith `${k}.`), plus a sibling-string-prefix control ("harnessX") proving the check
// is "." boundary-aware, not a bare substring test.
//
// Deterministic, no claude/network/daemon: a real Db + SessionService over a stub pty.
// ALSO checks the setup-surface project_configure/project_update tools for the same hole (per the card's
// DoD) — they carry NO unset/replace parameter at all (strict MCP schema rejects the extra arg outright),
// so there is structurally no hole to close there.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-configure-harness-unset-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-harness-unset-guard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pH", name: "H", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "project-configure-harness-unset-guard-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  // A zod strictShape() schema violation (an unknown top-level arg, e.g. `unset`/`replace` on a tool whose
  // inputSchema declares neither) rejects BEFORE the handler ever runs: the SDK returns isError:true with
  // a plain-text message, not the handler's own JSON {error:...} shape. Surface both so a caller can check
  // "was this call rejected at all" without caring which of the two shapes carried the rejection.
  return { ...parsed, isError: r.isError === true };
}
const lead = () => new PlatformMcpRouter(db, svc).buildServer();

// ============ (1) seed a stored human-only top-level key the normal write path would never allow ============
db.setProjectConfig("pH", { harness: { default: "codex", scope: "workers" }, docLint: false });
const stored1 = JSON.stringify(db.getProject("pH").config);

// ============ (2) unset:["harness"] must be REFUSED (RED on old code: this silently cleared it) ============
const unsetExact = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["harness"] });
check("(2) Lead unset of top-level harness is REFUSED", typeof unsetExact.error === "string" && /harness/.test(unsetExact.error));
check("(2) the refused unset did not change the stored config", JSON.stringify(db.getProject("pH").config) === stored1);

// ============ (3) replace:true omitting harness must be REFUSED (RED on old code) ============
const replaceDrop = await callTool(lead(), "project_configure", { projectId: "pH", config: { docLint: true }, replace: true });
check("(3) Lead replace:true that would drop the stored harness is REFUSED", typeof replaceDrop.error === "string" && /harness/.test(replaceDrop.error));
check("(3) the refused replace did not change the stored config", JSON.stringify(db.getProject("pH").config) === stored1);

// ============ (4) normalization: odd spellings of the same path still resolve and are REFUSED ============
for (const shape of ["harness.", ".harness", " harness", "harness "]) {
  const sh = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: [shape] });
  const refused = typeof sh.error === "string" && /harness/.test(sh.error);
  // "harness." / ".harness" normalize (split on ".", drop empty segments) to the same "harness" path and
  // must be refused; " harness" / "harness " carry a literal space (never dropped by the normalizer) and
  // are therefore a DIFFERENT path from "harness" — a true miss, not a bypass, so they are NOT refused and
  // (being unknown to the project's stored config) are harmless no-ops.
  const expectRefused = shape === "harness." || shape === ".harness";
  check(`(4) unset spelled ${JSON.stringify(shape)} ${expectRefused ? "normalizes to harness and is REFUSED" : "is a literal miss and is a harmless no-op"}`, refused === expectRefused);
}
check("(4) none of the above changed the stored config", JSON.stringify(db.getProject("pH").config) === stored1);

// ============ (4b) DESCENDANT paths: harness is an OBJECT ({default, scope}), unlike the leaf-valued ============
// ============      nested keys — unsetting just one sub-field drops the human-only value exactly as ============
// ============      effectively as unsetting "harness" itself, so this must be refused too (manager ============
// ============      follow-up on this same card: RED on ca2fc9c8, the commit that closed only the exact- ============
// ============      path and ancestor-prefix cases). ============
const descDefault = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["harness.default"] });
check("(4b) unset of the DESCENDANT path harness.default is REFUSED", typeof descDefault.error === "string" && /harness/.test(descDefault.error));
check("(4b) the refused harness.default unset did not change the stored config", JSON.stringify(db.getProject("pH").config) === stored1);
const descScope = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["harness.scope"] });
check("(4b) unset of the DESCENDANT path harness.scope is REFUSED", typeof descScope.error === "string" && /harness/.test(descScope.error));
check("(4b) the refused harness.scope unset did not change the stored config", JSON.stringify(db.getProject("pH").config) === stored1);
// CONTROL: a sibling key that merely shares "harness" as a STRING PREFIX (no "." boundary) must NOT be
// caught — proves the check is path-boundary-aware, not a bare substring/startsWith test. "harnessX" isn't
// a real config key, so this exercises the unset-of-an-unknown-key no-op path rather than any real data
// loss; CONFIG_TOP_LEVEL_KEYS has no real key sharing "harness" as a string prefix to use instead.
const siblingPrefix = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["harnessX"] });
check("(4b) CONTROL: unset of the sibling-string-prefix path \"harnessX\" is NOT refused (no \".\" boundary ⇒ not a real descendant)", !(typeof siblingPrefix.error === "string" && /harness/.test(siblingPrefix.error)));
check("(4b) the unrefused harnessX unset left the stored config untouched (unknown key ⇒ no-op)", JSON.stringify(db.getProject("pH").config) === stored1);

// ============ (5) controls: an unrelated unset/replace still works and harness survives ============
const unsetOther = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["docLint"] });
check("(5) CONTROL: unsetting an unrelated key still works and stored harness survives", !unsetOther.error && db.getProject("pH").config?.harness?.default === "codex" && db.getProject("pH").config?.docLint === undefined);
const replaceWithHarnessOmittedButDifferentProject = await callTool(lead(), "project_configure", { projectId: "pH", config: { harness: {} } });
// A WRITE that touches the top-level `harness` key AT ALL is rejected by the pre-existing write-direction
// check (unchanged by this fix) — included as a control that the two checks don't overlap/contradict.
check("(5) CONTROL: a WRITE touching harness at all is still rejected by the write-direction check", typeof replaceWithHarnessOmittedButDifferentProject.error === "string" && /harness/.test(replaceWithHarnessOmittedButDifferentProject.error));
db.setProjectConfig("pH", { docLint: false }); // no harness stored
const replaceFree = await callTool(lead(), "project_configure", { projectId: "pH", config: { docLint: true }, replace: true });
check("(5) CONTROL: replace:true is still allowed when NO human-only key is stored", !replaceFree.error);

// ============ (6) non-regression: the nested mergeGate case (card e8df2659) still works after the ============
// ============     refactor onto one combined list (full coverage lives in merge-gate-off-config.mjs) ============
db.setProjectConfig("pH", { orchestration: { mergeGate: "off" } });
const mergeGateUnset = await callTool(lead(), "project_configure", { projectId: "pH", config: {}, unset: ["orchestration.mergeGate"] });
check("(6) NON-REGRESSION: nested orchestration.mergeGate unset is still REFUSED after the list merge", typeof mergeGateUnset.error === "string" && /mergeGate/.test(mergeGateUnset.error));

// ============ (7) the setup surface has NO unset/replace parameter at all — structurally no hole ============
const setupProjectConfigureUnset = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pH", config: {}, unset: ["harness"] });
check("(7) setup-surface project_configure REJECTS an unset arg outright (no such parameter exists)", setupProjectConfigureUnset.isError === true);
const setupProjectUpdateUnset = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_update", { projectId: "pH", config: {}, unset: ["harness"] });
check("(7) setup-surface project_update REJECTS an unset arg outright (no such parameter exists)", setupProjectUpdateUnset.isError === true);

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the elevated Platform-Lead project_configure now refuses an unset or replace:true that would drop the TOP-LEVEL human-only harness key — exact path, ancestor prefix, AND a descendant sub-field (harness.default/harness.scope) — while a sibling string-prefix (harnessX) is correctly left alone, the nested mergeGate case still works after the list merge, and the setup surface has no unset/replace parameter to exploit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

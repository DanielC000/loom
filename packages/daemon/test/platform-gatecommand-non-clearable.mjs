import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fa777608 — the Platform Lead's `project_configure` may CHANGE `orchestration.gateCommand` but may
// not BLANK or DROP it (a blank/absent gateCommand = gateless merges via the "no gateCommand ⇒ unverified"
// path, the same power the HUMAN-only `orchestration.mergeGate` guards). Deterministic: real Db + service,
// in-memory MCP transport, no claude/network.
//
//   REFUSED (error names gateCommand, stored config byte-identical afterwards): blank "", whitespace-only,
//   unset (exact path, the "orchestration" prefix, every malformed dot-path spelling), replace:true
//   omitting it, replace:true carrying a blank one.
//   ALLOWED: changing it to another non-empty command; unrelated writes/unsets; replace:true that carries a
//   non-empty gateCommand; blanking/unsetting when NONE is stored (nothing to drop).
//   HUMAN PATH UNCHANGED: the shared full validator still accepts a blank gateCommand and
//   setProjectConfigSafe(..., "human") still lets a human drop a stored one.
//
// NOT COVERED: the manager/setup routers (they already reject gateCommand outright — merge-gate-off-config.mjs
// / surface tests) and the HTTP layer of the REST PATCH (project-config-patch*.mjs).
// Run: 1) build (turbo builds shared first), 2) node test/platform-gatecommand-non-clearable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-gc-nonclear-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { setProjectConfigSafe } = await import("../dist/tasks/columns.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pG", name: "G", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

async function call(args) {
  const server = new PlatformMcpRouter(db, svc).buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "gc-nonclear-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name: "project_configure", arguments: { projectId: "pG", ...args } });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const stored = () => JSON.stringify(db.getProject("pG").config);
const refused = (r) => typeof r.error === "string" && /gateCommand/.test(r.error) && /human|Settings/i.test(r.error);

// ---- refusals against a stored non-blank gateCommand ----
db.setProjectConfig("pG", { orchestration: { gateCommand: "pnpm test", maxConcurrentWorkers: 2 }, docLint: false });
const before = stored();

for (const [label, v] of [["blank \"\"", ""], ["whitespace \"   \"", "   "], ["tab/newline", "\t\n"], ["NBSP", "\u00a0"]]) {
  const r = await call({ config: { orchestration: { gateCommand: v } } });
  check(`set gateCommand ${label} is REFUSED`, refused(r));
}
check("blank/whitespace set: stored config unchanged", stored() === before);
for (const [label, v] of [["number 0", 0], ["null", null], ["object", {}]]) {
  const r = await call({ config: { orchestration: { gateCommand: v } } });
  check(`non-string gateCommand ${label} is rejected by the validator, NOT with the blank wording`, typeof r.error === "string" && /invalid config/.test(r.error) && !/empty\/blank/.test(r.error));
}
check("non-string sets: stored config unchanged", stored() === before);

const unsetExact = await call({ config: {}, unset: ["orchestration.gateCommand"] });
check("unset orchestration.gateCommand is REFUSED", refused(unsetExact));
const unsetPrefix = await call({ config: {}, unset: ["orchestration"] });
check("unset of the PREFIX \"orchestration\" is REFUSED", refused(unsetPrefix));
for (const shape of ["orchestration.gateCommand.", ".orchestration.gateCommand", "orchestration..gateCommand", "orchestration.", ".orchestration"]) {
  const r = await call({ config: {}, unset: [shape] });
  check(`unset spelled ${JSON.stringify(shape)} is REFUSED`, refused(r));
}
const replaceDrop = await call({ config: { docLint: true }, replace: true });
check("replace:true omitting gateCommand is REFUSED", refused(replaceDrop));
const replaceBlank = await call({ config: { orchestration: { gateCommand: "  " } }, replace: true });
check("replace:true carrying a blank gateCommand is REFUSED", refused(replaceBlank));
check("unset/replace refusals: stored config unchanged", stored() === before);

// ---- allowed ----
const change = await call({ config: { orchestration: { gateCommand: "pnpm build && pnpm test" } } });
check("CONTROL: changing gateCommand to another non-empty command is ALLOWED", !change.error && db.getProject("pG").config?.orchestration?.gateCommand === "pnpm build && pnpm test");
const unsetOther = await call({ config: {}, unset: ["docLint"] });
check("CONTROL: unsetting an unrelated key works and gateCommand survives", !unsetOther.error && db.getProject("pG").config?.orchestration?.gateCommand === "pnpm build && pnpm test");
const unsetSibling = await call({ config: {}, unset: ["orchestration.maxConcurrentWorkers"] });
check("CONTROL: unsetting a SIBLING nested key works and gateCommand survives", !unsetSibling.error && db.getProject("pG").config?.orchestration?.gateCommand === "pnpm build && pnpm test");
const replaceKeep = await call({ config: { orchestration: { gateCommand: "node check.js" } }, replace: true });
check("CONTROL: replace:true carrying a non-empty gateCommand is ALLOWED", !replaceKeep.error && db.getProject("pG").config?.orchestration?.gateCommand === "node check.js");

// ---- nothing stored: nothing to drop ----
db.setProjectConfig("pG", { docLint: false });
const unsetAbsent = await call({ config: {}, unset: ["orchestration.gateCommand"] });
check("CONTROL: unset when no gateCommand is stored is a harmless no-op (not refused)", !unsetAbsent.error);
const replaceNone = await call({ config: { docLint: true }, replace: true });
check("CONTROL: replace:true when no gateCommand is stored is ALLOWED", !replaceNone.error);
const blankNone = await call({ config: { orchestration: { gateCommand: "" } } });
check("a blank SET is refused even when none is stored (it would store a blank)", refused(blankNone));

// ---- the human path is unchanged ----
check("human/full validator STILL accepts a blank gateCommand", validateProjectConfigOverride({ orchestration: { gateCommand: "" } }).ok === true);
db.setProjectConfig("pG", { orchestration: { gateCommand: "pnpm test" } });
const human = setProjectConfigSafe(db, "pG", { docLint: false }, "human");
check("human setProjectConfigSafe can still DROP a stored gateCommand", human.ok !== false && db.getProject("pG").config?.orchestration?.gateCommand === undefined);

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the Lead can change but never blank/drop gateCommand; the human path is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

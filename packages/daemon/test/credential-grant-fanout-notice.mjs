import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card afe1bc90, ruling R1: the fan-out DATA migration (Db constructor) is independent of the NOTICE card
// (setup/seed.ts). Case "home missing at first boot": grants are already fanned out and reach identical,
// the notice files NOTHING (and stamps nothing) until the reserved Platform home exists, then files exactly
// once. Starting DB = the committed v0.31.0 base SCHEMA fixture (never the real DB).
//
// Run: 1) build, 2) node test/credential-grant-fanout-notice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lcg-notice-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(tmpHome, "n.db");
const now = "2026-01-01T00:00:00.000Z";
{
  const raw = new Database(dbFile);
  raw.exec(fs.readFileSync(path.join(here, "fixtures", "v0.31.0-schema.sql"), "utf8"));
  raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,created_at) VALUES (?,?,?,?,?)").run("pw", "Work", "/x/w", "/x/v", now);
  raw.prepare("INSERT INTO connections (id,name,host,auth_scheme,secret_blob,created_at,project_id) VALUES (?,?,?,?,?,?,?)").run("c-g", "GlobalAPI", "g.example", "bearer", "b", now, null);
  raw.prepare("INSERT INTO profiles (id,name,role,connections,capabilities) VALUES (?,?,?,?,?)").run("pr", "Granting", "worker", JSON.stringify(["c-g"]), JSON.stringify([{ slug: "cap-z" }]));
  raw.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position,profile_id) VALUES (?,?,?,?,?,?)").run("a1", "pw", "Worker Bee", "p", 0, "pr");
  raw.close();
}

const { Db } = await import("../dist/db.js");
const { fileCredentialGrantFanoutNoticeOnce, CREDENTIAL_GRANT_FANOUT_NOTICE_KEY } = await import("../dist/setup/seed.js");
const { SETUP_PROJECT_NAME } = await import("../dist/projects/reserved-home-markers.js");

const db = new Db(dbFile);
const reach = () => JSON.stringify([db.getAgent("a1").connections, db.getAgent("a1").capabilities]);
const reachAtBoot = reach();
check("(1) first boot, NO reserved home: the fan-out already moved the grants onto the agent", reachAtBoot === JSON.stringify([["c-g"], [{ slug: "cap-z" }]]));
const r1 = fileCredentialGrantFanoutNoticeOnce(db);
check("(2) no home ⇒ nothing filed", r1.filed === false && r1.reason === "no-home");
check("(2) no home ⇒ the notice marker is NOT stamped (retry on a later boot)", !db.getMeta(CREDENTIAL_GRANT_FANOUT_NOTICE_KEY));
check("(2) reach unchanged by the failed notice attempt", reach() === reachAtBoot);

// Later boot: the reserved Platform/Setup home now exists.
db.insertProject({ id: "home", name: SETUP_PROJECT_NAME, repoPath: "/x/h", vaultPath: "/x/hv", config: {}, createdAt: now, reserved: true });
const r2 = fileCredentialGrantFanoutNoticeOnce(db);
check("(3) home present ⇒ filed", r2.filed === true);
const cards = db.listTasks("home").filter((t) => t.title === "Credential grants moved onto agents");
check("(3) exactly one notice card on the home", cards.length === 1);
const body = cards[0]?.body ?? "";
check("(3) body lists the moved grants per agent (by name, connection by NAME)", body.includes('Agent "Worker Bee"') && body.includes("GlobalAPI") && body.includes("cap-z"));
check("(3) body says new agents on the profile no longer inherit", /new agent bound to one of these profiles no longer inherits/i.test(body));
check("(3) body says agent-facing tools can no longer change these agents' roles; the human can", body.includes("Agent-facing tools can no longer change these agents' roles; you can, in the agent editor."));
check("(3) marker stamped", !!db.getMeta(CREDENTIAL_GRANT_FANOUT_NOTICE_KEY));
const r3 = fileCredentialGrantFanoutNoticeOnce(db);
check("(4) a further call is a no-op (filed once ever)", r3.filed === false && db.listTasks("home").filter((t) => t.title === "Credential grants moved onto agents").length === 1);
// "dismissing or deleting it won't bring it back"
db.deleteTask?.(cards[0].id);
fileCredentialGrantFanoutNoticeOnce(db);
check("(4) deleting the card does not re-file it", db.listTasks("home").filter((t) => t.title === "Credential grants moved onto agents").length === 0);
check("(5) reach still identical after the notice", reach() === reachAtBoot);
// R10: a stripped capability binding says "kept ... binding removed", never "never had reach" for the capability itself.
{
  const { credentialGrantFanoutNoticeBody } = await import("../dist/setup/seed.js");
  const sum = { v: 1, at: now, profiles: [{ profileId: "p", profileName: "P", orphaned: false, profileConnections: [], profileCapabilities: [{ slug: "cap-x", connectionId: "c-x" }],
    agents: [{ agentId: "a", agentName: "Agent A", projectId: "pw", movedConnections: [], movedCapabilities: [{ slug: "cap-x" }], droppedCrossProject: [], strippedCapabilityBindings: [{ slug: "cap-x", connectionId: "c-x" }], dangling: [] }] }] };
  const nb = credentialGrantFanoutNoticeBody(sum, (id) => `NAME(${id})`);
  check("(6) notice: a stripped binding is reported as KEPT with the connection removed", /capability "cap-x" kept, but its binding to connection NAME\(c-x\) was removed/.test(nb));
  check("(6) notice: no 'dropped capability' wording for a stripped binding", !/dropped capability/.test(nb));
}
db.close?.();
fs.rmSync(tmpHome, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nALL PASS");

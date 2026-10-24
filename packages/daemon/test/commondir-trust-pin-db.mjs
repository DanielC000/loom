import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
// CARD 3a5c5d4a (round 5) — the Db-side half of the durable commondir-trust pin: `insertProject` pins
// every repoKey at BIND time, `updateProject` re-pins a CHANGED path and retires the old one (reusing
// `resetMainlineBaselinesForRepoChange`'s existing per-repoKey diff), and `backfillCommondirTrustPins`
// is the one-time (idempotent) boot pass for a binding that predates this feature.
//
// No new table or column — the pin rides the existing `app_meta` key/value store, exactly like the
// mainline watermark/branch-trust facts already do, so there is no migration to test. The closest
// equivalent of "a pre-migration DB" this card has is a project whose rows predate the FEATURE (no pin
// meta rows yet, same schema) — simulated below by deleting the pin rows `insertProject` just wrote,
// then confirming `backfillCommondirTrustPins` repopulates them cleanly.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/commondir-trust-pin-db.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-cgcr-dbpin-home-");

const { Db } = await import("../dist/db.js");
const { resolveTrustedToplevel } = await import("../dist/git/bounded.js");
const { literalRepoPathKey } = await import("../dist/git/repo-lock.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cgcr-dbpin-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=dbpin@loom -c user.name=dbpin";
function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
  git(dir, "add -A");
  git(dir, `${GIT_ID} commit -q -m "${name}: init"`);
  return dir;
}
const realTop = (p) => { const r = resolveTrustedToplevel(p); if (!r.ok) throw new Error(r.reason); return r.toplevel; };

const db = new Db();
const now = new Date().toISOString();

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// insertProject pins the primary repoPath AND every repos[] entry, at bind time.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const primaryA = initRepo("primary-a");
const extraB = initRepo("extra-b");
const projId1 = `dbpin-proj1-${sfx}`;
db.insertProject({
  id: projId1, name: "dbpin-1", repoPath: primaryA, vaultPath: primaryA, config: {}, createdAt: now, archivedAt: null,
  reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"],
  repos: [{ key: "extra", path: extraB, gateCommand: null }], vaultOnly: false,
});
const pinPrimary1 = db.getCommondirTrustPin(primaryA);
check("(insert) the primary repoPath is pinned at bind time", pinPrimary1 !== null && pinPrimary1.toplevel === realTop(primaryA) && pinPrimary1.source === "bind" && pinPrimary1.projectId === projId1 && pinPrimary1.repoKey === "primary");
const pinExtra1 = db.getCommondirTrustPin(extraB);
check("(insert) a repos[] entry is ALSO pinned at bind time", pinExtra1 !== null && pinExtra1.toplevel === realTop(extraB) && pinExtra1.repoKey === "extra");

// A project with no `repos` field at all (relying on the SQL-layer's own `?? []`) must not crash insertProject.
const vaultOnlyDir = path.join(SCRATCH, "vault-only");
fs.mkdirSync(vaultOnlyDir, { recursive: true });
const projId0 = `dbpin-proj0-${sfx}`;
let noReposThrew = null;
try {
  db.insertProject({ id: projId0, name: "dbpin-0", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null });
} catch (e) { noReposThrew = e; }
check("(insert) a Project literal with no `repos` field at all does not throw (defensive `?? []`, matching the SQL-layer's own fallback)", noReposThrew === null);
check("(insert) …and it simply stays unpinned (vaultOnlyDir has no .git at all — resolveTrustedToplevel fails, best-effort skip)", db.getCommondirTrustPin(vaultOnlyDir) === null);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// updateProject: a REBIND (changed repoPath) pins the NEW path and retires the OLD one.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const primaryC = initRepo("primary-c");
db.updateProject(projId1, { repoPath: primaryC });
check("(rebind) the NEW repoPath is now pinned", db.getCommondirTrustPin(primaryC)?.toplevel === realTop(primaryC) && db.getCommondirTrustPin(primaryC)?.source === "rebind");
check("(rebind) the OLD repoPath's pin is retired", db.getCommondirTrustPin(primaryA) === null);
// the untouched `extra` repoKey keeps its own pin — a primary-only rebind must not disturb a sibling repoKey.
check("(rebind) an UNCHANGED sibling repoKey (extra) keeps its own pin untouched", db.getCommondirTrustPin(extraB)?.repoKey === "extra");

// A BRAND NEW repoKey added via updateProject (never present in the project's `before.repos`) must ALSO
// get pinned — the diff loop only ever walks OLD keys, so this needs its own pass (round-5 fix).
const extraD = initRepo("extra-d");
db.updateProject(projId1, { repos: [{ key: "extra", path: extraB, gateCommand: null }, { key: "extra2", path: extraD, gateCommand: null }] });
check("(rebind, new key) a brand-new repos[] entry added via updateProject is pinned too", db.getCommondirTrustPin(extraD)?.toplevel === realTop(extraD) && db.getCommondirTrustPin(extraD)?.repoKey === "extra2");

// A NO-OP rebind (same path, just re-sent) must not disturb the existing pin's own `pinnedAt`/`source`.
const beforeNoOp = db.getCommondirTrustPin(primaryC);
db.updateProject(projId1, { repoPath: primaryC });
const afterNoOp = db.getCommondirTrustPin(primaryC);
check("(no-op rebind) an unchanged repoPath's pin is left untouched (same pinnedAt)", afterNoOp?.pinnedAt === beforeNoOp?.pinnedAt && afterNoOp?.source === beforeNoOp?.source);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// backfillCommondirTrustPins: idempotent, and files exactly ONE summary event when it backfills anything.
// Simulates "a binding that predates this feature" by deleting the pin rows insertProject just wrote for
// a FRESH project (same schema — there is no migration here, just the presence/absence of these rows).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const primaryE = initRepo("primary-e");
const projId2 = `dbpin-proj2-${sfx}`;
db.insertProject({
  id: projId2, name: "dbpin-2", repoPath: primaryE, vaultPath: primaryE, config: {}, createdAt: now, archivedAt: null,
  reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false,
});
check("(pre-backfill) a freshly-bound project is already pinned (nothing left for backfill to do here)", db.getCommondirTrustPin(primaryE) !== null);
// Simulate pre-feature state: strip ONLY this project's own pin rows (never touch another project's).
// The index entry names the EXACT literal path the pin was stored under — read it back rather than
// re-deriving the path from `primaryE` a second time, so this strip stays correct even if some other
// normalization ever diverges from what was actually written.
for (const row of db.listMetaByPrefix(`commondir-trust-pin-index:${projId2}:`)) {
  db.deleteMeta(`commondir-trust-pin:${literalRepoPathKey(row.value)}`);
  db.deleteMeta(row.key);
}
check("(pre-backfill simulation) primaryE's pin row is gone", db.getCommondirTrustPin(primaryE) === null);

const eventsBefore = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned").length;
const backfill1 = db.backfillCommondirTrustPins();
check("(backfill) re-pins the simulated pre-feature project", db.getCommondirTrustPin(primaryE)?.source === "boot-backfill");
check("(backfill) backfilled count includes this project's repoKey", backfill1.pins.some((p) => p.projectId === projId2 && p.repoKey === "primary"));
const eventsAfterFirst = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned").length;
check("(backfill) files exactly ONE new commondir_trust_pinned event for this pass", eventsAfterFirst === eventsBefore + 1);

const backfill2 = db.backfillCommondirTrustPins();
check("(backfill, idempotent) a second call backfills ZERO — everything is already pinned", backfill2.backfilled === 0);
const eventsAfterSecond = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned").length;
check("(backfill, idempotent) …and files NO additional event when there is nothing to backfill", eventsAfterSecond === eventsAfterFirst);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// deleteProject purges every pin (and its index entry) belonging to that project — never a sibling's.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
db.deleteProject(projId1);
check("(delete) the deleted project's own pins are gone", db.getCommondirTrustPin(primaryC) === null && db.getCommondirTrustPin(extraB) === null && db.getCommondirTrustPin(extraD) === null);
check("(delete) a DIFFERENT project's pin survives", db.getCommondirTrustPin(primaryE) !== null);

try { db.close(); } catch { /* best-effort — never let cleanup fail the test */ }
await finishAndExit(failures === 0 ? 0 : 1);

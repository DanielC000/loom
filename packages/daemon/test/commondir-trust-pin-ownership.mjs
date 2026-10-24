import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
// CARD 4d60366b (3a5c5d4a round 6) — commondir-trust pins are keyed per LITERAL path but owned/deleted
// per PROJECT. This file proves the three measured bugs ((a) overwrite-then-delete, (b) rebind-away,
// (c) dangling index after a repoKey removal), the overwrite-refusal case, and (Code Review ec8816e4)
// B1 (the HANDOFF mirror of (a)/(b): retiring the OWNER while a sibling still holds an index entry must
// hand off, not delete), S1 (an intra-project repoKey SWAP), and N1 (a walk that SUCCEEDS but resolves to
// a DIFFERENT toplevel, plus backfill's hadPinBefore/rePinnedCount) — each against the FIX in db.ts
// (`checkCommondirPinConflicts`/`assertNoCommondirPinConflicts{,ForRepoChange}`, the owner-check +
// HANDOFF in `pinCommondirTrust`/`unpinCommondirTrustIfOwned`/`findOtherCommondirPinHolder`, the
// two-pass restructure in `resetMainlineBaselinesForRepoChange`, and the index cleanup there too).
//
// RED-before-GREEN proof (card 4d60366b worker_report): run this file against `git show HEAD:…` (the
// pre-fix db.ts) via a captured diff + `git checkout HEAD --`, see every one of these FAIL, then restore
// the fix and see them PASS — see the worker_report for the exact commands run.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/commondir-trust-pin-ownership.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-cgcr-dbpin-own-home-");

const { Db } = await import("../dist/db.js");
const { resolveTrustedToplevel } = await import("../dist/git/bounded.js");
const { literalRepoPathKey } = await import("../dist/git/repo-lock.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cgcr-dbpin-own-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=dbpinown@loom -c user.name=dbpinown";
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
const freshProject = (id, repoPath, extra) => ({
  id, name: id, repoPath, vaultPath: repoPath, config: {}, createdAt: new Date().toISOString(), archivedAt: null,
  reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false,
  ...extra,
});

const db = new Db();

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (a) Project B binding the SAME literal path A already pinned must NOT become the recorded owner — and
// deleting B afterward must NOT touch A's pin.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const sharedA = initRepo("shared-a");
const idA = `cgcr-a-${sfx}`;
const idB = `cgcr-b-${sfx}`;
db.insertProject(freshProject(idA, sharedA));
const pinAfterA = db.getCommondirTrustPin(sharedA);
check("(a) A's bind pins the shared path, owner A", pinAfterA?.projectId === idA && pinAfterA?.toplevel === realTop(sharedA));

db.insertProject(freshProject(idB, sharedA)); // same literal path — walk agrees (same dir), so this is allowed
const pinAfterB = db.getCommondirTrustPin(sharedA);
check("(a) B binding the SAME path does NOT reassign ownership away from A", pinAfterB?.projectId === idA && pinAfterB?.repoKey === "primary");

db.deleteProject(idB);
const pinAfterBDeleted = db.getCommondirTrustPin(sharedA);
check("(a) deleting B leaves A's pin intact (was: A left refused/unpinned)", pinAfterBDeleted !== null && pinAfterBDeleted.projectId === idA);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (b) Project C binding the SAME shared path, then rebinding AWAY from it, must NOT unpin A either.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const idC = `cgcr-c-${sfx}`;
db.insertProject(freshProject(idC, sharedA)); // C also binds the shared path (like B did)
check("(b, setup) C binding the shared path still leaves A as owner", db.getCommondirTrustPin(sharedA)?.projectId === idA);

const repoC2 = initRepo("c-rebind-target");
db.updateProject(idC, { repoPath: repoC2 }); // C rebinds AWAY from the shared path
const pinAfterCRebind = db.getCommondirTrustPin(sharedA);
check("(b) C rebinding away from the shared path leaves A's pin intact (was: unpinned)", pinAfterCRebind !== null && pinAfterCRebind.projectId === idA);
check("(b) C's own new path is pinned to C", db.getCommondirTrustPin(repoC2)?.projectId === idC && db.getCommondirTrustPin(repoC2)?.source === "rebind");

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (c) Removing a repoKey must not leave a dangling index entry — and even a dangling entry surviving from
// before this fix (simulated below) must never let a later deleteProject touch an UNRELATED project's
// newer pin at the same reused literal path.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoDx = initRepo("d-extra-x");
const idD = `cgcr-d-${sfx}`;
db.insertProject(freshProject(idD, initRepo("d-primary"), { repos: [{ key: "x", path: repoDx, gateCommand: null }] }));
check("(c, setup) D's repoKey x is pinned", db.getCommondirTrustPin(repoDx)?.projectId === idD);
check("(c, setup) D's index entry for x exists", db.getMeta(`commondir-trust-pin-index:${idD}:x`) !== undefined);

const lostEventsBefore = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "lost").length;
db.updateProject(idD, { repos: [] }); // repoKey "x" removed entirely, no survivor anywhere — a genuine loss
check("(c) removing repoKey x deletes its pin", db.getCommondirTrustPin(repoDx) === null);
check("(c) …AND deletes the now-dangling index entry too (was: left dangling)", db.getMeta(`commondir-trust-pin-index:${idD}:x`) === undefined);
const lostEventsAfter = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "lost").length;
check("(N2) a durable 'lost' event was filed for a genuine loss with no survivor (round 2's test only ever asserted 'handoff')", lostEventsAfter === lostEventsBefore + 1);

// Simulate a PRE-FIX dangling index row surviving from before this card (the exact shape bug (c)
// describes) and prove deleteProject's owner-check still protects a later owner's pin even then.
db.setMeta(`commondir-trust-pin-index:${idD}:x`, repoDx);
const idE = `cgcr-e-${sfx}`;
db.insertProject(freshProject(idE, repoDx)); // E independently (re)binds the SAME path — fresh owner
check("(c, setup) E now owns the pin at the reused path", db.getCommondirTrustPin(repoDx)?.projectId === idE);
db.deleteProject(idD); // D's stale index still names this path
check("(c) deleteProject(D) must NOT delete E's newer pin via D's stale index entry (was: deleted)", db.getCommondirTrustPin(repoDx)?.projectId === idE);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// B1 (Code Review ec8816e4): deleting the OWNER while a SIBLING still holds an index entry must HAND OFF
// the pin to the sibling (same toplevel, no fresh walk) rather than deleting it — the mirror of (a)/(b)
// above, which only ever exercised retiring the NON-owner.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const sharedJ = initRepo("shared-j");
const idJ1 = `cgcr-j1-${sfx}`; // the OWNER, about to be deleted
const idJ2 = `cgcr-j2-${sfx}`; // sibling, index-only
db.insertProject(freshProject(idJ1, sharedJ));
db.insertProject(freshProject(idJ2, sharedJ));
check("(B1-delete, setup) J1 owns the shared pin, J2 only has an index entry", db.getCommondirTrustPin(sharedJ)?.projectId === idJ1);
const handoffEventsBefore = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "handoff").length;
db.deleteProject(idJ1);
const pinAfterJ1Delete = db.getCommondirTrustPin(sharedJ);
check("(B1-delete) the pin is HANDED OFF to J2, not deleted (was: left unpinned, fail-closed until reboot)", pinAfterJ1Delete !== null && pinAfterJ1Delete.projectId === idJ2 && pinAfterJ1Delete.repoKey === "primary");
check("(B1-delete) the handed-off pin keeps the SAME toplevel — no fresh walk, no TOFU window", pinAfterJ1Delete?.toplevel === realTop(sharedJ));
const handoffEventsAfter = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "handoff").length;
check("(N2) a durable handoff event was filed at the moment of the handoff", handoffEventsAfter === handoffEventsBefore + 1);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// B1 (rebind twin): the OWNER rebinding its primary AWAY from the shared path, while a sibling still holds
// an index entry there, must also HAND OFF rather than unpin.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const sharedK = initRepo("shared-k");
const idK1 = `cgcr-k1-${sfx}`; // OWNER, about to rebind away
const idK2 = `cgcr-k2-${sfx}`; // sibling, index-only
db.insertProject(freshProject(idK1, sharedK));
db.insertProject(freshProject(idK2, sharedK));
check("(B1-rebind, setup) K1 owns the shared pin", db.getCommondirTrustPin(sharedK)?.projectId === idK1);
const repoK1New = initRepo("k1-rebind-target");
db.updateProject(idK1, { repoPath: repoK1New }); // K1 rebinds AWAY from the shared path
const pinAfterK1Rebind = db.getCommondirTrustPin(sharedK);
check("(B1-rebind) the pin is HANDED OFF to K2, not deleted (was: left unpinned)", pinAfterK1Rebind !== null && pinAfterK1Rebind.projectId === idK2);
check("(B1-rebind) K1's own new path is freshly pinned to K1", db.getCommondirTrustPin(repoK1New)?.projectId === idK1 && db.getCommondirTrustPin(repoK1New)?.source === "rebind");

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// S1 (Code Review ec8816e4): an intra-project repoKey SWAP ({primary:p1,x:p2} → {primary:p2,x:p1}) must not
// lose either pin — order-dependent in the pre-fix single-pass code (whichever repoKey's unpin ran before
// the OTHER repoKey's new-path pin call wrote its index entry).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoL1 = initRepo("swap-l1");
const repoL2 = initRepo("swap-l2");
const idL = `cgcr-l-${sfx}`;
db.insertProject(freshProject(idL, repoL1, { repos: [{ key: "x", path: repoL2, gateCommand: null }] }));
check("(S1, setup) primary owns L1, x owns L2", db.getCommondirTrustPin(repoL1)?.repoKey === "primary" && db.getCommondirTrustPin(repoL2)?.repoKey === "x");
db.updateProject(idL, { repoPath: repoL2, repos: [{ key: "x", path: repoL1, gateCommand: null }] }); // SWAP
check("(S1) L2 is now owned by primary (was: lost, order-dependent)", db.getCommondirTrustPin(repoL2)?.projectId === idL && db.getCommondirTrustPin(repoL2)?.repoKey === "primary");
check("(S1) L1 is now owned by x (was: lost, order-dependent)", db.getCommondirTrustPin(repoL1)?.projectId === idL && db.getCommondirTrustPin(repoL1)?.repoKey === "x");

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// M-1 (Code Review 33b9c061): the REVIEWER'S EXACT measured sequence, reproduced through PRODUCTION calls
// only (insertProject/updateProject/deleteProject — never a direct setMeta/deleteMeta shortcut). A binds
// X; A rebinds "primary" to a NON-WALKABLE path (a never-created directory); C binds X fresh; C is
// deleted. Pre-M-1, A's OWN index entry for X survived the rebind's walk failure, so C's delete HANDED
// the pin OFF to A — a project no longer actually bound to X at all. Post-M-1, the pin must be DELETED
// (a genuine loss), never handed off, because A's stale index entry was cleared at rebind time.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoX = initRepo("m1-x");
const idM1A = `cgcr-m1a-${sfx}`;
db.insertProject(freshProject(idM1A, repoX));
check("(M1, setup) A binds X", db.getCommondirTrustPin(repoX)?.projectId === idM1A);
const nonWalkable = path.join(SCRATCH, "m1-never-created");
db.updateProject(idM1A, { repoPath: nonWalkable }); // A rebinds to a path that was never created on disk
check("(M1, setup) the rebind's walk failure deletes pin(X) outright (A was the sole holder, no survivor yet)", db.getCommondirTrustPin(repoX) === null);
check("(M1, setup) …AND clears A's OWN index entry for X (was: left dangling, pointing at X)", db.getMeta(`commondir-trust-pin-index:${idM1A}:primary`) === undefined);
const idM1C = `cgcr-m1c-${sfx}`;
db.insertProject(freshProject(idM1C, repoX)); // C binds X fresh
check("(M1, setup) C now owns a fresh pin at X", db.getCommondirTrustPin(repoX)?.projectId === idM1C);
db.deleteProject(idM1C); // C retires — A's stale index entry (if it survived) would be the ONLY possible "handoff" target
check("(M1) pin(X) is DELETED, never handed off to A (A's index entry for X was already cleared at rebind time)", db.getCommondirTrustPin(repoX) === null);
check("(M1) …and A's own repoKey is NOT silently re-pinned to X either", db.getMeta(`commondir-trust-pin-index:${idM1A}:primary`) === undefined);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// M-1a (Code Review e242c754, round 4): the M1 test above never reaches findOtherCommondirPinHolder's own
// LIVE-TABLE validation at all (M-1b's clear-on-walk-failure already removes the stale row before any
// handoff lookup runs) — M-1a itself has ZERO coverage without a test that puts a stale row in front of
// it DIRECTLY. P1/P2 below simulate the exact residue an UPGRADED DB (one that predates M-1b) could still
// carry — seeded with setMeta, which is legitimate here precisely because production code wrote THIS
// SAME row shape before M-1b existed. P3 is the live-path twin: no residue at all, just one ordinary
// updateProject patch that changes two repoKeys' paths at once.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// P1: a round-5-shaped stale row (a walk-failure rebind's old index value, surviving as if from before
// M-1b). B rebinds away from X (M-1b would normally clear this — undo that ONE write to simulate an
// upgraded DB that still carries the old-shaped residue), then A (the real owner of X) is deleted: pin(X)
// must be lost outright, never handed to B, who is not actually bound to X at all.
const repoP1X = initRepo("p1-x");
const idP1A = `cgcr-p1a-${sfx}`;
const idP1B = `cgcr-p1b-${sfx}`;
db.insertProject(freshProject(idP1A, repoP1X));
db.insertProject(freshProject(idP1B, repoP1X));
db.updateProject(idP1B, { repoPath: path.join(SCRATCH, "p1-never-created") }); // M-1b clears B's index for X
db.setMeta(`commondir-trust-pin-index:${idP1B}:primary`, repoP1X); // re-create the pre-M-1b residue directly
check("(P1, setup) the simulated stale row exists", db.getMeta(`commondir-trust-pin-index:${idP1B}:primary`) === repoP1X);
db.deleteProject(idP1A);
check("(P1) pin at X is lost, NOT handed to B (B is bound elsewhere — a stale row must never be trusted)", db.getCommondirTrustPin(repoP1X) === null);
check("(P1) the stale B index row is deleted on sight by the live-table validation", db.getMeta(`commondir-trust-pin-index:${idP1B}:primary`) === undefined);

// P2: the SAME residue shape, but for a REMOVED repoKey (c2 once had "x" at Y; removing it should have
// cleared the index, but simulate a row that survived from before that fix existed either).
const repoP2Y = initRepo("p2-y");
const idP2A = `cgcr-p2a-${sfx}`;
const idP2C = `cgcr-p2c-${sfx}`;
db.insertProject(freshProject(idP2A, repoP2Y));
db.insertProject(freshProject(idP2C, initRepo("p2-c"), { repos: [{ key: "x", path: repoP2Y, gateCommand: null }] }));
db.updateProject(idP2C, { repos: [] }); // repoKey "x" removed — its index entry is correctly deleted
db.setMeta(`commondir-trust-pin-index:${idP2C}:x`, repoP2Y); // re-create the residue for the REMOVED key directly
db.deleteProject(idP2A);
check("(P2) pin at Y is lost, NOT handed to the removed repoKey c2:x", db.getCommondirTrustPin(repoP2Y) === null);

// P3: production-only, NO residue anywhere. ONE updateProject patch both rebinds "primary" away from Z
// AND removes repoKey "x" (which was ALSO at Z) — exactly one genuine loss, and critically NOT a spurious
// "handoff" to the repoKey being removed in the SAME call.
const repoP3Z = initRepo("p3-z");
const idP3D = `cgcr-p3d-${sfx}`;
db.insertProject(freshProject(idP3D, repoP3Z, { repos: [{ key: "x", path: repoP3Z, gateCommand: null }] }));
const p3EventCount = (kind) => db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === kind).length;
const p3HandoffBefore = p3EventCount("handoff"), p3LostBefore = p3EventCount("lost");
db.updateProject(idP3D, { repoPath: initRepo("p3-new"), repos: [] });
check("(P3) pin at Z is gone", db.getCommondirTrustPin(repoP3Z) === null);
check("(P3) NO spurious handoff event to the repoKey being removed in the SAME patch", p3EventCount("handoff") === p3HandoffBefore);
check("(P3) exactly one lost event", p3EventCount("lost") === p3LostBefore + 1);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// M-2 (Code Review e242c754, round 4, MINOR but fixed now): insertProject/updateProject must be
// TRANSACTIONAL — a throw partway through the pin/unpin pass must never strand a half-applied write (the
// project row committed, the pin state only partly updated) — the SAME permanent dead end M-1 was about,
// reachable with no stale row at all. Inject a throw into unpinCommondirTrustIfOwned and assert the WHOLE
// update rolls back: the project's repoPath is unchanged, and the old pin is untouched (not moved/handed
// off/deleted).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoW = initRepo("m2-w");
const idM2E = `cgcr-m2e-${sfx}`;
db.insertProject(freshProject(idM2E, repoW));
const pinWBefore = db.getCommondirTrustPin(repoW);
check("(M2, setup) E is pinned at W", pinWBefore?.projectId === idM2E);
const origUnpin = Db.prototype.unpinCommondirTrustIfOwned;
Db.prototype.unpinCommondirTrustIfOwned = function () { throw new Error("M-2 injected failure"); };
let m2Threw = null;
try { db.updateProject(idM2E, { repoPath: initRepo("m2-new") }); } catch (e) { m2Threw = e; }
Db.prototype.unpinCommondirTrustIfOwned = origUnpin;
check("(M2) the injected throw propagates", m2Threw !== null && /M-2 injected failure/.test(m2Threw.message));
check("(M2) the WHOLE update rolled back — repoPath is unchanged (was: stranded on the NEW path)", db.getProject(idM2E)?.repoPath === repoW);
check("(M2) …and the OLD pin at W is untouched — not moved, handed off, or deleted", JSON.stringify(db.getCommondirTrustPin(repoW)) === JSON.stringify(pinWBefore));

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// overwrite case: a bind/rebind onto a literal path someone else owns, where a live walk does NOT confirm
// the SAME toplevel, must REFUSE the whole write (throw) rather than silently overwriting.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoF = initRepo("f-mismatch-target");
const idF = `cgcr-f-${sfx}`;
db.insertProject(freshProject(idF, repoF));
const pinFBefore = db.getCommondirTrustPin(repoF);
check("(overwrite, setup) F is pinned", pinFBefore?.projectId === idF);
// Restructure repoF's OWN .git into a FILE pointer after the pin was recorded — a live walk from the SAME
// literal path now disagrees (ok:false), simulating the path's disk reality shifting since pin time.
fs.rmSync(path.join(repoF, ".git"), { recursive: true, force: true });
fs.writeFileSync(path.join(repoF, ".git"), "gitdir: ../nonexistent-elsewhere\n");

const idG = `cgcr-g-${sfx}`;
let insertThrew = null;
try { db.insertProject(freshProject(idG, repoF)); } catch (e) { insertThrew = e; }
check("(overwrite) insertProject onto a mismatched-pin path THROWS a clear refusal", insertThrew !== null && /commondir-trust pin/i.test(insertThrew.message));
check("(overwrite) …and the new project was NEVER written (refusal is atomic)", db.getProject(idG) === undefined);
check("(overwrite) …and F's own pin is completely untouched", JSON.stringify(db.getCommondirTrustPin(repoF)) === JSON.stringify(pinFBefore));

const idH = `cgcr-h-${sfx}`;
const repoH1 = initRepo("h-original");
db.insertProject(freshProject(idH, repoH1, { name: "original-name" }));
let updateThrew = null;
try { db.updateProject(idH, { name: "renamed-by-refused-patch", repoPath: repoF }); } catch (e) { updateThrew = e; }
check("(overwrite) updateProject rebinding onto the SAME mismatched path ALSO throws", updateThrew !== null && /commondir-trust pin/i.test(updateThrew.message));
const hAfter = db.getProject(idH);
check("(overwrite) …and the WHOLE patch is refused atomically — name is unchanged too", hAfter?.name === "original-name" && hAfter?.repoPath === repoH1);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// N1: a live walk that SUCCEEDS (ok:true) but resolves to a DIFFERENT toplevel than the existing pin must
// ALSO refuse — the "overwrite case" above only ever exercised a walk FAILURE (ok:false).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const ancestorRepoN = initRepo("n1-ancestor");
const nestedDirN = path.join(ancestorRepoN, "nested-dir");
fs.mkdirSync(nestedDirN);
const idN1 = `cgcr-n1-${sfx}`;
db.insertProject(freshProject(idN1, nestedDirN));
check("(N1, setup) N1 is pinned via a subdir-bound walk up to the ancestor repo", db.getCommondirTrustPin(nestedDirN)?.toplevel === realTop(ancestorRepoN));
// Plant a FRESH plain .git DIRECTLY in the nested dir — a future walk from the SAME literal path now
// SUCCEEDS but resolves to the nested dir itself, a DIFFERENT toplevel than what's pinned.
fs.mkdirSync(path.join(nestedDirN, ".git"));
const idN2 = `cgcr-n2-${sfx}`;
let n1Threw = null;
try { db.insertProject(freshProject(idN2, nestedDirN)); } catch (e) { n1Threw = e; }
check("(N1) a walk that SUCCEEDS but finds a DIFFERENT toplevel still refuses", n1Threw !== null && /DIFFERENT toplevel/.test(n1Threw.message));
check("(N1) …and N1's own pin is completely untouched", db.getCommondirTrustPin(nestedDirN)?.projectId === idN1);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// N1: backfillCommondirTrustPins flags a re-pin whose INDEX entry survived with no matching pin
// (hadPinBefore) and rolls it into the event's rePinnedCount.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoM = initRepo("n1-backfill");
const idM = `cgcr-m-${sfx}`;
db.insertProject(freshProject(idM, repoM));
check("(N1-backfill, setup) M is pinned", db.getCommondirTrustPin(repoM)?.projectId === idM);
db.deleteMeta(`commondir-trust-pin:${literalRepoPathKey(repoM)}`); // pin lost, index survives (the exact shape bug (c) once left behind)
check("(N1-backfill, setup) M's pin is gone but its index entry survives", db.getCommondirTrustPin(repoM) === null && db.getMeta(`commondir-trust-pin-index:${idM}:primary`) !== undefined);
const backfillEventsBefore = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned").length;
const backfillResult = db.backfillCommondirTrustPins();
const mEntry = backfillResult.pins.find((p) => p.projectId === idM && p.repoKey === "primary");
check("(N1-backfill) the re-pin is flagged hadPinBefore:true (an index survivor, not a fresh TOFU)", mEntry?.hadPinBefore === true);
const backfillEvents = db.listEventsSince(0, 1000000).filter((e) => e.kind === "commondir_trust_pinned");
check("(N1-backfill) exactly one new backfill event was filed for this pass", backfillEvents.length === backfillEventsBefore + 1);
check("(N1-backfill) the event's rePinnedCount counts M", (backfillEvents.at(-1)?.detail?.rePinnedCount ?? 0) >= 1);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// M-1c: hadPinBefore must compare the index entry's own VALUE to the repoPath being backfilled, not just
// whether the KEY exists — a key that exists but names a DIFFERENT (stale) path must never be miscounted
// as a re-pin of THIS one (a first-time TOFU, wrongly flagged as a loss).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
const repoNCurrent = initRepo("m1c-current");
const repoNStale = initRepo("m1c-stale");
const idN = `cgcr-n-m1c-${sfx}`;
db.insertProject(freshProject(idN, repoNCurrent));
check("(M1c, setup) N is pinned at its current path", db.getCommondirTrustPin(repoNCurrent)?.projectId === idN);
// Simulate staleness directly (this is backfill's OWN defensive check under test, not a production rebind
// flow): the index entry now names a DIFFERENT path than N's current repoPath, and N's pin at its current
// path is gone — a genuine first-time TOFU for repoNCurrent, which just happens to share an index SLOT
// with an unrelated stale value.
db.setMeta(`commondir-trust-pin-index:${idN}:primary`, repoNStale);
db.deleteMeta(`commondir-trust-pin:${literalRepoPathKey(repoNCurrent)}`);
const backfillResult2 = db.backfillCommondirTrustPins();
const nEntry = backfillResult2.pins.find((p) => p.projectId === idN && p.repoKey === "primary");
check("(M1c) hadPinBefore is FALSE when the index value names a DIFFERENT path (was: miscounted as true)", nEntry?.hadPinBefore === false);

try { db.close(); } catch { /* best-effort — never let cleanup fail the test */ }
await finishAndExit(failures === 0 ? 0 : 1);

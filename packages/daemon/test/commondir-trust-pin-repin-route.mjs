import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// CARD a8bc0404 — a HUMAN-ONLY loopback REST route to refresh an EXISTING commondir-trust pin from a
// fresh live walk, mirroring /mainline-watermark/reset's shape (POST /api/projects/:id/commondir-trust-
// pin/repin). Closes the round-5 S-3 gap (docs/decisions/3a5c5d4a): nothing could otherwise ever refresh
// a pin once established (a same-path rebind is a no-op; the boot backfill skips anything already
// pinned), so a legitimate change behind an already-pinned literal path refused every canonical git call
// for that (project, repoKey) forever. See docs/decisions/a8bc0404-commondir-trust-pin-repin-route.md for
// the full design (ownership reuse, the A1 TOCTOU guard, the A2 disclosure, the A3 refusal-wording change).
//
// ONE cohesive scenario sets up most of the proof in a single coherent narrative:
//   - Project OWNER binds to `nested` (a subdir of a real repo ANCESTOR, no own .git — the pin records
//     ANCESTOR as the toplevel).
//   - Project SIBLING ALSO binds its primary to the SAME literal `nested` path while the walk still
//     matches ANCESTOR (the benign "shared path" case round 6 already supports) — SIBLING gets only an
//     index entry, OWNER keeps the real pin. This is the fixture for the A2 `alsoAffects` disclosure.
//   - `nested` is then turned into a REAL, standalone git repo (`git init` + a commit) directly inside
//     itself — the exact "git init ran inside a pinned subdir" scenario card a8bc0404's own body names.
//     Its LIVE toplevel is now ITSELF, not ANCESTOR — the pin is now stale.
//   - (A) a real canonicalGit call against `nested` is REFUSED (CanonicalGitPinMismatchRefusal) BEFORE
//     any repin.
//   - (B) SIBLING (not the recorded owner) tries to repin ⇒ 409 conflict (it isn't the owner, and the
//     live walk no longer confirms OWNER's recorded toplevel either — never silently handed to it).
//   - (C) OWNER repins with the WRONG expectedToplevel (the STALE ancestor value) ⇒ 409 expected-mismatch,
//     NO write, NO durable event (A1's TOCTOU guard).
//   - (D) OWNER repins with the CORRECT (current live) expectedToplevel ⇒ 200, pin refreshed, SIBLING
//     disclosed in `alsoAffects` (A2), ONE durable event naming old+new toplevel.
//   - (E) the SAME canonicalGit call that was refused in (A) now SUCCEEDS (the DoD's own explicit check).
// Separate, smaller scenarios cover: unknown project (404), unknown repoKey (404), missing
// expectedToplevel (400), and a walk failure (400, repoPath deleted entirely).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject; a real git CLI + canonicalGit).
// Run: 1) pnpm build, 2) node packages/daemon/test/commondir-trust-pin-repin-route.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-cgcr-repin-route-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { canonicalGit, CanonicalGitPinMismatchRefusal, registerCommondirTrustPinLookup } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// @decision a8bc0404 — production wires this ONCE at boot (index.ts, right after `new Db()`), which this
// hermetic harness never runs; a real canonicalGit call would otherwise silently find NO pin at all and
// skip the whole mechanism this file is testing. Re-register per Db instance (module-level singleton —
// only ONE resolver active at a time, safe here since every block below is sequential, never concurrent).
function openDb(dbPath) {
  const db = new Db(dbPath);
  registerCommondirTrustPinLookup((repoPath) => db.getCommondirTrustPin(repoPath));
  return db;
}

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

const SCRATCH = path.join(TMP, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=cgcrrepin@loom -c user.name=cgcrrepin";
function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
  git(dir, "add -A");
  git(dir, `${GIT_ID} commit -q -m "${name}: init"`);
  return dir;
}
/** Turns an EXISTING directory into a real, standalone git repo (its own `.git`, one commit) — unlike the
 *  bare `fs.mkdirSync(path.join(dir, ".git"))` idiom other commondir-trust-pin test files use (enough for
 *  resolveTrustedToplevel's own fs-only check, but not a repo `canonicalGit` can actually run commands
 *  against — this file needs the latter for its end-to-end "a real call succeeds after the repin" proof). */
function plantRealRepoInPlace(dir) {
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "g.txt"), "planted\n");
  git(dir, "add -A");
  git(dir, `${GIT_ID} commit -q -m "planted: init"`);
}

// ===================== the main scenario: (A)-(E) =====================
{
  const db = openDb(path.join(TMP, "loom-main.db"));
  const app = await buildApp(db);
  try {
    const ancestor = initRepo("main-ancestor");
    const nested = path.join(ancestor, "nested-dir");
    fs.mkdirSync(nested);

    const ownerRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Owner", repoPath: nested } });
    check("(setup) OWNER binds to the subdir (201)", ownerRes.statusCode === 201);
    const ownerId = ownerRes.json().id;
    check("(setup) OWNER's pin records the ANCESTOR toplevel", db.getCommondirTrustPin(nested)?.toplevel === ancestor && db.getCommondirTrustPin(nested)?.projectId === ownerId);

    const siblingRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Sibling", repoPath: nested } });
    check("(setup) SIBLING binds to the SAME literal path (still matches live ⇒ benign shared bind, 201)", siblingRes.statusCode === 201);
    const siblingId = siblingRes.json().id;
    check("(setup) the real pin is STILL owned by OWNER, not SIBLING", db.getCommondirTrustPin(nested)?.projectId === ownerId);

    // The repo moves / git init runs inside the pinned subdir — nested's LIVE toplevel is now ITSELF.
    plantRealRepoInPlace(nested);

    // (A) a real canonical call against `nested` is refused BEFORE any repin.
    let preRepinThrew;
    try { await canonicalGit(nested, 5_000).raw(["rev-parse", "HEAD"]); preRepinThrew = null; } catch (e) { preRepinThrew = e; }
    check("(A) a real canonicalGit call is refused pre-repin with CanonicalGitPinMismatchRefusal", preRepinThrew instanceof CanonicalGitPinMismatchRefusal);

    // (B) SIBLING (not the recorded owner) tries to repin ⇒ 409 conflict.
    const bRes = await app.inject({ method: "POST", url: `/api/projects/${siblingId}/commondir-trust-pin/repin`, payload: { expectedToplevel: nested } });
    check("(B) a non-owner's repin attempt is refused with 409", bRes.statusCode === 409);
    // Code Review m4 — the WRONG remedy ("delete or rebind X away") must NOT appear; the right remedy
    // (repin via the OWNER's own project id) must.
    check("(B) the 409 body names the OWNER's project id as the remedy (m4), not the bind/rebind-away wording", typeof bRes.json().error === "string" && bRes.json().error.includes(ownerId) && !/delete or rebind/i.test(bRes.json().error));
    check("(B) OWNER's pin is untouched by the refused attempt", db.getCommondirTrustPin(nested)?.toplevel === ancestor);

    const eventsSoFar = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "human-repin");
    check("(B) no human-repin event was filed by the refused conflict attempt", eventsSoFar.length === 0);

    // (C) OWNER repins with the WRONG (stale) expectedToplevel ⇒ 409 expected-mismatch, no write, no event.
    const cRes = await app.inject({ method: "POST", url: `/api/projects/${ownerId}/commondir-trust-pin/repin`, payload: { expectedToplevel: ancestor } });
    check("(C) a stale expectedToplevel is refused with 409", cRes.statusCode === 409);
    check("(C) the 409 body names the live-vs-expected mismatch", typeof cRes.json().error === "string" && cRes.json().error.includes(nested) && cRes.json().error.includes(ancestor));
    check("(C) the pin is STILL unchanged (A1's TOCTOU guard — no write on a mismatch)", db.getCommondirTrustPin(nested)?.toplevel === ancestor);
    const eventsAfterC = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "human-repin");
    check("(C) STILL no human-repin event filed (a TOCTOU refusal is logged, never audited as a real repin)", eventsAfterC.length === 0);

    // (D) OWNER repins with the CORRECT (current live) expectedToplevel ⇒ 200, pin refreshed, SIBLING disclosed.
    const dRes = await app.inject({ method: "POST", url: `/api/projects/${ownerId}/commondir-trust-pin/repin`, payload: { expectedToplevel: nested } });
    check("(D) the correct expectedToplevel succeeds (200)", dRes.statusCode === 200);
    const dBody = dRes.json();
    check("(D) changed:true on a real repin", dBody.changed === true);
    check("(D) the response names the old and new toplevel", dBody.oldToplevel === ancestor && dBody.newToplevel === nested);
    check("(D, A2) SIBLING is disclosed in alsoAffects", Array.isArray(dBody.alsoAffects) && dBody.alsoAffects.some((a) => a.projectId === siblingId && a.repoKey === "primary"));
    check("(D) the pin NOW records the new (nested) toplevel", db.getCommondirTrustPin(nested)?.toplevel === nested);
    const eventsAfterD = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "human-repin");
    check("(D) exactly ONE human-repin event is filed", eventsAfterD.length === 1);
    check("(D) the event names old+new toplevel and the disclosed sibling", eventsAfterD[0].detail.oldToplevel === ancestor && eventsAfterD[0].detail.newToplevel === nested && eventsAfterD[0].detail.alsoAffects?.some((a) => a.projectId === siblingId));

    // (D2) Code Review m5 — OWNER repins AGAIN with the SAME (now-current) expectedToplevel: a benign
    // no-op, since nothing is actually stale. Must still succeed (200) but report changed:false and file
    // NO new event — never audited as if a real repin happened.
    const d2Res = await app.inject({ method: "POST", url: `/api/projects/${ownerId}/commondir-trust-pin/repin`, payload: { expectedToplevel: nested } });
    check("(D2) a no-op repin still succeeds (200)", d2Res.statusCode === 200);
    const d2Body = d2Res.json();
    check("(D2) changed:false on a no-op repin", d2Body.changed === false);
    check("(D2) oldToplevel === newToplevel on a no-op", d2Body.oldToplevel === nested && d2Body.newToplevel === nested);
    const eventsAfterD2 = db.listEventsSince(0, 100000).filter((e) => e.kind === "commondir_trust_pinned" && e.detail?.event === "human-repin");
    check("(D2) STILL exactly ONE human-repin event — no new event filed for the no-op", eventsAfterD2.length === 1);

    // (E) the DoD's own explicit check — the SAME canonical call now succeeds, post-repin.
    const postRepinHead = await canonicalGit(nested, 5_000).raw(["rev-parse", "HEAD"]);
    check("(E) the SAME canonicalGit call that was refused in (A) now succeeds, post-repin", typeof postRepinHead === "string" && /^[0-9a-f]{40}$/.test(postRepinHead.trim()));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== Code Review M2 — pinCommondirTrust honors resolvedToplevel directly =====================
// A second, independent walk inside pinCommondirTrust could diverge from repinCommondirTrust's OWN prior
// walk under a genuine TOCTOU race; the fix threads that FIRST walk's result straight through instead of
// re-walking. Proven directly (TS `private` has no runtime effect on compiled JS — `db.pinCommondirTrust`
// is a plain, callable method here) rather than simulating a race: pass a value NO real walk of `repo2`
// could ever produce, and confirm the write reflects EXACTLY that value, never a fresh walk's own answer.
{
  const db = openDb(path.join(TMP, "loom-m2.db"));
  const app = await buildApp(db);
  try {
    const repo2 = initRepo("m2-repo");
    const ownerRes2 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "M2Owner", repoPath: repo2 } });
    check("(M2, setup) bind succeeds (201)", ownerRes2.statusCode === 201);
    const ownerId2 = ownerRes2.json().id;
    check("(M2, setup) the bind-time pin records repo2's own real toplevel", db.getCommondirTrustPin(repo2)?.toplevel === repo2);

    const fakeToplevel = "Z:\\this-value-no-real-walk-of-repo2-could-ever-produce";
    db.pinCommondirTrust(ownerId2, "primary", repo2, "human-repin", fakeToplevel);
    check("(M2) a passed resolvedToplevel is written VERBATIM, never overridden by a fresh internal walk", db.getCommondirTrustPin(repo2)?.toplevel === fakeToplevel);

    // Control: every EXISTING caller (bind/rebind/backfill) omits resolvedToplevel — confirm that path
    // still falls back to a real walk, restoring repo2's own correct toplevel.
    db.pinCommondirTrust(ownerId2, "primary", repo2, "human-repin");
    check("(M2, control) omitting resolvedToplevel still falls back to a real walk (restores repo2's own toplevel)", db.getCommondirTrustPin(repo2)?.toplevel === repo2);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== unknown project ⇒ 404 =====================
{
  const db = openDb(path.join(TMP, "loom-404-project.db"));
  const app = await buildApp(db);
  try {
    const res = await app.inject({ method: "POST", url: "/api/projects/no-such-project/commondir-trust-pin/repin", payload: { expectedToplevel: "/anything" } });
    check("unknown project id is refused with 404", res.statusCode === 404);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== unknown repoKey ⇒ 404 =====================
{
  const db = openDb(path.join(TMP, "loom-404-repokey.db"));
  const app = await buildApp(db);
  try {
    const repo = initRepo("repokey-404");
    const res1 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P", repoPath: repo } });
    const pid = res1.json().id;
    const res = await app.inject({ method: "POST", url: `/api/projects/${pid}/commondir-trust-pin/repin`, payload: { repoKey: "no-such-repo", expectedToplevel: repo } });
    check("unknown repoKey is refused with 404", res.statusCode === 404);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== missing expectedToplevel ⇒ 400 =====================
{
  const db = openDb(path.join(TMP, "loom-400-missing.db"));
  const app = await buildApp(db);
  try {
    const repo = initRepo("missing-expected");
    const res1 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P", repoPath: repo } });
    const pid = res1.json().id;
    const res = await app.inject({ method: "POST", url: `/api/projects/${pid}/commondir-trust-pin/repin`, payload: {} });
    check("a missing expectedToplevel is refused with 400", res.statusCode === 400);
    check("the 400 body names expectedToplevel", /expectedToplevel/i.test(res.json().error ?? ""));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== a walk failure (repoPath deleted entirely) ⇒ 400 =====================
{
  const db = openDb(path.join(TMP, "loom-400-walk.db"));
  const app = await buildApp(db);
  try {
    const repo = initRepo("walk-failed");
    const res1 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P", repoPath: repo } });
    const pid = res1.json().id;
    fs.rmSync(repo, { recursive: true, force: true }); // repoPath no longer resolves to anything at all
    const res = await app.inject({ method: "POST", url: `/api/projects/${pid}/commondir-trust-pin/repin`, payload: { expectedToplevel: repo } });
    check("a walk failure (deleted repoPath) is refused with 400", res.statusCode === 400);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

await finishAndExit(failures === 0 ? 0 : 1);

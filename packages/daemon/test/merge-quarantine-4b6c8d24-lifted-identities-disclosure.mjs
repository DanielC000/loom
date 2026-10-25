import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4b6c8d24 — a pre-existing two-path asymmetry: clear-by-id already returns `liftedRepoPaths`, but
// the project-scoped `/internal/merge-quarantine/clear` (clearMergeQuarantineReporting) and clear-by-path
// (clearMergeQuarantineByRecordedPath) returned only wasQuarantined/stillBlockedCoOccupants. On a
// provenanceUnknown union recorded under one party, clearing by the OTHER party's own identity silently
// lifted the recorded party's quarantine too, with no disclosure.
//
// Fix: clearMergeQuarantineByKey (the SHARED clear helper) now always returns `liftedRepoPaths` (every
// identity this call genuinely, structurally knows it lifted — the caller's own `identityRepoPath` AND
// the matched entry's own recorded `repoPath`, which can differ exactly in this shape) plus a
// `provenanceUnknown` notice when the lifted entry was marked — never a GUESSED third identity (db0a9db0's
// own rule). clearMergeQuarantineByRecordedPath/clearMergeQuarantineReporting forward it unconditionally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-4b6c8d24-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  activeMergeQuarantineFor, enterMergeQuarantine, quarantineLatchIdFor, setActiveQuarantineTestOnly,
  pushPendingQuarantineTestOnly, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, clearMergeQuarantineByKey,
  clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleUrl);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// @decision 58ae4b34 (round 2, CR `ebfdb799`) — assert the EXACT `blocking repo '<path>'` clause, never
// a bare `reason.includes(hostPath)`: a contributor path (e.g. xSub) contains its host path as a string
// PREFIX, so a substring check against the host path alone passes vacuously.
const namesAsBlockingRepo = (reason, repoPath) => reason.includes(`blocking repo '${repoPath}'`);

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const GIT_ID = "-c user.email=4b6c8d24@loom -c user.name=4b6c8d24";
// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
function hashKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-4b6c8d24-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# 4b6c8d24 fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// ===================== (A) /clear (clearMergeQuarantineReporting) on a provenanceUnknown union =====================
// A single, manufactured union entry — the shape e7652e06's own boot-time collision produces: ONE
// MergeQuarantineEntry armed at BOTH Y's and F's own canonical keys, `repoPath` recorded as F (the
// "older" party), marked provenanceUnknown. Built directly via the sanctioned setActiveQuarantineTestOnly
// seam (per d4b25feb's own rule: never drive clearMergeQuarantineByKey directly in a test — always
// exercise the real entry point) rather than re-deriving the boot-time collision mechanism itself, which
// e7652e06's own test files already cover.
{
  const Y = makeRepo("Y-A");
  const F = makeRepo("F-A");
  const kY = canonicalRepoLockKey(Y);
  const kF = canonicalRepoLockKey(F);
  const tokY = `tokY-A-${sfx}`;
  const tokF = `tokF-A-${sfx}`;
  const union = {
    repoPath: F, branch: "b", reason: "4b6c8d24 fixture: Y/F provenanceUnknown union",
    enteredAt: Date.now(), tokens: [tokY, tokF], resolvedKey: kF, resolvedKeys: [kY, kF],
    armedKeys: [kY, kF], provenanceUnknown: true,
  };
  setActiveQuarantineTestOnly(kY, union);
  setActiveQuarantineTestOnly(kF, union);
  check("(A precondition) Y is quarantined via the union", !!activeMergeQuarantineFor(Y));
  check("(A precondition) F is quarantined via the union", !!activeMergeQuarantineFor(F));

  const result = clearMergeQuarantineReporting(Y);
  check("(A) wasQuarantined:true", result.wasQuarantined === true);
  check("*** THE FIX (A) *** liftedRepoPaths names Y (the identity actually asked for)", (result.liftedRepoPaths ?? []).includes(Y));
  check("*** THE FIX (A) *** liftedRepoPaths ALSO names F (the union's own recorded identity, collaterally lifted)", (result.liftedRepoPaths ?? []).includes(F));
  check("*** THE FIX (A) *** provenanceUnknown:true — the lifted union was marked", result.provenanceUnknown === true);
  check("(A) Y is actually unblocked", !activeMergeQuarantineFor(Y));
  check("(A) F is ALSO actually unblocked (same union, same physical lift)", !activeMergeQuarantineFor(F));
}

// ===================== (B) clear-by-path (clearMergeQuarantineByRecordedPath) on a provenanceUnknown union =====================
// clear-by-path matches by the entry's own STORED repoPath identity (never a fresh key recompute), so it
// must be called with the union's own recorded identity (F2) to find it at all — see
// clearMergeQuarantineByRecordedPath's own doc. The disclosure asymmetry this card closes for THIS route
// is the missing `liftedRepoPaths`/`provenanceUnknown` fields themselves, not a Y-vs-F naming gap (that
// gap is specific to the KEY-addressed route exercised in (A) above, where the caller's own identity can
// genuinely differ from the entry's own recorded one).
{
  const Y2 = makeRepo("Y-B");
  const F2 = makeRepo("F-B");
  const kY2 = canonicalRepoLockKey(Y2);
  const kF2 = canonicalRepoLockKey(F2);
  const tokY2 = `tokY-B-${sfx}`;
  const tokF2 = `tokF-B-${sfx}`;
  const union2 = {
    repoPath: F2, branch: "b", reason: "4b6c8d24 fixture: Y2/F2 provenanceUnknown union",
    enteredAt: Date.now(), tokens: [tokY2, tokF2], resolvedKey: kF2, resolvedKeys: [kY2, kF2],
    armedKeys: [kY2, kF2], provenanceUnknown: true,
  };
  setActiveQuarantineTestOnly(kY2, union2);
  setActiveQuarantineTestOnly(kF2, union2);
  check("(B precondition) Y2 is quarantined via the union", !!activeMergeQuarantineFor(Y2));
  check("(B precondition) F2 is quarantined via the union", !!activeMergeQuarantineFor(F2));

  const result = clearMergeQuarantineByRecordedPath(F2);
  check("(B) wasQuarantined:true", result.wasQuarantined === true);
  check("*** THE FIX (B) *** liftedRepoPaths names F2 (the union's own recorded identity)", (result.liftedRepoPaths ?? []).includes(F2));
  check("*** THE FIX (B) *** provenanceUnknown:true — the lifted union was marked", result.provenanceUnknown === true);
  check("(B) F2 is actually unblocked", !activeMergeQuarantineFor(F2));
  check("(B) Y2 is ALSO actually unblocked (same union, same physical lift)", !activeMergeQuarantineFor(Y2));
}

// ===================== (C) an UNMARKED single-identity clear reports exactly that one identity — no false disclosure =====================
{
  const repoC1 = makeRepo("C1");
  enterMergeQuarantine(repoC1, "b", "4b6c8d24 fixture (C1, /clear)");
  const resultC1 = clearMergeQuarantineReporting(repoC1);
  check("(C1) /clear: liftedRepoPaths is EXACTLY [repoC1]", JSON.stringify(resultC1.liftedRepoPaths) === JSON.stringify([repoC1]));
  check("(C1) /clear: no provenanceUnknown notice on an unmarked clear", resultC1.provenanceUnknown === undefined);

  const repoC2 = makeRepo("C2");
  enterMergeQuarantine(repoC2, "b", "4b6c8d24 fixture (C2, clear-by-path)");
  const resultC2 = clearMergeQuarantineByRecordedPath(repoC2);
  check("(C2) clear-by-path: liftedRepoPaths is EXACTLY [repoC2]", JSON.stringify(resultC2.liftedRepoPaths) === JSON.stringify([repoC2]));
  check("(C2) clear-by-path: no provenanceUnknown notice on an unmarked clear", resultC2.provenanceUnknown === undefined);

  const repoC3 = makeRepo("C3");
  enterMergeQuarantine(repoC3, "b", "4b6c8d24 fixture (C3, clear-by-id)");
  const idC3 = quarantineLatchIdFor(repoC3);
  const resultC3 = clearMergeQuarantineLatchFile(idC3);
  check("(C3) clear-by-id: ok:true", resultC3.ok === true);
  check("(C3) clear-by-id: liftedRepoPaths is EXACTLY [repoC3] (unchanged — already correct per the card)", JSON.stringify(resultC3.liftedRepoPaths) === JSON.stringify([repoC3]));
}

// ===================== (D) the REFUSED shape (clear-by-id on an ambiguous/marked union) still refuses and reports nothing lifted =====================
{
  const Y3 = makeRepo("Y-D");
  const F3 = makeRepo("F-D");
  const kY3 = canonicalRepoLockKey(Y3);
  const kF3 = canonicalRepoLockKey(F3);
  const tokY3 = `tokY-D-${sfx}`;
  const tokF3 = `tokF-D-${sfx}`;
  const union3 = {
    repoPath: F3, branch: "b", reason: "4b6c8d24 fixture: Y3/F3 provenanceUnknown union (refusal check)",
    enteredAt: Date.now(), tokens: [tokY3, tokF3], resolvedKey: kF3, resolvedKeys: [kY3, kF3],
    armedKeys: [kY3, kF3], provenanceUnknown: true,
  };
  setActiveQuarantineTestOnly(kY3, union3);
  setActiveQuarantineTestOnly(kF3, union3);
  check("(D precondition) Y3 is quarantined via the union", !!activeMergeQuarantineFor(Y3));
  check("(D precondition) F3 is quarantined via the union", !!activeMergeQuarantineFor(F3));

  const idY3 = quarantineLatchIdFor(Y3);
  const resultD = clearMergeQuarantineLatchFile(idY3);
  check("(D) clear-by-id REFUSES on the ambiguous/marked union (ok:false)", resultD.ok === false);
  check("(D) Y3 stays blocked — nothing was lifted by the refused clear", !!activeMergeQuarantineFor(Y3));
  check("(D) F3 stays blocked too", !!activeMergeQuarantineFor(F3));

  // Clean up via the union's own recorded identity (F3), the one uniform way to lift a marked union.
  clearMergeQuarantineByRecordedPath(F3);
}

// ===================== (E) round 2, Code Review 12ae5f67 M1 — a runtime-folded contributor is named too =====================
// enterMergeQuarantine(A), then enterMergeQuarantine(A/sub) (a plain subdirectory, no own `.git`, so its
// own canonical key equals A's — 7673d096's own rule) — A/sub hits the `existing` branch and becomes a
// RUNTIME contributor (82032b5c), recorded on A's own entry as `contributorRepoPaths: [A/sub]`. Never a
// guess: this identity is already named, exactly, by the entry itself.
{
  const A = makeRepo("E-A");
  const aSub = path.join(A, "subdir");
  fs.mkdirSync(aSub, { recursive: true });
  enterMergeQuarantine(A, "a-branch", "4b6c8d24 fixture (E): A's own brand-new raise");
  enterMergeQuarantine(aSub, "asub-branch", "4b6c8d24 fixture (E): A/sub's runtime sibling-absorb raise");
  check("(E precondition) A/sub became a runtime contributor", !!activeMergeQuarantineFor(A)?.contributorRepoPaths?.includes(aSub));
  check("(E precondition) A is blocked before the clear", !!activeMergeQuarantineFor(A));

  const resultE = clearMergeQuarantineReporting(A);
  check("(E) wasQuarantined:true", resultE.wasQuarantined === true);
  check("*** THE FIX (E, M1) *** liftedRepoPaths names A", (resultE.liftedRepoPaths ?? []).includes(A));
  check("*** THE FIX (E, M1) *** liftedRepoPaths ALSO names A/sub (the runtime-folded contributor)", (resultE.liftedRepoPaths ?? []).includes(aSub));
  check("(E) A is actually unblocked", !activeMergeQuarantineFor(A));
  check("(E) A/sub is ALSO actually unblocked", assertRepoNotQuarantined(aSub).ok);
}

// ===================== (F) round 2, Code Review 12ae5f67 M2 — a foreign, protected occupant is NEVER reported lifted =====================
// X is a permanently-unresolvable ("ghost") path. Its own entry sits ARMED, in-memory, at
// canonicalRepoLockKey(R) — R's own key — with X's own real content on disk at that exact physical latch.
// Clearing R must PROTECT X (c9114934: a degraded occupant's content survives its key being reclaimed,
// diverted to its own pending record) rather than destroy or report it as lifted. The never-in-both
// invariant (an identity must never appear in BOTH liftedRepoPaths AND stillBlockedCoOccupants) is
// asserted explicitly, not just X's own absence from liftedRepoPaths.
{
  const R = makeRepo("F-R");
  const kR = canonicalRepoLockKey(R);
  const X = path.join(os.tmpdir(), `loom-4b6c8d24-F-X-ghost-${sfx}`); // deliberately never created
  const xToken = `x-token-F-${sfx}`;
  const xEntry = { repoPath: X, branch: "x-branch", reason: "4b6c8d24 fixture (F): ghost X squatting R's own key", enteredAt: Date.now(), tokens: [xToken] };
  setActiveQuarantineTestOnly(kR, xEntry);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kR)}.json`), JSON.stringify({
    repoPath: X, branch: "x-branch", reason: "4b6c8d24 fixture (F)", enteredAt: Date.now(), tokens: [xToken],
  }, null, 2) + "\n");
  check("(F precondition) X does not resolve on disk", !fs.existsSync(X));
  check("(F precondition) R reads blocked (X squats R's own key)", !assertRepoNotQuarantined(R).ok);

  const resultF = clearMergeQuarantineReporting(R);
  check("(F) wasQuarantined:true", resultF.wasQuarantined === true);
  check("*** THE FIX (F, M2) *** liftedRepoPaths names R", (resultF.liftedRepoPaths ?? []).includes(R));
  check("*** THE FIX (F, M2) *** liftedRepoPaths does NOT name X (a protected, still-blocked foreign occupant)", !(resultF.liftedRepoPaths ?? []).includes(X));
  check("*** THE FIX (F, M2) *** X IS named in stillBlockedCoOccupants instead", (resultF.stillBlockedCoOccupants ?? []).some((co) => co.repoPath === X));
  check("*** THE FIX (F, M2) *** NEVER-IN-BOTH invariant: no repoPath appears in both liftedRepoPaths and stillBlockedCoOccupants",
    (resultF.liftedRepoPaths ?? []).every((rp) => !(resultF.stillBlockedCoOccupants ?? []).some((co) => co.repoPath === rp)));
  check("(F) R is actually unblocked", assertRepoNotQuarantined(R).ok);
  check("(F) X stays blocked (protected, diverted to its own pending record)", !assertRepoNotQuarantined(X).ok);

  clearMergeQuarantineByRecordedPath(X); // cleanup — never leak X's protected divert into a later section
}

// ===================== (G) round 2 — a REDUCED (kept) pending twin's own repoPath must NOT appear =====================
// T is a real, resolvable repo. Its own active entry carries only `sharedToken`; a pending twin for the
// SAME identity (883e29bc's own dual-tracked-twin shape), tied via `orphanLatchFiles`, ALSO carries
// `privateToken` — outside the active entry's own token set, forcing clearMergeQuarantineByKey's own
// "reduce" branch (kept, never removed). T itself must stay OUT of liftedRepoPaths: privateToken is
// genuinely still outstanding, so T reads blocked after this clear.
//
// Driven via clearMergeQuarantineByKey DIRECTLY — the ONE deliberate exception to "always exercise the
// real entry point" in this file: `clearMergeQuarantineReporting`'s own `before`/`after` diagnostic
// queries call `resolveQuarantineFor`/`activeMergeQuarantineFor`, which can themselves LAZILY ABSORB a
// same-key pending sibling (8a1bc2ef) before the real clear ever runs — union-ing the twin's own tokens
// into the main entry ahead of time and destroying the exact "tied-but-separately-outstanding twin" shape
// this scenario needs to isolate. `clearMergeQuarantineByKey` is also the literal function this card's
// own fix lives in, mirroring `merge-quarantine-1fc3a561-residual-armedkeys-live-scan.mjs`'s own
// established precedent for testing this internal mechanism directly.
{
  const T = makeRepo("G-T");
  const kMain = canonicalRepoLockKey(T);
  const sharedToken = `shared-G-${sfx}`;
  const privateToken = `private-G-${sfx}`;
  const pSourceFile = `pending-4b6c8d24-G-${sfx}.json`;
  const mainEntry = {
    repoPath: T, branch: "main-branch", reason: "4b6c8d24 fixture (G): main entry", enteredAt: Date.now(),
    tokens: [sharedToken], orphanLatchFiles: [pSourceFile],
  };
  const twinEntry = {
    repoPath: T, branch: "twin-branch", reason: "4b6c8d24 fixture (G): dual-tracked twin, never armed",
    enteredAt: Date.now(), tokens: [sharedToken, privateToken],
  };
  setActiveQuarantineTestOnly(kMain, mainEntry);
  pushPendingQuarantineTestOnly(twinEntry, pSourceFile);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kMain)}.json`), JSON.stringify({
    repoPath: T, branch: "main-branch", reason: "4b6c8d24 fixture (G)", enteredAt: Date.now(), tokens: [sharedToken],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({
    repoPath: T, branch: "twin-branch", reason: "4b6c8d24 fixture (G)", enteredAt: Date.now(), tokens: [sharedToken, privateToken],
  }, null, 2) + "\n");

  const resultG = clearMergeQuarantineByKey(kMain, T, undefined, true);
  check("*** THE FIX (G, reduce) *** T's own repoPath does NOT appear in liftedRepoPaths (privateToken genuinely outstanding on the kept twin)", !(resultG.liftedRepoPaths ?? []).includes(T));
  check("(G) T STILL reads blocked after the clear (never falsely freed — the reduced twin re-armed at the now-vacated key)", !assertRepoNotQuarantined(T).ok);

  clearMergeQuarantineByRecordedPath(T); // cleanup — drop the surviving privateToken-holding twin
}

// ===================== (H) REST-level — both routes surface liftedRepoPaths/provenanceUnknown over a real app.inject() =====================
// Nothing could go RED at this layer before: the route handlers never destructured either field at all,
// so a stale pre-fix handler and a fixed clearMergeQuarantineReporting/clearMergeQuarantineByRecordedPath
// would read byte-identical over HTTP. This proves the WIRING, not just the underlying functions.
{
  const PORT = 45700 + (process.pid % 300);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const TMP = mkdtempManaged("loom-4b6c8d24-gw-");
  const db = new Db(path.join(TMP, "loom.db"));
  const now = new Date().toISOString();

  const Yh = makeRepo("H-Y");
  const Fh = makeRepo("H-F");
  const kYh = canonicalRepoLockKey(Yh);
  const kFh = canonicalRepoLockKey(Fh);
  const tokYh = `tokY-H-${sfx}`;
  const tokFh = `tokF-H-${sfx}`;
  const unionH = {
    repoPath: Fh, branch: "b", reason: "4b6c8d24 fixture (H): Y/F provenanceUnknown union",
    enteredAt: Date.now(), tokens: [tokYh, tokFh], resolvedKey: kFh, resolvedKeys: [kYh, kFh],
    armedKeys: [kYh, kFh], provenanceUnknown: true,
  };
  setActiveQuarantineTestOnly(kYh, unionH);
  setActiveQuarantineTestOnly(kFh, unionH);
  db.insertProject({
    id: "projH4b6c8d24", name: "ProjH4b6c8d24", repoPath: Yh, vaultPath: Yh, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const clearRes = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projH4b6c8d24" } });
    check("(H, /clear) -> 200", clearRes.statusCode === 200);
    const clearBody = clearRes.json();
    check("*** THE FIX (H, /clear) *** liftedRepoPaths names Y", Array.isArray(clearBody.liftedRepoPaths) && clearBody.liftedRepoPaths.includes(Yh));
    check("*** THE FIX (H, /clear) *** liftedRepoPaths ALSO names F", Array.isArray(clearBody.liftedRepoPaths) && clearBody.liftedRepoPaths.includes(Fh));
    check("*** THE FIX (H, /clear) *** provenanceUnknown:true over the wire", clearBody.provenanceUnknown === true);

    // A second, independent union for the clear-by-path {repoPath} route.
    const Yh2 = makeRepo("H2-Y");
    const Fh2 = makeRepo("H2-F");
    const kYh2 = canonicalRepoLockKey(Yh2);
    const kFh2 = canonicalRepoLockKey(Fh2);
    const tokYh2 = `tokY-H2-${sfx}`;
    const tokFh2 = `tokF-H2-${sfx}`;
    const unionH2 = {
      repoPath: Fh2, branch: "b", reason: "4b6c8d24 fixture (H2): Y2/F2 provenanceUnknown union",
      enteredAt: Date.now(), tokens: [tokYh2, tokFh2], resolvedKey: kFh2, resolvedKeys: [kYh2, kFh2],
      armedKeys: [kYh2, kFh2], provenanceUnknown: true,
    };
    setActiveQuarantineTestOnly(kYh2, unionH2);
    setActiveQuarantineTestOnly(kFh2, unionH2);
    const cbpRes = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { repoPath: Fh2 } });
    check("(H, clear-by-path {repoPath}) -> 200", cbpRes.statusCode === 200);
    const cbpBody = cbpRes.json();
    check("*** THE FIX (H, clear-by-path) *** liftedRepoPaths names F2 (the union's own recorded identity)", Array.isArray(cbpBody.liftedRepoPaths) && cbpBody.liftedRepoPaths.includes(Fh2));
    check("*** THE FIX (H, clear-by-path) *** provenanceUnknown:true over the wire", cbpBody.provenanceUnknown === true);
  } finally {
    await app.close();
    db.close();
  }
}

// ===================== (I) round 3, Code Review 6b9a4d0d R1 — sticky OR, clear-by-path =====================
// A marked ACTIVE entry for F plus a SEPARATE, UNMARKED pending entry for the SAME identity F (two
// distinct objects — never reference-equal, never tied). clearMergeQuarantineByRecordedPath's own
// matchedPending sweep drops the unmarked pending entry UNCONDITIONALLY (identity match alone), and that
// drop runs AFTER the marked active entry has already contributed `provenanceUnknown:true` — a plain
// `.set()` would let the later, unmarked candidate silently reset it to `false`.
{
  const F = makeRepo("I-F");
  const kF = canonicalRepoLockKey(F);
  const tokActive = `tokActive-I-${sfx}`;
  const tokPending = `tokPending-I-${sfx}`;
  const markedActive = {
    repoPath: F, branch: "active-branch", reason: "4b6c8d24 fixture (I): marked active entry",
    enteredAt: Date.now(), tokens: [tokActive], provenanceUnknown: true,
  };
  const unmarkedPending = {
    repoPath: F, branch: "pending-branch", reason: "4b6c8d24 fixture (I): separate, UNMARKED pending entry",
    enteredAt: Date.now(), tokens: [tokPending],
  };
  setActiveQuarantineTestOnly(kF, markedActive);
  pushPendingQuarantineTestOnly(unmarkedPending, `pending-4b6c8d24-I-${sfx}.json`);
  check("(I precondition) F is quarantined", !!activeMergeQuarantineFor(F));

  const resultI = clearMergeQuarantineByRecordedPath(F);
  check("(I) liftedRepoPaths names F", (resultI.liftedRepoPaths ?? []).includes(F));
  check("*** THE FIX (I, R1) *** provenanceUnknown:true SURVIVES despite the later unmarked pending candidate", resultI.provenanceUnknown === true);
}

// ===================== (J) round 3, R1 — sticky OR, the clearMergeQuarantineByKey twin =====================
// Same shape as (I), but tied via a shared token (subsetOfClearedTokens) so clearMergeQuarantineByKey's
// OWN pendingPlan processes the unmarked twin as a "remove" — driven DIRECTLY (same documented exception
// as scenario (G): isolating the shared helper's own internal candidate bookkeeping).
{
  const F = makeRepo("J-F");
  const kF = canonicalRepoLockKey(F);
  const sharedToken = `shared-J-${sfx}`;
  const markedActive = {
    repoPath: F, branch: "active-branch", reason: "4b6c8d24 fixture (J): marked active entry",
    enteredAt: Date.now(), tokens: [sharedToken], provenanceUnknown: true,
  };
  const unmarkedTwin = {
    repoPath: F, branch: "twin-branch", reason: "4b6c8d24 fixture (J): separate, UNMARKED twin (same token)",
    enteredAt: Date.now(), tokens: [sharedToken],
  };
  setActiveQuarantineTestOnly(kF, markedActive);
  pushPendingQuarantineTestOnly(unmarkedTwin, `pending-4b6c8d24-J-${sfx}.json`);

  const resultJ = clearMergeQuarantineByKey(kF, F, undefined, true);
  check("(J) liftedRepoPaths names F", (resultJ.liftedRepoPaths ?? []).includes(F));
  check("*** THE FIX (J, R1) *** provenanceUnknown:true SURVIVES despite the later unmarked twin candidate", resultJ.provenanceUnknown === true);
}

// ===================== (K) round 3, R2 — a NEVER-quarantined repo reports liftedRepoPaths:[] everywhere =====================
{
  const K1 = makeRepo("K1"); // genuinely never raised, never armed, never pending
  const kK1 = canonicalRepoLockKey(K1);
  const resultK1 = clearMergeQuarantineByKey(kK1, K1, undefined, true);
  check("*** THE FIX (K1, R2, ByKey) *** liftedRepoPaths is EMPTY for a never-quarantined repo (never [K1])", (resultK1.liftedRepoPaths ?? []).length === 0);
  check("(K1) wasQuarantined:false", resultK1.wasQuarantined === false);

  const K2 = makeRepo("K2");
  const resultK2 = clearMergeQuarantineReporting(K2);
  check("*** THE FIX (K2, R2, /clear) *** liftedRepoPaths is EMPTY for a never-quarantined repo", (resultK2.liftedRepoPaths ?? []).length === 0);
  check("(K2) wasQuarantined:false", resultK2.wasQuarantined === false);

  // The REST route, over a real app.inject() call.
  const PORT = 45900 + (process.pid % 300);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const TMP = mkdtempManaged("loom-4b6c8d24-gwK-");
  const db = new Db(path.join(TMP, "loom.db"));
  const now = new Date().toISOString();
  const K3 = makeRepo("K3");
  db.insertProject({
    id: "projK4b6c8d24", name: "ProjK4b6c8d24", repoPath: K3, vaultPath: K3, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const clearRes = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projK4b6c8d24" } });
    check("(K3, REST) -> 200", clearRes.statusCode === 200);
    const clearBody = clearRes.json();
    check("*** THE FIX (K3, R2, REST /clear) *** liftedRepoPaths is EMPTY for a never-quarantined repo over the wire", Array.isArray(clearBody.liftedRepoPaths) && clearBody.liftedRepoPaths.length === 0);
    check("(K3) wasQuarantined:false over the wire", clearBody.wasQuarantined === false);
  } finally {
    await app.close();
    db.close();
  }
}

// ===================== (L) round 3, Q — a protected occupant's OWN contributors are excluded too =====================
// Same ghost-X-squats-R's-key shape as (F), but X ITSELF now carries provenanceUnknown:true AND
// contributorRepoPaths:[xSub]. Since X is protected (not genuinely lifted), neither its mark NOR its own
// contributor may be reported — liftedRepoPaths must name ONLY R, and provenanceUnknown must be ABSENT.
{
  const R = makeRepo("L-R");
  const kR = canonicalRepoLockKey(R);
  const X = path.join(os.tmpdir(), `loom-4b6c8d24-L-X-ghost-${sfx}`); // deliberately never created
  const xSub = path.join(X, "subdir"); // X's own runtime-folded contributor — never its own object
  const xToken = `x-token-L-${sfx}`;
  const xEntry = {
    repoPath: X, branch: "x-branch", reason: "4b6c8d24 fixture (L): MARKED ghost X, with its own contributor",
    enteredAt: Date.now(), tokens: [xToken], provenanceUnknown: true, contributorRepoPaths: [xSub],
  };
  setActiveQuarantineTestOnly(kR, xEntry);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kR)}.json`), JSON.stringify({
    repoPath: X, branch: "x-branch", reason: "4b6c8d24 fixture (L)", enteredAt: Date.now(), tokens: [xToken],
    provenanceUnknown: true, contributorRepoPaths: [xSub],
  }, null, 2) + "\n");
  check("(L precondition) R reads blocked (X squats R's own key)", !assertRepoNotQuarantined(R).ok);

  const resultL = clearMergeQuarantineReporting(R);
  check("*** THE FIX (L, Q) *** liftedRepoPaths names R", (resultL.liftedRepoPaths ?? []).includes(R));
  check("*** THE FIX (L, Q) *** liftedRepoPaths does NOT name X (protected, still blocked)", !(resultL.liftedRepoPaths ?? []).includes(X));
  check("*** THE FIX (L, Q) *** liftedRepoPaths does NOT name X's own contributor xSub either (rides on X's surviving record)", !(resultL.liftedRepoPaths ?? []).includes(xSub));
  check("*** THE FIX (L, Q) *** provenanceUnknown is ABSENT — X's own mark was never genuinely lifted", resultL.provenanceUnknown === undefined);
  check("(L) R is actually unblocked", assertRepoNotQuarantined(R).ok);
  check("(L) X stays blocked (protected, diverted to its own pending record)", !assertRepoNotQuarantined(X).ok);

  // @decision 58ae4b34 — this used to be a Round-3-Q open probe (xSub read UNBLOCKED here, logged as a
  // finding, not fixed by this card). Card 58ae4b34 fixed `ownIdentityEntryFor` to also match an entry's
  // own `contributorRepoPaths`, so xSub is now correctly found via X's surviving (relocated) record.
  const xSubResult = assertRepoNotQuarantined(xSub);
  check("*** 58ae4b34 FIX *** xSub (X's own contributor) reads BLOCKED too, riding on X's surviving record", xSubResult.ok === false);
  check("*** 58ae4b34 FIX *** the refusal names the HOST entry X, not xSub itself", xSubResult.ok === false && namesAsBlockingRepo(xSubResult.reason, X));

  clearMergeQuarantineByRecordedPath(X); // lift X's own surviving divert record
  check("*** 58ae4b34 FIX *** clearing X (the host, by its own path) also unblocks its contributor xSub", assertRepoNotQuarantined(xSub).ok);
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);

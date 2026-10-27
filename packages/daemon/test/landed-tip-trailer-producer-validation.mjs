import "./_guard.mjs";
// @decision f2b4d684 — never collapse readLandedTipTrailer's UNVERIFIABLE result into ABSENT at a
// caller whose null-handling is a fresh live read rather than an unconditional refuse/hold.
//
// This file tests the PRODUCER's own three-way ABSENT/VALID/UNVERIFIABLE split in isolation; see
// landed-tip-trailer-unverifiable-retains-branch.mjs for the end-to-end caller proof.
//
// REAL git on a temp repo, no claude + no live daemon — same harness shape as
// stale-generation-landedtip-content-check.mjs's own (LANDEDTIP-REF-NAME-SHAPE) scenario, which exercises
// the SAME class of ambiguity at verifyReviewedTipChain's `live` parameter; this file exercises it at
// readLandedTipTrailer itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("ltt-home-");

const { readLandedTipTrailer, TRAILER_TIP_UNVERIFIABLE } = await import("../dist/git/worktrees.js");
const { simpleGit: realSimpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const ID = ["-c", "user.email=ltt@loom", "-c", "user.name=ltt"];
const run = (repo, args) => execFileSync("git", args, { cwd: repo }).toString().trim();

function newRepo(prefix) {
  const repo = mkdtempManaged(prefix);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...ID, "commit", "-q", "-m", "genesis"], { cwd: repo });
  return repo;
}

/** Commits a squash-shaped message carrying a real Loom trailer block (Loom-Worker-Branch + Loom-Landed-Tip). */
function commitWithLandedTipTrailer(repo, landedTip) {
  fs.writeFileSync(path.join(repo, "b.txt"), "squash\n"); // fixed content — one call per fresh repo, no uniqueness needed
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const message = `feat(x): squash landing\n\nLoom-Worker-Branch: loom/ltt-test\nLoom-Landed-Tip: ${landedTip}\n`;
  execFileSync("git", [...ID, "commit", "-q", "-m", message], { cwd: repo });
  return run(repo, ["rev-parse", "HEAD"]);
}

// (1) GENUINE: a real, resolvable commit sha with NO decoy ref of that name — must still resolve.
{
  const repo = newRepo("ltt-genuine-");
  const genesisSha = run(repo, ["rev-parse", "HEAD"]);
  const squashSha = commitWithLandedTipTrailer(repo, genesisSha);
  const result = await readLandedTipTrailer(repo, squashSha);
  check("(GENUINE) a real Loom-Landed-Tip with no decoy ref resolves to itself",
    result === genesisSha);
}

// (1b) NON-RESOLVING (the gc'd-genuine shape, at the producer level): a well-formed 40-hex Loom-Landed-Tip
// that simply does not correspond to any object in the repo (no decoy ref either — just gone/never-existed)
// — must be UNVERIFIABLE, never ABSENT (null) and never the literal text.
{
  const repo = newRepo("ltt-nonresolving-");
  const wellFormedButMissing = "3".repeat(40);
  const setupAbsent = (() => { try { return run(repo, ["cat-file", "-t", wellFormedButMissing]); } catch { return null; } })();
  check("(NON-RESOLVING) setup control: the well-formed hex genuinely does not resolve to any object", setupAbsent === null);

  const squashSha = commitWithLandedTipTrailer(repo, wellFormedButMissing);
  const result = await readLandedTipTrailer(repo, squashSha);
  check("(NON-RESOLVING) a well-formed but nonexistent Loom-Landed-Tip is UNVERIFIABLE, never ABSENT and never the literal text",
    result === TRAILER_TIP_UNVERIFIABLE);
}

// (2) FORGED (the fix): a 50-hex Loom-Landed-Tip (too long to be a real SHA-1 object id, so git can only
// resolve it as a REF NAME) with a planted same-named tag pointing at a DIFFERENT commit than the literal
// text denotes — must be UNVERIFIABLE, never silently return the decoy's resolved target, and (CR round 2)
// never ABSENT either — a present-but-forged trailer must NOT collapse to the same state a genuinely
// missing trailer does, or pinnedTipForLandedSquash would fall back to a fresh live read and finalize
// could delete a branch this trailer was supposed to protect.
{
  const repo = newRepo("ltt-forged-");
  const decoyTarget = run(repo, ["rev-parse", "HEAD"]); // what the planted tag will ACTUALLY point at
  const refNameHex = "7".repeat(50);
  execFileSync("git", [...ID, "tag", refNameHex, decoyTarget], { cwd: repo });

  const setupResolved = run(repo, ["rev-parse", "--verify", "--quiet", `${refNameHex}^{object}`]);
  check("(FORGED) setup control: the ref-name-shaped text resolves (via the planted tag) to the decoy target, proving it is NOT itself a raw object id",
    setupResolved === decoyTarget && setupResolved !== refNameHex);

  const squashSha = commitWithLandedTipTrailer(repo, refNameHex);
  const result = await readLandedTipTrailer(repo, squashSha);
  check("(FORGED) THE FIX: a ref-name-shaped Loom-Landed-Tip is UNVERIFIABLE, never the decoy's resolved target and never ABSENT",
    result === TRAILER_TIP_UNVERIFIABLE);
}

// (3) THROW PATH: a fault-injected gitFactory that lets the initial `git log` (producer's own read) and
// an ordinary `rev-parse HEAD` succeed, but throws on the validation call (rev-parse --verify / cat-file)
// resolveExactTrailerObjectId makes — must map to UNVERIFIABLE (CR round 2: never null/ABSENT — a trailer
// WAS parsed here, so a validation-call throw is "present but untrusted", not "nothing recorded").
{
  const repo = newRepo("ltt-throw-");
  const genesisSha = run(repo, ["rev-parse", "HEAD"]);
  const squashSha = commitWithLandedTipTrailer(repo, genesisSha);

  const throwingAfterLogFactory = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => (args[0] === "log" ? real.raw(args) : Promise.reject(new Error("simulated git failure (fault-injected for the throw-path test)"))),
    };
  };

  let threw = false;
  let result;
  try {
    result = await readLandedTipTrailer(repo, squashSha, { gitFactory: throwingAfterLogFactory });
  } catch {
    threw = true;
  }
  check("(THROW) a thrown git error from the validation call does not propagate out of readLandedTipTrailer",
    threw === false);
  check("(THROW) a thrown git error from the validation call maps to UNVERIFIABLE, never ABSENT (a trailer WAS parsed)",
    result === TRAILER_TIP_UNVERIFIABLE);
}

// (4) OUTER THROW (the log read itself fails): CR round 3 — an unreadable commit message is UNVERIFIABLE,
// never ABSENT. "Could not read the message" is "could not confirm either way", not "confirmed no
// trailer" — the round-1/2 ABSENT mapping here fed the permissive legacyTip fallback at
// pinnedTipForLandedSquash on nothing more than a transient git failure (the CR reproduced the deletion).
{
  const repo = newRepo("ltt-outer-throw-");
  const genesisSha = run(repo, ["rev-parse", "HEAD"]);
  const squashSha = commitWithLandedTipTrailer(repo, genesisSha);

  const throwingLogFactory = () => ({ raw: () => Promise.reject(new Error("simulated git failure (fault-injected: the outer log read itself)")) });

  let threw = false;
  let result;
  try {
    result = await readLandedTipTrailer(repo, squashSha, { gitFactory: throwingLogFactory });
  } catch {
    threw = true;
  }
  check("(OUTER THROW) a thrown git error from the log read itself does not propagate",
    threw === false);
  check("(OUTER THROW) THE FIX (CR round 3): a thrown git error from the log read itself maps to UNVERIFIABLE, never ABSENT — unreadable is not confirmed-absent",
    result === TRAILER_TIP_UNVERIFIABLE);
}

process.exitCode = failures === 0 ? 0 : 1;

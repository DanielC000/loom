import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1a858805 — createWorktree's `worktree add` call (inside withCanonicalIndexLock, git/worktrees.ts)
// can be KILLED mid-checkout by card 8e75ee20's withTimeoutKillingChild. `git worktree add` writes
// `.git/worktrees/<name>/locked` (content `initializing`) at the START of the add and clears it on
// success; a kill mid-flight leaves it behind. `git worktree prune` SKIPS locked records BY DESIGN, so
// neither the leading prune in createWorktree nor removeWorktree()'s existing single `--force` can ever
// clear it — git refuses: "cannot remove a locked working tree, lock reason: initializing" (verified
// below, real git, not a mock).
//
// This proves: (a) the OLD remedy (single `--force`) genuinely FAILS against the exact residue this card
// is about — the falsifiability leg DoD-3 asks for, using real git's own enforcement rather than a
// synthetic assertion that could pass vacuously; (b) createWorktree's OWN catch around its `worktree add`
// call recovers the residue end-to-end (`git worktree remove -f -f`, git's own documented override for
// this lock reason) and still rejects with the ORIGINAL add error, never a masked/replaced one; (c) a
// cleanup failure of its own is swallowed — createWorktree rejects with the original error, never hangs;
// (d) an add that fails WITHOUT ever creating the worktree (e.g. "already used by worktree at <path>")
// makes the cleanup a harmless no-op that never touches whatever OTHER path such an error names.
//
// Residue synthesis (real `worktree add` to completion, then hand-write the `locked` marker) mirrors the
// manager's own independent experiment on this card, corroborated separately by the 8e75ee20 worker's
// real killed-mid-checkout repro — both land on the identical on-disk shape this test manufactures.
//
// Run: 1) build daemon (pnpm build), 2) node test/worktree-locked-residue-cleanup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wt-lock-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree } = await import("../dist/git/worktrees.js");
const { simpleGit: realSimpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
/** Run a git command expected to FAIL; returns the captured stderr (or the error message), or null if it
 *  unexpectedly succeeded. Used for the falsifiability leg — proving real git itself refuses the old remedy. */
const gitFails = (cwd, args) => {
  try { execSync(`git ${args}`, { cwd }); return null; }
  catch (e) { return (e.stderr ? e.stderr.toString() : "") || e.message || ""; }
};

/** git's own worktree admin dir for `worktreePath`, under `<repoPath>/.git/worktrees/<name>` — `<name>` is
 *  the path's own basename for a fresh, uncollided path (verified against real git in this test's setup). */
const adminDirFor = (repoPath, worktreePath) => path.join(repoPath, ".git", "worktrees", path.basename(worktreePath));

const repo = path.join(os.tmpdir(), `loom-wt-lock-repo-${Date.now()}-${process.pid}`);
const extraDirs = []; // worktree checkouts created OUTSIDE createWorktree's own LOOM_HOME tree — cleaned in finally

try {
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email wtlock@loom && git config user.name wtlock && git commit -q --allow-empty -m init`, { cwd: repo });

  // (a) FALSIFIABILITY LEG — real git, not a mock: prove the residue is real and the OLD remedy
  //     (removeWorktree's single `--force`) genuinely cannot clear it, before trusting the new one can.
  {
    const wtA = `${repo}-wt-a`; // derived from repo's OWN <ts>-<pid> uniquifier, never a fixed shared-tmpdir name (card 1a858805 review finding 1)
    extraDirs.push(wtA);
    git(repo, `worktree add -q -b loom-lock-a "${wtA}"`); // real, complete add
    fs.writeFileSync(path.join(adminDirFor(repo, wtA), "locked"), "initializing"); // synthesize the killed-mid-checkout marker
    check("(a) [control] worktree list shows the locked record before any cleanup",
      git(repo, "worktree list --porcelain").includes("locked"));

    const singleForceErr = gitFails(repo, `worktree remove "${wtA}" --force`);
    check("(a) OLD remedy (single --force) genuinely FAILS against this exact residue (falsifiability leg)",
      singleForceErr !== null && /cannot remove a locked working tree/.test(singleForceErr));
    check("(a) admin record SURVIVES the failed single-force attempt — there is still something to clean",
      fs.existsSync(adminDirFor(repo, wtA)));

    // THE FIX, standalone (git's own documented override — the error text above names it verbatim):
    git(repo, `worktree remove "${wtA}" -f -f`);
    check("(a) `-f -f` clears the admin record", !fs.existsSync(adminDirFor(repo, wtA)));
    check("(a) worktree list no longer references it", !git(repo, "worktree list --porcelain").includes(path.basename(wtA)));
  }

  // (b) END-TO-END through createWorktree's own catch: a gitFactory performs a REAL `worktree add`
  //     (genuine admin state), injects the locked-mid-checkout residue, THEN rejects — modeling what
  //     withTimeoutKillingChild leaves behind before its wrapper promise settles. Proves the ACTUAL catch
  //     wiring (not just the standalone git calls above) recovers it, and still rejects with the ORIGINAL
  //     error — cleanup never masks or replaces it.
  {
    let capturedWtPath;
    const killingAddFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            capturedWtPath = args[2];
            await real.raw(args);
            fs.writeFileSync(path.join(adminDirFor(repoPathArg, capturedWtPath), "locked"), "initializing");
            throw new Error("git worktree add exceeded 250ms (git child killed)");
          }
          return real.raw(args);
        },
      };
    };
    let rejected = false, rejectMessage = null;
    await createWorktree(repo, "projLockB", "task-lock-b", {}, undefined, undefined, { gitFactory: killingAddFactory, timeoutMs: 5000 })
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
    check("(b) createWorktree REJECTS — the add genuinely failed; cleanup does not swallow it into a success", rejected === true);
    check(`(b) rejection carries the ORIGINAL add error, unchanged by cleanup (got: "${rejectMessage}")`,
      /git child killed/.test(rejectMessage ?? ""));
    check("(b) THE FIX: the ghost admin record is gone after createWorktree's own catch ran",
      capturedWtPath !== undefined && !fs.existsSync(adminDirFor(repo, capturedWtPath)));
    check("(b) THE FIX: the partial worktree directory itself is gone too",
      capturedWtPath !== undefined && !fs.existsSync(capturedWtPath));
    check("(b) git worktree list no longer references the failed path",
      capturedWtPath !== undefined && !git(repo, "worktree list --porcelain").includes(path.basename(capturedWtPath)));
  }

  // (c) BEST-EFFORT, BOUNDED: the cleanup call ITSELF also fails — createWorktree must still reject with
  //     the ORIGINAL add error (never a masking/different one), and must not hang.
  {
    const doubleFailFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") throw new Error("git worktree add exceeded 250ms (git child killed)");
          if (args[0] === "worktree" && args[1] === "remove") throw new Error("simulated cleanup failure — e.g. a second kill");
          return real.raw(args);
        },
      };
    };
    let rejected = false, rejectMessage = null;
    const t0 = performance.now(); // MONOTONIC
    await createWorktree(repo, "projLockC", "task-lock-c", {}, undefined, undefined, { gitFactory: doubleFailFactory, timeoutMs: 5000 })
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
    const elapsed = performance.now() - t0;
    check("(c) createWorktree still REJECTS when the cleanup call itself also fails", rejected === true);
    check(`(c) rejection is the ORIGINAL add error, NOT the cleanup failure (got: "${rejectMessage}")`,
      /git child killed/.test(rejectMessage ?? "") && !/simulated cleanup failure/.test(rejectMessage ?? ""));
    check(`(c) settled promptly (${Math.round(elapsed)}ms) — a failed cleanup does not hang createWorktree`, elapsed < 5000);
  }

  // (d) the add fails WITHOUT ever creating a worktree at its target path (e.g. "already used by worktree
  //     at <other path>" — the most likely non-kill failure to reach this catch, per the card's own
  //     remedy-scoping discussion). Cleanup must be a silent no-op, and must never touch whatever OTHER
  //     path the real error names — proven here via a sibling worktree that must stay untouched.
  {
    const sibling = `${repo}-wt-sibling`; // derived from repo's OWN <ts>-<pid> uniquifier, same reasoning as wtA above
    extraDirs.push(sibling);
    git(repo, `worktree add -q -b loom-lock-sibling "${sibling}"`);

    const neverCreatedFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            throw new Error(`fatal: 'loom-lock-d' is already used by worktree at '${sibling}'`);
          }
          return real.raw(args);
        },
      };
    };
    let rejected = false, rejectMessage = null;
    await createWorktree(repo, "projLockD", "task-lock-d", {}, undefined, undefined, { gitFactory: neverCreatedFactory, timeoutMs: 5000 })
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
    check("(d) createWorktree rejects with the real 'already used by worktree' error",
      rejected === true && /already used by worktree/.test(rejectMessage ?? ""));
    check("(d) the sibling worktree named in that error is UNTOUCHED (still on disk, still listed)",
      fs.existsSync(sibling) && git(repo, "worktree list --porcelain").includes(path.basename(sibling)));
  }
} finally {
  for (const d of extraDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a killed `worktree add`'s locked ghost admin record is recovered by createWorktree's " +
    "own catch (`git worktree remove -f -f`), the OLD single-force remedy genuinely fails against the " +
    "identical residue (real git, not a mock), and a cleanup failure never masks createWorktree's own " +
    "rejection nor touches an unrelated worktree."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2d06e5f1 — deterministic regression for served-status.mjs's (4) stale assertions flaking in full
// gates: the fixture commit date was derived from ONE early probe of the build clock, but
// computeDeployStaleness() recomputes that clock on every call, so a dist write landing between the probe
// and the call made the commit "not after the build" (stale:false, commitsBehind:0).
//
// HERMETIC: fixture dist dir + fixture git repo via the exported test-seam options; no real dist/git state.
// The interleaving is forced by SEQUENCING (probe → dist write → call), never by a wait.
//   (1) control: with no dist write, BOTH derivations count the commit (proves the fixture can read stale).
//   (2) RED shape: with a dist write after the probe, the OLD probe-only derivation reads commitsBehind 0.
//   (3) GREEN: the current derivation still counts the commit after the same write.
//   (4) the fixture can still read CLEAN: a commit dated BEFORE the build clock is not counted.
// Not covered: which real test lane writes dist in a gate (see the card report), or served_status's MCP wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitDateAfterBuild, commitDateAfterBuildProbeOnly } from "./_served-status-fixture-dates.mjs";
useOwnLoomHome("svdd-");
requireHermeticEnv();

const { computeDeployStaleness } = await import("../dist/deploy-staleness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const HOUR = 3_600_000;
const T0 = Date.now() - 2 * HOUR; // the "real build" — old, like a gate's build long before this test runs
const processStartedAt = new Date(Date.now() - HOUR).toISOString(); // gate: process starts long after the build

/** Fresh fixture: dist (one file at T0) + repo with an empty init commit; returns helpers. */
function makeFixture() {
  const root = mkdtempManaged("loom-svdd-");
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const distEntry = path.join(distDir, "index.js");
  fs.writeFileSync(distEntry, "// fixture entry\n");
  fs.utimesSync(distEntry, new Date(T0), new Date(T0));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
  const git = (args, dateIso) => execFileSync("git", args, {
    cwd: repo, stdio: "pipe",
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  git(["init", "-q"]);
  git(["-c", "user.email=t@loom", "-c", "user.name=t", "commit", "-q", "-m", "init", "--allow-empty"], new Date(T0 - 60_000).toISOString());
  const commitSrc = (dateIso) => {
    fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "foo.ts"), `export const foo = ${Math.random()};\n`);
    git(["add", "packages/daemon/src/foo.ts"]);
    git(["-c", "user.email=t@loom", "-c", "user.name=t", "commit", "-q", "-m", "feat(daemon): add foo"], dateIso);
  };
  const probe = () => computeDeployStaleness({ distEntry, repoRoot: repo, sharedDist: path.join(root, "no-shared-dist"), webDist: path.join(root, "no-web-dist"), processStartedAt });
  const bumpDist = () => { const f = path.join(distDir, "late-write.js"); fs.writeFileSync(f, "// another lane wrote dist\n"); };
  return { commitSrc, probe, bumpDist };
}

// (1) control — no drift, both derivations count the commit.
for (const [name, derive] of [["current", commitDateAfterBuild], ["probe-only", commitDateAfterBuildProbeOnly]]) {
  const fx = makeFixture();
  const p = fx.probe();
  check(`(1-setup ${name}) fixture probe is available and reads the fixture build clock`, p.available === true && Date.parse(p.distBuiltAt) === T0);
  fx.commitSrc(derive(Date.parse(p.distBuiltAt)));
  const r = fx.probe();
  check(`(1 ${name}) no dist drift ⇒ the after-build commit counts (commitsBehind 1, stale:true)`, r.commitsBehind === 1 && r.stale === true);
}

// (2) RED shape — a dist write between probe and call defeats the OLD derivation.
{
  const fx = makeFixture();
  const p = fx.probe();
  fx.bumpDist(); // the interleaving, forced by sequencing
  fx.commitSrc(commitDateAfterBuildProbeOnly(Date.parse(p.distBuiltAt)));
  const r = fx.probe();
  check("(2) probe-only derivation + a dist write after the probe ⇒ commitsBehind 0 (the flake, reproduced deterministically)", r.available === true && r.commitsBehind === 0 && r.stale === false);
  check("(2) the write really did move the build clock past the probed one (names the drift)", Date.parse(r.distBuiltAt) > Date.parse(p.distBuiltAt));
}

// (3) GREEN — the current derivation survives the same write.
{
  const fx = makeFixture();
  const p = fx.probe();
  fx.bumpDist();
  fx.commitSrc(commitDateAfterBuild(Date.parse(p.distBuiltAt)));
  const r = fx.probe();
  check("(3) current derivation + the same dist write ⇒ commitsBehind 1, stale:true", r.available === true && r.commitsBehind === 1 && r.stale === true);
}

// (4) the fixture can still read CLEAN — a commit before the build clock must NOT count.
{
  const fx = makeFixture();
  const p = fx.probe();
  fx.bumpDist();
  fx.commitSrc(new Date(Date.parse(p.distBuiltAt) - 60_000).toISOString());
  const r = fx.probe();
  check("(4) a commit dated BEFORE the build clock is not counted (stale:false, commitsBehind 0)", r.available === true && r.commitsBehind === 0 && r.stale === false);
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

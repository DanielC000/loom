import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 887e10b8 Item 1 (multi-harness epic df1f94b0, Phase 1) — hermetic coverage for
// pty/codex-doctrine.ts#injectCodexDoctrine and its git-hygiene helpers. Pure filesystem-transform logic,
// no pty/real spawn involved — a fake-pty/real-spawn test can't observe this any more precisely than
// direct file assertions can, so a hermetic unit test is the right-sized check here (mirrors
// codex-host-decisions.mjs's own "pure decision logic gets a hermetic test" posture). RECEPTION (does a
// real codex process actually READ this file) is a SEPARATE claim this test does NOT make — see
// test/codex-doctrine-real-spawn.mjs for that proof.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-injection.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { injectCodexDoctrine, isCodexDoctrinePath, CODEX_DOCTRINE_FILE } = await import("../dist/pty/codex-doctrine.js");

check("CODEX_DOCTRINE_FILE is the codex-native convention name", CODEX_DOCTRINE_FILE === "AGENTS.md");

// --- isCodexDoctrinePath: positive + negative control on the SAME predicate --------------------------
check("isCodexDoctrinePath('AGENTS.md') === true (positive control)", isCodexDoctrinePath("AGENTS.md") === true);
check("isCodexDoctrinePath is exact-match, not prefix-match — 'sub/AGENTS.md' is NOT the root file", isCodexDoctrinePath("sub/AGENTS.md") === false);
check("isCodexDoctrinePath('CLAUDE.md') === false (negative control — the predicate can discriminate, not just always-false)", isCodexDoctrinePath("CLAUDE.md") === false);

function makeFakeRepo(prefix) {
  const cwd = mkdtempManaged(prefix);
  fs.mkdirSync(path.join(cwd, ".git")); // a bare dir is enough — resolveGitCommonDirForDoctrine only stats it
  return cwd;
}

// --- non-worker role: never injects --------------------------------------------------------------------
{
  const cwd = makeFakeRepo("loom-codex-doctrine-norole-");
  injectCodexDoctrine(cwd, "manager");
  check("role !== 'worker' (manager) — no AGENTS.md written (Phase-1 scope limit)", !fs.existsSync(path.join(cwd, "AGENTS.md")));
  injectCodexDoctrine(cwd, null);
  check("role === null — no AGENTS.md written", !fs.existsSync(path.join(cwd, "AGENTS.md")));
  injectCodexDoctrine(cwd, undefined);
  check("role === undefined — no AGENTS.md written", !fs.existsSync(path.join(cwd, "AGENTS.md")));
}

// --- fresh worker spawn: creates AGENTS.md with the doctrine block + a stable, content-derived ID ------
let firstBlock = null;
{
  const cwd = makeFakeRepo("loom-codex-doctrine-fresh-");
  const target = path.join(cwd, "AGENTS.md");
  check("AGENTS.md absent before injection", !fs.existsSync(target));
  injectCodexDoctrine(cwd, "worker");
  check("AGENTS.md created for role='worker'", fs.existsSync(target));
  firstBlock = fs.readFileSync(target, "utf8");
  check("carries the managed-block BEGIN marker", firstBlock.startsWith("<!-- LOOM:CODEX-DOCTRINE:BEGIN"));
  check("carries the managed-block END marker", firstBlock.trimEnd().endsWith("<!-- LOOM:CODEX-DOCTRINE:END -->"));
  check("carries a LOOM-DOCTRINE-ID line (the real-spawn test's reception marker)", /LOOM-DOCTRINE-ID: [0-9a-f]{8}/.test(firstBlock));
  check("names the three load-bearing rules (targeted-test default, no-speculative-gate, escalate-up)",
    /[Tt]argeted-test default/.test(firstBlock) && /speculatively run a shared\/full gate/.test(firstBlock) && /Escalate up/.test(firstBlock));
  check("points at the project's own CLAUDE.md rather than restating project specifics", /CLAUDE\.md/.test(firstBlock));

  // --- idempotent re-injection: identical content on a second call (resume) ----------------------------
  injectCodexDoctrine(cwd, "worker");
  const secondBlock = fs.readFileSync(target, "utf8");
  check("re-injecting the SAME doctrine version produces byte-identical content (idempotent resume)", secondBlock === firstBlock);

  // --- git-hygiene: the shared .git/info/exclude gets the entry, so a worker's `git status` never
  // surfaces this as untracked noise a blind `git add -A` could sweep in. --------------------------------
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let excludeContent = "";
  try { excludeContent = fs.readFileSync(excludePath, "utf8"); } catch { /* asserted false below */ }
  check("git info/exclude gains a '/AGENTS.md' entry after injection", excludeContent.split(/\r?\n/).includes("/AGENTS.md"));
}

// --- never clobbers a repo's OWN real, pre-existing AGENTS.md (mirrors skills/inject.ts's rule) --------
{
  const cwd = makeFakeRepo("loom-codex-doctrine-preexisting-");
  const target = path.join(cwd, "AGENTS.md");
  const ownContent = "# This project's own real AGENTS.md\n\nSome real, human-authored project instructions.\n";
  fs.writeFileSync(target, ownContent);
  injectCodexDoctrine(cwd, "worker");
  check("a pre-existing AGENTS.md that does NOT start with the Loom marker is left byte-identical (never clobbered)",
    fs.readFileSync(target, "utf8") === ownContent);
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let excludeContent = "";
  try { excludeContent = fs.readFileSync(excludePath, "utf8"); } catch { /* fine if absent */ }
  check("a real pre-existing AGENTS.md is NOT git-excluded either (it is a real, presumably-tracked project file)",
    !excludeContent.split(/\r?\n/).includes("/AGENTS.md"));
}

// --- stale Loom-owned content (an older doctrine wording) IS refreshed, unlike a foreign file ----------
{
  const cwd = makeFakeRepo("loom-codex-doctrine-stale-");
  const target = path.join(cwd, "AGENTS.md");
  const staleBlock = "<!-- LOOM:CODEX-DOCTRINE:BEGIN (managed by Loom — regenerated every spawn; do not edit by hand) -->\nSTALE PRIOR VERSION\n<!-- LOOM:CODEX-DOCTRINE:END -->\n";
  fs.writeFileSync(target, staleBlock);
  injectCodexDoctrine(cwd, "worker");
  const refreshed = fs.readFileSync(target, "utf8");
  check("a stale Loom-OWNED block (starts with our marker) IS refreshed to the current doctrine content", refreshed === firstBlock && refreshed !== staleBlock);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — injectCodexDoctrine creates/refreshes a Loom-owned AGENTS.md for worker-role codex sessions only, never clobbers a repo's own real file, and hides its own untracked artifact from git status."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);

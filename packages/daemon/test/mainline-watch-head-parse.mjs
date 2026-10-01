import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 — PURE unit test of `parseHeadShaAndBranch` (git/mainline-watch.ts), the parser for the
// combined `git rev-parse HEAD --symbolic-full-name HEAD` output this card introduced to cut the batch
// fast-forward's branch-pin verification from 4 extra git spawns per landing down to 1 (see
// docs/decisions/b801bad0-*.md "Round 2"). No real git process here — this is the parse logic alone,
// fast and hermetic; the real-spawn integration is covered by batch-merge-canonical-branch-divert.mjs and
// mainline-watch-reads.mjs (which exercise `readMainlineHead`, now backed by this same parser).
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-head-parse.mjs
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const { parseHeadShaAndBranch } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── attached: the ordinary case ───────────────────────────────────────────────────────────────────────
{
  const r = parseHeadShaAndBranch(`${SHA_A}\nrefs/heads/main\n`);
  check("attached: resolves", r !== null);
  check("attached: sha", r?.sha === SHA_A);
  check("attached: branch", r?.branch === "main");
}
{
  // A branch name itself containing a slash (e.g. loom/abc123) must not be mis-sliced.
  const r = parseHeadShaAndBranch(`${SHA_A}\nrefs/heads/loom/abc123\n`);
  check("attached, slashy branch name: branch is the FULL remainder after refs/heads/, not truncated at the first slash", r?.branch === "loom/abc123");
}

// ── detached: THE branch this card adds (card b801bad0's own DoD ask) ────────────────────────────────
{
  const r = parseHeadShaAndBranch(`${SHA_A}\nHEAD\n`);
  check("detached: resolves (does not fail closed on git's own documented fallback)", r !== null);
  check("detached: sha still present", r?.sha === SHA_A);
  check("detached: branch is null, never a guessed name", r?.branch === null);
}

// ── fail-closed cases: never guess, never half-parse ──────────────────────────────────────────────────
{
  check("empty output: fails closed", parseHeadShaAndBranch("") === null);
}
{
  check("only one line: fails closed (missing the ref line)", parseHeadShaAndBranch(`${SHA_A}\n`) === null);
}
{
  check("three lines: fails closed (not the expected two-line shape)", parseHeadShaAndBranch(`${SHA_A}\nrefs/heads/main\nextra\n`) === null);
}
{
  check("unparseable sha (not hex): fails closed", parseHeadShaAndBranch(`not-a-sha\nrefs/heads/main\n`) === null);
}
{
  check("a non-refs/heads/ second line (e.g. a tag): fails closed, never guessed as a branch", parseHeadShaAndBranch(`${SHA_A}\nrefs/tags/v1\n`) === null);
}
{
  check("refs/heads/ with nothing after it: fails closed (empty branch name)", parseHeadShaAndBranch(`${SHA_A}\nrefs/heads/\n`) === null);
}
{
  // Positive control that the sha format check actually discriminates (64-hex sha256 also accepted).
  const SHA256_LIKE = "c".repeat(64);
  const r = parseHeadShaAndBranch(`${SHA256_LIKE}\nrefs/heads/main\n`);
  check("a 64-hex (sha256-shaped) sha is accepted too", r?.sha === SHA256_LIKE);
}
{
  // Negative control for the "attached" positive above: a DIFFERENT sha is read correctly, not a stale fixture.
  const r = parseHeadShaAndBranch(`${SHA_B}\nrefs/heads/other\n`);
  check("negative control: a different input really does parse to a different result (not a hardcoded fixture)", r?.sha === SHA_B && r?.branch === "other");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — parseHeadShaAndBranch correctly splits the combined `rev-parse HEAD --symbolic-full-name HEAD` output into sha+branch when attached, sha+null when detached, and fails closed on anything else rather than guessing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

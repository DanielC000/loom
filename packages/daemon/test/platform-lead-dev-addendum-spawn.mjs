import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f437d4e9 C4 ROUND 2: the Platform Lead's dev-only addendum (the self-hosting daemon_restart/deploy
// framing + the "don't auto-drive Loom-product development" carve-out, stripped from the now-generic
// /platform-lead skill) is injected at SPAWN TIME by `composePlatformLeadStartupPrompt`
// (sessions/platform-lead-prompt.ts), not via a stored-prompt migration — so an agent whose startupPrompt
// row is hand-edited can never silently lose it, and a non-dev install never sees it at all.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: calls the real compiled compose function directly (pure given
// `isLoomDev()`'s env read), no Db/pty/daemon involved. Proves:
//   (a) LOOM_DEV=1: the addendum is appended, even when the agent's own startupPrompt is user-edited
//       (arbitrary text unrelated to the original seeded prompt);
//   (b) LOOM_DEV unset (and LOOM_DEV=0): the addendum never appears;
//   (c) no duplication across repeated composes of the SAME raw agent prompt — the shape every real
//       fresh/recycle/forced-restart spawn site uses (each always passes the agent's raw stored
//       startupPrompt, never a previously-composed one — see that function's own doc) — so calling it
//       twice (simulating two recycles in a row) never yields two copies of the addendum.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-dev-addendum-spawn.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composePlatformLeadStartupPrompt, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM } =
  await import("../dist/sessions/platform-lead-prompt.js");

const RESUME_DOC_PATH = "/tmp/PLATFORM-LEAD-RESUME.md";
const USER_EDITED_PROMPT = "My own completely rewritten Platform Lead prompt — nothing like the seeded one.";

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ===================== (a) LOOM_DEV=1: addendum appended, even over a user-edited prompt =====================
process.env.LOOM_DEV = "1";
const devComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
check("(a) LOOM_DEV=1: composed text contains the dev addendum", devComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
check("(a) LOOM_DEV=1: the user-edited prompt text still survives verbatim", devComposed.includes(USER_EDITED_PROMPT));
check("(a) LOOM_DEV=1: the addendum is appended AFTER the user's own prompt (so it can't be edited away)",
  devComposed.indexOf(USER_EDITED_PROMPT) < devComposed.indexOf(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

// ===================== (a, cont'd) also appended with NO own startupPrompt at all =====================
const devComposedNoOwn = composePlatformLeadStartupPrompt(undefined, RESUME_DOC_PATH);
check("(a) LOOM_DEV=1, no own startupPrompt: addendum still appended", devComposedNoOwn.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

// ===================== (b) LOOM_DEV unset / "0": addendum never appears =====================
delete process.env.LOOM_DEV;
const nonDevComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
check("(b) LOOM_DEV unset: composed text does NOT contain the dev addendum", !nonDevComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
check("(b) LOOM_DEV unset: the user's own prompt still survives verbatim", nonDevComposed.includes(USER_EDITED_PROMPT));

process.env.LOOM_DEV = "0";
const devZeroComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
check("(b) LOOM_DEV=0: composed text does NOT contain the dev addendum either", !devZeroComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

// ===================== (c) no duplication across repeated composes of the SAME raw prompt =====================
process.env.LOOM_DEV = "1";
const firstCompose = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
// Simulates a SECOND recycle in a row: every real call site re-reads the agent's own raw startupPrompt
// fresh (never the previously-composed text), so the input here is the SAME raw USER_EDITED_PROMPT again,
// not firstCompose.
const secondCompose = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
check("(c) repeated compose of the same raw prompt yields byte-identical output (no drift)", firstCompose === secondCompose);
check("(c) the addendum appears EXACTLY once in a single compose", countOccurrences(firstCompose, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM) === 1);

delete process.env.LOOM_DEV;

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead's dev-only addendum is injected at spawn time (LOOM_DEV=1 only), survives over a user-edited prompt, never appears on a non-dev install, and never duplicates across repeated composes of the same raw prompt."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

import "./_guard.mjs"; // prod-guard: pure source-level/discovery checks below, no Db used
// Card ce02e7e5: the adopted gateCommand split (owner-approved via request 6fe23078, card 852b58e5)
// hardcodes the codex real-spawn basename list TWICE — once in --only=, once in --exclude=. This test
// proves the replacement --codex-real-spawn/--no-codex-real-spawn presets (scripts/test-daemon.mjs,
// resolved via resolveSelectionForCliMode) actually remove that duplication: they are exact complements
// over the REAL discovered hermetic set (DoD-1), and they demonstrably READ CODEX_REAL_SPAWN_BASENAMES
// (test/_codex-real-spawn-lock.mjs, the single source of truth) rather than a second, re-hardcoded copy
// (DoD-2). test-daemon-cli-args.mjs already covers CLI classification + the same properties against a
// synthetic hermetic set; this file is the real-corpus counterpart.
//
// ⚠️ Deliberately does NOT execute any real codex-real-spawn test file (that needs a real, model-backed
// `codex` CLI spawn and the shared cross-process lock — see _codex-real-spawn-lock.mjs's own header, and
// this project's own doctrine: executing a `*-real-spawn.mjs` file needs explicit go-ahead). Every check
// here drives the exported, pure selection-resolution functions directly against real DISCOVERY data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHermeticTests, resolveSelectionForCliMode } from "../scripts/test-daemon.mjs";
import { CODEX_REAL_SPAWN_BASENAMES } from "./_codex-real-spawn-lock.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Population sanity: the real inputs must actually be usable before trusting anything derived from them ---

const { hermetic: HERMETIC, violations } = discoverHermeticTests(TEST_DIR);
check(`sanity: discovery ran clean against the real test/ dir (0 violations, found ${violations.length})`, violations.length === 0);
check(`sanity: the real discovered hermetic set is non-empty (found ${HERMETIC.length})`, HERMETIC.length > 0);
check(`sanity: CODEX_REAL_SPAWN_BASENAMES is non-empty (found ${CODEX_REAL_SPAWN_BASENAMES.length})`, CODEX_REAL_SPAWN_BASENAMES.length > 0);

// Every real codex real-spawn basename must actually be a discovered hermetic test, or --codex-real-spawn
// would refuse loudly at real gate time (an unknown --only= name — card 6185fbfc's own discipline) and
// the complement check below would be comparing against a set that doesn't really contain them.
const missingFromHermetic = CODEX_REAL_SPAWN_BASENAMES.filter((b) => !HERMETIC.includes(b));
check(
  `every real CODEX_REAL_SPAWN_BASENAMES entry is a discovered hermetic test (missing: ${JSON.stringify(missingFromHermetic)})`,
  missingFromHermetic.length === 0,
);

// --- DoD-1: --codex-real-spawn / --no-codex-real-spawn are EXACT COMPLEMENTS over the REAL hermetic set ---

{
  const onlyResult = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "only", only: null, exclude: null }, CODEX_REAL_SPAWN_BASENAMES);
  const excludeResult = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "exclude", only: null, exclude: null }, CODEX_REAL_SPAWN_BASENAMES);
  check("--codex-real-spawn resolves cleanly against the real corpus (no unknown-name/empty-selection refusal)", onlyResult.error === null);
  check("--no-codex-real-spawn resolves cleanly against the real corpus (no unknown-name/empty-selection refusal)", excludeResult.error === null);

  const onlySel = onlyResult.selected ?? [];
  const excludeSel = excludeResult.selected ?? [];
  const union = new Set([...onlySel, ...excludeSel]);
  const intersection = onlySel.filter((n) => excludeSel.includes(n));

  // Without the union half, a future CODEX_REAL_SPAWN_BASENAMES change (a name renamed/removed from the
  // hermetic set without updating the lock file) could silently drop a file from BOTH steps — the card's
  // own named failure mode ("skipping a test entirely, which would read as a pleasingly faster suite").
  check(
    `union of --codex-real-spawn + --no-codex-real-spawn equals the FULL real hermetic set (union ${union.size}, hermetic ${HERMETIC.length})`,
    union.size === HERMETIC.length && HERMETIC.every((n) => union.has(n)),
  );
  check(`intersection of --codex-real-spawn + --no-codex-real-spawn is EMPTY (found ${intersection.length}: ${JSON.stringify(intersection)})`, intersection.length === 0);
  check(
    `--codex-real-spawn selects EXACTLY the real codex real-spawn family (${onlySel.length} of ${CODEX_REAL_SPAWN_BASENAMES.length})`,
    onlySel.length === CODEX_REAL_SPAWN_BASENAMES.length && CODEX_REAL_SPAWN_BASENAMES.every((n) => onlySel.includes(n)),
  );
}

// --- DoD-2: positive control that the presets genuinely READ the array, not a re-hardcoded copy ---
//
// DoD-1 above, on its own, is NOT sufficient: the union==full/intersection==empty property holds for ANY
// fixed list vs. the real hermetic set, whether or not that list is actually wired to
// CODEX_REAL_SPAWN_BASENAMES — a preset that silently re-hardcoded today's 7 names inline would pass
// every check above unchanged and "would sail through a naive test" exactly as the card warns. This block
// is what would actually catch that regression: drive the SAME preset through resolveSelectionForCliMode
// twice, varying ONLY the codexRealSpawnBasenames argument — a real, ordinary (non-codex) hermetic test
// name, then that SAME name plus a second real hermetic test name as a planted "fake member" — and
// confirm the selection tracks the array, not a closed-over constant.
{
  const nonCodexHermetic = HERMETIC.filter((n) => !CODEX_REAL_SPAWN_BASENAMES.includes(n));
  check(`sanity: at least 2 non-codex hermetic tests exist to build a synthetic basenames array from (found ${nonCodexHermetic.length})`, nonCodexHermetic.length >= 2);

  const [firstName, fakeMember] = nonCodexHermetic;
  const baseArray = [firstName];
  const fakeMemberArray = [firstName, fakeMember];

  const baseOnly = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "only", only: null, exclude: null }, baseArray).selected ?? [];
  const fakeOnly = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "only", only: null, exclude: null }, fakeMemberArray).selected ?? [];
  check(
    "[positive control] --codex-real-spawn's selection CHANGES the instant the basenames array gains a fake member — proves it reads the array, not a hardcoded copy",
    !baseOnly.includes(fakeMember) && fakeOnly.includes(fakeMember),
  );

  const baseExclude = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "exclude", only: null, exclude: null }, baseArray).selected ?? [];
  const fakeExclude = resolveSelectionForCliMode(HERMETIC, { codexRealSpawnPreset: "exclude", only: null, exclude: null }, fakeMemberArray).selected ?? [];
  check(
    "[positive control] --no-codex-real-spawn's selection ALSO tracks the array (the fake member becomes excluded too)",
    baseExclude.includes(fakeMember) && !fakeExclude.includes(fakeMember),
  );
}

// --- Wiring check: the REAL gate path (isMain) must pass the imported CODEX_REAL_SPAWN_BASENAMES ---
// --- binding into resolveSelectionForCliMode, not a re-typed literal array ---
//
// The two blocks above prove resolveSelectionForCliMode ITSELF is correctly array-driven; this is what
// would catch isMain wiring a hardcoded list into it instead of the real dynamically-imported binding —
// a defect the pure-function tests above cannot see, since they call resolveSelectionForCliMode directly.
{
  const scriptPath = path.join(TEST_DIR, "..", "scripts", "test-daemon.mjs");
  const scriptSource = fs.readFileSync(scriptPath, "utf8");
  check(
    "isMain wires the REAL, imported CODEX_REAL_SPAWN_BASENAMES binding into resolveSelectionForCliMode (source-text check)",
    scriptSource.includes("resolveSelectionForCliMode(HERMETIC, cliMode, CODEX_REAL_SPAWN_BASENAMES)"),
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — --codex-real-spawn/--no-codex-real-spawn are exact complements over the real discovered hermetic set, both presets are shown reading CODEX_REAL_SPAWN_BASENAMES rather than a hardcoded copy (a planted fake member changes the resulting selection), and the real isMain gate path is wired to the real imported binding."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

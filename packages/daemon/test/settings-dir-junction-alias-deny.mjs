import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card f2bb9dbe — `SETTINGS_DIR_READ_DENY_RULE` (pty/claude-settings.ts) used to be built from the RAW,
// unresolved `SETTINGS_DIR` string alone (discovered by 30039c88, left acknowledged only in a source
// comment at pty/loom-home-deny.ts:9-12, untracked by any card or decision record). When the CONFIGURED
// `LOOM_HOME` (or `tmp/settings` itself) is behind a junction (Windows) or symlink (POSIX), that raw-only
// glob names only the configured (alias) path — a read of the SAME content issued via the REAL, unaliased
// path went unmatched. This file proves exactly that one case; see docs/decisions/f2bb9dbe's own "What
// stays open" section for the distinct, NOT-closed shape (a THIRD, unrelated alias reaching the same real
// directory) this is easy to conflate it with.
//
// This file proves:
//   PART 1 — with LOOM_HOME itself set to a junction/symlink ALIAS of a real target directory,
//            `SETTINGS_DIR_REAL` (claude-settings.ts) resolves to the REAL target's own tmp/settings
//            path, genuinely different from the raw (alias-rooted) `SETTINGS_DIR` string.
//   PART 2 — `SETTINGS_DIR_READ_DENY_RULES` denies BOTH the raw (alias) path AND the resolved real path;
//            the raw-only rule (`SETTINGS_DIR_READ_DENY_RULE`, kept for back-compat) is still one of them.
//   PART 3 — a BEHAVIOURAL negative control: applying the SAME real-target-path coverage check against
//            the OLD, pre-fix single-rule array (`[SETTINGS_DIR_READ_DENY_RULE]` alone) is RED by name —
//            proving the check can fail, not just that the new code happens to pass it.
//   PART 4 — `withSettingsDirDenyForSpawn`, under the SAME aliased LOOM_HOME, unions in whichever of the
//            two rules is missing, de-duped. The ordinary, non-aliased byte-identical case is deliberately
//            NOT re-verified in this file — see the NOTE near the bottom for why — and is already covered
//            by mcp-config-secret-lifecycle.mjs's existing assertions.
//
// Windows gets a directory JUNCTION (no elevated privilege needed); POSIX gets a symlink. Either creation
// failing (e.g. a POSIX host without symlink permission) skips every check in this file cleanly.
//
// Run: 1) build (turbo builds shared first), 2) node test/settings-dir-junction-alias-deny.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A simple, test-local approximation of the CLI's own `Read(<glob>/**)` matching: strip the wrapper and
// check the candidate (forward-slashed) absolute path is the glob's base or nested under it. This is NOT
// a claim about the real CLI matcher's exact semantics (that is measured elsewhere, real-spawn, per
// ed0757d6/37310431's own "Ruling A" caveats) — it exists only to give PART 3's negative control
// something to fail against, deterministically, with no real engine involved.
function ruleCoversPath(rule, absPath) {
  const m = /^Read\((.+)\/\*\*\)$/.exec(rule);
  if (!m) return false;
  const base = m[1];
  const normalized = absPath.replace(/\\/g, "/");
  return normalized === base || normalized.startsWith(`${base}/`);
}

// @decision 37310431 — LOOM_HOME must be assigned, and (for this file) the junction/symlink alias must
// exist on disk, BEFORE the FIRST import of anything that transitively imports `paths.js` — `paths.js`
// computes LOOM_HOME-derived constants at MODULE-LOAD time and caches them.
const realHome = mkdtempManaged("loom-sdjad-real-");
fs.mkdirSync(path.join(realHome, "tmp", "settings"), { recursive: true });
fs.mkdirSync(path.join(realHome, "logs"), { recursive: true });

const aliasParent = mkdtempManaged("loom-sdjad-alias-parent-");
const aliasHome = path.join(aliasParent, "alias-loom-home");
let aliasOk = true;
try {
  fs.symlinkSync(realHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
} catch (e) {
  aliasOk = false;
  console.log(`WARN  SKIP  all checks in this file — could not create a junction/symlink alias on this host (${e.message}).`);
}

if (aliasOk) {
  registerForCleanup(aliasParent);
  process.env.LOOM_HOME = aliasHome;
  requireHermeticEnv();

  const { SETTINGS_DIR } = await import("../dist/paths.js");
  const { SETTINGS_DIR_REAL, SETTINGS_DIR_READ_DENY_RULE, SETTINGS_DIR_READ_DENY_RULES, withSettingsDirDenyForSpawn } =
    await import("../dist/pty/claude-settings.js");

  const rawForwardSlashed = SETTINGS_DIR.replace(/\\/g, "/");
  const realTargetSettingsDir = path.join(realHome, "tmp", "settings");
  const realTargetForwardSlashed = realTargetSettingsDir.replace(/\\/g, "/");

  // =====================================================================================================
  // PART 1 — SETTINGS_DIR_REAL resolves the alias to its real target, genuinely different from raw
  // =====================================================================================================
  check("SETTINGS_DIR (raw) is rooted at the ALIAS path, not the real target",
    path.resolve(SETTINGS_DIR).toLowerCase() === path.resolve(aliasHome, "tmp", "settings").toLowerCase());
  check("SETTINGS_DIR_REAL resolves to the REAL target's own tmp/settings path",
    path.resolve(SETTINGS_DIR_REAL).toLowerCase() === path.resolve(realTargetSettingsDir).toLowerCase());
  check("SETTINGS_DIR_REAL genuinely differs from the raw SETTINGS_DIR string (the alias actually aliases)",
    rawForwardSlashed.toLowerCase() !== SETTINGS_DIR_REAL.toLowerCase());
  check("...and the resolved real path genuinely reaches the real target's own directory",
    fs.existsSync(realTargetSettingsDir) && fs.realpathSync.native(SETTINGS_DIR) === fs.realpathSync.native(realTargetSettingsDir));

  // =====================================================================================================
  // PART 2 — SETTINGS_DIR_READ_DENY_RULES denies BOTH forms; the raw rule is still present
  // =====================================================================================================
  const sidFile = path.join(realTargetSettingsDir, "some-other-session.mcp-config.json");
  fs.writeFileSync(sidFile, "{}"); // stands in for another live session's secret file

  check("SETTINGS_DIR_READ_DENY_RULES still includes the RAW rule (back-compat; the alias path itself stays denied)",
    SETTINGS_DIR_READ_DENY_RULES.includes(SETTINGS_DIR_READ_DENY_RULE));
  check("SETTINGS_DIR_READ_DENY_RULES ALSO includes a rule rooted at the RESOLVED real path",
    SETTINGS_DIR_READ_DENY_RULES.some((r) => r === `Read(${SETTINGS_DIR_REAL}/**)`));
  check("the real-path rule covers a sibling session's secret file reached via the REAL (non-alias) path",
    SETTINGS_DIR_READ_DENY_RULES.some((r) => ruleCoversPath(r, sidFile)));
  check("the raw rule covers the SAME file reached via the ALIAS path",
    SETTINGS_DIR_READ_DENY_RULES.some((r) => ruleCoversPath(r, path.join(aliasHome, "tmp", "settings", "some-other-session.mcp-config.json"))));

  // =====================================================================================================
  // PART 3 — behavioural negative control: the OLD raw-only rule set is RED on the exact same check
  // =====================================================================================================
  const preFixRulesOnly = [SETTINGS_DIR_READ_DENY_RULE];
  check("(negative control) the pre-fix raw-only rule array does NOT cover the real-path file — proves this check can fail",
    !preFixRulesOnly.some((r) => ruleCoversPath(r, sidFile)));
  check("(sanity) the pre-fix raw-only rule array DOES still cover the alias-path file (never regressed)",
    preFixRulesOnly.some((r) => ruleCoversPath(r, path.join(aliasHome, "tmp", "settings", "some-other-session.mcp-config.json"))));

  // =====================================================================================================
  // PART 4a (aliased case) — withSettingsDirDenyForSpawn unions in BOTH missing rules
  // =====================================================================================================
  const withAlias = withSettingsDirDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [] });
  check("withSettingsDirDenyForSpawn (aliased LOOM_HOME): both rules present, no more, no fewer",
    withAlias.deny.length === SETTINGS_DIR_READ_DENY_RULES.length &&
    SETTINGS_DIR_READ_DENY_RULES.every((r) => withAlias.deny.includes(r)));
  const alreadyBoth = { mode: "acceptEdits", allow: [], deny: [...SETTINGS_DIR_READ_DENY_RULES] };
  check("withSettingsDirDenyForSpawn (aliased): idempotent once both rules already present — same object reference",
    withSettingsDirDenyForSpawn(alreadyBoth) === alreadyBoth);
} else {
  console.log("WARN  SKIP  all checks in this file — no junction/symlink alias could be created on this host.");
}

// NOTE: the ORDINARY, non-aliased case (byte-identical to before this card: exactly one rule, same
// string) is deliberately NOT re-verified here. `paths.js`'s LOOM_HOME-derived constants are cached at
// MODULE-LOAD time for the life of this process (see the `@decision 37310431` note above) — once this
// file's own PART 1 import has loaded `../dist/paths.js` under the ALIASED LOOM_HOME, there is no way
// from this same process to re-import it under a second, non-aliased LOOM_HOME and get a second, honest
// reading (a query-string cache-bust on `claude-settings.js` alone does NOT re-bust its own internal,
// query-free `import ... from "../paths.js"`, which stays pinned to the first-loaded instance — tried and
// reverted while writing this file). `mcp-config-secret-lifecycle.mjs` already covers the non-aliased
// case, in its own fresh process, and its existing assertions (`SETTINGS_DIR_READ_DENY_RULE` equality,
// `withSettingsDirDenyForSpawn` adding exactly one rule, idempotency) continue to hold unchanged by this
// card's fix — that file is part of this card's own verification, see the worker report.

console.log(failures === 0
  ? "\n✅ ALL PASS — when the CONFIGURED LOOM_HOME/SETTINGS_DIR is itself a junction/symlink alias, SETTINGS_DIR_READ_DENY_RULES denies both that configured (alias) path and the resolved real path, proven against a behavioural negative control showing the pre-fix raw-only rule was blind to the real path. A third, unrelated alias reaching the same real directory is a distinct, NOT-closed case — see docs/decisions/f2bb9dbe's own 'What stays open' section."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);

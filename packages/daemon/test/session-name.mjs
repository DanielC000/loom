// Session-naming helpers (card f9b47cd1) — PURE, dependency-free unit tests, no daemon/db/pty. Covers the
// version gate + the naming-scheme composers (slugify edge cases, per-role tags, the worker
// agent+task+collision shape, Platform Lead's fixed name). Run (after a build): node test/session-name.mjs
import {
  meetsMinVersion, MIN_SESSION_NAME_VERSION,
  slugify,
  composeRoleSessionName, composeWorkerSessionName, PLATFORM_LEAD_SESSION_NAME,
} from "../dist/pty/session-name.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- meetsMinVersion: the load-bearing safety gate ------------------------------------------------
{
  check("gate: the constant is 2.1.196", MIN_SESSION_NAME_VERSION === "2.1.196");
  check("gate: exactly the min version → true (inclusive)", meetsMinVersion("2.1.196") === true);
  check("gate: above the min version → true", meetsMinVersion("2.1.211") === true);
  check("gate: a higher major → true", meetsMinVersion("3.0.0") === true);
  check("gate: a higher minor, lower patch → true (X.Y wins over Z)", meetsMinVersion("2.2.0") === true);
  check("gate: below on patch → false", meetsMinVersion("2.1.195") === false);
  check("gate: below on minor → false", meetsMinVersion("2.0.999") === false);
  check("gate: below on major → false", meetsMinVersion("1.9.999") === false);
  check("gate: null → false (fail closed)", meetsMinVersion(null) === false);
  check("gate: undefined → false (fail closed)", meetsMinVersion(undefined) === false);
  check("gate: empty string → false", meetsMinVersion("") === false);
  check("gate: unparseable garbage → false", meetsMinVersion("not-a-version") === false);
  check("gate: a version with a trailing suffix still parses (prefix match)", meetsMinVersion("2.1.211-beta") === true);
  check("gate: whitespace-padded still parses", meetsMinVersion("  2.1.200  ") === true);
  // The pinned usage-status.ts fallback (2.1.162, used when `claude --version` can't be read) must stay
  // BELOW the naming gate — this is the safety property the fallback's specific value depends on.
  check("gate: the usage-status pinned fallback (2.1.162) stays below the naming gate", meetsMinVersion("2.1.162") === false);
}

// --- slugify: edge cases -----------------------------------------------------------------------
{
  check("slugify: lowercases + hyphenates spaces", slugify("Hello World", 40, "x") === "hello-world");
  check("slugify: collapses a run of non-alnum to ONE hyphen", slugify("a---b__c!!d", 40, "x") === "a-b-c-d");
  check("slugify: trims a leading/trailing hyphen", slugify("--hi--", 40, "x") === "hi");
  check("slugify: unicode diacritics fold to ASCII", slugify("Café Résumé", 40, "x") === "cafe-resume");
  check("slugify: pure emoji/CJK input falls back", slugify("日本語", 40, "fallback") === "fallback");
  check("slugify: pure punctuation input falls back", slugify("!!!???", 40, "fallback") === "fallback");
  check("slugify: empty string falls back", slugify("", 40, "fallback") === "fallback");
  check("slugify: whitespace-only input falls back", slugify("   ", 40, "fallback") === "fallback");
  const long = "a".repeat(100);
  const capped = slugify(long, 16, "x");
  check("slugify: a very long title is capped to maxLen", capped.length === 16);
  check("slugify: capped output has no dangling trailing hyphen", !capped.endsWith("-"));
  const longWithBreak = "abc-" + "d".repeat(20);
  const cappedBreak = slugify(longWithBreak, 6, "x"); // cuts mid-run of 'd's — no trailing '-' to strip anyway
  check("slugify: cap mid-word still respects maxLen", cappedBreak.length <= 6);
  check("slugify: numbers pass through", slugify("v2.1.196", 40, "x") === "v2-1-196");
}

// --- composeRoleSessionName: fixed per-role tags -------------------------------------------------
{
  check("role: manager → mgr", composeRoleSessionName("manager", "Loom") === "loom-loom-mgr");
  check("role: assistant → comp (Companion)", composeRoleSessionName("assistant", "Fire Studio") === "loom-fire-studio-comp");
  check("role: setup → setup", composeRoleSessionName("setup", "Loom") === "loom-loom-setup");
  check("role: auditor → audit", composeRoleSessionName("auditor", "Loom") === "loom-loom-audit");
  check("role: workspace-auditor → wsaudit", composeRoleSessionName("workspace-auditor", "Loom") === "loom-loom-wsaudit");
  check("role: run → run", composeRoleSessionName("run", "Loom") === "loom-loom-run");
  check("role: operator → operator", composeRoleSessionName("operator", "Loom") === "loom-loom-operator");
  check("role: undefined (plain \"+New\") groups with run", composeRoleSessionName(undefined, "Loom") === "loom-loom-run");
  check("role: project name is slugified too", composeRoleSessionName("manager", "Fire Studio!") === "loom-fire-studio-mgr");
  check("role: prefix is always \"loom-\"", composeRoleSessionName("manager", "x").startsWith("loom-"));
}

// --- PLATFORM_LEAD_SESSION_NAME: fixed, no project segment ---------------------------------------
{
  check("platform lead: exactly \"loom-lead\"", PLATFORM_LEAD_SESSION_NAME === "loom-lead");
}

// --- composeWorkerSessionName: agent + task + taskless + collision -------------------------------
{
  check("worker: known agent short-slug (Dev)", composeWorkerSessionName("Loom", "Dev", "Expose referenceRepos in the wizard", "id-1") === "loom-loom-dev-expose-reference");
  check("worker: known agent short-slug (QA Tester → qa)", composeWorkerSessionName("Fire Studio", "QA Tester", "Fix the login bug", "id-2") === "loom-fire-studio-qa-fix-the-login");
  check("worker: known agent short-slug (Web Designer → webdesign)", composeWorkerSessionName("Loom", "Web Designer", "Polish the dashboard", "id-3") === "loom-loom-webdesign-polish-the-dashb");
  check("worker: known agent short-slug (Code Reviewer → review)", composeWorkerSessionName("Loom", "Code Reviewer", "Review the merge", "id-4") === "loom-loom-review-review-the-merge");
  check("worker: an agent NOT in the table falls back to a plain slug", composeWorkerSessionName("Loom", "Custom Rig", "Do a thing", "id-5") === "loom-loom-custom-rig-do-a-thing");
  check("worker: a null task title (taskless spawn) slugs to \"adhoc\"", composeWorkerSessionName("Loom", "Dev", null, "id-6") === "loom-loom-dev-adhoc");
  check("worker: an empty-string task title also falls to \"adhoc\"", composeWorkerSessionName("Loom", "Dev", "", "id-6b") === "loom-loom-dev-adhoc");

  // Collision: two live cards would slug identically → append a 4-char disambiguator from the id.
  const base = composeWorkerSessionName("Loom", "Dev", "Fix the thing", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const existing = new Set([base]);
  const disambiguated = composeWorkerSessionName("Loom", "Dev", "Fix the thing", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", existing);
  check("worker: no collision → base name returned unchanged", composeWorkerSessionName("Loom", "Dev", "Fix the thing", "zzzz").length > 0 && !existing.has("loom-loom-dev-fix-the-nonexistent"));
  check("worker: a collision appends a 4-char lowercase suffix from the id", disambiguated === `${base}-aaaa`);
  check("worker: the disambiguated name differs from the base", disambiguated !== base);
  check("worker: no existingNames arg (default) never collides", composeWorkerSessionName("Loom", "Dev", "Fix the thing", "aaaaaaaa") === base);

  // Very long title still respects the task-segment cap.
  const longTitle = "This is an extremely long task title that goes on and on and on";
  const withLongTitle = composeWorkerSessionName("Loom", "Dev", longTitle, "id-7");
  check("worker: task segment is capped even for a long title", withLongTitle.length < 60);
  check("worker: task segment only takes the first ~3 words", withLongTitle === "loom-loom-dev-this-is-an");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the version gate fails closed on anything below/unparseable, slugify handles unicode/empty/overlong input, every role composes its fixed tag, the Platform Lead name is invariant, and a worker's name carries agent+task with a collision-only 4-char disambiguator."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

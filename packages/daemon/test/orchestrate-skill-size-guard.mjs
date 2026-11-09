import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// SIZE GUARD for the shipped `/orchestrate` doctrine core (assets/skills/orchestrate/SKILL.md).
//
// WHY: the whole SKILL.md loads into every manager generation (even a tiny scheduled cycle), so every
// character added to the core is paid by every manager session. Detail that is only needed on demand
// belongs in `references/*.md`, each pointed at from the core with a "read this when" line. This test
// fails loudly when the core grows past the budget so the next addition has to move something out (or
// make a deliberate, reviewed budget bump) instead of silently re-bloating the always-loaded text.
//
// It checks the CORE only (SKILL.md), not references/** (those load on demand). Name of what it does NOT
// cover: that the core's content is the RIGHT content — only its size and that every `references/<file>.md`
// it names exists.
//
// Run (no build needed): node packages/daemon/test/orchestrate-skill-size-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** THE budget: max characters (UTF-16 code units, i.e. `string.length`) of orchestrate/SKILL.md. The ONE
 *  place to change it — raise it only as a deliberate, reviewed decision, never to make a diff pass. */
const ORCHESTRATE_CORE_MAX_CHARS = 33_000;

const SKILL_DIR = path.join(__dirname, "..", "assets", "skills", "orchestrate");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Returns a failure message, or null when `text` is within budget. */
function sizeFailure(text, budget) {
  if (text.length <= budget) return null;
  return `orchestrate/SKILL.md is ${text.length} chars, ${text.length - budget} over the ${budget}-char budget ` +
    `(ORCHESTRATE_CORE_MAX_CHARS in ${path.basename(fileURLToPath(import.meta.url))}). The core loads into EVERY ` +
    `manager session: move on-demand detail into assets/skills/orchestrate/references/*.md and leave a ` +
    `one-line "read this when" pointer in the core, rather than raising the budget.`;
}

const core = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const msg = sizeFailure(core, ORCHESTRATE_CORE_MAX_CHARS);
if (msg) console.log(msg);
check(`orchestrate/SKILL.md is within the ${ORCHESTRATE_CORE_MAX_CHARS}-char budget (actual ${core.length})`, msg === null);

// NEGATIVE CONTROL: the same function must FAIL a known-oversized input and PASS the real core's size at a
// budget exactly equal to it — proving the check can fire and that the boundary is inclusive.
check("(negative control) an input one char over the budget is reported as a failure",
  sizeFailure("x".repeat(ORCHESTRATE_CORE_MAX_CHARS + 1), ORCHESTRATE_CORE_MAX_CHARS) !== null);
check("(positive control) an input exactly at the budget passes",
  sizeFailure("x".repeat(ORCHESTRATE_CORE_MAX_CHARS), ORCHESTRATE_CORE_MAX_CHARS) === null);

// Every reference file the core names must exist (a pointer to a missing file silently loses its detail).
const named = [...new Set([...core.matchAll(/references\/([A-Za-z0-9_-]+\.md)/g)].map((m) => m[1]))];
check(`the core names at least one references/*.md pointer (found ${named.length})`, named.length > 0);
for (const f of named) {
  check(`references/${f} (named in the core) exists`, fs.existsSync(path.join(SKILL_DIR, "references", f)));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

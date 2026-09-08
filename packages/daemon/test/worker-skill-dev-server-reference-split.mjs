// Hermetic content-composition test (card 8c4ffe0f) for the /worker skill's dev-server/browser
// self-verification block: it is NOT reachable from a task class that never touches a rendered feature
// (docs-only, backend-only, test-only), so it lives in a conditionally-read reference file
// (assets/skills/worker/references/dev-server-verification.md) rather than the always-loaded
// assets/skills/worker/SKILL.md core. Every dispatch pays for SKILL.md (Step 0 of every worker); only a
// dispatch that actually reads the reference pays for the moved content. This asserts the SPLIT — which
// content lives in the always-loaded core vs. the conditionally-read reference — not a byte count (byte
// counts drift as either file is edited; the split itself is the composition decision under test).
// Run after build: node test/worker-skill-dev-server-reference-split.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(__dirname, "..", "assets", "skills", "worker");
const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const refPath = path.join(skillDir, "references", "dev-server-verification.md");
const ref = fs.readFileSync(refPath, "utf8");

// Distinctive strings that only ever belonged to the dev-server/port/log-identity mechanics — chosen to be
// unlikely to recur elsewhere in the doctrine by coincidence, so a match is a genuine content signal, not
// noise. If a future edit rewords all of these away, that's a real doc change; the test would need updating
// either way, which is the correct failure mode (unlike a byte-count assertion, which fails on any edit).
const MOVED_MARKERS = [
  "loom-dev-server-*.log",
  "trace UPWARD",
  "EPERM",
];

// (a) NEGATIVE CONTROL — proves these markers are the kind of string this test CAN find at all, before
// trusting their absence from SKILL.md as meaningful. Run the exact same check against the reference file
// itself: every marker must be present there (it's a verbatim copy of the moved block).
for (const marker of MOVED_MARKERS) {
  check(`(control) reference file contains moved marker: ${JSON.stringify(marker)}`, ref.includes(marker));
}

// (b) The always-loaded core must NOT carry this content — that's the actual composition decision: a
// docs-only/backend-only dispatch that reads SKILL.md via Step 0 never pays for it.
for (const marker of MOVED_MARKERS) {
  check(`(core) SKILL.md does NOT contain moved marker: ${JSON.stringify(marker)}`, !skillMd.includes(marker));
}

// (c) The core still POINTS at the reference, by its real relative path, so an agent doing UI/browser work
// can actually find it — a split that drops the pointer silently strands that content.
check("(core) SKILL.md points to references/dev-server-verification.md",
  skillMd.includes("references/dev-server-verification.md"));

// (d) The reference itself still chains onward to the pre-existing browser-verification.md (screenshot/
// scratch-dir mechanics) — the two-hop chain (SKILL.md → dev-server-verification.md → browser-verification.md)
// must survive the split, not just the first hop.
check("(chain) reference still points to references/browser-verification.md",
  ref.includes("references/browser-verification.md"));
check("(chain) browser-verification.md reference file still exists",
  fs.existsSync(path.join(skillDir, "references", "browser-verification.md")));

// (e) SANITY — the core is not accidentally empty/corrupted (a vacuous "doesn't contain X" pass): it still
// carries doctrine that has nothing to do with UI/browser work and must survive on EVERY dispatch.
check("(sanity) SKILL.md still contains universal doctrine (worker_report)", skillMd.includes("worker_report"));
check("(sanity) SKILL.md still contains the numbered step 4 verify-before-reporting doctrine",
  skillMd.includes("**Verify before reporting.**"));

console.log(failures === 0
  ? "\n✅ ALL PASS — dev-server/browser mechanics live in the conditional reference, not the always-loaded core."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

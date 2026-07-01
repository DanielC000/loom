// Hermetic label-copy test for UI-audit finding #20 (card c65bbb93): disambiguate the three meanings of
// "run" in the cockpit. auditReplay's "Run replay" section label actually means a WAVE replay (an
// orchestration wave's audit timeline), and RunHistory's "run" wording actually means a SESSION/invocation
// — both were easily confused with the real API-style Agent Runs plane (pages/Runs.tsx). This is
// copy-only: it reads each surface's source text and asserts the corrected DISPLAY strings are present
// and the old ambiguous ones are gone. It does NOT touch (and doesn't assert on) any route/query-key/
// identifier — `rootId`, `["audit", ...]` query keys, `RunHistory`/`RunRow`/`AuditReplayPanel` exports,
// and the Runs.tsx `"runs" | "keys"` tab discriminant all keep their existing `run`/`Run` spelling.
//
// The web package has no test runner, so this is a self-contained node script, mirroring
// test/terminal-chrome.mjs's source-text structural-check pattern (these are JSX string literals, not
// extractable pure functions). Run standalone:
//   node packages/web/test/run-label-copy.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const auditReplaySrc = readFileSync(new URL("../src/components/auditReplay.tsx", import.meta.url), "utf8");
const runHistorySrc = readFileSync(new URL("../src/components/RunHistory.tsx", import.meta.url), "utf8");
const runsPageSrc = readFileSync(new URL("../src/pages/Runs.tsx", import.meta.url), "utf8");
const endUserViewSrc = readFileSync(new URL("../src/pages/EndUserPlatformView.tsx", import.meta.url), "utf8");
const devViewSrc = readFileSync(new URL("../src/pages/DeveloperPlatformView.tsx", import.meta.url), "utf8");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("auditReplay: both SectionLabel renders read 'Wave replay', not the ambiguous 'Run replay'", () => {
  const labels = [...auditReplaySrc.matchAll(/<SectionLabel>([^<]*)<\/SectionLabel>/g)].map((m) => m[1]);
  assert.ok(labels.length >= 2, "expected at least two SectionLabel renders in auditReplay.tsx");
  for (const label of labels) assert.equal(label, "Wave replay");
  assert.ok(!auditReplaySrc.includes("Run replay"), "stale 'Run replay' label text still present");
});

check("RunHistory: its user-facing tooltip copy says 'session', not the bare noun 'run'", () => {
  assert.ok(!runHistorySrc.includes("this run’s transcript"), "stale 'this run's transcript' tooltip still present");
  assert.ok(!runHistorySrc.includes("Resume this exited run "), "stale 'Resume this exited run' tooltip still present");
  assert.ok(runHistorySrc.includes("this session’s transcript"));
  assert.ok(runHistorySrc.includes("Resume this exited session"));
});

check("Platform views: RunHistory captions/emptyLabels say 'session(s)', not the bare noun 'run(s)'", () => {
  for (const src of [endUserViewSrc, devViewSrc]) {
    assert.ok(!/every \w+ run —/.test(src), "stale 'every X run —' caption still present");
    assert.ok(!/No \w+ runs yet/.test(src), "stale 'No X runs yet' emptyLabel still present");
  }
  assert.ok(endUserViewSrc.includes("every operator session"));
  assert.ok(endUserViewSrc.includes("No operator sessions yet"));
  assert.ok(devViewSrc.includes("every Lead session"));
  assert.ok(devViewSrc.includes("No Lead sessions yet"));
  assert.ok(devViewSrc.includes("every audit session"));
  assert.ok(devViewSrc.includes("No audit sessions yet"));
});

check("the API-style Agent Runs plane (Runs.tsx) keeps its own 'Runs' naming untouched", () => {
  assert.ok(runsPageSrc.includes("RunsTab"));
  assert.ok(runsPageSrc.includes('"runs" | "keys"'));
});

console.log(`\n${pass} passed`);

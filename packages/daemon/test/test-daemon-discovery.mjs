// Card b122c7d4 acceptance evidence — a real, permanent regression test (not a one-off manual proof) for
// scripts/test-daemon.mjs's discovery ALLOWLIST: `discoverHermeticTests` is imported directly (never a
// duplicated copy — the census harness already learned that lesson the hard way, see its own lib.mjs
// comment) and exercised against a synthetic temp directory, never the real test/ tree.
//
// Fully hermetic — no daemon, no claude, just fs + the real discovery function.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { discoverHermeticTests } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

const dir = mkdtempManaged("loom-test-daemon-discovery-");
{
  // A genuine test-shaped file — must be discovered and allowlisted.
  fs.writeFileSync(
    path.join(dir, "real-test.mjs"),
    'if (1 !== 1) { throw new Error("unreachable"); }\nconsole.log("ok");\n',
  );
  // A legitimate helper (leading underscore, no assertion marker of its own) — must be silently excluded,
  // never flagged as a violation, never run.
  fs.writeFileSync(path.join(dir, "_helper.mjs"), 'export const thing = 1;\n');
  // The positive control (card b122c7d4's exact acceptance scenario): NOT underscore-prefixed, and does
  // NOT look like a test (no check(/assert/throw new Error/process.exit(1) marker) — must be refused as
  // a violation, not silently run-and-passed and not silently dropped.
  fs.writeFileSync(path.join(dir, "not-a-test.mjs"), 'console.log("just a script that exits 0");\n');
  // A genuine importer living inside an EXCLUDED directory (fixtures/) — even though its content matches
  // the assertion-marker shape, it must never be discovered at all (directory-level exclusion wins).
  fs.mkdirSync(path.join(dir, "fixtures"));
  fs.writeFileSync(path.join(dir, "fixtures", "child.mjs"), 'if (false) throw new Error("x");\n');
  fs.mkdirSync(path.join(dir, "census"));
  fs.writeFileSync(path.join(dir, "census", "probe.mjs"), 'process.exit(1);\n');

  const { hermetic, violations } = discoverHermeticTests(dir, new Set());

  check("real, assertion-shaped file is discovered and allowlisted", hermetic.includes("real-test"));
  check("underscore-prefixed helper is silently excluded (not hermetic, not a violation)", !hermetic.includes("_helper") && !violations.includes("_helper.mjs"));
  check(
    "[positive control] a non-underscore file with no assertion marker is REFUSED (named as a violation), not silently run",
    violations.includes("not-a-test.mjs") && !hermetic.includes("not-a-test"),
  );
  check("a file under fixtures/ is never discovered at all, even though it is assertion-shaped", !hermetic.includes("fixtures/child") && !violations.includes("fixtures/child.mjs"));
  check("a file under census/ is never discovered at all, even though it is assertion-shaped", !hermetic.includes("census/probe") && !violations.includes("census/probe.mjs"));
  check("exactly one violation is reported (only the genuine positive control)", violations.length === 1);
  check("exactly one hermetic test is reported (only the genuine test)", hermetic.length === 1);

  // notHermetic denylist still removes an otherwise-valid candidate by name, same as the real gate's
  // NOT_HERMETIC set removes e.g. "integration-e2e".
  const { hermetic: withDenylist } = discoverHermeticTests(dir, new Set(["real-test"]));
  check("the notHermetic denylist still removes a genuine test by name", !withDenylist.includes("real-test"));
}
// dir's own manual finally-block rmSync removed here: mkdtempManaged already registered it for
// guaranteed cleanup at process exit (card 995be21f).

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-discovery: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);

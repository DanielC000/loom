import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40cddf93 (filed at the merge review of 2a79a74c — that code is CORRECT as merged; this closes a
// DURABILITY gap in its TEST coverage only): gate-runner.ts's HARNESS_NOT_EXECUTED_RE and
// HARNESS_FAIL_WRAPPER_RE are each keyed to an EXACT line shape emitted by a DIFFERENT file,
// scripts/test-daemon.mjs. The card's own new tests (gate-runner-failing-test-truncation.mjs,
// merge-gate-single-file-retry.mjs) only ever feed the tracker a SYNTHETIC line matching the regex — they
// prove the tracker reacts correctly to a match, never that test-daemon.mjs still EMITS one. Reword
// either console.error/console.log call in test-daemon.mjs (drop the emoji, reword, renumber, translate)
// and the corresponding regex silently stops matching while every existing test stays green — quietly
// resuming the exact masking 2a79a74c was filed to prevent.
//
// This file locates each real call site in the CURRENT scripts/test-daemon.mjs source, extracts its
// template literal VERBATIM, renders it via a real JS template-literal evaluation (substituting the
// ${...} slots with sample values — matching raw source text would fail on `${notExecuted.length}` etc,
// which the regex's `\d+` cannot match), and asserts the rendered line still satisfies the regex IMPORTED
// from gate-runner.ts (never a re-declared copy — a duplicated literal would drift independently and
// reintroduce the identical class one level up).
//
// No daemon/DB, no child process — pure string/regex work against real source files.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-runner-harness-marker-coupling.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { HARNESS_NOT_EXECUTED_RE, HARNESS_FAIL_WRAPPER_RE } = await import("../dist/orchestration/gate-runner.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DAEMON_PATH = path.join(__dirname, "..", "scripts", "test-daemon.mjs");

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

/**
 * Finds the (single) line in `src` containing every string in `needles`, and returns the exact backtick
 * template-literal source found immediately after `callPrefix` on that line (WITHOUT its surrounding
 * backticks) — e.g. for `` console.error(`${a} ...`); `` and callPrefix `"console.error("` this returns
 * `` ${a} ... `` verbatim, backticks and all internal nesting intact, ready to be re-wrapped and evaluated.
 * Structural locator: `needles` names the VARIABLES the real call site uses (e.g. `${notExecuted.length}`,
 * `notExecuted.join(`) rather than any of the WORDING the regex under test expects — so a wording-only
 * drift (the exact failure this card is about) still locates the real line; only the later render+match
 * step is sensitive to wording. Returns `undefined` if no single line satisfies all needles, or the call
 * isn't a plain `` callPrefix`...`); `` statement.
 */
function extractTemplateLiteral(src, callPrefix, needles) {
  const line = src.split("\n").find((l) => l.includes(callPrefix) && needles.every((n) => l.includes(n)));
  if (line === undefined) return undefined;
  const start = line.indexOf(callPrefix);
  const afterCall = line.slice(start + callPrefix.length);
  const m = afterCall.match(/^`([\s\S]*)`\);\s*$/);
  return m ? m[1] : undefined;
}

/** Really EVALUATES the extracted template-literal source (as JS, via `new Function`) with the given
 *  bindings in scope — the only way to correctly render nested `${...}` ternaries/backticks (as the
 *  real FAIL-wrapper line has) without hand-rolling a parser that could itself diverge from JS semantics. */
function renderTemplateLiteral(templateInner, bindings) {
  const names = Object.keys(bindings);
  const values = names.map((n) => bindings[n]);
  // eslint-disable-next-line no-new-func -- deliberate: real JS template-literal evaluation, see doc above
  const fn = new Function(...names, "return `" + templateInner + "`;");
  return fn(...values);
}

const realSrc = fs.readFileSync(TEST_DAEMON_PATH, "utf8");

// ---------------------------------------------------------------------------------------------------
// (A) HARNESS_NOT_EXECUTED_RE <-> the `notExecuted` console.error in scripts/test-daemon.mjs
// ---------------------------------------------------------------------------------------------------
{
  const template = extractTemplateLiteral(realSrc, "console.error(", ["${notExecuted.length}", "notExecuted.join("]);
  check("(A) test-daemon.mjs still has a console.error(`...`) call using notExecuted.length + notExecuted.join(...)",
    template !== undefined, () => `no matching line found in ${TEST_DAEMON_PATH}`);

  if (template !== undefined) {
    const rendered = renderTemplateLiteral(template, { notExecuted: ["a.mjs", "b.mjs"] });
    check("(A) the REAL rendered line matches HARNESS_NOT_EXECUTED_RE (imported from gate-runner.ts, not re-declared)",
      HARNESS_NOT_EXECUTED_RE.test(rendered), () => rendered);

    // Negative control (DoD-2): mutate the rendered wording and confirm the SAME regex — unmodified —
    // now reports false. Proves this assertion is not vacuously true (it can and does fail on a
    // genuine wording drift, the exact risk this card exists to catch), without touching the regex itself.
    const mutated = rendered.replace("were NOT actually executed", "did not run");
    check("(A) NEGATIVE CONTROL: a reworded rendering of the SAME line no longer matches HARNESS_NOT_EXECUTED_RE",
      !HARNESS_NOT_EXECUTED_RE.test(mutated), () => mutated);
  }

  // Negative control (DoD-2, "point the check at content known not to contain it"): the same locator run
  // against source with no notExecuted call at all must find nothing — proves the locator itself isn't
  // vacuously matching everything.
  const unrelatedSrc = "function unrelated() {\n  console.error(`plain message, no template slots`);\n}\n";
  const noTemplate = extractTemplateLiteral(unrelatedSrc, "console.error(", ["${notExecuted.length}", "notExecuted.join("]);
  check("(A) NEGATIVE CONTROL: the locator finds NOTHING in source that doesn't contain the notExecuted call",
    noTemplate === undefined, () => JSON.stringify(noTemplate));
}

// ---------------------------------------------------------------------------------------------------
// (B) HARNESS_FAIL_WRAPPER_RE <-> runLane's own PASS/FAIL console.log in scripts/test-daemon.mjs
//
// DoD-3: doing both in one pass is cheap and closes the identical gap next door (same file, same silent-
// death mode, from card 6c84b87b/squash 180e012f) — so this is done, not merely considered.
// ---------------------------------------------------------------------------------------------------
{
  const template = extractTemplateLiteral(realSrc, "console.log(", ["${result.ok", "${result.name}", "statusLabel"]);
  check("(B) test-daemon.mjs still has a console.log(`...`) call using result.ok/result.name/statusLabel (runLane's PASS/FAIL wrapper)",
    template !== undefined, () => `no matching line found in ${TEST_DAEMON_PATH}`);

  if (template !== undefined) {
    const rendered = renderTemplateLiteral(template, { result: { ok: false, name: "widget.spec.js" }, statusLabel: "1" });
    check("(B) the REAL rendered FAILING-file line matches HARNESS_FAIL_WRAPPER_RE (imported from gate-runner.ts, not re-declared)",
      HARNESS_FAIL_WRAPPER_RE.test(rendered), () => rendered);

    // Negative control (DoD-2): the SAME template rendered for a PASSING file must NOT match — the wrapper
    // regex exists specifically to identify a FAILING file's line, never a passing one.
    const renderedPass = renderTemplateLiteral(template, { result: { ok: true, name: "widget.spec.js" }, statusLabel: "0" });
    check("(B) NEGATIVE CONTROL: the SAME line rendered for a PASSING file does not match HARNESS_FAIL_WRAPPER_RE",
      !HARNESS_FAIL_WRAPPER_RE.test(renderedPass), () => renderedPass);
  }

  const unrelatedSrc = "function unrelated() {\n  console.log(`just a message`);\n}\n";
  const noTemplate = extractTemplateLiteral(unrelatedSrc, "console.log(", ["${result.ok", "${result.name}", "statusLabel"]);
  check("(B) NEGATIVE CONTROL: the locator finds NOTHING in source that doesn't contain runLane's wrapper call",
    noTemplate === undefined, () => JSON.stringify(noTemplate));
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

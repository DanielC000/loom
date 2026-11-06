import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cdc262b5 — source-text pin of the advisory-coverage expressions in src/sessions/service.ts. Split out of
// dist-importer-supersede-coverage.mjs because it reads real src TEXT (so it is a member of
// CHANGED_TS_TEXT_SCANNER_REPO_PATHS), while that file is a slow behavioural test that does not belong on the reduced gate.
//
// The conjuncts !preLanded and gateBaseMainHead are DEFENCE IN DEPTH, not behaviourally reachable exclusions:
// preLanded already implies merge.ok && !noop is excluded upstream, and gateBaseMainHead is non-null on any non-preLanded run.
// They are pinned as text so a future refactor cannot silently drop the extra guard.
//
// COMMENT-STRIPPED before matching, so a comment-only edit that merely mentions the tokens can neither satisfy nor break a pin.
// Run: 1) build daemon (pnpm build), 2) node test/dist-importer-supersede-coverage-source-pin.mjs
import fs from "node:fs";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const soloOf = (text) => text.match(/advisoryFullGatePassed = (gateRan[^;\n]+);/)?.[1] ?? "";
const batchOf = (text) => text.match(/batchFullGatePassed = (r\.passed[^;\n]+);/)?.[1] ?? "";
const soloOk = (e) => /gateRan/.test(e) && /passed === true/.test(e) && /!preLanded/.test(e) && /gateBaseMainHead/.test(e) && /effectiveGate === gate/.test(e);
const batchOk = (e) => /passed === true/.test(e) && /!batchReduced/.test(e) && /effectiveGate === gate/.test(e);

const raw = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
const src = stripComments(raw);

check("(P) [source-text, not behavioural] the solo coverage expression requires: gate ran, passed, !preLanded, gateBaseMainHead set, effectiveGate === gate",
  soloOk(soloOf(src)));
check("(P) [source-text, not behavioural] the batch coverage expression requires: passed, !batchReduced, effectiveGate === gate",
  batchOk(batchOf(src)));

// ── comment-only negative control: a comment mentioning the full expression must not be matched as code ─────────────────────
{
  const full = "advisoryFullGatePassed = gateRan && gateResult.passed === true && !preLanded && !!gateBaseMainHead && effectiveGate === gate;";
  const weakCode = "advisoryFullGatePassed = gateRan && gateResult.passed === true;";
  const withCommentOnly = `// ${full}\n${weakCode}\n`;
  check("(control) the stripper removes a comment-only copy of the full expression", soloOf(stripComments(withCommentOnly)) === "gateRan && gateResult.passed === true");
  check("(control) NEGATIVE: a weakened real expression fails the pin even with the full text in a comment above it", !soloOk(soloOf(stripComments(withCommentOnly))));
  check("(control) NEGATIVE: unstripped, the same text would have wrongly passed (proves stripping is what protects it)", soloOk(soloOf(withCommentOnly)));
  check("(control) POSITIVE: the full expression as real code still passes", soloOk(soloOf(stripComments(`${full}\n`))));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

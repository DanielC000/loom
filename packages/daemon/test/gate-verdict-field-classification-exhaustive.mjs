import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5ef78900, round 3 (manager review, then PROVEN by a REAL concurrent event, not an argument): a
// plain deny-`Set` of cross-project-sensitive `gate_status` verdict fields is STILL a deny-list — a field
// added to `PendingGateOpVerdict` (db.ts) tomorrow and not ALSO added to the Set is silently visible
// cross-project, the exact "a new field opts out of redaction by silence" failure the finding was named
// for, just moved up one level. It stopped being hypothetical within the hour: a SIBLING branch
// (card 67030bb9) added a real new field, `batchBranchCount`, to the exact object this card redacts,
// landing before this one.
//
// THE FIX (sessions/service.ts): `GATE_VERDICT_FIELD_CLASSIFICATION`, an EXHAUSTIVE
// `Record<GateVerdictFieldKey, "sensitive" | "structural">` keyed off `keyof PendingGateOpVerdict` plus the
// 4 fields `gateStatus` computes itself and never stores (`passed`/`cancelled`/`retryWarning`/
// `transientRetryWarning`). TypeScript's own missing/excess-property checks on that object literal turn an
// unclassified field into a COMPILE ERROR — mutation-proven directly during development (removing one
// entry broke `pnpm --filter @loom/daemon build` with "Property '<x>' is missing", restored after).
//
// THIS FILE is the STANDING, repeatable version of that one-off manual proof — the manager's own framing:
// "extend the tests to cover... a case that would FAIL if a new unclassified field were added. That test
// is the actual deliverable here — it's what makes the guarantee survive the next person." It parses BOTH
// source files with the TypeScript compiler API (same convention `task-version-guard.mjs` already
// establishes for structural source assertions) and asserts, independent of and in ADDITION to `tsc`
// itself, that every member of `PendingGateOpVerdict` has a classification entry — so a reader who runs
// this file directly (the ordinary, fast, targeted-test path this project's CLAUDE.md defaults every
// worker to) gets the SAME guarantee `tsc` gives at build time, without needing a full build to see it.
//
// HERMETIC — reads only this repo's own two checked-in .ts SOURCE files (never compiled output: an
// `interface` is erased by `tsc` and has no representation in `dist/`, so this MUST parse `src/db.ts`
// directly, unlike `task-version-guard.mjs`'s dist-based method-body check, which works because a class
// METHOD survives compilation and an INTERFACE does not). No daemon, no Db, no real claude.
// Run: node packages/daemon/test/gate-verdict-field-classification-exhaustive.mjs (no build needed — this
// reads TypeScript SOURCE text directly, not dist/)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbSrcPath = path.join(here, "..", "src", "db.ts");
const serviceSrcPath = path.join(here, "..", "src", "sessions", "service.ts");

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

/** Every top-level (own, not nested-deeper) property-signature name of `interface <interfaceName> { ... }`
 *  found anywhere in `srcText`, or `null` if no such interface is found at all. */
function extractInterfaceMemberNames(srcText, srcPath, interfaceName) {
  const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  let names = null;
  const visit = (node) => {
    if (names === null && ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      names = node.members
        .filter(ts.isPropertySignature)
        .map((m) => (ts.isIdentifier(m.name) ? m.name.text : m.name.getText(sourceFile)));
    }
    if (names === null) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** Every top-level property-assignment KEY of `const <constName> = { ... }` (an object-literal
 *  initializer) found anywhere in `srcText`, or `null` if no such declaration is found at all. */
function extractObjectLiteralKeysForConst(srcText, srcPath, constName) {
  const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  let keys = null;
  const visit = (node) => {
    if (
      keys === null && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === constName &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = node.initializer.properties
        .filter(ts.isPropertyAssignment)
        .map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sourceFile)));
    }
    if (keys === null) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

const dbSrc = fs.readFileSync(dbSrcPath, "utf8");
const serviceSrc = fs.readFileSync(serviceSrcPath, "utf8");

// ── SANITY — the extraction itself actually finds something, so a `null`/empty result below means a real ──
// gap, never a broken pattern silently returning nothing.
const verdictMembers = extractInterfaceMemberNames(dbSrc, dbSrcPath, "PendingGateOpVerdict");
check("(sanity) PendingGateOpVerdict interface found with a non-trivial member list",
  Array.isArray(verdictMembers) && verdictMembers.length >= 20,
  () => JSON.stringify(verdictMembers));

const classificationKeys = extractObjectLiteralKeysForConst(serviceSrc, serviceSrcPath, "GATE_VERDICT_FIELD_CLASSIFICATION");
check("(sanity) GATE_VERDICT_FIELD_CLASSIFICATION found with a non-trivial key list",
  Array.isArray(classificationKeys) && classificationKeys.length >= 20,
  () => JSON.stringify(classificationKeys));

// The 4 fields `gateStatus` computes itself and never stores on `PendingGateOpVerdict` — hand-listed here
// since they have no interface to derive from; small and stable (see GATE_VERDICT_FIELD_CLASSIFICATION's
// own doc for why these specifically carry no foreign content and are "structural").
const DERIVED_KEYS = ["passed", "cancelled", "retryWarning", "transientRetryWarning"];

// ── THE GUARANTEE — every PendingGateOpVerdict member, and every derived key, has a classification entry. ──
const classificationSet = new Set(classificationKeys ?? []);
const missingVerdictMembers = (verdictMembers ?? []).filter((m) => !classificationSet.has(m));
check(`(THE GUARANTEE) every PendingGateOpVerdict member is classified — this is the check that would catch a repeat of "batchBranchCount shipped unclassified" (missing: ${JSON.stringify(missingVerdictMembers)})`,
  missingVerdictMembers.length === 0);
const missingDerived = DERIVED_KEYS.filter((k) => !classificationSet.has(k));
check(`(THE GUARANTEE, derived keys) passed/cancelled/retryWarning/transientRetryWarning are all classified (missing: ${JSON.stringify(missingDerived)})`,
  missingDerived.length === 0);

// ── EXHAUSTIVE BOTH WAYS — no STALE classification entry either (a field REMOVED from the interface but ──
// left classified isn't a leak, but it is exactly the kind of drift `Record<K,V>`'s own excess-property
// check would also catch at compile time — mirror that here too, so this file's guarantee matches tsc's).
const knownKeys = new Set([...(verdictMembers ?? []), ...DERIVED_KEYS]);
const staleClassificationKeys = (classificationKeys ?? []).filter((k) => !knownKeys.has(k));
check(`(exhaustive, other direction) no classification entry names a field that isn't a real PendingGateOpVerdict member or derived key (stale: ${JSON.stringify(staleClassificationKeys)})`,
  staleClassificationKeys.length === 0);

// ── RED PROOF — mutate a COPY of PendingGateOpVerdict's source text to inject a brand-new member that is ──
// deliberately NOT in the real classification, and confirm the SAME extraction+comparison logic catches
// it. Proves this check can fail before trusting its "0 missing" green above — the standing verification
// posture this project's CLAUDE.md requires of every check.
const PROBE_FIELD = "neverClassifiedProbeField";
check("(mutation precondition) the injected probe field is NOT already classified — otherwise the red proof below would be vacuous",
  !classificationSet.has(PROBE_FIELD));
const mutatedDbSrc = dbSrc.replace(
  "export interface PendingGateOpVerdict {",
  `export interface PendingGateOpVerdict {\n  ${PROBE_FIELD}?: string;`,
);
check("(mutation precondition) the injection actually landed in the mutated source text",
  mutatedDbSrc.includes(`${PROBE_FIELD}?: string`) && mutatedDbSrc !== dbSrc);
const mutatedMembers = extractInterfaceMemberNames(mutatedDbSrc, dbSrcPath, "PendingGateOpVerdict");
const mutatedMissing = (mutatedMembers ?? []).filter((m) => !classificationSet.has(m));
check("(RED PROOF) a field added to PendingGateOpVerdict with no matching classification entry IS caught — exactly the batchBranchCount shape",
  mutatedMissing.length === 1 && mutatedMissing[0] === PROBE_FIELD,
  () => JSON.stringify(mutatedMissing));

// ── RED PROOF, other direction — removing a real classification entry (the SAME mutation manually proven ──
// against `tsc` during development: deleting the `retriedFile: "sensitive",` line broke the build with
// "Property 'retriedFile' is missing") must ALSO be caught by this file's own extraction-based check,
// independent of invoking `tsc` at all.
check("(precondition) retriedFile IS a real PendingGateOpVerdict member this corpus can test against",
  (verdictMembers ?? []).includes("retriedFile"));
const mutatedServiceSrc = serviceSrc.replace(/\s*retriedFile:\s*"sensitive",/, "");
check("(mutation precondition) the removal actually changed the source text",
  mutatedServiceSrc !== serviceSrc && !mutatedServiceSrc.includes('retriedFile: "sensitive",'));
const mutatedClassificationKeys = extractObjectLiteralKeysForConst(mutatedServiceSrc, serviceSrcPath, "GATE_VERDICT_FIELD_CLASSIFICATION");
const mutatedClassificationSet = new Set(mutatedClassificationKeys ?? []);
const missingAfterRemoval = (verdictMembers ?? []).filter((m) => !mutatedClassificationSet.has(m));
check("(RED PROOF, other direction) removing a real classification entry (retriedFile) IS caught by this file's own check, without needing tsc",
  missingAfterRemoval.length === 1 && missingAfterRemoval[0] === "retriedFile",
  () => JSON.stringify(missingAfterRemoval));

console.log(failures === 0
  ? "\n✅ ALL PASS — every PendingGateOpVerdict member (db.ts) and every gateStatus-derived field has a real classification entry in GATE_VERDICT_FIELD_CLASSIFICATION (sessions/service.ts), with no stale entries the other direction; a field added to the interface with no matching classification (the exact batchBranchCount shape from card 67030bb9) is caught by this file directly, and so is a classification entry removed by hand — both proven by actual source mutation, not by trusting the type signature or tsc alone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

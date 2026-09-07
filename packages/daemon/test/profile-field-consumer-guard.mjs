import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// Card d34dd208 — bounds the "structured field that lies" class: a Profile field the validator accepts
// (and the UI shows as set) with NO real consumer on some supported harness's spawn/runtime path. Three
// instances (cb7d6998, 6d5a6280, and codex silently dropping model/restrictedTools) were each caught by
// a HUMAN reading the artifact, none by CI — the card's own trigger: "a third instance earns a
// schema-wide pass, not a third card."
//
// MECHANISM: `profiles/field-consumers.ts` (PROFILE_FIELD_CONSUMERS) is a machine-readable, per-field
// declaration of one of: (a) "not spawn-relevant" (a closed-enum reason), or (b) "consumed", carrying one
// or more real, grep-verifiable proof sites, plus — for any harness a proof doesn't cover — EITHER a
// closed-enum `exempt` entry (permanent, legitimate, benign) OR a `gaps` entry (a TEMPORARY, carded,
// currently-open instance of the defect this card exists to bound). See field-consumers.ts's own header
// for the full three-way split and why `gaps` is a declared BASELINE, never a debt baseline. This guard:
//   1. Asserts every field `profiles/validate.ts`'s PROFILE_FIELD_NAMES actually accepts has a registry
//      entry, and vice versa (a field renamed/removed in the schema without updating the registry is
//      caught either direction) — THIS is the mechanism that stops a NEW field from ever shipping silent.
//   2. Re-verifies every `proofs[].pattern` is a real, literal substring of the named source file (scoped
//      to a named region for a pty/host.ts proof, via anchor-based extraction — see below) — a future
//      refactor that silently drops a real consumption line fails HERE even if this registry is never
//      touched.
//   3. For every SUPPORTED_PROFILE_HARNESSES entry a field's proofs don't cover, requires a matching
//      `exempt` OR `gaps` entry — a `gaps` entry's `cardId` is checked against CARD_ID_PATTERN (a real
//      8-hex-char Loom card id shape) so a placeholder can never satisfy it. An UNDECLARED absence — no
//      `exempt`, no `gaps`, or a `gaps` entry with a malformed cardId — is a HARD FAIL, exit 1. A
//      declared, carded `gaps` entry PASSES (the fleet isn't blocked on already-known, already-tracked
//      debt) but is printed LOUDLY, naming the card, so it stays visible rather than fading into "green."
//
// CURRENT BOUND: card d34dd208's own sweep found FIVE fields with no codex consumer — `model`,
// `restrictedTools` (the card's original seed evidence) plus THREE NEW FINDINGS from this sweep —
// `browserTesting`, `documentConversion`, `capabilities` (createCodexPty's own `buildMcpServers({
// sessionId, port, role })` call omits all three). All five are now declared `gaps` tracked by card
// `0770d916` — see field-consumers.ts for the per-field remedy. ⚠️ `restrictedTools` is NOT the same
// shape as the other four: those are `remedy:"connect"` (a straightforward wiring fix — buildMcpServers
// already accepts the param generically), but codex has NO per-native-tool disallow mechanism at all
// (verified against the real capability-probe findings — see field-consumers.ts's own note), so
// `restrictedTools` is `remedy:"no-mechanism-reject-or-warn"` — the correct fix is a validation-time
// rejection or a loud warning for harness:"codex"+restrictedTools:true, never a silent connection. This
// guard passes today (0 undeclared gaps) precisely because both shapes are DECLARED, not because either
// is actually fixed — read the loud "KNOWN, CARDED GAP" lines below rather than trusting a bare PASS.
//
// ⛔ POSITIVE-CONTROLLED: every check below is exercised against BOTH a known-true case (the real
// registry/source) and a synthetic known-false case (a fabricated field/pattern/cardId), so an
// always-green helper function can't hide behind a corpus that happens to already be clean.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_FIELD_NAMES } from "../dist/profiles/validate.js";
import { PROFILE_FIELD_CONSUMERS, SUPPORTED_PROFILE_HARNESSES, CARD_ID_PATTERN } from "../dist/profiles/field-consumers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; return cond; };

// --- region extraction (pty/host.ts only) — anchor-based, not hardcoded line numbers (line numbers move;
// this repo's own doctrine says "re-verify before you build on it" rather than trust a cited number).
const HOST_TS_PATH = path.join(SRC_DIR, "pty", "host.ts");
const HOST_TS = fs.readFileSync(HOST_TS_PATH, "utf8");

function sliceBetween(text, startAnchor, endAnchor, label) {
  const s = text.indexOf(startAnchor);
  const sOk = check(`region anchor FOUND: start-of-${label} ("${startAnchor.slice(0, 40)}...")`, s !== -1);
  if (!sOk) return "";
  const e = text.indexOf(endAnchor, s + startAnchor.length);
  const eOk = check(`region anchor FOUND: end-of-${label} ("${endAnchor.slice(0, 40)}...")`, e !== -1 && e > s);
  if (!eOk) return "";
  return text.slice(s, e);
}

const CLAUDE_CREATE_PTY_REGION = sliceBetween(
  HOST_TS, "protected createPty(opts: SpawnOpts", "private isHumanMutable(m: QueuedMessage)", "claude-create-pty",
);
const CODEX_SPAWN_REGION = sliceBetween(
  HOST_TS, "protected createCodexPty(opts: SpawnOpts",
  "private captureCodexEngineSessionId(sessionId: string, live: CodexLive, cwd: string, attempt = 0): void {",
  "codex-spawn",
);

// Sanity: regions are plausibly sized (not an anchor typo silently matching zero real content).
check("claude-create-pty region is non-trivially sized (>1000 chars)", CLAUDE_CREATE_PTY_REGION.length > 1000);
check("codex-spawn region is non-trivially sized (>500 chars)", CODEX_SPAWN_REGION.length > 500);
// Positive control: the two regions must actually be DISJOINT in content, or every "scoped to claude
// only" / "scoped to codex only" proof below would be meaningless (a claude-only token leaking into the
// codex region would make an unexempted codex gap invisible to this guard).
check("(control) a known claude-only token (opts.model) is ABSENT from the codex-spawn region", !CODEX_SPAWN_REGION.includes("opts.model"));
check("(control) a known claude-only token (opts.model) IS PRESENT in the claude-create-pty region", CLAUDE_CREATE_PTY_REGION.includes("opts.model"));
check("(control) a known codex-only token (trustDialogAnswered) is ABSENT from the claude-create-pty region", !CLAUDE_CREATE_PTY_REGION.includes("trustDialogAnswered"));
check("(control) a known codex-only token (trustDialogAnswered) IS PRESENT in the codex-spawn region", CODEX_SPAWN_REGION.includes("trustDialogAnswered"));

// --- source resolution for a proof's `file`+`region` -----------------------------------------------
const SRC_TEXT_CACHE = new Map();
function wholeFileText(repoRelFile) {
  if (!SRC_TEXT_CACHE.has(repoRelFile)) {
    const PREFIX = "packages/daemon/src/";
    if (!repoRelFile.startsWith(PREFIX)) throw new Error(`unexpected repo-relative path shape: ${repoRelFile}`);
    const abs = path.join(SRC_DIR, repoRelFile.slice(PREFIX.length));
    SRC_TEXT_CACHE.set(repoRelFile, fs.readFileSync(abs, "utf8"));
  }
  return SRC_TEXT_CACHE.get(repoRelFile);
}

/** Resolve a proof's search text — the real function this guard's own correctness rests on, so it's
 *  exercised below against BOTH a real proof and a synthetic bogus one (never trusted by inspection alone). */
function regionText(proof) {
  if (proof.region === "whole file") return wholeFileText(proof.file);
  if (proof.file !== "packages/daemon/src/pty/host.ts") {
    throw new Error(`region "${proof.region}" is only meaningful for pty/host.ts, got file=${proof.file}`);
  }
  if (proof.region === "claude-create-pty") return CLAUDE_CREATE_PTY_REGION;
  if (proof.region === "codex-spawn") return CODEX_SPAWN_REGION;
  throw new Error(`unknown region: ${proof.region}`);
}

// Self-test (synthetic, before trusting this against the real registry): a proof naming a pattern that
// really is in the file, and one naming a pattern that is NOT — must discriminate correctly.
check("(self-test) regionText+pattern-match finds a KNOWN-PRESENT token in the real claude region",
  regionText({ file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty" }).includes("injectSkills(opts.cwd"));
check("(self-test) regionText+pattern-match correctly reports ABSENT for a fabricated token nowhere in the real claude region",
  !regionText({ file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty" }).includes("thisPatternDoesNotExistAnywhereInHostTs12345"));

// --- 1. completeness: PROFILE_FIELD_NAMES <-> PROFILE_FIELD_CONSUMERS key set, BOTH directions -------
check(`PROFILE_FIELD_NAMES is non-empty (found ${PROFILE_FIELD_NAMES.length})`, PROFILE_FIELD_NAMES.length > 0);
const registryKeys = Object.keys(PROFILE_FIELD_CONSUMERS);
const missingFromRegistry = PROFILE_FIELD_NAMES.filter((f) => !registryKeys.includes(f));
const extraInRegistry = registryKeys.filter((f) => !PROFILE_FIELD_NAMES.includes(f));
check(`every validator field has a registry entry (missing: ${missingFromRegistry.join(", ") || "none"})`, missingFromRegistry.length === 0);
check(`the registry names no field the validator doesn't accept (extra: ${extraInRegistry.join(", ") || "none"})`, extraInRegistry.length === 0);

// Positive control: the completeness check must actually be ABLE to fail — prove it against a synthetic
// field list carrying one name absent from the real registry, and a synthetic registry carrying one key
// absent from the real field list.
{
  const fakeFields = [...PROFILE_FIELD_NAMES, "thisFieldDoesNotExistInTheSchema"];
  const missing = fakeFields.filter((f) => !registryKeys.includes(f));
  check("(control) completeness check DOES catch a fabricated unregistered field", missing.length === 1 && missing[0] === "thisFieldDoesNotExistInTheSchema");
}
{
  const fakeRegistryKeys = [...registryKeys, "thisRegistryEntryNamesNoRealField"];
  const extra = fakeRegistryKeys.filter((f) => !PROFILE_FIELD_NAMES.includes(f));
  check("(control) completeness check DOES catch a fabricated registry-only key", extra.length === 1 && extra[0] === "thisRegistryEntryNamesNoRealField");
}

// --- 2 & 3: per-field proof verification + per-harness exempt/gap completeness -------------------------
const ALLOWED_NOT_SPAWN_REASONS = new Set(["cosmetic-identity"]);
const ALLOWED_EXEMPT_REASONS = new Set(["harness-lacks-equivalent-mechanism"]);
const ALLOWED_GAP_REMEDIES = new Set(["connect", "no-mechanism-reject-or-warn"]);

/** The core per-field check — the actual mechanism the whole guard exists to run. Exercised for real
 *  below against every registered field, AND (further down) against synthetic entries to prove it can
 *  both pass and fail. Returns {ok, reasons:[...], declaredGaps:[...]} — `ok` is HARD-fail-driven
 *  (undeclared absence only); `declaredGaps` carries every legitimately-carded open gap this field has,
 *  so the caller can print them LOUDLY even on an `ok:true` result — a declared gap must never look like
 *  an ordinary silent PASS. */
function evaluateField(fieldName, entry) {
  const reasons = [];
  const declaredGaps = [];
  if (!entry) return { ok: false, reasons: [`no registry entry for "${fieldName}"`], declaredGaps };
  if (entry.kind === "not-spawn-relevant") {
    if (!ALLOWED_NOT_SPAWN_REASONS.has(entry.reason)) reasons.push(`"${fieldName}": not-spawn-relevant reason "${entry.reason}" is outside the closed enum`);
    return { ok: reasons.length === 0, reasons, declaredGaps };
  }
  if (entry.kind !== "consumed") return { ok: false, reasons: [`"${fieldName}": unknown kind "${entry.kind}"`], declaredGaps };
  const covered = new Set();
  for (const proof of entry.proofs ?? []) {
    let text;
    try { text = regionText(proof); } catch (e) { reasons.push(`"${fieldName}": ${e.message}`); continue; }
    if (!text.includes(proof.pattern)) {
      reasons.push(`"${fieldName}": claimed consumer pattern NOT FOUND in ${proof.file} [${proof.region}] — "${proof.pattern.slice(0, 60)}..."`);
    }
    for (const h of proof.harnesses) covered.add(h);
  }
  for (const h of SUPPORTED_PROFILE_HARNESSES) {
    if (covered.has(h)) continue;
    const exemption = (entry.exempt ?? []).find((x) => x.harness === h);
    if (exemption) {
      if (!ALLOWED_EXEMPT_REASONS.has(exemption.reason)) reasons.push(`"${fieldName}": exempt reason "${exemption.reason}" for harness "${h}" is outside the closed enum`);
      continue;
    }
    const gapEntry = (entry.gaps ?? []).find((x) => x.harness === h);
    if (gapEntry) {
      const gap = gapEntry.gap;
      if (!gap?.cardId || !CARD_ID_PATTERN.test(gap.cardId)) {
        reasons.push(`"${fieldName}": gaps[].cardId for harness "${h}" is missing or not a real card-id shape ("${gap?.cardId}") — a declared gap MUST name a live card, never a placeholder`);
        continue;
      }
      if (!ALLOWED_GAP_REMEDIES.has(gap.remedy)) {
        reasons.push(`"${fieldName}": gaps[].remedy "${gap.remedy}" for harness "${h}" is outside the closed enum`);
        continue;
      }
      declaredGaps.push({ field: fieldName, harness: h, cardId: gap.cardId, remedy: gap.remedy, note: gap.note });
      continue;
    }
    reasons.push(`"${fieldName}": NO CONSUMER, NO EXEMPTION, and NO DECLARED GAP on harness "${h}" — unexplained absence`);
  }
  return { ok: reasons.length === 0, reasons, declaredGaps };
}

// Self-test, synthetic, BEFORE trusting evaluateField against the real registry:
{
  const goodEntry = { kind: "consumed", proofs: [{ harnesses: ["claude", "codex"], file: "packages/daemon/src/pty/host.ts", region: "whole file", pattern: `if (opts.harness === "codex") { this.spawnCodexProcess(opts); return; }` }] };
  check("(self-test) evaluateField PASSES a synthetic entry whose proof pattern genuinely appears in-scope", evaluateField("fakeGood", goodEntry).ok === true);

  const badPatternEntry = { kind: "consumed", proofs: [{ harnesses: ["claude", "codex"], file: "packages/daemon/src/pty/host.ts", region: "whole file", pattern: "thisPatternDoesNotExistAnywhereInHostTs12345" }] };
  const badPatternResult = evaluateField("fakeBadPattern", badPatternEntry);
  check("(self-test) evaluateField FAILS a synthetic entry whose proof pattern does not exist", badPatternResult.ok === false && badPatternResult.reasons.length > 0);

  const silentHarnessEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }] };
  const silentResult = evaluateField("fakeSilentCodex", silentHarnessEntry);
  check("(self-test) evaluateField FAILS a synthetic entry that covers claude but leaves codex UNEXPLAINED (no exempt, no gap)", silentResult.ok === false && silentResult.reasons.some((r) => r.includes('NO CONSUMER, NO EXEMPTION, and NO DECLARED GAP on harness "codex"')));

  const legitimatelyExemptEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], exempt: [{ harness: "codex", reason: "harness-lacks-equivalent-mechanism" }] };
  check("(self-test) evaluateField PASSES the same claude-only coverage once a valid exempt entry declares codex", evaluateField("fakeExempt", legitimatelyExemptEntry).ok === true);

  const badReasonEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], exempt: [{ harness: "codex", reason: "trust me" }] };
  check("(self-test) evaluateField FAILS an exempt entry whose reason is outside the closed enum", evaluateField("fakeBadReason", badReasonEntry).ok === false);

  const missingEntry = evaluateField("fakeMissing", undefined);
  check("(self-test) evaluateField FAILS when no entry exists at all", missingEntry.ok === false);

  // --- gaps mechanism self-tests (Manager directive: exit 0 for a DECLARED, CARDED gap; exit 1 for any
  // undeclared one; a placeholder card id must never satisfy the requirement) ---
  const validGapEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], gaps: [{ harness: "codex", gap: { cardId: "0770d916", remedy: "connect", note: "test" } }] };
  const validGapResult = evaluateField("fakeValidGap", validGapEntry);
  check("(self-test) evaluateField PASSES a claude-only field with a validly-carded gaps[] entry for codex", validGapResult.ok === true);
  check("(self-test) evaluateField SURFACES the declared gap in its declaredGaps[] output (never silent, even on ok:true)", validGapResult.declaredGaps.length === 1 && validGapResult.declaredGaps[0].cardId === "0770d916" && validGapResult.declaredGaps[0].remedy === "connect");

  const placeholderCardIdEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], gaps: [{ harness: "codex", gap: { cardId: "TBD", remedy: "connect", note: "test" } }] };
  check("(self-test) evaluateField FAILS a gaps[] entry whose cardId is a placeholder, not a real card-id shape", evaluateField("fakePlaceholderCard", placeholderCardIdEntry).ok === false);

  const missingCardIdEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], gaps: [{ harness: "codex", gap: { remedy: "connect", note: "test" } }] };
  check("(self-test) evaluateField FAILS a gaps[] entry with NO cardId at all", evaluateField("fakeMissingCard", missingCardIdEntry).ok === false);

  const badRemedyEntry = { kind: "consumed", proofs: [{ harnesses: ["claude"], file: "packages/daemon/src/pty/host.ts", region: "claude-create-pty", pattern: "opts.model" }], gaps: [{ harness: "codex", gap: { cardId: "0770d916", remedy: "just trust it", note: "test" } }] };
  check("(self-test) evaluateField FAILS a gaps[] entry whose remedy is outside the closed enum", evaluateField("fakeBadRemedy", badRemedyEntry).ok === false);

  check("(self-test) CARD_ID_PATTERN matches a real card id shape", CARD_ID_PATTERN.test("0770d916") && CARD_ID_PATTERN.test("d34dd208"));
  check("(self-test) CARD_ID_PATTERN rejects common placeholders", !CARD_ID_PATTERN.test("TBD") && !CARD_ID_PATTERN.test("todo") && !CARD_ID_PATTERN.test("") && !CARD_ID_PATTERN.test("card-123"));
}

// --- Run for real, against every field the validator actually accepts --------------------------------
console.log("");
const allDeclaredGaps = [];
for (const field of PROFILE_FIELD_NAMES) {
  const entry = PROFILE_FIELD_CONSUMERS[field];
  const result = evaluateField(field, entry);
  check(`field "${field}": ${result.ok ? "every supported harness has a real consumer, a declared exemption, or a declared+carded gap" : result.reasons.join(" | ")}`, result.ok);
  allDeclaredGaps.push(...result.declaredGaps);
}

// A declared, validly-carded gap PASSES the guard (per manager directive: don't block the fleet on
// already-tracked debt) — but it must NEVER read as an ordinary silent green. Print every one of them
// loudly, grouped by tracking card, regardless of overall pass/fail.
//
// Card 10787759: this block ALONE used to be the whole story — but scripts/test-daemon.mjs discards a
// PASSING file's stdout entirely (see its own `declaredWarnings`/`WARN_LINE_RE` comment), so on every real
// gate run this loud-looking block was written and then read by nobody (verified: 23 "gap" hits running
// this file directly vs. 0 mentions of the tracking card through the runner). Each per-gap line below is
// ALSO emitted under the `WARN  ` two-space convention (card 22d995ca) so the runner's own scan picks it
// up and surfaces it in its WARNINGS: block on a passing run — gated the SAME as the block itself, so it
// stays silent when there are no gaps.
if (allDeclaredGaps.length > 0) {
  console.log(`\n⚠️  ${allDeclaredGaps.length} KNOWN, CARDED GAP(S) — these PASS the guard (tracked, not undeclared) but are real, currently-open instances of the defect this card exists to bound. Do not read a bare PASS above as "fixed":`);
  const byCard = new Map();
  for (const g of allDeclaredGaps) {
    if (!byCard.has(g.cardId)) byCard.set(g.cardId, []);
    byCard.get(g.cardId).push(g);
  }
  for (const [cardId, gaps] of byCard) {
    console.log(`  card ${cardId}:`);
    for (const g of gaps) {
      console.log(`    - "${g.field}" on harness "${g.harness}" [remedy: ${g.remedy}] — ${g.note}`);
      console.log(`WARN  card ${cardId}: "${g.field}" on harness "${g.harness}" [remedy: ${g.remedy}] — ${g.note}`);
    }
  }
}

console.log("");
console.log(failures === 0
  ? `\n✅ ALL CHECKS PASS — every one of the ${PROFILE_FIELD_NAMES.length} profile fields has a registered, re-verified consumer, a legitimate closed-enum exemption, or a declared+carded open gap on every supported harness (${SUPPORTED_PROFILE_HARNESSES.join(", ")}). No UNDECLARED instance of the "structured field that lies" class exists today.${allDeclaredGaps.length > 0 ? ` (${allDeclaredGaps.length} gap(s) remain OPEN and tracked — see above; this guard will hard-fail the moment a NEW, undeclared gap appears, or the moment an existing gaps[] entry's cardId/remedy stops validating.)` : ""}`
  : `\n❌ ${failures} FAILURE(S) — at least one field has NO consumer, NO exemption, and NO declared+carded gap on a supported harness (an UNDECLARED instance of the "structured field that lies" class), or a gaps[]/exempt[] entry itself fails validation (malformed cardId, non-enum reason/remedy). See the FAIL lines above for exactly which.`);
process.exit(failures === 0 ? 0 : 1);

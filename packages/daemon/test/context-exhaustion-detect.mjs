import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65) — pure unit test for detectContextExhaustionInTail
// (pty/claude-transcript.ts), the wire-format-aware predicate behind the context-exhaustion
// detector. HERMETIC: no fs, no DB, no MCP — pure string-in/object-out.
//
// THE REAL FIXTURE (positive case) is copied verbatim-in-shape from the actual terminal record found
// in worker 09e8c9f1's own engine transcript (session 09e8c9f1-32b1-4f61-ade3-bd3c05760a83, resolved
// 2026-11-02 via git + the documented homedir transcript-path convention, never the real ~/.loom DB —
// see card 66ff7321's own investigation checkpoint) — only the ids are synthetic.
//
// Negative fixtures prove the THREE false-positive classes the record-shape predicate rejects by
// construction (never a bare substring scan): the phrase inside a tool_result, inside genuine
// assistant prose (a REAL model id), and inside a user message. A fourth negative fixture proves the
// "latest assistant record wins" rule: a real assistant record landing AFTER the exhaustion marker
// means the session recovered and is no longer exhausted.
//
// ROUND 2 (tests 7-9) — a stale-marker false positive; full mechanism in docs/decisions/66ff7321-*.md's
// own round-2 section.
//
// ROUND 5f825506 (tests below, item 1) — the STALE-TURN cutoff: `notBeforeMs` rejects a shape-matching
// record whose own `timestamp` predates the caller's cutoff.
//
// @decision 5f825506 — see that record for the full mechanism (why `Live.busySince`, not
// `Session.lastActivity`) and the fail-open rules.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-exhaustion-detect.mjs
import { detectContextExhaustionInTail } from "../dist/pty/claude-transcript.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

// The real terminal record's shape (ids/timestamps synthetic — see header doc).
const REAL_EXHAUSTION_RECORD = {
  parentUuid: "f7c7eb44-ab91-4f5e-97d5-01217d082a3d", isSidechain: false, type: "assistant",
  uuid: "c27526c2-13da-49a8-8abc-bda07c35451f", timestamp: "2026-11-02T20:38:15.497Z",
  message: {
    diagnostics: null, id: "31bc6234-f3a4-436c-9c8c-4278ebb0b9ab", container: null, model: "<synthetic>",
    role: "assistant", stop_details: null, stop_reason: "stop_sequence", stop_sequence: "",
    type: "message",
    usage: {
      output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null, iterations: null, speed: null, fallback_credit: null,
    },
    content: [{ type: "text", text: "Prompt is too long" }],
    context_management: null,
  },
  error: "invalid_request", isApiErrorMessage: true, session_id: "deadbeef-dead-dead-dead-deadbeefdead",
  userType: "external", entrypoint: "cli", cwd: "C:\\fake\\worktree", sessionId: "deadbeef-dead-dead-dead-deadbeefdead",
  version: "2.1.316", gitBranch: "loom/fake",
};

const REAL_MODEL_ASSISTANT_RECORD = (text) => ({
  type: "assistant",
  message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text }] },
});

// ===== (a) positive: the real specimen's shape ⇒ detected =====
{
  const tail = jsonl(REAL_EXHAUSTION_RECORD);
  const result = detectContextExhaustionInTail(tail);
  check("(a) the real exhaustion record IS detected", result !== null);
  check("(a) matchedText is the exact assistant text", result?.matchedText === "Prompt is too long");
  check("(a) error is the record's own 'invalid_request' code", result?.error === "invalid_request");
}

// ===== (b) negative control on the detector itself: a bogus pattern must return 0/null-equivalent =====
// (sanity that a record with NO matching shape at all is correctly NOT detected — the detector's own
// "nothing to see here" baseline, distinct from the deliberate false-positive classes below).
{
  const tail = jsonl({ type: "system", subtype: "turn_duration", durationMs: 1000 });
  check("(b) negative control: an unrelated system record is NOT detected", detectContextExhaustionInTail(tail) === null);
}

// ===== (1) the phrase inside a tool_result (type:\"user\", content is tool_result blocks) =====
{
  const toolResultRecord = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Error: Prompt is too long for this tool call" }] },
  };
  const tail = jsonl(toolResultRecord);
  check("(1) the phrase inside a tool_result is NOT detected (wrong type, not assistant)", detectContextExhaustionInTail(tail) === null);
}

// ===== (2) the phrase inside genuine assistant prose (real model id, not the synthetic sentinel) =====
{
  const proseRecord = REAL_MODEL_ASSISTANT_RECORD(
    "I investigated the incident: the session hit \"Prompt is too long\" and nothing recovered it.",
  );
  const tail = jsonl(proseRecord);
  check("(2) the phrase in real assistant prose is NOT detected (model is a real id, not '<synthetic>')",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (3) the phrase inside an ordinary user message =====
{
  const userRecord = { type: "user", message: { role: "user", content: "I keep seeing Prompt is too long, can you fix it?" } };
  const tail = jsonl(userRecord);
  check("(3) the phrase in a user message is NOT detected (type:\"user\", not assistant)",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (4) the marker followed by a LATER real assistant record ⇒ NOT exhausted (recovered) =====
{
  const tail = jsonl(REAL_EXHAUSTION_RECORD, REAL_MODEL_ASSISTANT_RECORD("Continuing the investigation now."));
  check("(4) a later real-model assistant record supersedes an earlier exhaustion marker (recovered, not exhausted)",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (4b) the inverse order — exhaustion AFTER a real record is still detected (not an ordering bug) =====
{
  const tail = jsonl(REAL_MODEL_ASSISTANT_RECORD("Starting work."), REAL_EXHAUSTION_RECORD);
  const result = detectContextExhaustionInTail(tail);
  check("(4b) exhaustion after a real record IS still detected (latest wins, not merely 'any match')", result !== null);
}

// ===== (5) a DIFFERENT isApiErrorMessage class (out of scope) must never be read as exhaustion =====
{
  const rateLimitLikeRecord = {
    type: "assistant",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Claude AI usage limit reached" }] },
    error: "rate_limit", isApiErrorMessage: true,
  };
  const tail = jsonl(rateLimitLikeRecord);
  check("(5) a different isApiErrorMessage class (e.g. rate_limit) is NOT read as context exhaustion",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (6) a truncated first line (a bounded tail's own artifact) is skipped, not a parse failure =====
{
  const full = jsonl(REAL_EXHAUSTION_RECORD);
  const truncatedTail = full.slice(20); // cut mid-way through the first (only) line's JSON
  check("(6) a truncated first line from a bounded tail read does not throw and is correctly NOT detected",
    detectContextExhaustionInTail(truncatedTail) === null);
}

// ===== (6b) a truncated first line followed by the REAL marker on its own full line IS still detected =====
{
  const truncatedThenReal = full_truncated_plus_real();
  function full_truncated_plus_real() {
    const garbage = '{"type":"assistant","message":{"model":"claude-sonne'; // deliberately cut mid-JSON, no trailing newline issue
    return `${garbage}\n${JSON.stringify(REAL_EXHAUSTION_RECORD)}\n`;
  }
  const result = detectContextExhaustionInTail(truncatedThenReal);
  check("(6b) a truncated garbage first line never prevents detecting a real, complete marker line after it", result !== null);
}

// ===== (7) ROUND 2 (CR finding, reviewer 6ba057e4): a marker followed by a GENUINE NEW USER PROMPT
// with NO assistant reply yet (a human /compact or rewind, then a new turn) must NOT stay detected —
// `latest` used to be reset only by a LATER type:"assistant" record, so this exact shape re-marked a
// recovered session exhausted on the next tick. =====
{
  const newUserPrompt = { type: "user", message: { role: "user", content: "continuing after the recovery" } };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, newUserPrompt);
  check("(7) marker followed by a genuine new user prompt (no assistant reply yet) is NOT detected (superseded, not stale)",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (7b) a tool_result-only type:"user" record (bookkeeping for the SAME dead turn, never a new
// one) must NOT supersede the marker — only a GENUINE user turn does. =====
{
  const toolResultOnly = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, toolResultOnly);
  const result = detectContextExhaustionInTail(tail);
  check("(7b) a tool_result-only record after the marker does NOT supersede it (still detected)", result !== null);
}

// ===== (8) ROUND 2: a real `/compact` landing — compact_boundary, then a summary record, then a new
// prompt — must also supersede a stale marker. Real wire shapes read from the installed CLI binary's
// own embedded zod schema (never hand-typed, per lesson 288): `type:"system",
// subtype:"compact_boundary"` carries a `compact_metadata` object; `type:"summary"` is a distinct,
// separate record (already used as a real-shaped fixture in context-stats.mjs). =====
{
  const compactBoundary = {
    type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info",
    compact_metadata: { trigger: "manual", pre_tokens: 180000 }, uuid: "cb-uuid-1", timestamp: "2026-11-02T20:40:00.000Z",
  };
  const summaryRecord = { type: "summary", summary: "the conversation so far" };
  const newPrompt = { type: "user", message: { role: "user", content: "picking up after /compact" } };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, compactBoundary, summaryRecord, newPrompt);
  check("(8) marker ⇒ compact_boundary ⇒ summary ⇒ new prompt is NOT detected (a real /compact landing superseded it)",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (8b) each of compact_boundary/summary ALONE (no later records) also supersedes the marker —
// not just the full landing sequence together. =====
{
  const compactBoundary = {
    type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info",
    compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 4000 }, uuid: "cb-uuid-2", timestamp: "2026-11-02T20:41:00.000Z",
  };
  check("(8b-i) marker ⇒ compact_boundary alone is NOT detected",
    detectContextExhaustionInTail(jsonl(REAL_EXHAUSTION_RECORD, compactBoundary)) === null);
  check("(8b-ii) marker ⇒ summary alone is NOT detected",
    detectContextExhaustionInTail(jsonl(REAL_EXHAUSTION_RECORD, { type: "summary", summary: "x" })) === null);
}

// ===== (9) ROUND 2 REGRESSION GUARD: the ORIGINAL real specimen (the marker followed ONLY by its own
// trailing system/last-prompt/cost-state records — turn_duration under type:"system", and
// top-level types "last-prompt"/"cost-state", confirmed from the same installed binary) must STILL be
// detected — none of those three record shapes matches a reset condition. =====
{
  const turnDuration = { type: "system", subtype: "turn_duration", duration_ms: 1200 };
  const lastPrompt = { type: "last-prompt", leafUuid: "lp-uuid-1" };
  const costState = { type: "cost-state", sessionId: "deadbeef-dead-dead-dead-deadbeefdead", totalCostUSD: 0.42 };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, turnDuration, lastPrompt, costState);
  const result = detectContextExhaustionInTail(tail);
  check("(9) the original specimen's own trailing records (turn_duration/last-prompt/cost-state) do NOT supersede the marker — still detected",
    result !== null);
  check("(9) matchedText is still the exact assistant text", result?.matchedText === "Prompt is too long");
}

// ===== (10) ROUND 3 (CR finding #3): a real `type:"user", isMeta:true` record — the CLI's OWN
// synthesized metaTexts/hook-caveat content, never something a human typed — must NOT supersede the
// marker. Wire shape confirmed from the installed CLI binary's own dispatcher (never hand-typed, per
// lesson 288): `isMeta` sits top-level, a sibling of `type`, and the content is a plain string, same as
// the genuine fixture at test (7) — the ONLY difference is the `isMeta:true` flag. =====
{
  const metaTextRecord = { type: "user", isMeta: true, message: { role: "user", content: "picking up unrelated caveat content the CLI itself inserted" } };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, metaTextRecord);
  const result = detectContextExhaustionInTail(tail);
  check("(10) a type:\"user\", isMeta:true record (the CLI's own caveat content) does NOT supersede the marker — still detected", result !== null);
  check("(10) matchedText is still the exact assistant text", result?.matchedText === "Prompt is too long");
}

// ===== (10b) POSITIVE CONTROL, same shape minus the flag: proves (10) isn't vacuous — an otherwise-
// identical record with isMeta OMITTED still correctly supersedes the marker, exactly like test (7). =====
{
  const genuineUserRecord = { type: "user", message: { role: "user", content: "picking up unrelated caveat content the CLI itself inserted" } };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, genuineUserRecord);
  check("(10b) positive control: the SAME content with isMeta omitted DOES supersede the marker (not detected)",
    detectContextExhaustionInTail(tail) === null);
}

// ===== (10c) a local command's own OUTPUT (`<local-command-stdout>`, type:"system",
// subtype:"local_command" — confirmed from the same binary, see docs/decisions/66ff7321-*.md's round-3
// section) is not even `type:"user"` and so was already excluded before this round; regression-guards
// that shape explicitly rather than leaving it proven only by the earlier isApiErrorMessage/system
// negative control at test (b). =====
{
  const localCommandOutput = { type: "system", subtype: "local_command", content: "<local-command-stdout>42 tokens</local-command-stdout>", level: "info", isMeta: false };
  const tail = jsonl(REAL_EXHAUSTION_RECORD, localCommandOutput);
  const result = detectContextExhaustionInTail(tail);
  check("(10c) a local-command-output system record does NOT supersede the marker — still detected", result !== null);
}

// ===== (11) card 5f825506 item 1: a notBeforeMs cutoff AFTER the record's own timestamp rejects a
// shape-matching marker as STALE (predates the current turn) — the fix's whole point. =====
{
  const recTs = Date.parse("2026-11-02T20:38:15.497Z"); // REAL_EXHAUSTION_RECORD's own timestamp
  const tail = jsonl(REAL_EXHAUSTION_RECORD);
  check("(11) a cutoff strictly AFTER the record's timestamp rejects it as stale (not detected)",
    detectContextExhaustionInTail(tail, recTs + 1) === null);
}

// ===== (12) POSITIVE CONTROL for (11): a cutoff strictly BEFORE the record's own timestamp (the
// genuinely-current-turn case) is STILL detected — proves (11) isn't vacuously rejecting everything. =====
{
  const recTs = Date.parse("2026-11-02T20:38:15.497Z");
  const tail = jsonl(REAL_EXHAUSTION_RECORD);
  const result = detectContextExhaustionInTail(tail, recTs - 1);
  check("(12) a cutoff BEFORE the record's timestamp (current-turn exhaustion) is still detected", result !== null);
  check("(12) matchedText is still the exact assistant text", result?.matchedText === "Prompt is too long");
}

// ===== (13) EQUAL-TIMESTAMP TIE: a cutoff EXACTLY equal to the record's own timestamp rounds toward
// "still current" (NOT stale) — the deliberate direction documented on
// `detectContextExhaustionInTail`'s own doc.
//
// @decision 5f825506 — see that record for why a tie rounds this way.
// =====
{
  const recTs = Date.parse("2026-11-02T20:38:15.497Z");
  const tail = jsonl(REAL_EXHAUSTION_RECORD);
  check("(13) an EXACT tie (cutoff === record timestamp) is treated as still-current, not stale",
    detectContextExhaustionInTail(tail, recTs) !== null);
}

// ===== (14) NO CUTOFF (both omitted and explicit null/undefined) is BYTE-IDENTICAL to the pre-card
// behaviour — the cutoff is purely additive. =====
{
  const tail = jsonl(REAL_EXHAUSTION_RECORD);
  check("(14a) omitted notBeforeMs ⇒ still detected (byte-identical to the old behaviour)",
    detectContextExhaustionInTail(tail) !== null);
  check("(14b) explicit null notBeforeMs ⇒ still detected (same as omitted)",
    detectContextExhaustionInTail(tail, null) !== null);
  check("(14c) explicit undefined notBeforeMs ⇒ still detected (same as omitted)",
    detectContextExhaustionInTail(tail, undefined) !== null);
}

// ===== (15) FAIL-OPEN on an unparseable/missing record timestamp: a cutoff is supplied, but the
// matching record itself carries no usable `timestamp` field — ambiguity defers to the old (detecting)
// behaviour rather than ever silently dropping a real exhaustion it can't actually date. =====
{
  const noTimestampRecord = { ...REAL_EXHAUSTION_RECORD };
  delete noTimestampRecord.timestamp;
  const tail = jsonl(noTimestampRecord);
  // An arbitrarily FAR-FUTURE cutoff — if the feature mistakenly treated "no timestamp" as "anything
  // before now", this would be the case most likely to expose it.
  const farFutureCutoff = Date.parse("2099-01-01T00:00:00.000Z");
  const result = detectContextExhaustionInTail(tail, farFutureCutoff);
  check("(15) a record with no parseable timestamp is NOT rejected as stale even against a far-future cutoff (fails open)", result !== null);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectContextExhaustionInTail keys on the record SHAPE (type:\"assistant\" + model:\"<synthetic>\" + isApiErrorMessage:true + a named text match), correctly rejecting the tool_result/prose/user-message false-positive classes and correctly tracking recovery (a later real assistant record) and non-recovery (exhaustion after real output) — both orderings proven, not just one; round 2 adds: a genuine new user prompt with no assistant reply yet supersedes a stale marker (a tool_result-only record does not), a real /compact landing (compact_boundary + summary, together or alone) supersedes it too, and the original specimen's own trailing system/last-prompt/cost-state records still do NOT — still detected exactly as before; round 3 adds: a real type:\"user\",isMeta:true record (the CLI's own caveat content) does NOT supersede it either (proven against a positive control that the same content without the flag DOES), and a local command's own <local-command-stdout> output (type:\"system\",subtype:\"local_command\") does not supersede it; card 5f825506 adds the notBeforeMs stale-turn cutoff — a record provably predating the cutoff is rejected (11), a genuinely current-turn record at the identical shape is still detected (12, the positive control proving the fail-open case stays closed), an exact timestamp tie rounds toward still-current (13), an omitted/null/undefined cutoff is byte-identical to the old behaviour (14), and a record with no parseable timestamp fails OPEN even against a far-future cutoff (15)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

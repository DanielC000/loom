// Card c83983cc — the ONE shared `TIMING-GUARD-SAFE:` reason enum for BOTH fixed-wait-negative-guard.mjs
// (corpus-wide, negative-polarity-classifying) and fixed-wait-witness-guard.mjs (diff-scoped, polarity-
// agnostic). Before this card the witness guard carried no enum at all — it accepted ANY non-empty
// `TIMING-GUARD-SAFE:` reason, so an exemption that would have been REJECTED by the negative guard's own
// closed enum could still clear the witness guard on a newly-added line. ONE shared Set closes that gap;
// never fork a second copy.
//
// Each entry is a claim, source-verified against a real site, about why a WAIT is safe despite guarding
// a check() nearby — see fixed-wait-negative-guard.mjs's own header for the per-reason citations. Extend
// this enum only with a reason that is itself source-verified against a real site, same discipline as
// the rest of this file's history — never to make an audit corpus pass, and never silently from inside
// either guard.
export const SANCTIONED_REASONS = new Set([
  "sync-early-return",
  "sync-probe-no-macrotask",
  "fully-awaited-completion",
  "poll-observes-prior-step",
]);

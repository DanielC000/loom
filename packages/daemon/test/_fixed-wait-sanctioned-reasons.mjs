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
  // Card 1584084e — source-verified against pending-ops-registry.mjs's "(a) RUNNING" peekAttachable case:
  // one wait is a MOCKED SUBJECT's own scripted internal latency (data the test itself set, not a wait
  // inserted to gate a check), and/or a companion probe deliberately sized with a stated safe margin
  // UNDER that same scripted duration, to catch the subject genuinely still in flight for a POSITIVE
  // ("still running") claim. The relationship between the two fixed, test-controlled numbers is the proof
  // itself — there is no unobservable real-world event being raced, only two constants the test authored.
  "scripted-duration-margin",
  // Card 1584084e — source-verified against _probe-composer-clear-overshoot.mjs's manual real-claude probe
  // (5 sites: TUI-render/Enter/boot settle pauses) and resume-arms-halted-successor-observer.mjs's (M1)
  // round-2 revival pacing: a settle/pacing sleep inserted between two actions, where the check()/assert()
  // nearby is anchored to a SEPARATELY observed condition (a poll-until-condition helper, or the subject's
  // own state read directly) rather than to this sleep's own duration — the real gate is named and lives
  // elsewhere in the same scenario, so this wait's length proves nothing either way.
  "non-gating-settle-pause",
]);

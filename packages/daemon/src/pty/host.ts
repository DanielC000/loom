import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole, CompanionRoute, CapabilityGrant } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveProfileCapabilities } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { meetsMinVersion } from "./session-name.js";
import { getCachedClaudeVersion } from "../orchestration/usage-status.js";
import { writeSessionSettings, writeSessionMcpConfig } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { injectSkills } from "../skills/inject.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { engineTranscriptExists, engineTranscriptPath } from "../sessions/transcript.js";
import { detectUsageLimit, isWeeklyUsageLimitSentinel, rateLimitedUntil } from "../orchestration/usage-limit.js";
import { detectBarePastePlaceholderTripwire, isPasteRecoveryAttempt, buildPasteRecoveryText, PASTE_RECOVERY_TAG, detectPastePlaceholderLengthLoss, PASTE_LOSS_CALIBRATED_BYTES_PER_LINE, PASTE_LOSS_EXPLAIN_WINDOW, computeWrittenLineCounts, matchEmbeddedPlaceholderToken, PASTE_TRIPWIRE_TOKEN_WINDOW, type PasteLengthLossCandidate, type WrittenLineCountEntry, type SeenPlaceholderTokenEntry } from "../orchestration/paste-tripwire.js";
import { PORT, LOGS_DIR, ENSURE_OBSIDIAN_SCRIPT, sessionScratchDir, isLoomDev, isCodescapeSupervisorEnabled, isPtyUseConptyDllEnabled } from "../paths.js";
import { loomVenvBin, ensurePythonPackageAsync } from "../python/venv.js";
import type { EnsurePythonPackageOpts, EnsurePythonResult, ProvisionOutcome } from "../python/venv.js";
import { resolveCapabilityServer, type CapabilityDefRow } from "../capabilities/registry.js";

const RING_CAP_BYTES = 256 * 1024;
/**
 * Gap between writing a turn's text and writing the FIRST Enter (\r) that submits it. A SINGLE
 * `text + "\r"` write does NOT submit a second turn to a running claude v2.1.150 session — the
 * trailing \r is swallowed with the text and no UserPromptSubmit fires (observed; this also
 * explains PR #9's earlier injected-turn finding). Writing Enter as a separate write a beat
 * later submits reliably. (Revises the roadmap's S2 "single raw write" note.)
 *
 * This constant alone is NOT the fix for a swallowed/dropped Enter (card 9549e322) — it is just
 * the initial gap before the FIRST attempt. `pasteSettleExtraMs` scales that initial gap with the
 * paste size, and `sendEnterAndVerify`'s verify-and-retry loop (below) is the real backstop: it
 * re-sends the Enter on a bounded schedule until `UserPromptSubmit` (or a Stop/StopFailure, which
 * implies a turn ran) confirms the turn actually started.
 */
const SUBMIT_ENTER_DELAY_MS = Number(process.env.LOOM_SUBMIT_ENTER_DELAY_MS) || 150;

/** Extra bytes of paste body absorbed per extra ms added to the initial pre-Enter delay — a larger
 * injected message (a worker report, a coalesced multi-message drain) gives claude's TUI more real
 * time to finish ingesting/re-rendering the paste before the first Enter races it. Capped by
 * SUBMIT_ENTER_DELAY_MAX_EXTRA_MS so a huge paste can't stall the first attempt for seconds — the
 * verify-retry loop is what actually guarantees delivery, this is just a better-aimed first shot. */
const SUBMIT_ENTER_DELAY_BYTES_PER_MS = 50;
const SUBMIT_ENTER_DELAY_MAX_EXTRA_MS = 1500;
function pasteSettleExtraMs(textLength: number): number {
  return Math.min(SUBMIT_ENTER_DELAY_MAX_EXTRA_MS, Math.ceil(textLength / SUBMIT_ENTER_DELAY_BYTES_PER_MS));
}

/**
 * Card 1bd1f045: cheap, non-cryptographic 32-bit FNV-1a content fingerprint for the `[pty-write]` write-
 * sequence log (see `ptyWrite`). O(n) over a SINGLE write call's data — bounded at PTY_WRITE_CHUNK_UNITS
 * for a chunk (a few KB, never the full 15KB+ turn), so it stays cheap on the hot path. Not collision-
 * proof and doesn't need to be: on `tag=chunk` records, two `[pty-write]` entries sharing (len, hash) at
 * distinct `seq` WITHIN THE SAME `gen` is a duplicate CANDIDATE for a human/script to correlate, not a
 * courtroom proof. A pair spanning DIFFERENT `gen` values is a by-design re-write (give-up requeue/retry/
 * re-drain — see `purgeConfirmedGiveUpRequeue`), not a double-emission — see `ptyWrite`'s doc for the two
 * traps this discriminator missed until corrected 2026-07-23. Chosen over a head/tail excerpt (this card's
 * first draft) purely for size: fixed 8 hex chars regardless of payload length, versus ~80-90 bytes of
 * quoted excerpt — material at 17 write sites logging on every session's hot path against a rotating,
 * forensically-relied-on daemon-output.log (see ptyWrite's doc for the measured before/after).
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Card d005f55b DoD-2: extends a fnv1a32 hash already computed over some prefix string A with additional
 * trailing text B, producing exactly `fnv1a32(A + B)` — WITHOUT ever needing A's own bytes, only its
 * already-computed hash. Valid because fnv1a32's accumulator `h` is folded purely via `^=`/`Math.imul`,
 * both bitwise ops JS evaluates via ToInt32 regardless of whether the operand is held as a signed int32
 * or the `>>> 0`-formatted unsigned representation `fnv1a32` returns — so parsing the returned hex string
 * back to a 32-bit int and continuing the SAME fold on B yields the identical bit pattern `fnv1a32(A + B)`
 * would compute directly (verified: `fnv1a32Continue(fnv1a32(A), B) === fnv1a32(A + B)` for every sampled
 * A/B pair, including the card's own gen=10/gen=11 fixture lengths).
 *
 * This is what lets `Live.recentReportedTurns` retain only each generation's REPORTED length+hash — never
 * its full text, matching `Live.ambiguousDispatches`'s existing minimal-signature discipline (see that
 * field's own doc) — while still supporting an exact-hash "reported(prior) + written(current)" candidate
 * in `detectComposerAccumulationOverDivergedPrior` below.
 */
function fnv1a32Continue(priorHash: string, s: string): string {
  let h = parseInt(priorHash, 16) | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Card 4a0af485: the MINIMAL signature `Live.ambiguousDispatches` stores per still-ambiguous generation —
 * length + the SAME cheap `fnv1a32` hash `ptyWrite`'s own log line already uses, never the full text (see
 * that map's own doc for why).
 *
 * ⚠️ CODE REVIEW CORRECTION (an earlier draft of this comment claimed a collision is "never a false-
 * positive purge" — WRONG, and the real vector needs no collision at all): a 32-bit hash collision between
 * two genuinely DIFFERENT texts is ~2⁻³² and not worth carding on its own. But two GENUINELY DISTINCT
 * messages that happen to carry byte-IDENTICAL text (P=1 if they coexist, no collision needed) land on the
 * exact same signature too — indistinguishable from a coalesced batch's members by signature alone.
 * FIXED (card bc0774c4): `purgeConfirmedGiveUpRequeue` no longer purges every signature match
 * unconditionally — every `Live.ambiguousDispatches` entry also carries a `batchId` (the `gen` every member
 * of ONE `requeueGiveUpOrigin` call is seeded under; see that map's own doc), and a content match purges
 * ONLY when every matched entry shares ONE `batchId`. A match spanning more than one `batchId` — the
 * genuinely-distinct-same-text case — is left entirely untouched rather than guessed at (an age-based
 * tie-break was considered and rejected: a batch that has already redrained under a fresh
 * `submitGeneration` breaks the "oldest batch confirmed first" assumption — see
 * `purgeConfirmedGiveUpRequeue`'s own doc for the concrete trace). A non-byte-identical engine echo,
 * separately, is still only ever a false-negative MISS (a real duplicate this map could have purged is
 * left for the FIFO-position fallback instead) — that half of the original claim holds.
 */
function textSignature(text: string): { len: number; hash: string } {
  return { len: text.length, hash: fnv1a32(text) };
}

/**
 * Card c2c750a9: how many of the most-recent WRITTEN submissions `Live.recentWrittenTurns` retains per
 * session, oldest-first, for the composer-accumulation detector below. Small and bounded — the hash-
 * confirmed specimen this detector was built from (card 736de9c0) needed only 3 (current + 2 preceding);
 * this leaves headroom without letting the ring (and the per-check concatenation cost) grow unbounded.
 */
const COMPOSER_ACCUM_WINDOW = 8;

/**
 * Card c2c750a9 — the CONSUMING half of card 736de9c0's hash-confirmed finding: the engine's
 * UserPromptSubmit hook can report back the composer's whole accumulated buffer (everything written
 * since the composer last genuinely cleared), not just the current turn's own text, when a clear is
 * silently missed between submissions. `[prompt-echo]` (below) already logs every field this needs on
 * every submission — this function is the first thing that actually READS it.
 *
 * TWO STAGES, deliberately kept separate (736de9c0's own counterexample: `A+B+C` and `C+A+B` share length
 * 11105 but hash `1136780e` vs `687d2824` — a sum cannot pin ordering, only a hash can):
 *   TRIGGER     — `reportedLen` equals the SUM of the current write's length plus one-or-more IMMEDIATELY-
 *                 PRECEDING writes' lengths (a contiguous suffix of `window`, which is oldest-first and
 *                 always ends with the current submission's own entry).
 *   CONFIRMATION — `fnv1a32` of those same payloads' TEXT, concatenated in that same gen order, BARE (no
 *                 separator bytes), equals `reportedHash`. Only a length-AND-order match is a genuine
 *                 accumulation; a length-only match (same total, different order/content) is refused here
 *                 — see the reorder counterexample above.
 * Tries the SMALLEST span first (k=2 upward) and returns the first CONFIRMED (hash-matching) span it
 * finds; if none confirm, returns the smallest span whose SUM matched anyway (`confirmed: false`) so a
 * caller can tell "no candidate at all" apart from "a candidate existed and the hash refused it" — the
 * exact distinction card c2c750a9's DoD requires demonstrating.
 *
 * ⚠️ COVERAGE LIMIT this function cannot lift (state in any caller's own log/report too, per the card):
 * `[prompt-echo]` fires only at the NEXT write — an accumulation with no SUBSEQUENT submission on that
 * session emits nothing and is structurally invisible here. Scope every claim this produces to
 * "accumulation detectable at the next write", never "duplicates detected" (card 736de9c0's own limit).
 * Also out of scope by construction: this compares SUBMITTED-TURN text (`live.lastPrompt` / `hook.prompt`,
 * already fully decoded), never raw `[pty-write]` byte chunks — so the give-up clear's
 * `BACKSPACE.repeat(N)` false-signature class (content-identical by construction, see `ptyWrite`'s own
 * doc) never reaches this comparison at all; it doesn't need excluding here because it was never included.
 */
function detectComposerAccumulation(
  reportedLen: number,
  reportedHash: string,
  window: ReadonlyArray<{ gen: number; text: string }>,
): { confirmed: boolean; spanGens: number[]; sumOfWrittenLens: number; concatenatedHash: string } | null {
  let bestUnconfirmed: { spanGens: number[]; sumOfWrittenLens: number; concatenatedHash: string } | null = null;
  for (let k = 2; k <= window.length; k++) {
    const span = window.slice(window.length - k);
    const sum = span.reduce((s, e) => s + e.text.length, 0);
    if (sum !== reportedLen) continue;
    const concatenatedHash = fnv1a32(span.map((e) => e.text).join(""));
    const spanGens = span.map((e) => e.gen);
    if (concatenatedHash === reportedHash) return { confirmed: true, spanGens, sumOfWrittenLens: sum, concatenatedHash };
    if (!bestUnconfirmed) bestUnconfirmed = { spanGens, sumOfWrittenLens: sum, concatenatedHash };
  }
  return bestUnconfirmed ? { confirmed: false, ...bestUnconfirmed } : null;
}

/**
 * Card d005f55b DoD-2 — the SEPARATE, ADDITIVE candidate the card's own fix direction names. `detectComposerAccumulation`
 * above can never confirm a fusion whose PRIOR generation's own reported echo had ALREADY diverged from
 * what Loom wrote for it — it sums `recentWrittenTurns` (what Loom WROTE), but the composer's real state
 * is what was actually SUBMITTED (see the card's §THE COMPOUNDING MECHANISM: on a real, arithmetically-
 * exact specimen, `reported(gen11) = written(gen11) + reported(gen10)`, not `written(gen11) +
 * written(gen10)`, once gen10's own report had already mismatched). This tries exactly ONE additional,
 * narrower candidate: the immediately preceding RECORDED generation's own REPORTED signature (never its
 * written one) plus the CURRENT write's own WRITTEN text. Still exact-sum AND exact-hash — no loosening:
 * `fnv1a32Continue` reconstructs the concatenation's hash from the prior entry's own hash alone (see that
 * function's own doc for why this needs no full text), so this confirmation is no less rigorous than the
 * sibling detector above; it only widens WHICH prior signature a candidate is allowed to reuse.
 *
 * Deliberately narrow — a single two-entry candidate (prior generation's REPORTED value + the current
 * write's own WRITTEN text), not a multi-span search like `detectComposerAccumulation`. The card's own
 * regression fixture (gen=10/gen=11: written 1893/1126, reported 2161/3287) and fix direction name exactly
 * this shape, measured on n=1 pair in the card body; a real-corpus length-only sweep (worker report, card
 * d005f55b) found the SAME sum equation — `reportedLen(N) == writtenLen(N) + reportedLen(prior recorded
 * gen)` — satisfied by 80 of 362 checked mismatches (~22%) across 6 rotations of `daemon-output.log`, so
 * this is not a one-off shape. Widening to a multi-generation REPORTED chain (prior-of-prior, etc.) is
 * unestablished by this sweep (which only checked one hop back) and is explicitly left as a follow-up —
 * see the card's own bounds on not re-litigating scope here.
 */
function detectComposerAccumulationOverDivergedPrior(
  reportedLen: number,
  reportedHash: string,
  currentWrittenText: string,
  priorReported: { gen: number; len: number; hash: string } | undefined,
): { confirmed: true; priorGen: number; sumOfLens: number } | null {
  if (!priorReported) return null;
  const sum = priorReported.len + currentWrittenText.length;
  if (sum !== reportedLen) return null;
  const concatenatedHash = fnv1a32Continue(priorReported.hash, currentWrittenText);
  if (concatenatedHash !== reportedHash) return null;
  return { confirmed: true, priorGen: priorReported.gen, sumOfLens: sum };
}

/**
 * Card d005f55b DoD-3 (the card's own floor item — mergeable even if DoD-1/2 above are deferred). Tried
 * ONLY once every exact-match candidate above (`replayedEntry`, `detectComposerAccumulation`,
 * `detectComposerAccumulationOverDivergedPrior`) has already refused. Tests whether `reported` nonetheless
 * CONTAINS a recorded write as a SUBSTRING ANYWHERE (rather than equalling it, or being one exact term of
 * an exact-sum span) — this is deliberately NOT a confirmation of anything and asserts no new mechanism or
 * confidence: it only names what WAS recognized so a caller can say the LEADING/TRAILING remainder around
 * it is unaccounted-for, instead of the prior "could not be matched to any... at all" wording that reads
 * identically whether zero bytes or nearly the whole payload are actually explained (§THE GAP, card
 * d005f55b — this is what stops an observed foreign-content fusion from reading as noise).
 *
 * ⚠️ DELIBERATELY NOT edge-anchored (an earlier draft of this function only tried `startsWith`/`endsWith`
 * and would have MISSED the card's own motivating gen=4 specimen: `<26ch placeholder><gen3's full
 * text><gen4's own text>` — gen3's own write sits SANDWICHED in the MIDDLE, between the placeholder prefix
 * and the current generation's own trailing text, not at either edge). Uses `indexOf` (a true substring
 * search) and reports BOTH remainders — whatever precedes and follows the match — since either or both can
 * be non-empty depending on where the recognized write sits.
 *
 * `window` must be the CALLER's own writes EXCLUDING the current generation's own just-pushed entry (pass
 * `recentWrittenTurns.slice(0, -1)`, mirroring `priorEntry`'s own `length - 2` exclusion elsewhere in this
 * file) — the current generation's own text is, by construction, almost always a literal trailing
 * substring of `reported` in a fusion-shaped mismatch (`recentWrittenTurns.push` happens at submit() time,
 * before this hook ever fires), so including it here would trivially "recognize" the caller's own current
 * turn on nearly every unmatched-longer mismatch and never surface a genuinely PRIOR generation's write —
 * the whole point of this check.
 *
 * Checked most-recent-generation-first (mirrors this file's own `findLast` precedent elsewhere) so a match
 * against the freshest prior write wins over an older, possibly-recycled one; only the FIRST hit is
 * returned — this is a diagnostic aid, not an exhaustive census, and callers must not treat "no hit" as
 * anything beyond that.
 */
function findRecognizedSubstring(
  reported: string,
  window: ReadonlyArray<{ gen: number; text: string }>,
): { gen: number; matchedLen: number; leadingRemainder: string; trailingRemainder: string } | null {
  for (let idx = window.length - 1; idx >= 0; idx--) {
    const entry = window[idx];
    if (!entry || entry.text.length === 0 || entry.text.length >= reported.length) continue;
    const at = reported.indexOf(entry.text);
    if (at === -1) continue;
    return {
      gen: entry.gen,
      matchedLen: entry.text.length,
      leadingRemainder: reported.slice(0, at),
      trailingRemainder: reported.slice(at + entry.text.length),
    };
  }
  return null;
}

/**
 * Card 78e4b3f2 — the RECIPIENT-side half of duplicate legibility (the sender-side half, card 417cea0a,
 * is the `[loom:redelivery-parked]`/`[loom:redelivery-confirmed]` notices above). Duplicate-over-loss
 * (`bc0774c4`) stays exactly as it is — this does not reduce or gate a single re-delivery — it only marks
 * one so the recipient can tell it apart from genuine new direction, per that card's own recommended
 * direction.
 *
 * Applied to a re-delivery of a message whose FIRST write was never confirmed, via TWO distinct triggers:
 * an in-session requeue (`requeueGiveUpOrigin` stamps `giveUpGen` on the kept entry; the actual call to
 * THIS function happens later, at the moment of physical re-write — `joinSubmittedText`, this file, shared
 * by `drainPending`'s real write and `requeueGiveUpOrigin`'s own signature-seed) or a cross-remint
 * (`handleGiveUpExhausted`, sessions/service.ts, `chainDepth > 0` — applied immediately at message
 * CREATION, before it's ever enqueued). The ORIGINAL, first-ever write of a logical message never triggers
 * either path — see each site's own doc — so a genuine first-time directive is never marked (marking it
 * would train recipients to discount real direction, exactly the outcome card 78e4b3f2 rules out).
 *
 * `rootMsgId` is `QueuedMessage.logicalId` — stable across every requeue/re-mint (card 4a0af485) — so
 * every re-delivery of the SAME logical message carries the SAME tag; no new identifier is minted.
 */
const POSSIBLE_DUPLICATE_TAG_RE = /^\[loom:possible-duplicate root:[0-9a-f]{8}\] /;
const HEX8_RE = /^[0-9a-f]{8}$/;

/**
 * CR follow-up (card 78e4b3f2, found in review): `rootMsgId` is NOT always a UUID. `worker_message`'s
 * `resendOf` (sessions/service.ts, `messageWorker`) is a raw, UNVALIDATED MCP string argument
 * (`mcp/orchestration.ts`'s `z.string().optional()`) that a caller can set to anything and that then flows
 * straight through as `rootMsgId` — a non-hex or short value would produce a tag `POSSIBLE_DUPLICATE_TAG_RE`
 * can never recognize again, breaking the frame/strip pair's inverse property (a later re-tag would
 * double-prefix instead of correctly no-op-ing, and `stripPossibleDuplicateFrame` would never remove it).
 * The common case — every self-minted `msgId` IS a UUID, and a chain whose `rootMsgId` was never set via
 * `resendOf` at ANY point in its OWN history resolves to that UUID's own `.slice(0, 8)` — short-circuits
 * there so the tag stays the SAME 8 chars the `[loom:redelivery-parked]` notice's own
 * `root ${rootMsgId.slice(0, 8)}` wording already shows a human. NOT scoped to "this call didn't pass
 * `resendOf`": `ctx.rootMsgId` wins priority over `ctx.resendOf` (service.ts's `enqueueDurableMessage`), so
 * a later re-mint that itself never sets `resendOf` still carries an earlier hop's tainted value forward
 * via `ctx.rootMsgId` — this function validates the ACTUAL VALUE it receives, not which path it arrived
 * by, so any irregular id (a direct `resendOf`, or one inherited from an earlier hop) falls back to
 * `fnv1a32` (already used elsewhere in this file for exactly this "always 8 lowercase hex chars,
 * deterministic" shape) — still correlatable (same input ⇒ same label) but never breaks the regex
 * invariant, regardless of how the irregularity entered the chain.
 *
 * Exported (card 35c96aa6): the worker-facing `directive_status` MCP tool (mcp/orchestration.ts) needs
 * this SAME label computation to match a root a worker supplies against the internal rootMsgId values in
 * its own durable event history. Reusing this function (a pure function of its own input) guarantees that
 * ONE step — computing a label from a candidate rootMsgId — is byte-identical to what produced the tag a
 * worker sees, rather than a re-derived approximation that could silently drift from it; it says nothing
 * about whether the tool's SURROUNDING logic correctly identifies the right rootMsgId to feed in.
 */
export function possibleDuplicateRootLabel(rootMsgId: string): string {
  const slice = rootMsgId.slice(0, 8);
  return HEX8_RE.test(slice) ? slice : fnv1a32(rootMsgId);
}

/**
 * PROVABLY IDEMPOTENT regardless of lineage: strips any EXISTING possible-duplicate tag before applying
 * the current one, rather than short-circuiting only on an exact match for THIS `rootMsgId`. Needed for a
 * chain-identity boundary a plain `text.startsWith(tag)` guard would miss — e.g. `carryPendingToSuccessor`
 * (sessions/service.ts) carries an already-tagged durable record to a recycle successor that self-roots a
 * FRESH chain (a new `rootMsgId`); if that successor's own give-up later re-mints, the OLD tag (a
 * different root id) would not match the NEW tag's exact-string check and would double-prefix instead of
 * being replaced. Stripping first makes this correct for that case too, at zero cost to the common
 * single-lineage case (strip finds nothing, then applies the one tag — same net result as before).
 */
export function framePossibleDuplicate(text: string, rootMsgId: string): string {
  const tag = `[loom:possible-duplicate root:${possibleDuplicateRootLabel(rootMsgId)}]`;
  return `${tag} ${stripPossibleDuplicateFrame(text)}`;
}

/**
 * The inverse of {@link framePossibleDuplicate} — strips a leading possible-duplicate tag if present,
 * else returns `text` unchanged. Card 78e4b3f2: a SENDER-facing notice (`[loom:redelivery-parked]`, card
 * 417cea0a) that previews a message's own `head: text.slice(0, 60)` needs THIS, not the raw closure-
 * captured text — a re-mint's `text` already carries our tag by the time it reaches that notice (a
 * cross-remint frames at creation, before any further give-up), and the tag alone is ~40+ chars, so a
 * bare slice(0, 60) would show mostly tag and cut off before the actual identifying content the sender
 * needs to recognise which message this is about. The notice already states the correlating `rootMsgId`
 * separately in its own wording — the head preview's job is to show real content, not repeat the tag.
 * PROVABLY the exact inverse of `framePossibleDuplicate` for every input: that function only ever
 * produces a root label matching `[0-9a-f]{8}` (see `possibleDuplicateRootLabel`'s doc), which is exactly
 * what this regex requires — there is no `rootMsgId` value the two can ever disagree about.
 */
export function stripPossibleDuplicateFrame(text: string): string {
  return text.replace(POSSIBLE_DUPLICATE_TAG_RE, "");
}

/**
 * Card d005f55b — manager-supplied LIVE evidence (sessions 494db005/f6eeeb52, 2026-08-06) CONFIRMS the
 * card's own Candidate #3 ("a Loom redelivery wrapper", marked PLAUSIBLE/UNVERIFIED in the card body) as a
 * real foreign-content source — but as a DEFICIT, not a fusion: both measured specimens had `reported`
 * SHORTER than `intended` by EXACTLY 40 chars (`divergesAtChar=0`, `lenDelta=-40`), and 40 is the fixed
 * length of `POSSIBLE_DUPLICATE_TAG_RE`'s own match regardless of which 8 hex chars fill the root id
 * (`"[loom:possible-duplicate root:"` (30) + 8 hex + `"] "` (2) = 40 — verified). In both specimens,
 * `intended` (what Loom wrote for that generation) STARTS WITH the tag, and `reported` equals `intended`
 * with the tag stripped, byte-for-byte.
 *
 * ⛔ NOT an accumulation/fusion (those are always LONGER, never shorter) — deliberately its own,
 * orthogonal check; do not fold this into `detectComposerAccumulation`/`…OverDivergedPrior` above.
 *
 * ⭐ CORRECTED MECHANISM (manager measurement, 2026-08-06, card 854d1632 — supersedes an earlier, wrong
 * "does not establish whether the tag reached the engine" framing this doc used to carry): the wrapper
 * DOES reach the engine and IS echoed back byte-identically in the ordinary case — verified directly via
 * `[submit-write]`/`[prompt-echo]` pairs showing a wrapped write (`len=written+40`) confirmed
 * `byteIdentical=true` at its full wrapped length. The `-40` specimens are best explained as a STALE,
 * OUT-OF-ORDER confirmation: the hook that fired belongs to an EARLIER, bare (pre-wrap) write, but by the
 * time it arrives `live.lastPrompt` has already advanced to a LATER, wrapped re-mint of that same
 * content. This is an ATTRIBUTION/ORDERING artifact, NOT corruption and NOT content loss — every byte of
 * SOME intended content (the earlier bare write) did arrive; it's compared against the wrong (already-
 * advanced) generation's `intended`, not evidence that anything failed to transmit.
 * ⛔ Do NOT chase the wrapper's actual delivery path from here — that question is answered and tracked
 * separately (card 854d1632); this function only NAMES the byte-pattern precisely enough that it stops
 * reading as "matched nothing" (card d005f55b DoD-3's own point, which this specimen strengthens) — it
 * must NOT be worded as a loss/deficit in anything that consumes it (see the notice text below).
 * Precise and non-heuristic, mirroring `isStalePlaceholderPrefix`'s own exact-strip-and-compare
 * discipline (this file, below) — reuses the EXISTING `stripPossibleDuplicateFrame` (no new matcher, no
 * loosening of anything): fires ONLY when stripping the tag from `intended` produces `reported` EXACTLY.
 */
function detectPossibleDuplicateWrapperDeficit(reported: string, intended: string): { strippedTag: string } | null {
  const stripped = stripPossibleDuplicateFrame(intended);
  if (stripped === intended) return null; // no tag was present to strip
  if (stripped !== reported) return null;
  return { strippedTag: intended.slice(0, intended.length - stripped.length) };
}

/**
 * Card a640c110: a sibling to {@link detectPossibleDuplicateWrapperDeficit} — a DIFFERENT benign
 * byte-pattern that otherwise presents as an ordinary mismatch. Measured specimen (worker
 * `671766c9…`, gen=3, from `daemon-output.log`): `reportedLen=4106 intendedLen=4115 lenDelta=-9
 * divergesAtChar=897`, and `intended` carried EXACTLY two ANSI/CSI escape sequences at that point
 * (`\x1b[31m` = 5 chars, `\x1b[0m` = 4 chars) — `5 + 4 = 9`, matching `lenDelta` exactly, and
 * `divergesAtChar` lands precisely where the first sequence starts. The engine's own echo had
 * stripped both sequences and reproduced everything else byte-for-byte: NOT corruption, NOT content
 * loss — an attribution/rendering artifact, same posture as the wrapper-deficit shape above.
 *
 * Precise and non-heuristic, mirroring `detectPossibleDuplicateWrapperDeficit`'s own
 * exact-strip-and-compare discipline: reuses the EXISTING `ANSI_CSI` regex (this file, below —
 * the same one `collapseBoot` already strips with), no new matcher. Fires ONLY when stripping
 * EVERY ANSI/CSI escape sequence from `intended` produces `reported` EXACTLY, byte-for-byte — never
 * a fuzzy/near match, and never a one-sided/partial strip (a payload where ANSI is present but the
 * REMAINING content also genuinely diverges fails the `stripped !== reported` check below and is
 * correctly left unclassified, same as a payload with no ANSI at all).
 *
 * ⛔ n=1 (one specimen, one shape) — this classifies THIS byte-pattern only; it is not license for
 * any broader claim that mismatches are generally benign. See memory
 * `the-qualifier-dies-in-the-summary-label`.
 */
function detectAnsiEscapeStripDeficit(reported: string, intended: string): { strippedAnsiLen: number } | null {
  const stripped = intended.replace(ANSI_CSI, "");
  if (stripped === intended) return null; // no ANSI/CSI escape sequence was present to strip
  if (stripped !== reported) return null;
  return { strippedAnsiLen: intended.length - stripped.length };
}

/**
 * Card 4af5aefa: a real, live false positive showed a paste-recovery notice minted CORRECTLY (its
 * resent content genuinely was the most recent inbound at the moment of detection) but delivered
 * ~293s and TWO genuine intervening turns later — by which point a newer message had already arrived
 * and been actioned, making the resend read as stale. Reconstructed from `daemon-output.log`'s own
 * per-line epoch-ms timestamps for the actual specimen: the gap was ordinary FIFO queue-wait behind
 * two successfully-confirmed turns, not a give-up/re-mint retry, and not a stale `originalText` capture.
 *
 * The fix is NOT to suppress or re-verify "is this still current" at delivery time — that would ask a
 * question the detector still can't answer (engine/recipient VISIBILITY), reintroducing the exact
 * proxy-for-the-claim substitution this card exists to name, one level up. What IS genuinely observable
 * at delivery time is a fact about OUR OWN QUEUE: how many `Live.submitGeneration` bumps happened since
 * this was minted. So this only ever ANNOTATES — it never drops, never gates, never alters ordering.
 *
 * Code review correction: the disclosed count is worded as "submit generations", never "turns" — a
 * SECOND, independent false claim was caught here, inside this very card's own remedy. `submitGeneration`
 * counts submit ATTEMPTS ISSUED (`submit()`'s own `++`) plus out-of-band bumps (a give-up via
 * `healIfStuck`, both stop paths) — NOT completed turns. A give-up can consume a whole generation with NO
 * turn ever actually running, so "N turns ago" would sometimes be false (e.g. mint at G, one give-up with
 * zero turns run, delivery at G+1 — that is NOT "1 turn ago"). "N submit generations ago" is true by
 * construction: it's exactly what `currentGen - mintedAtGen` counts, nothing inferred beyond it.
 *
 * EXHAUSTIVE no-op / branch conditions (code review, card 4af5aefa; extended by card 1c47454b): (1) BOTH
 * `mintedAtGen` and `mintedAtWallClock` are `undefined` — set only for a paste-recovery mint, so `text`
 * for anything else is returned unchanged; (2) `mintedAtGen` is defined but `currentGen` is no greater
 * than it — delivered before anything else ran IN THIS SAME SESSION, nothing to disclose yet; (3) the
 * text, once any possible-duplicate frame is stripped, doesn't start with `PASTE_RECOVERY_TAG` at all —
 * not a recovery notice. Checking the STRIPPED text (not the raw `text`) for (3) matters: a recovery
 * notice that itself gave up once and redrained arrives here PREFIXED with `[loom:possible-duplicate
 * root:…]` (`joinSubmittedText` applies that framing first) — a raw `startsWith` check would silently
 * no-op on EXACTLY the notices whose age is largest (a give-up hold adds minutes on top of the ordinary
 * queue wait this function exists to disclose), which is this fix failing in its own motivating case. Any
 * possible-duplicate prefix is preserved verbatim ahead of the tag; the note always lands immediately
 * after `PASTE_RECOVERY_TAG` itself, regardless of what (if anything) precedes it.
 *
 * TWO DISTINCT disclosures, card 1c47454b: `mintedAtGen` defined (and `currentGen` has advanced) means
 * this entry is being read in the SAME session it was minted in — the existing "N submit generations
 * ago" wording, unchanged. `mintedAtGen` UNDEFINED but `mintedAtWallClock` defined means this entry just
 * crossed a `worker_recycle`/`daemon_restart` boundary — `carryPendingToSuccessor`/the restart replay
 * both deliberately omit `mintedAtGen` when threading a carried entry onto its successor (see
 * `mintedAtGen`'s own doc on `QueuedMessage` for why: comparing a predecessor's generation count against
 * a fresh successor's, which always restarts at 0, is a unit error — "47 submit generations ago" would
 * be reported against a session that has run at most a handful), so this branch reports the one thing
 * that DOES survive the boundary honestly: an absolute wall-clock mint time, for the recipient to weigh
 * against their own handoff/transcript. `mintedAtGen`'s presence alone still selects WHICH wording leads
 * (generation-count phrasing for the in-session case, wall-clock-only phrasing for the cross-boundary
 * case) — but card 2d36337e: the in-session branch now ALSO appends that same absolute wall-clock time
 * (verified: every current construction path that sets `mintedAtGen` also sets `mintedAtWallClock` in the
 * SAME call — the paste-recovery mint site stamps both together, and every carry across a boundary either
 * keeps both or deliberately drops `mintedAtGen` alone, never the reverse — see the grep audit in that
 * card's history). A relative generation count ("2 submit generations ago") tells the recipient nothing
 * about whether this predates a SPECIFIC later message they've already read; a directly comparable
 * absolute timestamp does — that gap (not guard (a) below, which correctly stays quiet only when nothing
 * has run since mint) is what let a recovered message read as redundant instead of as a missed premise.
 */
function annotatePasteRecoveryAge(
  text: string, mintedAtGen: number | undefined, currentGen: number, mintedAtWallClock: number | undefined,
): string {
  if (mintedAtGen === undefined && mintedAtWallClock === undefined) return text;
  if (mintedAtGen !== undefined && currentGen <= mintedAtGen) return text; // in-session, nothing to disclose yet
  const stripped = stripPossibleDuplicateFrame(text);
  if (!stripped.startsWith(PASTE_RECOVERY_TAG)) return text;
  const framePrefix = text.slice(0, text.length - stripped.length); // "" when no possible-duplicate frame
  let note: string;
  if (mintedAtGen !== undefined) {
    const gensSince = currentGen - mintedAtGen;
    // Card 2d36337e: append the SAME absolute wall-clock time the cross-boundary branch below uses —
    // always stamped alongside mintedAtGen at mint time (verified: every mintedAtGen write site also sets
    // mintedAtWallClock in the same call; see this function's own doc). A relative generation count says
    // only how OLD this message is, never whether it predates some OTHER message the recipient already
    // read — the absolute time is what lets the recipient actually check that. Guarded (not assumed) in
    // case a future caller ever threads mintedAtGen without it.
    const sentAt = mintedAtWallClock !== undefined ? ` Originally sent at ${new Date(mintedAtWallClock).toISOString()}.` : "";
    note = `[this refers to an EARLIER message (${gensSince} submit generation${gensSince === 1 ? "" : "s"} ago), not your most recent one.${sentAt}]`;
  } else if (mintedAtWallClock !== undefined) {
    note = `[this refers to a message minted at ${new Date(mintedAtWallClock).toISOString()}, from BEFORE this session began — compare that timestamp against your own handoff/transcript to judge whether it's still current.]`;
  } else {
    return text; // unreachable given the guard above; kept for exhaustiveness
  }
  return `${framePrefix}${PASTE_RECOVERY_TAG} ${note} ${stripped.slice(PASTE_RECOVERY_TAG.length).trimStart()}`;
}

/**
 * How long to wait for `UserPromptSubmit` (or a Stop/StopFailure, either of which proves a turn ran)
 * to confirm a written Enter actually registered, before re-sending it. Bounds the verify-and-retry
 * loop in `sendEnterAndVerify`. Env-overridable so tests can shrink it instead of waiting real seconds.
 */
const SUBMIT_VERIFY_TIMEOUT_MS = Number(process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS) || 900;

/**
 * Total Enter attempts (the first write + retries) before giving up and recovering busy. Card 417cea0a:
 * exported (was module-private) so sessions/service.ts's `[loom:redelivery-parked]` notice can DERIVE its
 * "how much effort did Loom actually spend" figure from this constant instead of hand-typing a number that
 * silently rots the moment this changes — see that notice's own doc for the full derivation.
 */
export const SUBMIT_MAX_ATTEMPTS = Number(process.env.LOOM_SUBMIT_MAX_ATTEMPTS) || 4;

/**
 * Card 441499ee: how many times a single message may be put back on `live.pending` after a GIVE-UP
 * RECOVERY before it's dropped for real (with a loud log) instead of requeued again. Requeueing converts
 * a silent drop into delayed delivery, but an UNBOUNDED requeue would let a message that keeps hitting a
 * structurally-broken session (not just a transient contention burst) loop forever — worse than the
 * original drop. One requeue is enough to ride out a contention-driven burst (give-ups cluster where the
 * daemon is already busy, per the measurement on this same card) without risking an infinite retry loop.
 * Card 417cea0a: exported alongside `SUBMIT_MAX_ATTEMPTS` for the same reason — see that constant's doc.
 */
export const GIVE_UP_REQUEUE_LIMIT = Number(process.env.LOOM_GIVE_UP_REQUEUE_LIMIT) || 1;

/**
 * Card b64b3726: bounded poll for the GIVE-UP attempt's own paste-reassert (`BRACKET_PASTE_START +
 * BRACKET_PASTE_END`, written by `sendEnterAndVerify` on every `attempt > 1`) to settle BEFORE writing
 * that attempt's Enter and capturing `enterWrittenAt` — see `awaitReassertSettle`. Mirrors this file's
 * existing `RESUME_MODE_READ_POLL_MS`/`RESUME_MODE_CHANGE_MAX_POLLS` poll-count convention (observe, don't
 * guess, but stay bounded).
 *
 * SIZED FROM A MEASURED DISTRIBUTION, not guessed (real `claude` engine, card b64b3726 probes — see
 * `test/_probe-empty-paste-provocation.mjs` for the base finding). The re-assert alone reliably provokes a
 * deterministic 16-byte TUI response (a keyboard-protocol renegotiation) — but only INTERMITTENTLY at
 * production's actual retry cadence (~900ms between reasserts): a cadence-matched probe found it lands
 * inside its own attempt's verify window in ~13-20% of give-ups, not "always" (an earlier, wider-spaced
 * probe had wrongly suggested "always" — see that finding's own correction note for why probe CADENCE has
 * to match the thing being measured). When it DOES fire, latency across n=10 pooled real-engine samples was
 * bimodal: 8/10 (80%) landed in 1.15-7.65ms, 2/10 (20%) landed at 820.96/1367.94ms. `REASSERT_SETTLE_MAX_POLLS`
 * × `REASSERT_SETTLE_POLL_MS` ≈ 300ms therefore catches the fast majority with wide margin and deliberately
 * accepts the slow tail as a residual — a slow-arriving response can still land after this bound and cause a
 * suppress on THIS attempt, same as before this fix. That residual is acceptable ONLY because `healIfStuck`
 * (card b64b3726 Half 2) backstops the consequence regardless of which vector caused the suppression — if
 * that backstop is ever removed, this bound needs re-deriving against a fuller sample, not just widened.
 * If a future re-measurement shows the fast group is no longer the majority, THIS bound is the wrong one to
 * keep — don't just halve it, re-derive it from a fresh distribution.
 */
const REASSERT_SETTLE_POLL_MS = Number(process.env.LOOM_REASSERT_SETTLE_POLL_MS) || 15;
const REASSERT_SETTLE_MAX_POLLS = Number(process.env.LOOM_REASSERT_SETTLE_MAX_POLLS) || 20;

/**
 * Card 441499ee (hardening against the give-up discriminator's own measured false-negative rate — card
 * 04de8bbf, n=84: ~86% of give-ups that reach this point are followed by a confirming hook, i.e. the turn
 * actually started; only ~14% are genuine drops). A SHORT, bounded, OBSERVED wait for `enterConfirmed` to
 * flip true, inserted right where the output-based discriminator has ALREADY failed to suppress a give-up
 * — see `awaitGiveUpConfirmSettle`. Modeled on `REASSERT_SETTLE_POLL_MS`/`_MAX_POLLS`'s own shape and
 * accept-a-residual philosophy, but kept as an INDEPENDENT constant pair: that one is sized against a
 * measured LOCAL terminal-protocol renegotiation latency (a completely different, much faster mechanism
 * than an actual hook round-trip), so reusing it here would smuggle in an unmeasured assumption.
 *
 * DELIBERATELY NOT sized to cover the full hook-confirmation latency distribution — give-ups are
 * CONTENTION-DRIVEN BURSTS (see SUBMIT_VERIFY_TIMEOUT_MS's own REJECTED ALTERNATIVE note), so a bound wide
 * enough to reliably catch a contention-delayed hook would have to keep growing to chase wherever fleet
 * contention peaks next — the exact anti-pattern this project has reverted twice (cards 595aad10,
 * fea23514). This is a SHORT last-chance check that only claims to catch the FASTEST-confirming subset of
 * the 86% for free (zero requeue, zero purge race, ever, for those); anything slower still falls through to
 * GIVE-UP RECOVERY's existing requeue, with `purgeConfirmedGiveUpRequeue` as the defense-in-depth for a
 * confirmation that arrives later still, before the requeued entry has actually drained. Closing the gap
 * further needs the discriminator itself fixed (04de8bbf), not a bigger constant here.
 */
const GIVE_UP_CONFIRM_SETTLE_POLL_MS = Number(process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS) || 15;
const GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = Number(process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS) || 20;

/**
 * Card 3e76ecad: bounded, OBSERVED wait `flushComposer` (the manager-facing submit-only affordance) uses
 * to report whether its Enter actually confirmed, so the MCP call it backs always resolves instead of
 * hanging on a promise nothing ever settles. Sized to comfortably outlast `fireEnterAndVerify`'s own
 * worst-case retry ladder (`SUBMIT_MAX_ATTEMPTS` attempts × `SUBMIT_VERIFY_TIMEOUT_MS`, plus its
 * `awaitReassertSettle`/`awaitGiveUpConfirmSettle` settle windows) at PRODUCTION defaults — at
 * 100ms×50=5000ms this covers the ~4.2s worst case with margin; env-overridable so a test with a
 * shrunk ladder isn't stuck waiting out the production-sized bound.
 */
const FLUSH_CONFIRM_POLL_MS = Number(process.env.LOOM_FLUSH_CONFIRM_POLL_MS) || 100;
const FLUSH_CONFIRM_MAX_POLLS = Number(process.env.LOOM_FLUSH_CONFIRM_MAX_POLLS) || 50;

/**
 * Card 73d5c34a: how long a GIVE-UP-requeued entry stays INELIGIBLE for `drainPending` after
 * `requeueGiveUpOrigin` puts it back on `live.pending`, giving a late confirming hook a fair window to
 * `purgeConfirmedGiveUpRequeue` it before anything can resubmit it a second time — see that method's doc
 * for the race this closes (a ~10s reconcile tick beating a merely-late hook to the punch). Sized well
 * past one reconcile tick (`watchers.reconcileMs`, daemon-default 10_000ms) so an ordinary reconcile pass
 * can never win the race outright; NOT tied to the live reconcile interval itself (this file has no
 * access to that daemon-resolved config, and coupling to it would make the bound implicit and
 * un-overridable in isolation). Still a HARD bound, never infinite: a genuine give-up (no hook ever
 * arrives) is held only this long before falling through to the pre-existing recovery-and-drain behavior
 * (card 441499ee) — the silent-drop protection that bound exists to preserve. Env-overridable so a
 * hermetic test can shrink it instead of waiting real seconds.
 *
 * EXPORTED (card ccb407eb CR follow-up): `sessions/service.ts`'s cross-turn-boundary re-mint reuses this
 * SAME constant when stamping its own `giveUpHeldUntil` — "matching the requeue path's own discipline"
 * means literally sharing the bound, not maintaining a second one that could drift from it.
 */
export const GIVE_UP_HOLD_MS = Number(process.env.LOOM_GIVE_UP_HOLD_MS) || 20_000;

/**
 * Card 2521bf51: bound on `Live.humanSubmitHeldUntil` — how long `drainPending` will hold a queued
 * programmatic turn after a genuine human Enter-submit, waiting for claude's own `UserPromptSubmit`/
 * `Stop` hook to confirm the turn actually started (see that field's own doc for the race this closes).
 * The common case clears this well before the bound — a real hook round-trip is fast — so the bound
 * itself is only the belt-and-suspenders backstop for the rare case BOTH hooks are lost for this turn.
 * Sized past one reconcile tick (`watchers.reconcileMs`, daemon-default 10_000ms — same reasoning as
 * `GIVE_UP_HOLD_MS`'s own sizing above) so an ordinary reconcile pass can't win the very race this hold
 * exists to prevent. A SEPARATE constant/env var from `GIVE_UP_HOLD_MS` on purpose — same default value,
 * unrelated concept (ambiguous re-mint resolution vs. human-submit engine confirmation), so tuning one
 * never silently retunes the other. Env-overridable so a hermetic test can shrink it.
 */
export const HUMAN_SUBMIT_CONFIRM_HOLD_MS = Number(process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS) || 20_000;

/**
 * Card 4a0af485: bounds `Live.ambiguousDispatches` by COUNT, deliberately NOT by elapsed time — the whole
 * point of that map is to keep listening for a late confirmation for as long as the session lives, since a
 * real engine-confirmation lag has no known upper bound (232s measured, no ceiling established). This is an
 * OBSERVATION-WINDOW bound, not a retry DEADLINE — `SUBMIT_VERIFY_TIMEOUT_MS`/`GIVE_UP_REQUEUE_LIMIT` (the
 * actual retry cadence) are untouched by this card.
 *
 * ⚠️ CODE REVIEW CORRECTION (an earlier draft claimed this cap is "expected to almost never actually
 * evict" because "real ambiguity is rare" — WRONG as originally reasoned): the map tracks EVER-given-up
 * generations, not CURRENTLY-ambiguous ones — with no cleanup on resolution, it grows MONOTONICALLY with
 * every give-up event for the session's whole life, and this card's own body measures give-ups at
 * 79%/~86% false-negative rates under load; 20 distinct give-ups in one long session is ordinary, not rare.
 * The cap's actual safety net is `purgeConfirmedGiveUpRequeue`/`drainPending` DELETING an entry the MOMENT
 * its own ambiguity resolves (content match, the FIFO-position fallback's own purge, or a `giveUpGen`-
 * tagged entry's successful re-drain — see each site's own comment) — cleaned up promptly like that, the
 * map commonly WILL stay near-empty in practice, but that is a CONSEQUENCE of the cleanup discipline, not
 * an independent claim about how rarely a session gives up. This cap is the memory-safety BACKSTOP for
 * whatever manages to outlive that cleanup (e.g. a session that gives up dozens of times with no confirming
 * hook ever arriving for any of them) — eviction only ever discards the OLDEST entry, oldest-first being
 * correct precisely BECAUSE cleanup keeps the map append-only-but-current, not append-only-and-stale.
 */
const AMBIGUOUS_DISPATCH_CAP = 20;

/**
 * A single large `pty.write` is truncated by Windows ConPTY's input buffer — observed as long
 * worker reports and pastes arriving cut off in the receiving session. Split big writes into
 * paced chunks so the console host drains between them. Keystroke-sized writes take one chunk.
 */
// Env-overridable (test-only seam, mirrors other env-overridable timing constants in this file): a
// hermetic test can shrink the chunk size / widen the delay to make a multi-chunk writeChunked() chain
// span a wide, deterministic window instead of relying on production-sized timing — see
// pty-restart-nudge-atomicity.mjs.
// Card fc58ae55: named UNITS, not BYTES — `String.prototype.slice`/`.length` count UTF-16 CODE UNITS,
// not bytes, and the old `_BYTES` name read as byte-safe when it never was (part of why the surrogate-
// pair-splitting bug survived). The env var keeps its original name (LOOM_PTY_WRITE_CHUNK_BYTES) —
// existing tests set it and there is no correctness reason to churn it, only the in-code identifier lied.
const PTY_WRITE_CHUNK_UNITS = Number(process.env.LOOM_PTY_WRITE_CHUNK_BYTES) || 1024;
const PTY_WRITE_CHUNK_DELAY_MS = Number(process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS) || 8;

/**
 * Card fc58ae55: the last unit of a `writeChunked` chunk must never be the high half of a surrogate
 * pair whose low half starts the NEXT chunk. Each chunk is written to the pty (and UTF-8-encoded)
 * independently, so a pair split across chunks turns into two lone surrogates — each independently
 * replaced with U+FFFD on encode. Same length in, same length out, content silently corrupted.
 * Splitting BETWEEN two distinct code points (e.g. either side of a ZWJ) is NOT this bug and must stay
 * untouched — only shrink the chunk when the split point is provably INSIDE one surrogate pair.
 */
function surrogateSafeChunkEnd(text: string, start: number, maxUnits: number): number {
  const end = Math.min(start + maxUnits, text.length);
  if (end <= start || end >= text.length) return end;
  const lastUnit = text.charCodeAt(end - 1);
  const nextUnit = text.charCodeAt(end);
  const lastIsHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  const nextIsLowSurrogate = nextUnit >= 0xdc00 && nextUnit <= 0xdfff;
  // Only shrink when doing so leaves a non-empty chunk — an unrealistically small maxUnits (e.g. a
  // hermetic test) could otherwise produce a zero-length chunk and stall the `i` advance forever.
  if (lastIsHighSurrogate && nextIsLowSurrogate && end - 1 > start) return end - 1;
  return end;
}

/**
 * Bracketed-paste delimiters. Programmatic turns (worker reports, queued messages, /input) are
 * wrapped so claude treats the whole block — even multi-line — as ONE paste unit: embedded newlines
 * don't submit partial turns, and the trailing Enter (after the close marker) reliably submits. This
 * is why a worker report no longer "sits in the input box" un-submitted.
 */
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

/**
 * Visible separator between coalesced queued messages when drainPending delivers the WHOLE pending FIFO
 * as ONE turn. Each queued entry is already independently framed (e.g. `[loom:from-manager]\n…`); this
 * rule keeps consecutive messages legible as distinct items within the single concatenated turn, in
 * FIFO order (so e.g. 3 superseding manager redirects arrive together, newest last, not one-per-Stop).
 */
const DRAIN_SEPARATOR = "\n\n────────\n\n";

/**
 * Card 78e4b3f2: the text ACTUALLY submitted for a batch of drained (or `Live.giveUpOrigin`-captured)
 * messages — coalesces them with `DRAIN_SEPARATOR` exactly like before this card, but ALSO frames any
 * member whose `giveUpGen` is already set (this write is a genuine re-delivery of a message that was never
 * confirmed) as a possible duplicate — see `framePossibleDuplicate`'s own doc. A first-ever write
 * (`giveUpGen` undefined) or an already-tagged cross-remint (the idempotency guard) passes through
 * unmarked/unchanged.
 *
 * SHARED, deliberately, between `drainPending` (computes what to actually write) and `requeueGiveUpOrigin`
 * (must seed `Live.ambiguousDispatches`'s signature from EXACTLY what was written for the failing attempt,
 * never from `QueuedMessage.text`'s own possibly-pristine value — `giveUpGen` has not yet been bumped to
 * the NEW generation at the point `requeueGiveUpOrigin` reads it, so this reconstructs the SAME text
 * `drainPending` used to write the attempt that just gave up). Letting these two drift would break the
 * late-confirmation content-match/purge mechanism the instant a marked (giveUpGen-tagged) retry itself
 * gives up: the engine's real echo would carry the tag, but a signature computed from the pristine text
 * would never match it.
 *
 * Card 4af5aefa: `currentGen` — the generation count at the moment THIS text is being assembled for a
 * real write — is threaded through the SAME way, for the SAME reason: `annotatePasteRecoveryAge` must
 * run on whatever `drainPending` is about to actually write, and `requeueGiveUpOrigin` must reconstruct
 * that exact same annotated text (not the pristine one) to seed a matching signature. See both call
 * sites for why each passes the value it passes.
 */
function joinSubmittedText(messages: QueuedMessage[], currentGen: number): string {
  return messages
    .map((m) => {
      const t = m.giveUpGen !== undefined ? framePossibleDuplicate(m.text, m.logicalId) : m.text;
      return annotatePasteRecoveryAge(t, m.mintedAtGen, currentGen, m.mintedAtWallClock);
    })
    .join(DRAIN_SEPARATOR);
}

/**
 * The coalescing key for a queued message's route (Loom Companion multi-channel routing). A NO-route
 * message (every non-companion inject — manager→worker direction, nudges, reports) maps to the EMPTY key,
 * so all no-route messages share one key and coalesce ALL-TOGETHER exactly as before. A routed companion
 * inbound keys on channel+chatId (NUL-joined, unambiguous), so a different route breaks the coalescing run.
 */
function routeKeyOf(route?: TurnRoute): string {
  return route ? `${route.channel}\x00${route.chatId}` : "";
}

/**
 * A session marked busy with NO engine output for this long is treated as STUCK (a turn that never
 * really started, or a missed Stop hook) and self-healed to idle so its queued messages can drain
 * and the UI stops showing a phantom 'busy'. Conservative — a genuinely long, silent tool call is
 * rare — so a false heal can't clobber a live turn. (The robust follow-up is transcript-based.)
 *
 * DAEMON-GLOBAL tunable: this const is the default / test seam; the live value is `platform.timeouts.busyStaleMs`,
 * threaded in via the PtyHost constructor opt (index.ts passes the resolved number at boot — BOOT-BOUND).
 */
const BUSY_STALE_MS = 5 * 60_000;

/** Shift+Tab (CSI Z / back-tab) — Claude's TUI cycles the permission mode on this key. */
const SHIFT_TAB = "\x1b[Z";
/** Down/Up arrow (CSI B / CSI A) — move the selection in Claude's TUI menus. */
const DOWN_ARROW = "\x1b[B";
const UP_ARROW = "\x1b[A";
const ENTER = "\r";
const ESC_KEY = "\x1b";
/** Backspace/DEL — used to surgically un-type a give-up'd injection char-by-char (see sendEnterAndVerify). */
const BACKSPACE = "\x7f";
/** Strip CSI sequences so the boot-output scan matches the MCP prompt's words across TUI styling. */
const ANSI_CSI = new RegExp(ESC_KEY + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const collapseBoot = (s: string): string => s.replace(ANSI_CSI, "").replace(/\s+/g, "");

/** Settle window before the ONE Down press on the resume-summary gate (let its initial render finish
 *  painting before we read/press anything — mirrors MODE_CYCLE_SETTLE_MS's rationale). */
const RESUME_GATE_SETTLE_MS = 300;
/** Poll cadence + total budget while waiting for the ❯ cursor to confirm the (single) Down landed on
 *  option 2 (resolveResumeGate). Exactly ONE Down is ever written for the confirm loop itself — a retry
 *  that re-presses Down while an earlier, merely-SLOW (not dropped) press is still in flight would
 *  overshoot the cursor 1→2→3, landing on "Don't ask me again" (a code-review catch, card c7353d24
 *  follow-up: persists the gate-disable AND still compacts this turn — worse than the bug this fix
 *  exists to kill). So the budget is GENEROUS (not a tight per-press window) rather than retried —
 *  bounded so a genuinely wedged/garbled gate can't poll forever, but sized to let one slow render land.
 *  Env-overridable so the hermetic test drives the whole confirm loop in milliseconds (mirrors
 *  RESUME_MODE_*). */
const RESUME_GATE_POLL_MS = Number(process.env.LOOM_RESUME_GATE_POLL_MS) || 150;
const RESUME_GATE_MAX_POLLS = Number(process.env.LOOM_RESUME_GATE_MAX_POLLS) || 20;

/**
 * Recompute the human's RAW-terminal composer draft length from ONE input chunk, given the prior
 * length. PURE + exported for the hermetic test. "Composer-dirty" is simply `len > 0`; while dirty,
 * a programmatic turn is HELD (never delivered onto the half-typed text) — see deferForHumanDraft.
 * We track LENGTH, not a bool, only so a human who BACKSPACES the whole line back to empty also
 * releases the hold (a bare bool couldn't tell that from a still-dirty box).
 *
 * Classification of the chunk:
 *  - A LONE Esc (\x1b) dismisses/clears the box → 0.
 *  - Otherwise walk the chunk in a single pass, tracking whether we're INSIDE a `\x1b[200~ … \x1b[201~`
 *    bracketed-paste span:
 *      - A BARE box-FREEING control encountered OUTSIDE a paste span — Enter (\r/\n), Ctrl-C (\x03),
 *        or kill-line (Ctrl-U \x15) — means the human submitted/interrupted/killed the line → 0.
 *        (We can't whole-chunk short-circuit on these: a MULTI-LINE paste body carries \r/\n that is
 *        draft CONTENT, not a free — that would wrongly zero a held paste and let a queued turn drain
 *        onto it.) Inside a span, \r/\n is counted as one draft char.
 *      - backspace/DEL (\x7f/\b) decrements (floored at 0).
 *      - printable chars (>= 0x20) increment.
 *      - an escape sequence (arrow keys / navigation / the bracketed-paste markers) is skipped to its
 *        final byte so its parameter bytes aren't miscounted as printable; the \x1b[200~ / \x1b[201~
 *        markers toggle the paste flag. Other C0 controls (Tab, etc.) are ignored.
 *
 * Best-effort BY DESIGN — it can't perfectly mirror Claude's Ink editor (e.g. cursor-mid-line edits),
 * but it only ever errs toward HOLDING a delivery, never toward clobbering the human's text.
 */
export function nextComposerLen(prevLen: number, data: string): number {
  if (data === ESC_KEY) return 0;                 // a lone Esc dismisses/clears the box
  let len = prevLen;
  let inPaste = false;                            // inside a \x1b[200~ … \x1b[201~ bracketed-paste span
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      // Escape/CSI/SS3 sequence (arrow keys, Home/End, bracketed-paste \x1b[200~ markers, …). The paste
      // markers toggle inPaste; any other sequence is skipped to its final byte so its param bytes
      // (e.g. the "200" in \x1b[200~) aren't counted. The paste BODY between the markers is counted by
      // the normal printable/newline path on later iterations.
      if (data.startsWith(BRACKET_PASTE_START, i)) { inPaste = true; i += BRACKET_PASTE_START.length - 1; continue; }
      if (data.startsWith(BRACKET_PASTE_END, i)) { inPaste = false; i += BRACKET_PASTE_END.length - 1; continue; }
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        i += 2;
        while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
      } else {
        i += 1; // a lone/unknown ESC inside a larger chunk — skip just the ESC byte
      }
      continue;
    }
    if (c === 0x7f || c === 0x08) { len = Math.max(0, len - 1); continue; } // backspace / DEL
    if (c === 0x0d || c === 0x0a || c === 0x03 || c === 0x15) {
      // Enter (\r/\n) / Ctrl-C / kill-line. OUTSIDE a paste these FREE the box (real submit/interrupt/
      // clear). INSIDE a bracketed paste a newline is pasted draft content, so count \r/\n toward length
      // and ignore the (vanishingly rare) other controls.
      if (!inPaste) return 0;
      if (c === 0x0d || c === 0x0a) len++;
      continue;
    }
    if (c >= 0x20) len++;                          // printable → one more draft char
    // other C0 controls (Tab, etc.) — ignore for length
  }
  return len;
}

/**
 * Card 0f9268cc: mirrors `nextComposerLen`'s exact parsing model, but tracks the raw-terminal draft's
 * actual TEXT (not just its length) and reports a genuine SUBMIT — an Enter that frees the box OUTSIDE a
 * bracketed-paste span — as opposed to Ctrl-C/kill-line/Esc, which discard the draft without producing a
 * transcript turn. `submitted` is the composed text at the moment of that Enter (null on every other
 * chunk), which the caller stashes as the raw-channel counterpart of `live.lastPrompt` — see
 * `Live.lastRawSubmit`'s doc. Deliberately a SEPARATE function/state from `nextComposerLen` rather than a
 * shared one: `composerLen` is load-bearing for the drain-hold gate and already has its own hermetic test;
 * this stays purely additive so that existing behavior can't regress.
 *
 * Same best-effort caveat as `nextComposerLen`: it can't perfectly mirror Claude's Ink editor, and a
 * multi-free chunk only reports the FIRST free (matching nextComposerLen's own limitation) — acceptable
 * because a `submitted` false-negative only means the tripwire misses a detection, never a wrong write.
 */
export function nextRawDraftState(prevText: string, data: string): { text: string; submitted: string | null } {
  if (data === ESC_KEY) return { text: "", submitted: null };
  let text = prevText;
  let inPaste = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      if (data.startsWith(BRACKET_PASTE_START, i)) { inPaste = true; i += BRACKET_PASTE_START.length - 1; continue; }
      if (data.startsWith(BRACKET_PASTE_END, i)) { inPaste = false; i += BRACKET_PASTE_END.length - 1; continue; }
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        i += 2;
        while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
      } else {
        i += 1; // a lone/unknown ESC inside a larger chunk — skip just the ESC byte
      }
      continue;
    }
    if (c === 0x7f || c === 0x08) { text = text.slice(0, -1); continue; } // backspace / DEL
    if (c === 0x0d || c === 0x0a || c === 0x03 || c === 0x15) {
      if (!inPaste) {
        const submitted = (c === 0x0d || c === 0x0a) && text.length > 0 ? text : null;
        return { text: "", submitted };
      }
      if (c === 0x0d || c === 0x0a) text += "\n";
      continue;
    }
    if (c >= 0x20) text += data[i]; // printable → one more draft char
    // other C0 controls (Tab, etc.) — ignore, same as nextComposerLen
  }
  return { text, submitted: null };
}

/**
 * Detect Claude Code's "resume from summary / as-is" gate, which appears BEFORE SessionStart when
 * resuming a large/old session (e.g. "This session is 1h 16m old and 435k tokens. Resuming the full
 * session will consume a substantial portion of your usage limits. We recommend resuming from a
 * summary." → ❯ 1. Resume from summary (recommended) / 2. Resume full session as-is / 3. Don't ask
 * me again). It blocks unattended resume: the DEFAULT is option 1 "from summary", which triggers a
 * SUMMARIZATION (compaction) and silently drops the manager's full context. Loom always wants option 2
 * (full as-is). Input is collapseBoot()'d output (ANSI + whitespace stripped). Exported for testing.
 */
export function isResumeSummaryGate(flatCollapsed: string): boolean {
  return /resumefromsummary/i.test(flatCollapsed) && /resumefullsession/i.test(flatCollapsed);
}

/**
 * Which option the resume-summary gate's ❯ cursor currently sits on — "1" (still the default, "Resume
 * from summary"), "2" (the target, "Resume full session as-is"), "3" ("Don't ask me again"), or `null`
 * if unreadable (the frame hasn't painted the cursor yet, or the gate isn't on screen). PURE + exported
 * for the hermetic test. `collapseBoot` strips ANSI but does NOT insert separators between lines (it
 * collapses whitespace to nothing), so a rendered "❯ 2. Resume full session as-is" flattens to
 * "❯2.Resumefullsessionas-is" — the cursor glyph sits immediately against the option's leading digit.
 *
 * This is what lets `resolveResumeGate` CONFIRM a Down press actually landed before risking Enter,
 * closing the 2026-07-10 incident: the old handler wrote a blind, unverified Down+Enter pair, and under
 * restart load the Down was delayed/reordered past the Enter — which then confirmed the still-default
 * option 1, silently compacting the manager's full context (3-for-3 simultaneously, a systematic race,
 * not a random dropped keystroke).
 *
 * Takes the LAST `❯N.` match, not the first: `resumeGateScan` is a CUMULATIVE rolling buffer (each
 * re-render is appended, not substituted — the TUI repaints via cursor-repositioning escapes that
 * `collapseBoot` strips, leaving every prior frame's text still concatenated in front of the current
 * one), so only the most recent occurrence reflects the gate's current state. Same "last occurrence
 * wins" reasoning as `detectPermissionMode`'s footer-mode `lastIndexOf` scan above.
 */
export function resumeGateCursorOption(flatCollapsed: string): "1" | "2" | "3" | null {
  const matches = [...flatCollapsed.matchAll(/❯(\d)\./g)];
  const digit = matches.at(-1)?.[1];
  return digit === "1" || digit === "2" || digit === "3" ? digit : null;
}

/**
 * The permission mode a spawned/resumed `claude` actually LANDED in, read from the TUI footer.
 * "default" = the unlabeled normal mode (footer shows the Shift+Tab cycle hint but no "<x> on" label);
 * "unknown" = no footer could be read (still booting / no output). OBSERVABILITY ONLY — see logLandedMode.
 */
export type LandedMode = "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "default" | "unknown";

/** Charset-designation (ESC ( B …) + keypad-mode (ESC = / ESC >) escapes — not CSI, so ANSI_CSI misses them. */
const ANSI_OTHER = new RegExp(ESC_KEY + "[()][0-9A-Za-z]|" + ESC_KEY + "[=>]", "g");
/** Strip ALL TUI escapes and collapse whitespace. The footer is laid out with cursor-position escapes,
 *  so after stripping the mode words run together ("accept edits on" → "accepteditson"). */
const collapseFooter = (s: string): string => s.replace(ANSI_CSI, "").replace(ANSI_OTHER, "").replace(/\s+/g, "");

/** Footer mode labels (collapsed, lowercase) → mode. acceptEdits/auto share the ⏵⏵ glyph; plan uses ⏸. */
const MODE_TOKENS: { mode: LandedMode; token: string }[] = [
  { mode: "plan", token: "planmodeon" },
  { mode: "acceptEdits", token: "accepteditson" },
  { mode: "auto", token: "automodeon" },
  { mode: "bypassPermissions", token: "bypasspermissionson" },
];

/**
 * Classify the permission mode from recent pty output by the LAST occurrence of a footer mode label
 * (the footer is repainted continuously, so the last label is the current mode). Empirically mapped
 * against real `claude` 2.1.163 (board card f05e4897; see test/_probe-resume-mode.mjs). PURE +
 * exported for the hermetic regression test. Never throws.
 *  - a labeled mode ("accept edits on"/"plan mode on"/"auto mode on"/"bypass permissions on") → that mode
 *  - no label but the Shift+Tab cycle hint is present → "default" (the unlabeled normal mode)
 *  - no footer readable at all → "unknown"
 */
export function detectPermissionMode(recentOutput: string): { mode: LandedMode; matchedToken: string | null } {
  const flat = collapseFooter(recentOutput).toLowerCase();
  let best: { mode: LandedMode; idx: number; token: string } | null = null;
  for (const { mode, token } of MODE_TOKENS) {
    const idx = flat.lastIndexOf(token);
    if (idx >= 0 && (best === null || idx > best.idx)) best = { mode, idx, token };
  }
  if (best) return { mode: best.mode, matchedToken: best.token };
  // No labeled mode. The cycle hint (tolerant of a char dropped across a line-wrap, e.g. "tabocycle")
  // means we DID read a footer in the unlabeled default mode; otherwise we couldn't read a footer.
  if (/shift\+tab[a-z]{0,3}cycle/.test(flat)) return { mode: "default", matchedToken: null };
  return { mode: "unknown", matchedToken: null };
}

/**
 * The cycle order Shift+Tab walks from the gate-free `acceptEdits` boot mode (claude 2.1.163; mapped by
 * the probe — board card f05e4897 / test/_probe-resume-mode.mjs):
 *   acceptEdits →(+1) plan →(+2) auto →(+3) default →(+4) acceptEdits   (period 4).
 */
const ACCEPT_EDITS_CYCLE_ORDER: LandedMode[] = ["acceptEdits", "plan", "auto", "default"];
/**
 * The permission mode reached after `cycles` Shift+Tab presses from the gate-free acceptEdits boot mode.
 * Used to derive a RESUME's TARGET mode from the SAME `startupModeCycles` a fresh spawn uses, so a
 * resumed session converges to exactly where a fresh spawn lands (default config: 2 → auto). PURE +
 * exported for the hermetic test. (Both fresh AND `--resume` boot at acceptEdits — `--resume` honours
 * `--permission-mode`, probe-verified; it does NOT restore the persisted mode — so this single map is
 * correct for both.)
 */
export function modeAfterCyclesFromAcceptEdits(cycles: number): LandedMode {
  const n = Math.trunc(cycles);
  // The index is always in [0,4) so this is always defined; the ?? keeps the type non-optional.
  return ACCEPT_EDITS_CYCLE_ORDER[(((n % 4) + 4) % 4)] ?? "acceptEdits";
}
/**
 * The INVERSE of {@link modeAfterCyclesFromAcceptEdits}: how many blind Shift+Tab presses from the
 * gate-free `acceptEdits` boot mode land on `target`. Lets a caller pin a session's boot-cycle target to
 * a SPECIFIC mode (e.g. a worker's structural `auto` default — card 760cd01d) without hand-copying the
 * cycle-order index, so a future change to {@link ACCEPT_EDITS_CYCLE_ORDER} can't silently desync the two.
 * `target` not found in the cycle (e.g. `bypassPermissions`/`unknown`, never reachable by this cycle) ⇒ 0
 * (stay at the gate-free boot mode) rather than throwing — mirrors `modeAfterCyclesFromAcceptEdits`'s own
 * fail-safe `?? "acceptEdits"` fallback.
 */
export function cyclesToReachFromAcceptEdits(target: LandedMode): number {
  const idx = ACCEPT_EDITS_CYCLE_ORDER.indexOf(target);
  return idx === -1 ? 0 : idx;
}

/** One step of the feedback cycler: at the target → stop; out of presses → stop; else press once. */
export type CycleAction = "done" | "press" | "giveup";
/**
 * PURE decision for the mode-convergence loop (cycleToMode, shared by fresh spawn + resume): given the
 * footer mode we just read, the target, and how many Shift+Tabs we've already issued, decide whether to
 * stop (reached the target), give up (hit the bounded press cap — leave the session as-is), or press one
 * more Shift+Tab. Exported so the table-driven hermetic test can assert the press count + stop conditions
 * with no real claude. The loop NEVER presses twice without first observing the footer change (see
 * cycleToMode), so feeding the sequence of observed modes through this function reproduces the exact
 * press sequence.
 */
export function nextCycleAction(o: { current: LandedMode; target: LandedMode; presses: number; maxPresses: number }): CycleAction {
  if (o.current === o.target) return "done";
  if (o.presses >= o.maxPresses) return "giveup";
  return "press";
}

/** Settle window after SessionStart before sending the first mode-cycle keystroke (let the TUI's input attach). */
const MODE_CYCLE_SETTLE_MS = 700;
/**
 * OBSERVABILITY (card f05e4897): after a session settles (markReady), poll the footer a few times
 * (until a mode is read or this cap) and log the landed permission mode. Read-only — see logLandedMode.
 * Card 0050a17e: kickoff delivery now GATES on this poll settling (see logLandedMode's `onSettled` doc),
 * so this is no longer purely observational timing — env-overridable (like the other constants in this
 * file) so a test can shrink it instead of eating a real ≥500ms wait per scenario.
 */
// Exported (card 27c36293): kickoff-real-spawn.mjs derives its post-SessionStart delivery budget from
// these two production constants instead of hardcoding a second copy that could silently drift out of
// sync with this file.
export const MODE_LOG_POLL_MS = Number(process.env.LOOM_MODE_LOG_POLL_MS) || 500;
export const MODE_LOG_MAX_ATTEMPTS = 8; // ≤ ~4s of best-effort polling, then log whatever we have
/**
 * Mode-convergence loop (cycleToMode, card f05e4897 / generalized in b99d3d67). Drives the footer to the
 * target ABSOLUTELY for BOTH a fresh spawn and a resume: press one Shift+Tab, then poll the footer until
 * it CHANGES (the press registered) before deciding again — so a laggy repaint can never trick us into
 * overshooting. Polling cadence + the per-press change-wait cap (≈3s) and the total press cap. Sized so
 * the whole loop (worst case ≈ MAX_PRESSES × CHANGE_MAX_POLLS × POLL_MS + settle ≈ 13–14s) finishes
 * COMFORTABLY under MODE_CYCLE_FALLBACK_MS (20s, re-armed from SessionStart — see its own doc; card
 * c469d54e corrected this comment, which previously named READY_FALLBACK_MS here — that constant is
 * SPAWN-anchored and no longer what a healthy in-flight cycle races against once SessionStart has fired)
 * — the mode-cycle fallback must not fire mid-cycle and release queued injections before the mode settles
 * (the 2026-06-03 strand bug). From the acceptEdits boot mode, auto is reached in 2 presses; the cap is
 * headroom (a full period is 4). */
const RESUME_MODE_READ_POLL_MS = Number(process.env.LOOM_RESUME_MODE_POLL_MS) || 200;
const RESUME_MODE_CHANGE_MAX_POLLS = Number(process.env.LOOM_RESUME_MODE_MAX_POLLS) || 15;
const RESUME_MODE_MAX_PRESSES = Number(process.env.LOOM_RESUME_MODE_MAX_PRESSES) || 4;
/**
 * `logLandedMode`'s auto-heal trigger set (card 9c03f5a6) — every DEFINITE `LandedMode` reading short of
 * the session's own configured target (`auto` for the platform default). Deliberately an explicit
 * enumeration, not `mode !== target`: the latter would also match `"unknown"` (no footer could be read at
 * all), breaking the heal's load-bearing invariant that no correction is EVER attempted without a
 * definite read. `"unknown"` is excluded by construction here, not by a separate runtime check.
 */
const HEALABLE_MODES: ReadonlySet<LandedMode> = new Set(["plan", "acceptEdits", "default", "bypassPermissions"]);
/**
 * `setPermissionMode` (worker_set_mode) outer retry bound (card 9c03f5a6) — how many FULL cycleToMode
 * passes to attempt, each starting from a fresh footer read, before giving up and reporting the true
 * landed mode. 1 = the raw single-pass behaviour; >1 self-corrects a genuinely dropped keystroke (a press
 * whose footer repaint never registered within one pass's own change-wait cap) without the caller having
 * to notice a miss and retry by hand.
 */
const MODE_OVERRIDE_MAX_ATTEMPTS = Number(process.env.LOOM_MODE_OVERRIDE_MAX_ATTEMPTS) || 3;
/**
 * Readiness fallback, spawn-scoped. SessionStart normally flips a (re)spawned session to `ready` (after
 * the mode-cycles land). If that hook never arrives AT ALL, don't strand a queued boot injection forever —
 * mark ready after this grace so the message still drains. Env-overridable so tests don't wait 20s.
 *
 * Card c469d54e: this is now ONLY the missed-hook guarantee. Once SessionStart DOES arrive, the
 * SessionStart handler cancels this timer and re-arms MODE_CYCLE_FALLBACK_MS (below) scoped from that
 * moment instead — see its own doc for why sharing this one spawn-anchored clock between two different
 * things it was never sized for (the hook merely arriving vs. the mode-cycle it kicks off actually
 * finishing) was the defect. Both timers share `Live.readyFallbackTimer` — never two pending at once.
 */
// Exported (card 27c36293) for the same reason as MODE_LOG_POLL_MS/MODE_LOG_MAX_ATTEMPTS above —
// kickoff-real-spawn.mjs's real-child-boot budget derives from this production constant too.
export const READY_FALLBACK_MS = Number(process.env.LOOM_READY_FALLBACK_MS) || 20_000;

/**
 * Card c469d54e — mode-cycle-scoped readiness fallback, re-armed from SessionStart (not spawn) once the
 * SessionStart hook's `deliverHook` call is actually DISPATCHED (not merely once the hook has arrived at
 * the process — an arrived-but-not-yet-dispatched hook, e.g. queued behind other synchronous work on an
 * overloaded event loop, gets none of this budget's protection until dispatch actually happens). Sized
 * like READY_FALLBACK_MS's own original budget: comfortably over cycleToMode's documented worst case
 * (~13-14s, see its doc comment) so a HEALTHY cycle always finishes first. Under host contention
 * SessionStart's dispatch can land late enough to leave less than this much runway before the ORIGINAL
 * spawn-anchored deadline — that shrinking residual, not cycleToMode being slow, was the actual defect:
 * confirmed against the 2026-08-01 mass-restart's raw daemon-output.log — 9/9 fallback firings in that
 * incident had SessionStart already dispatched 5.3s-11.6s before the old spawn+20s deadline, well under
 * this budget, and 7/9 (8/9 under a broader any-non-clean-landing definition) showed the corrupted-footer
 * signature this card fixes (see docs/investigations/c469d54e-ready-fallback-race/findings.md for the
 * frozen log, its md5, and the re-runnable extraction script — this is manager-verified, not the parent
 * card's original worker-reported figure). Re-arming FROM SessionStart's dispatch gives every healthy
 * cycle its full, un-eroded budget regardless of how late that dispatch was. Env-overridable so tests
 * don't wait it out.
 *
 * INVARIANT (must hold for the clamp below to ever matter): READY_FALLBACK_ABSOLUTE_CEILING_MS −
 * MODE_CYCLE_FALLBACK_MS ≥ READY_FALLBACK_MS (45s − 20s ≥ 20s at the shipped defaults). All three are
 * independently env-overridable — raising LOOM_READY_FALLBACK_MS past ~25s alone (holding the other two at
 * their defaults) shrinks that margin below zero and deterministically RE-CREATES this card's race: the
 * ceiling would then clamp the re-armed budget to LESS than the original spawn-anchored deadline already
 * gave a cycle starting near spawn+0, for no reason. Nothing enforces this invariant at runtime — it is a
 * deployment-time contract between three env vars, stated here so a future override doesn't reopen it silently.
 */
export const MODE_CYCLE_FALLBACK_MS = Number(process.env.LOOM_MODE_CYCLE_FALLBACK_MS) || 20_000;

/**
 * Card c469d54e — absolute ceiling on the re-armed timer above, measured from SPAWN (Live.startedAt), not
 * SessionStart. Preserves READY_FALLBACK_MS's original liveness guarantee ("never strand a queued boot
 * injection forever") for the residual failure mode this fix does NOT eliminate: a SessionStart hook whose
 * `deliverHook` dispatch is delayed to or past the original spawn+READY_FALLBACK_MS mark — a strictly worse
 * contention level than anything observed in the incident this card fixes (worst observed SessionStart-
 * dispatch gap there was ~11.6s, per docs/investigations/c469d54e-ready-fallback-race/findings.md; this
 * ceiling gives roughly 4x that margin before giving up regardless). Deliberately NOT unbounded: a cycle
 * that starts very late still gets bounded runway, not an open-ended wait. See MODE_CYCLE_FALLBACK_MS's own
 * doc for the three-constant invariant this ceiling's value participates in.
 */
export const READY_FALLBACK_ABSOLUTE_CEILING_MS = Number(process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS) || 45_000;

/**
 * Card df5e37e7: bound on waitForMcpSeen — how long a deferred resume-continuation nudge (see
 * sessions/service.ts resumeFleetOnBoot / recoverCrashOrphanedWorkers) waits for the CLI's own
 * loom-orchestration MCP handshake to reach us (markMcpSeen) before giving up and delivering the nudge
 * anyway (today's behavior — the possible "not connected" race, not a wedge). Comfortably under
 * READY_FALLBACK_MS (20s): a normal MCP HTTP handshake is sub-second, so this only needs to absorb
 * fleet-wide restart contention, not stand in as a second readiness fallback. Env-overridable so tests
 * don't wait out the default.
 */
const MCP_READY_TIMEOUT_MS = Number(process.env.LOOM_MCP_READY_TIMEOUT_MS) || 9_000;

// Card 0050a17e removed `STARTUP_PROMPT_GRACE_MS` (formerly a ~10s window here, env-overridable via
// LOOM_STARTUP_PROMPT_GRACE_MS): it existed ONLY to outlast the vendor CLI's own auto-type-and-submit of
// a positional startup prompt, which no longer happens for ANY role (buildSpawnArgs never emits the
// prompt into argv any more — see that function's own doc). With nothing left to race, the kickoff
// guarantee (scheduleKickoffGuarantee, below) fires on the very next tick after `markReady` instead of
// waiting out an arbitrary grace window — see that function's own doc for what "next tick" still needs
// to wait for (it is not truly zero-cost) and why deleting the constant outright, rather than keeping it
// "just in case", is the correct call: a timer with nothing left to guard is dead weight that would
// eventually be mistaken for load-bearing by a future reader.

/**
 * SHORT stale-busy threshold for a session that has NEVER started its first turn (Live.firstTurnStarted
 * still false — see the UserPromptSubmit hook handler). Used by healIfStuck INSTEAD of the full
 * `busyStaleMs` (5min default): there is no such thing as a legitimately long tool call before turn 1 has
 * even started, so a pre-first-turn session with stale pty output is already known-broken and should
 * self-heal to `busy:false` fast — surfacing to the manager via the existing onBusy→notifyManagerOfIdleWorker
 * path (which branches on `engineSessionId` there to distinguish this from a genuine post-turn idle) instead
 * of sitting masked as "busy" for the full 5-minute window. Once a real turn starts, firstTurnStarted flips
 * true and the normal, more generous busyStaleMs applies. Env-overridable for tests.
 */
const FIRST_TURN_STALE_MS = Number(process.env.LOOM_FIRST_TURN_STALE_MS) || 30_000;

/**
 * Card b4b9b707: how long a captured Live.pendingRawOwnerSubmit may sit unconsumed before a later
 * UserPromptSubmit discards it rather than attributing it — see that field's doc. A genuine raw-terminal
 * answer is correlated to the engine's hook near-instantly; this only needs to be generous enough to
 * absorb normal relay/scheduling latency while still bounding how far a stray (non-composer) Enter could
 * drift onto an unrelated later turn.
 */
const RAW_OWNER_SUBMIT_TTL_MS = Number(process.env.LOOM_RAW_OWNER_SUBMIT_TTL_MS) || 30_000;

/**
 * Graceful-stop escalation — makes a graceful stop ALWAYS terminate the session (the deterministic-stop
 * fix). A double Ctrl-C EXITS an IDLE `claude` (the second press exits from an empty prompt), but on a
 * session that's mid-turn the two Ctrl-Cs only INTERRUPT the running turn — the pty stays alive at a (now)
 * idle prompt and, because no Stop hook fires after the interrupt, the busy flag stays stale. So the
 * operator sees a "stopped" session that's actually still live+busy (the board bug). Fix: after the
 * initial interrupt sequence, if the pty is STILL alive, RE-SEND the exit sequence (the turn has since
 * unwound to an idle prompt, where the double Ctrl-C exits); and if it STILL refuses to exit within a hard
 * bound (a wedged TUI / a tool call that swallows Ctrl-C), ESCALATE to a hard `pty.kill()` (node-pty Job
 * Object — orphan-free, kills the tree). An IDLE session exits on the very FIRST sequence, so the escalation
 * timers always find `!alive` and are pure no-ops — its graceful stop is unchanged. All three are
 * env-overridable so the hermetic test drives the whole escalation in milliseconds (default unset =
 * production behaviour: the first two Ctrl-Cs keep their original 600ms gap).
 *   GAP   — gap between the two Ctrl-Cs of one exit sequence (was the inline 600ms literal)
 *   RETRY — re-send the exit sequence at this point if the session is still live after the interrupt
 *   KILL  — hard bound after which an un-exited pty is killed (RETRY+GAP < KILL, so the re-send gets a
 *           full window to land before the kill)
 */
const GRACEFUL_STOP_GAP_MS = Number(process.env.LOOM_GRACEFUL_GAP_MS) || 600;
const GRACEFUL_STOP_RETRY_MS = Number(process.env.LOOM_GRACEFUL_RETRY_MS) || 2_000;
const GRACEFUL_STOP_KILL_MS = Number(process.env.LOOM_GRACEFUL_KILL_MS) || 6_000;

/**
 * Settle window for `interruptForRedirect`: after writing the single Esc that cancels a busy worker's
 * in-flight generation, wait this long for the engine to unwind back to an idle prompt before we
 * SYNCHRONOUSLY clear the (now stale) busy and drain the freshly-enqueued redirect as the next turn. An
 * Esc-cancel fires NO Stop hook (same as the Ctrl-C interrupt), so nothing else lowers busy — this timer
 * is what does. Env-overridable so the hermetic test drives it in milliseconds (mirrors GRACEFUL_STOP_*);
 * default unset = production behaviour (a beat for the cancel to land). Sized well under BUSY_STALE_MS so
 * it always wins the self-heal race.
 */
const REDIRECT_SETTLE_MS = Number(process.env.LOOM_REDIRECT_SETTLE_MS) || 1_500;

/**
 * Companion injection-guard Primitive A widening (card 2b26035c): how many RECENT authenticated
 * owner-turns `Live.recentOwnerTurns` retains for a "recent-turns verbatim acceptance" check. Small and
 * bounded on purpose — wide enough to cover a cross-turn correction/re-phrase in the SAME live exchange
 * (owner: "Creative projects…" → owner: "no, creating…") without widening "recent" into "anything the
 * owner ever said in this conversation", which would erode the guard's whole point.
 */
const RECENT_OWNER_TURNS_WINDOW = 5;

/**
 * Resolve the per-session Playwright MCP (`@playwright/mcp`) stdio server entry, injected at spawn
 * ONLY for a browserTesting session (opt-in, gated). Built with ABSOLUTE paths — the same lesson as
 * the absolute-claude-path invariant: node-pty's Windows agent does NOT search %PATH%, and a bare
 * `command: "npx"`/`"playwright-mcp"` would not launch. So:
 *   - command = `process.execPath` (the daemon's own absolute node binary), and
 *   - args[0] = the absolute path to the package's `cli.js`.
 * `cli.js` isn't in the package's `exports` map (only `.` and `./package.json` are), so we resolve
 * `@playwright/mcp/package.json` and join `cli.js` (its `bin` target) beside it — robust under both
 * the source (tsx) and the built `dist/` daemon. Memoized: the resolution is constant per process.
 *
 * `--headless` (unattended; no visible window) + `--isolated` (profile kept in memory — no on-disk
 * profile lock, so PARALLEL browser-workers never collide and nothing persists between runs, matching
 * the "own isolated browser, no shared state/auth" design). Chromium is launched LAZILY by the MCP on
 * the first browser tool call, so an idle browser-capable worker boots no Chromium. If the Chromium
 * binaries are absent the FIRST tool call fails inside the MCP with Playwright's own actionable
 * "run `npx playwright install chromium`" message (the one-time host provisioning step).
 *
 * `--output-dir <outputDir>` (when supplied) sets where the MCP writes capture artifacts —
 * `browser_take_screenshot`, traces, downloads. Loom passes a repo-EXTERNAL per-session scratch dir
 * (`sessionScratchDir`) by default so a screenshot taken with NO explicit path can NEVER land inside the
 * project working tree: without it the MCP defaults output to `<cwd>/.playwright-mcp`, and cwd IS the
 * project repo root — a stray-PNG-commit footgun in a self-hosting repo.
 * `outputDir` is ALSO the enforced write boundary, not just the default: an explicit (absolute) caller
 * filename bypasses the JOIN (playwright-core resolves it with `path.resolve(outputDir, fileName)`, which
 * returns the absolute path verbatim) but is then checked by playwright-core's OWN `checkFile` guard,
 * which allows a write only inside `outputDir` OR the MCP subprocess's inherited OS cwd — TWO fixed
 * roots, no configurable extra-roots list in this pinned version, and that cwd is NOT independently
 * settable per MCP server (a `"cwd"` field on the stdio server entry is silently ignored — verified by
 * spawning a real `claude` and observing the child still inherit claude's own cwd). So a caller-absolute
 * path OUTSIDE both roots is DENIED, not just "unaffected". **A caller-supplied RELATIVE/bare filename is
 * the footgun, not a safe third case**: traced against the pinned `@playwright/mcp@0.0.75` bundle
 * (`playwright-core`'s `Response.resolveClientFile` → `resolveClientFilename` → `context.workspaceFile`),
 * a supplied filename — even a bare one — resolves against `context.options.cwd` (the worktree/repo root),
 * NOT `outputDir`; only the OMIT-filename default path goes through `context.outputFile()`/`outputDir`.
 * So a bare `browser_take_screenshot({ filename: "foo.png" })` silently lands in the repo root, not scratch
 * — `checkFile` allows it (cwd is one of its two roots) rather than denying it. This is baked into
 * playwright-core's bundled classes; no `Config` field or CLI flag redirects it, so it is NOT something
 * Loom's spawn config can fix — omit the filename (auto-names into `outputDir`) or pass an absolute path
 * under `LOOM_SCRATCH_DIR` (see `browserScratchEnv` below) to actually land in scratch. `outputDir` also
 * governs the DEFAULT (implicit,
 * no-filename) artifact for every snapshot-bearing tool response, not just an explicit screenshot — the
 * MCP's default `snapshot.mode` writes the page's ARIA snapshot to `page-{timestamp}.yml` in `outputDir`
 * on essentially every browser tool call, so `outputDir` is a HIGH-FREQUENCY write target, not an
 * occasional one (card 61ab62e3: this is why an earlier `outputDir = vaultPath` default littered the
 * user's Obsidian vault with `page-*.yml` on every browser turn — `buildMcpServers` now always passes the
 * scratch dir, never the vault). Omit `outputDir` and the flag is absent (byte-identical to the
 * pre-output-dir spawn) — the caller (`buildMcpServers`) always supplies a dir.
 *
 * Returns null if the package can't be resolved (it's a pinned daemon dependency, so this is a
 * should-never-happen guard) — the caller then simply omits the server, leaving the spawn otherwise
 * intact rather than crashing it.
 */
let playwrightCliPathCache: string | null | undefined;
function resolvePlaywrightCli(): string | null {
  if (playwrightCliPathCache !== undefined) return playwrightCliPathCache;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@playwright/mcp/package.json");
    playwrightCliPathCache = path.join(path.dirname(pkgJson), "cli.js");
  } catch {
    playwrightCliPathCache = null;
  }
  return playwrightCliPathCache;
}

/**
 * The stdio MCP-config entry for a browserTesting session, or null if the package is unresolvable.
 * `outputDir` (when given) is wired as `--output-dir` so captures default OUTSIDE the repo working tree;
 * omitted ⇒ no flag (byte-identical to the pre-output-dir spawn).
 */
export function playwrightMcpServer(outputDir?: string): { type: "stdio"; command: string; args: string[] } | null {
  const cli = resolvePlaywrightCli();
  if (!cli) return null;
  const args = [cli, "--headless", "--isolated"];
  if (outputDir) args.push("--output-dir", outputDir);
  return { type: "stdio", command: process.execPath, args };
}

/**
 * Resolve the Microsoft markitdown MCP (`markitdown-mcp`) console script to an ABSOLUTE path, for the
 * per-session document-conversion server injected ONLY for a documentConversion session (opt-in, gated).
 *
 * markitdown is a PYTHON tool, NOT a node_modules dependency, so it can't be resolved off `require`. Loom
 * owns ONE shared Python venv under `<LOOM_HOME>/python/venv` and pip-installs markitdown into it.
 *
 * EVENT-LOOP SAFETY (the load-bearing rule): this runs on the SYNCHRONOUS spawn hot path (`createPty` →
 * `buildMcpServers`), so it must do NO blocking work. Creating the venv + `pip install markitdown[all]`
 * takes minutes — running that via `spawnSync` here would FREEZE the whole daemon (every spawn/resume, the
 * web UI, all HTTP/MCP) for the entire install. So the hot path is fast + sync-safe only:
 *   (a) a HUMAN-only override via `LOOM_MARKITDOWN_BIN` — host-set, NEVER an agent MCP parameter (identical
 *       trust posture + mechanism to `LOOM_CLAUDE_BIN`). Resolved through `resolveExecutable` (fast, no
 *       child process); it's the TEST seam too (a fake binary, so CI never builds a venv). Checked FIRST.
 *   (b) else a single `fs.existsSync(loomVenvBin('markitdown-mcp'))` (instant): if the venv binary is
 *       present → inject it; if NOT → return null (this spawn skips the MCP, exactly like Playwright's
 *       missing-cli fallback) AND kick BACKGROUND provisioning ({@link kickMarkitdownProvision}) so the
 *       venv warms up off the event loop. A later spawn picks it up once the async job lands the binary.
 *
 * CACHE: memoize ONLY a resolved absolute path (success) — never memoize `null`, or a pre-warm skip would
 * stick forever. The not-ready case re-checks `fs.existsSync` cheaply on every spawn until it flips ready.
 */
let markitdownBin: string | undefined; // success memo (stable once resolved); never holds null
/**
 * Mark a WARM-resolved binary as `ready` in the status model — for the two warm branches that resolve the
 * tool WITHOUT a kick (the `LOOM_MARKITDOWN_BIN` override, and a venv binary already present on disk, e.g. a
 * manually-built venv or one boot-pre-warm found already there). Without this the status would sit at `idle`
 * even though document conversion fully works, so GET /api/python/provisioning (the UI card) would falsely
 * read "not ready". Cheap + sync (a plain object assignment) — safe on the hot path, no I/O.
 */
function markMarkitdownReady(bin: string): void {
  markitdownBin = bin;
  markitdownProvisionStatus = { state: "ready", binary: bin, lastAttemptAt: Date.now() };
}
/**
 * Apply a TERMINAL `failed` provisioning outcome — but NEVER downgrade an already-`ready` status. `ready` is a
 * positive terminal that means the venv binary genuinely exists on disk (set by this job's own success, or by a
 * CONCURRENT documentConversion spawn that found the binary already present and called {@link markMarkitdownReady}).
 * A STALE in-flight job that resolves `failed` AFTER such a `ready` must NOT flip the status back to failed — the
 * binary is there and conversion actually works; only GET /api/python/provisioning reads the state, and it must
 * not falsely show "not ready". Returns true when the failure was applied, false when a prior `ready` superseded
 * this (stale) job — so the caller can log honestly. All other transitions (idle/installing → failed) are intact.
 */
function applyMarkitdownFailure(reason: ProvisionOutcome, errorTail: string | undefined, lastAttemptAt: number): boolean {
  if (markitdownProvisionStatus.state === "ready") return false;
  markitdownProvisionStatus = { state: "failed", reason, errorTail, lastAttemptAt };
  return true;
}
function resolveMarkitdownBin(pythonInterpreterPath?: string): string | null {
  if (markitdownBin) return markitdownBin;
  const override = process.env.LOOM_MARKITDOWN_BIN;
  if (override) {
    const resolved = resolveExecutable(override);
    if (path.isAbsolute(resolved)) { markMarkitdownReady(resolved); return resolved; }
    return null; // human pointed the override somewhere unresolvable — respect it, don't auto-provision
  }
  const bin = loomVenvBin("markitdown-mcp");
  if (fs.existsSync(bin)) { markMarkitdownReady(bin); return bin; } // venv warm → use it (cache + status ready)
  kickMarkitdownProvision(pythonInterpreterPath); // cold → provision in the BACKGROUND; skip this spawn
  return null;
}

/**
 * Bound (ms) for the markitdown `pip install`. Much larger than the default pip bound because `markitdown[all]`
 * is a HEAVY first install — it pulls onnxruntime + a long tail of format converters, which on a real/corporate
 * network (or behind a slow proxy) routinely exceeds a few minutes. The old 3-min default killed the download
 * mid-flight and mislabeled it a generic failure. ~15 min gives the heavy first install room while still being
 * KILLED-on-exceed (classified `timeout`), never unbounded. The venv-create/probe bounds stay as-is (fast).
 */
const MARKITDOWN_PIP_TIMEOUT_MS = 900_000;

/**
 * Live markitdown provisioning status — the model the REST/UI layer reads ({@link getMarkitdownProvisionStatus}).
 *   - `idle`       — never attempted (or reset);
 *   - `installing` — a background kick is IN-FLIGHT;
 *   - `ready`      — the venv binary resolved (`binary` set);
 *   - `failed`     — a terminal failure (`reason` = the classified {@link ProvisionOutcome}; `errorTail` = the
 *                    captured stdout/stderr tail when one was produced).
 * `lastAttemptAt` is the epoch-ms of the most recent kick. A failure is NOT sticky — it's retryable (see
 * {@link kickMarkitdownProvision}) — so the UI can show the reason + offer a retry.
 */
export type MarkitdownProvisionState = "idle" | "installing" | "ready" | "failed";
export interface MarkitdownProvisionStatus {
  state: MarkitdownProvisionState;
  reason?: ProvisionOutcome;
  errorTail?: string;
  binary?: string;
  lastAttemptAt?: number;
}
let markitdownProvisionStatus: MarkitdownProvisionStatus = { state: "idle" };

/** A COPY of the live markitdown provisioning status, for the human-only REST surface. Never the live object. */
export function getMarkitdownProvisionStatus(): MarkitdownProvisionStatus {
  return { ...markitdownProvisionStatus };
}

/**
 * The provisioner the kick calls — `ensurePythonPackageAsync` in production, swappable in a hermetic test via
 * {@link __setMarkitdownProvisionerForTest} so the failure-classification / retry / status-transition tests can
 * drive every outcome WITHOUT building a real venv or hitting the network.
 */
type MarkitdownProvisioner = (opts: EnsurePythonPackageOpts) => Promise<EnsurePythonResult>;
let markitdownProvisioner: MarkitdownProvisioner = ensurePythonPackageAsync;

/**
 * Kick BACKGROUND provisioning of the shared venv's markitdown (async `child_process.spawn` under the hood
 * — NEVER `spawnSync`), so the heavy venv-create + pip install runs OFF the event loop.
 *
 * RETRYABLE, not a permanent one-shot: the dedupe guard is ONLY a genuinely IN-FLIGHT install
 * (`markitdownProvisionInFlight`), so concurrent documentConversion spawns never launch parallel pip installs —
 * but after a TERMINAL outcome (ready/failed) the in-flight clears and a fresh kick is allowed. So a
 * profile-save pre-warm, a later spawn, or an explicit `POST /api/python/provisioning/retry` all actually
 * retry (the old PERMANENT `markitdownProvisionTried` flag dead-ended every retry until a daemon restart — the
 * defect this fixes).
 *
 * On success it lands the resolved binary into the `markitdownBin` memo (subsequent spawns inject it) and the
 * status → `ready`; on failure it warn-logs the SPECIFIC classified reason + captured tail and the status →
 * `failed` (documentConversion sessions keep spawning WITHOUT the MCP, best-effort), retryable as above.
 */
let markitdownProvisionInFlight: Promise<void> | null = null;
let markitdownProvisionKicks = 0; // test observability (see __markitdownProvisionKicks)
function kickMarkitdownProvision(pythonInterpreterPath?: string): void {
  if (markitdownProvisionInFlight) return; // dedupe ONLY an in-flight install (retryable after a terminal outcome)
  markitdownProvisionKicks++;
  const attemptAt = Date.now();
  markitdownProvisionStatus = { state: "installing", lastAttemptAt: attemptAt };
  // eslint-disable-next-line no-console
  console.warn("[pty] markitdown venv not ready — provisioning in the BACKGROUND; documentConversion spawns skip the MCP until it's warm.");
  markitdownProvisionInFlight = markitdownProvisioner({
    // markitdown-mcp is the MCP server / console script; markitdown[all] pulls the full
    // PDF/Office/image converters into the SAME shared venv.
    package: ["markitdown-mcp", "markitdown[all]"],
    binary: "markitdown-mcp",
    probeImport: "markitdown_mcp",
    timeoutMs: MARKITDOWN_PIP_TIMEOUT_MS,
    interpreterOverride: pythonInterpreterPath,
  })
    .then((res) => {
      if (res.outcome === "ready" && res.binary) {
        markitdownBin = res.binary;
        markitdownProvisionStatus = { state: "ready", binary: res.binary, lastAttemptAt: attemptAt };
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown venv ready (${res.binary}) — documentConversion sessions now spawn with the MCP.`);
      } else if (applyMarkitdownFailure(res.outcome, res.errorTail, attemptAt)) {
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown background provisioning FAILED (${res.outcome}) — documentConversion sessions spawn WITHOUT the markitdown MCP. Retryable: re-save the profile or POST /api/python/provisioning/retry (no daemon restart needed).${res.errorTail ? `\n  captured output tail:\n${res.errorTail}` : ""}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown background provisioning resolved ${res.outcome}, but the venv binary is already present (a concurrent spawn proved it on disk) — status stays 'ready'; this stale job did NOT downgrade it.`);
      }
    })
    .catch(() => {
      // ensurePythonPackageAsync never throws; belt-and-suspenders for an injected test provisioner that might.
      applyMarkitdownFailure("pip-failed", undefined, attemptAt);
    })
    .finally(() => { markitdownProvisionInFlight = null; });
}

/** TEST-ONLY: how many times background markitdown provisioning has been kicked this process. */
export function __markitdownProvisionKicks(): number {
  return markitdownProvisionKicks;
}

/**
 * TEST-ONLY: deterministically await the CURRENT in-flight markitdown provision kick's real completion
 * (or resolve immediately if nothing is in flight) — DETERMINISTIC SETTLEMENT for a hermetic test to use
 * instead of guessing a sleep length (card 1addef27). Never throws: `markitdownProvisionInFlight` itself
 * never rejects (see its own `.catch` above), so this is belt-and-suspenders for an injected test
 * provisioner that might.
 */
export async function __markitdownProvisionSettle(): Promise<void> {
  if (markitdownProvisionInFlight) { try { await markitdownProvisionInFlight; } catch { /* best-effort */ } }
}

/**
 * TEST-ONLY: swap the provisioner the kick calls (pass nothing/undefined to restore the real
 * `ensurePythonPackageAsync`) and reset provisioning module state back to idle (status, the success memo, the
 * kick counter, any in-flight handle). Lets a hermetic test drive every classified outcome + the retry/dedupe
 * semantics with NO real venv or network.
 */
export function __setMarkitdownProvisionerForTest(fn?: MarkitdownProvisioner): void {
  markitdownProvisioner = fn ?? ensurePythonPackageAsync;
  markitdownProvisionInFlight = null;
  markitdownProvisionStatus = { state: "idle" };
  markitdownBin = undefined;
  markitdownProvisionKicks = 0;
}

/**
 * Pre-warm the shared markitdown venv AHEAD of the first documentConversion session — called OFF the spawn
 * hot path (at daemon boot if any profile opts in, and when a profile is SAVED with documentConversion=true,
 * see `python/prewarm.ts`). This closes the provision-on-first-spawn cold-skip window: today the FIRST
 * documentConversion session kicks provisioning and spawns WITHOUT the MCP, and only a LATER spawn picks the
 * tool up once the venv warms (~1.5 min). Pre-warming earlier means the venv is usually warm by the first
 * spawn.
 *
 * Pure delegation to {@link resolveMarkitdownBin} — it REUSES the SAME gating (the `LOOM_MARKITDOWN_BIN`
 * override + the venv-already-warm short-circuits, both of which simply return without kicking) and the SAME
 * in-flight-deduped, RETRYABLE {@link kickMarkitdownProvision} the spawn path uses. So a pre-warm never
 * launches a parallel install (an in-flight job suppresses it), never blocks (the heavy venv-create + pip runs
 * in the EXISTING async background job — best-effort, off the event loop), and — because the guard is no longer
 * a permanent one-shot — a pre-warm AFTER a prior failed attempt actually RE-kicks (so re-saving the profile
 * retries). The resolved path is discarded; the POINT is the background-kick side effect.
 */
export function prewarmMarkitdown(pythonInterpreterPath?: string): void {
  resolveMarkitdownBin(pythonInterpreterPath);
}

/**
 * The stdio MCP-config entry for a documentConversion session, or null if markitdown can't be resolved
 * (no base Python / venv or pip failure). `markitdown-mcp` speaks STDIO by default and needs NO args (the
 * one tool, `convert_to_markdown(uri)`, accepts file:/http(s):/data: URIs) — the args difference from
 * Playwright. `pythonInterpreterPath` is the HUMAN-only `python.interpreterPath` (carried via session env).
 */
export function markitdownMcpServer(pythonInterpreterPath?: string): { type: "stdio"; command: string; args: string[] } | null {
  const bin = resolveMarkitdownBin(pythonInterpreterPath);
  if (!bin) return null;
  return { type: "stdio", command: bin, args: [] };
}

/**
 * Card 088afc94 (P4 wiring) — the streamable-HTTP MCP-config entry for a codescape-enabled session,
 * pointed at the SHARED `codescape serve` process (`/mcp/<codescapeId>` for a manager, or
 * `/mcp/<codescapeId>/<worktreeId>` for a worker tied to a task — codescape confirmed this route is the
 * STABLE long-term interface: it serves the project's main graph today and will serve worktree-adjusted
 * overlay content through this SAME URL once that ships, so this is not a placeholder to "simplify" back
 * to the bare route later). Returns `null` — a CLEAN SKIP, never a stale/absent fallback (Platform Lead
 * ruling on this card: silent staleness was the ORIGINAL defect, and a stdio-snapshot fallback would
 * silently reproduce exactly that) — when `port` is null (serve isn't up: disabled, never started, mid-
 * restart, or gave up) or when `resolveProjectId` can't resolve an id for `repoPath` (never registered).
 * `resolveProjectId` should be the SAME supervisor instance's `resolveProjectId` (its own boot-
 * registration cache first, falling back to the cold manifest read — see codescape/supervisor.ts) — kept
 * as an injected function (not a raw homeDir) so this stays a pure, hermetically-testable seam and so
 * every caller shares the ONE id-resolution strategy in one place.
 *
 * PRIOR-ATTEMPT NOTE: an EARLIER HTTP-mount attempt was abandoned because it scoped by Loom's own
 * project.id, which never matched codescape's OWN path-derived id — the MCP never registered, silently.
 * Resolving via `resolveProjectId` (never a reimplemented hash) is what fixes that class of bug for good.
 */
export function codescapeHttpMcpServer(opts: { repoPath: string; port: number | null; worktreeId?: string | null; resolveProjectId?: (repoPath: string) => string | null }): { type: "http"; url: string } | null {
  if (opts.port == null || !opts.resolveProjectId) return null;
  const id = opts.resolveProjectId(opts.repoPath);
  if (!id) return null;
  const scope = opts.worktreeId ? `${id}/${opts.worktreeId}` : id;
  return { type: "http", url: `http://127.0.0.1:${opts.port}/mcp/${scope}` };
}

/**
 * Assemble the `--mcp-config` mcpServers map for a Claude spawn (extracted from createPty as the ONE
 * testable seam for the MCP surface). ALWAYS the project-scoped `loom-tasks` HTTP server; PLUS the
 * role-gated surface (manager/worker → loom-orchestration, platform → loom-platform, auditor → loom-audit,
 * workspace-auditor → loom-user-audit, setup → loom-setup);
 * PLUS — one generalized capability-registry loop (agent-tooling P4) that mounts EVERY resolved
 * registry-capability grant (`resolveProfileCapabilities(o)`, bridging the legacy `browserTesting`/
 * `documentConversion` booleans + the new `capabilities` array into ONE list). The legacy
 * slugs ("browser-testing"/"document-conversion") are special-cased to their EXISTING,
 * already-hardened resolvers (`playwrightMcpServer`/`markitdownMcpServer`, untouched) so
 * this generalization is byte-identical for every caller that still passes the booleans directly (every
 * existing test + call site) — the mounted map keys stay "playwright"/"markitdown" exactly as
 * before. Any OTHER slug is an
 * owner-added catalog capability, resolved via the injected `o.capabilityCatalog` + the generic
 * node-package/python-venv/bundled dispatcher (`resolveCapabilityServer`), with its bound connection's
 * secret (if any) resolved via `o.resolveConnectionSecret` and injected ONLY into that server's own `env`
 * — never a CLI argument, never reaching the `claude` process. Fully ADDITIVE: with nothing enabled the
 * map is byte-identical to today's. Pure + deterministic (no pty, no network — `capabilityCatalog`/
 * `resolveConnectionSecret` are plain injected values, never a live db handle), so the spawn-config test
 * can assert inclusion directly, incl. via a FAKE catalog + fake secret resolver (no real DB/venv/network).
 *
 * SECURITY (P5): an "auditor" session gets ONLY loom-tasks + loom-audit — NEVER loom-platform and NEVER
 * loom-orchestration. The restricted loom-audit surface (read transcripts + file findings) is its whole
 * tool world, so a prompt-injection in an audited transcript has no outward/destructive tool to reach.
 */
export function buildMcpServers(o: {
  sessionId: string; port: number; role?: SessionRole; browserTesting?: boolean; documentConversion?: boolean;
  /** HUMAN-only `python.interpreterPath` (carried via session env) — forwarded to the markitdown venv resolver. */
  pythonInterpreterPath?: string;
  /** Agent-tooling P4: registry-capability grants BEYOND the two legacy booleans above (raw, un-bridged —
   *  see resolveProfileCapabilities). Default []. */
  capabilities?: CapabilityGrant[];
  /** Owner-added capability catalog rows (injected, never a live db handle) — looked up by slug for any
   *  grant that isn't one of the two reserved legacy slugs. Default []. */
  capabilityCatalog?: CapabilityDefRow[];
  /** Resolve a P1 connection id to its DECRYPTED secret (injected callback, never a live db handle) —
   *  consulted only for a grant whose def has `requiresConnection` AND that carries a `connectionId`.
   *  Passed THIS spawn's own `projectId` (below) so a project-scoped connection (card f2abce7e) only ever
   *  resolves for the project it's bound to — the callback fails closed on a scope mismatch. */
  resolveConnectionSecret?: (connectionId: string, projectId?: string) => string | undefined;
  /** Card C2: the project's raw `codescape.enabled` flag — see the "codescape" mount below. */
  codescapeEnabled?: boolean;
  /** Card C2: the session's project id (non-Codescape uses only, e.g. connection-secret scoping). */
  projectId?: string;
  /**
   * Card 088afc94 (P4 wiring): the project's PRIMARY repo path, `codescapeSupervisor.getPort()`, and
   * `codescapeSupervisor.resolveProjectId` (bound to that instance) — the three ingredients
   * `codescapeHttpMcpServer` needs to resolve codescape's OWN project id and build the streamable-HTTP
   * mount URL. `worktreeId` scopes a worker's mount to its own worktree route; absent for every other
   * role. See SpawnOpts's identical fields for the full doc.
   */
  repoPath?: string;
  codescapePort?: number | null;
  codescapeResolveProjectId?: (repoPath: string) => string | null;
  worktreeId?: string | null;
  /**
   * Card 8dc5ebb9: DB-persisted host-tool integration paths (`PlatformConfigOverride.integrations`) —
   * resolved PER-SPAWN (not boot-bound) via PtyHost's `getIntegrationPaths` seam, consulted ONLY for the
   * daemon-wide `isCodescapeSupervisorEnabled` gate check below (DB path wins, env var falls back). No
   * longer feeds a bin-resolution call — the per-session mount is a URL now, not a spawn.
   */
  integrationPaths?: { codescape?: string };
}): Record<string, unknown> {
  // Agent Runs R2: a `run` session gets ONLY the restricted run surface — NOT even loom-tasks. This is
  // the one path that does not mount loom-tasks (every other role layers ON TOP of it). The early return
  // keeps every non-run spawn byte-identical to today (a run is the only role that reaches this branch).
  if (o.role === "run") {
    return { "loom-run": { type: "http", url: `http://127.0.0.1:${o.port}/mcp-run/${o.sessionId}` } };
  }
  // manager/worker AND the Companion (assistant) mount loom-orchestration — but a role-gated surface:
  // the assistant gets only my_context + the companion-gated chat_reply (buildServer's assistant branch),
  // NEVER the manager spawn/stop/list tools. Additive: byte-identical map for every non-orch role.
  const wantsOrch = o.role === "manager" || o.role === "worker" || o.role === "assistant";
  const wantsPlatform = o.role === "platform";
  const wantsAudit = o.role === "auditor";
  const wantsUserAudit = o.role === "workspace-auditor";
  const wantsSetup = o.role === "setup";
  const wantsOperator = o.role === "operator";
  const mcpServers: Record<string, unknown> = {
    "loom-tasks": { type: "http", url: `http://127.0.0.1:${o.port}/mcp/${o.sessionId}` },
  };
  if (wantsOrch) {
    mcpServers["loom-orchestration"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-orch/${o.sessionId}` };
  }
  if (wantsPlatform) {
    mcpServers["loom-platform"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-platform/${o.sessionId}` };
  }
  if (wantsAudit) {
    mcpServers["loom-audit"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-audit/${o.sessionId}` };
  }
  // End-User Platform tier B3: a "workspace-auditor" session gets ONLY the curated loom-user-audit surface
  // (on top of loom-tasks) — NEVER loom-platform/orchestration/audit/setup. A tool not registered there
  // can't be reached (its whole tool world is 2 reads + 2 inert daemon-local suggest-writes).
  if (wantsUserAudit) {
    mcpServers["loom-user-audit"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-user-audit/${o.sessionId}` };
  }
  // Setup Assistant (E1-3): a "setup" session gets ONLY the curated loom-setup surface (on top of
  // loom-tasks) — NEVER loom-platform/orchestration/audit. A tool not registered there can't be reached.
  if (wantsSetup) {
    mcpServers["loom-setup"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-setup/${o.sessionId}` };
  }
  // Bucket 2b Elevated Operator: an "operator" session gets ONLY the curated loom-operator surface (on
  // top of loom-tasks) — NEVER loom-platform/orchestration/audit/setup. A tool not registered there can't
  // be reached. The router ITSELF re-checks platform.operatorEnabled LIVE (isOperatorEnabled) on every
  // request, so this mount alone is not the enforcement point — a flag flip to OFF 404s the surface even
  // though the mount entry (an inert URL) still exists in this session's already-spawned argv.
  if (wantsOperator) {
    mcpServers["loom-operator"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-operator/${o.sessionId}` };
  }
  // Agent-tooling P4: ONE generalized loop over every resolved registry-capability grant (the bridged
  // legacy booleans + the new capabilities array). byte-identical-when-none: an empty resolved list is a
  // no-op, so this whole block vanishes for a spawn with nothing enabled — exactly today's map.
  const catalog = o.capabilityCatalog ?? [];
  for (const grant of resolveProfileCapabilities(o)) {
    if (grant.slug === "browser-testing") {
      // The Playwright capability: capture output ALWAYS defaults to a repo/vault-EXTERNAL per-session
      // scratch dir, so a screenshot (or the ARIA `page-*.yml` snapshot the MCP writes by default on
      // essentially every browser tool call) taken with no explicit path can never land inside the project
      // working tree OR the user's Obsidian vault. Card 61ab62e3: an earlier revision pointed `--output-dir`
      // at the project's `vaultPath` when set, meaning every implicit browser turn wrote a `page-*.yml`
      // straight into the vault — the vault got treated as a dumping ground, not just a deliberate
      // milestone-shot target. Always scratch closes that; the trade-off (documented on
      // `playwrightMcpServer` above) is that an agent can no longer target an explicit absolute vault path
      // either, since `@playwright/mcp`'s `checkFile` guard only allows a write inside `outputDir` or the
      // subprocess's inherited cwd — a session that wants a capture preserved as a project artifact should
      // land it in scratch and have it copied into the vault explicitly, not written there directly. A null
      // (unresolvable package) is logged + skipped rather than crashing the spawn.
      const pw = playwrightMcpServer(sessionScratchDir(o.sessionId));
      if (pw) {
        mcpServers["playwright"] = pw;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} browserTesting set but @playwright/mcp could not be resolved — spawning WITHOUT a browser MCP. Is the daemon dependency installed?`);
      }
      continue;
    }
    if (grant.slug === "document-conversion") {
      // The legacy markitdown capability, UNCHANGED resolution: fast + sync-safe (fs.existsSync on the
      // hot path); a null means the shared venv isn't warm yet — it has kicked BACKGROUND provisioning,
      // so THIS spawn just skips the MCP (logged, never crashes), and a later spawn picks it up once the
      // venv lands. The one-time host setup is just a base Python ≥3.10 (PATH or python.interpreterPath).
      const md = markitdownMcpServer(o.pythonInterpreterPath);
      if (md) {
        mcpServers["markitdown"] = md;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} documentConversion set but the markitdown venv isn't warm yet — spawning WITHOUT the document MCP (provisioning in the background; a later spawn will pick it up). Needs a base Python >=3.10 on PATH (or python.interpreterPath).`);
      }
      continue;
    }
    // An owner-added catalog capability: look it up in the injected catalog, resolve its bound
    // connection's secret (if it requiresConnection and a connectionId was granted), and dispatch
    // through the generic node-package/python-venv/bundled resolver. Unknown slug / unresolvable
    // provisioning ⇒ log-and-skip, exactly like the two legacy capabilities above — never crashes the spawn.
    // P4↔P5a: if the bound connection is `oauth2`, `resolveConnectionSecret` resolves to undefined by
    // design (see connections/store.ts getSecretForUse) — this spawn mounts the server with NO env
    // injected, correctly fail-closed. That binding is rejected earlier, at profile-save time
    // (profiles/validate.ts › capabilityGrantBindingError), so reaching a spawn with one bound here would
    // mean an already-existing profile predates the guard — still handled safely, just silently.
    const def = catalog.find((c) => c.slug === grant.slug);
    if (!def) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} capability '${grant.slug}' is enabled but not found in the catalog — spawning without it.`);
      continue;
    }
    const connectionSecret = def.requiresConnection && grant.connectionId ? o.resolveConnectionSecret?.(grant.connectionId, o.projectId) : undefined;
    const server = resolveCapabilityServer(def, {
      scratchDir: def.wantsScratchDir ? sessionScratchDir(o.sessionId) : undefined,
      connectionSecret,
      pythonInterpreterPath: o.pythonInterpreterPath,
    });
    if (server) {
      mcpServers[def.slug] = server;
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} capability '${grant.slug}' could not be resolved — spawning without it (provisioning may be in progress in the background).`);
    }
  }
  // Card C2 (Codescape wiring epic `369dde3c`), P4 REWRITE (card 088afc94): a per-PROJECT opt-in (NOT a
  // profile capability grant, hence outside the resolveProfileCapabilities loop above). `o.codescapeEnabled`
  // is the RAW project flag — isLoomDev() is re-checked HERE (not pre-baked by the caller) so this pure
  // seam can assert the LOOM_DEV-off negative case directly.
  //
  // GATE ORDERING IS LOAD-BEARING (card 3e429d83) — keep the cheap checks (`o.codescapeEnabled`,
  // `isLoomDev()`) first; don't reorder or hoist them behind `isCodescapeSupervisorEnabled`.
  // `isCodescapeSupervisorEnabled` bottoms out in `resolveExecutable`, a SYNCHRONOUS walk of every PATH
  // dir × PATHEXT extension (measured ~17-20ms on a real Windows PATH) — exactly the kind of blocking
  // work the spawn hot path (`createPty` → `buildMcpServers`) must never do (see CLAUDE.md's "no blocking
  // work on the hot path" invariant).
  //
  // TWO INDEPENDENT LAYERS keep that walk off the hot path for a normal spawn, not one: this outer
  // ordering, AND `isCodescapeSupervisorEnabled` itself re-checking `isLoomDev()` before touching the
  // filesystem (paths.ts). A regression has to defeat BOTH to actually reach `resolveExecutable`.
  //
  // test/pty-hot-path-no-path-walk.mjs guards the INVARIANT — "no PATH walk on the hot path for a normal
  // spawn" — not this specific ordering: it reddens on anything that actually causes the walk (e.g.
  // removing/inlining `isCodescapeSupervisorEnabled`'s own `isLoomDev()` short-circuit, confirmed by
  // fail-first testing), but it will NOT catch a reorder of just this outer gate — the inner short-circuit
  // still prevents the walk, so that alone is harmless and the test correctly stays green. Keep this
  // ordering as defense-in-depth anyway; just don't read the test's silence on a reorder as proof nothing
  // changed.
  //
  // P4: the per-session mount is now a streamable-HTTP entry pointed at the SHARED `codescape serve`
  // process (`codescapeHttpMcpServer`) — no per-session spawn at all. This SUPERSEDES the C2/C3-era
  // per-session stdio `codescape mcp --graph <graph.json>` process (which read a Loom-maintained snapshot
  // file); that mechanism is gone. `isCodescapeSupervisorEnabled(dbPath)` (isLoomDev() AND a codescape CLI
  // actually detected on the host) stays the daemon-wide master switch for the whole Codescape feature.
  // `o.integrationPaths?.codescape` (the DB-persisted path) is passed through so THIS gate check honors
  // the same DB-first precedence the supervisor's own detection uses — a daemon with the DB path set but
  // no LOOM_CODESCAPE_BIN/bare-PATH binary still detects correctly. Ruling (card 088afc94): when serve
  // isn't up (`codescapePort` null) or `resolveCodescapeProjectId` can't resolve an id for this repo,
  // this CLEAN-SKIPS — no stdio-snapshot fallback — a silent stale/absent mount masquerading as fresh is
  // the exact defect this card exists to fix, and a permanent second code path is exactly the "weaker
  // architecture" avoided by not duplicating codescape's own server-side staleness/single-flight machinery.
  if (o.codescapeEnabled && o.repoPath) {
    if (isLoomDev()) {
      if (isCodescapeSupervisorEnabled(o.integrationPaths?.codescape)) {
        const cs = codescapeHttpMcpServer({ repoPath: o.repoPath, port: o.codescapePort ?? null, worktreeId: o.worktreeId, resolveProjectId: o.codescapeResolveProjectId });
        if (cs) {
          mcpServers["codescape"] = cs;
        } else if (o.codescapePort == null) {
          // CR fix: split from the id-unresolved case below — both facts (port vs id) are already in hand
          // here, and `codescapeHttpMcpServer` checks port BEFORE id (see its own body), so a null `cs`
          // with a null port can ONLY be the serve-is-down case. The whole design premise of a clean skip
          // is that it's distinguishable from a silent failure — a merged message defeats that for anyone
          // reading the log, since "serve down" (self-heals once serve restarts) and "id unresolved"
          // (self-heals once this repo is registered/ingested) point at different fixes.
          // eslint-disable-next-line no-console
          console.warn(`[pty] ${o.sessionId} codescape enabled but serve isn't up (port unresolved) for repo ${o.repoPath} — spawning WITHOUT the Codescape MCP. A later spawn will pick it up once serve is back.`);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[pty] ${o.sessionId} codescape enabled but codescape has no id resolvable for repo ${o.repoPath} (not yet registered/ingested?) — spawning WITHOUT the Codescape MCP. A later spawn will pick it up once ready.`);
        }
      }
      // else: no codescape CLI detected on this host — the benign "feature not present" case; no per-spawn warning.
    }
    // !isLoomDev(): silent skip — the "missing" reason is the gate itself.
  }
  return mcpServers;
}

/**
 * Card C2: the `--allowedTools` contribution for a mounted Codescape MCP entry — ONLY the 7 read tools
 * (list_flows/trace_flow/what_touches/describe_symbol/render_tree/boundary_map/scenario_space), NEVER the
 * 5 control/write tools (focus_flow/highlight/open_view/annotate/show_diff). Read-only "agent orients
 * itself" integration (Q4). Named per-tool, not the whole `mcp__codescape`
 * server prefix, so the write surface stays unreachable even though the server itself exposes it.
 */
export const CODESCAPE_TOOL_ALLOW: readonly string[] = [
  "mcp__codescape__list_flows",
  "mcp__codescape__trace_flow",
  "mcp__codescape__what_touches",
  "mcp__codescape__describe_symbol",
  "mcp__codescape__render_tree",
  "mcp__codescape__boundary_map",
  "mcp__codescape__scenario_space",
];

/**
 * Card C2 hardening (post-hoc CR blocker): the 5 control/write Codescape tools — NEVER allowlisted (see
 * {@link CODESCAPE_TOOL_ALLOW}), but the mounted `codescape` MCP entry still ADVERTISES all 12 to the
 * model regardless. Under `--permission-mode acceptEdits`, a tool that's mounted but not allowlisted is
 * NOT auto-approved — it PROMPTS. A Loom-driven role (worker/setup/auditor/workspace-auditor, stdin owned
 * by its manager, `AskUserQuestion` disallowed) can never answer that prompt, so a stray call wedges the
 * turn until the busy-stuck watchdog fires. These names are unioned into `--disallowedTools` (see
 * {@link disallowedToolsForSpawn}) whenever the codescape MCP is actually mounted, so the write surface is
 * structurally unreachable rather than merely un-allowlisted.
 */
export const CODESCAPE_WRITE_TOOLS: readonly string[] = [
  "mcp__codescape__focus_flow",
  "mcp__codescape__highlight",
  "mcp__codescape__open_view",
  "mcp__codescape__annotate",
  "mcp__codescape__show_diff",
];

/**
 * Security hardening (card 7159466a): `browserTesting`'s `--allowedTools` grant is the WHOLE
 * `mcp__playwright` server (a wildcard — see {@link capabilityToolAllowlist}'s "browser-testing" slug and
 * the direct browserTesting allow at the createPty chokepoint), which includes `browser_run_code_unsafe` —
 * @playwright/mcp's own README calls it "RCE-equivalent" (executes arbitrary JS in the Playwright server
 * process). No legitimate browser-testing workflow needs it (`browser_evaluate` covers in-page JS), and
 * nothing caps it once the wildcard is granted — including a human enabling `browserTesting` on the
 * untrusted-chat-facing companion (assistant) profile. This name is unioned into `--disallowedTools` (see
 * {@link disallowedToolsForSpawn}) whenever the Playwright MCP is actually mounted, so `--disallowedTools`
 * overrides the wildcard `--allowedTools` grant and the tool is structurally unreachable rather than merely
 * un-allowlisted (verified empirically via a real spawn — see the spawn-args test).
 */
export const PLAYWRIGHT_DISALLOWED_TOOLS: readonly string[] = [
  "mcp__playwright__browser_run_code_unsafe",
];

/**
 * Security hardening (card f1609e1a, a residual the Code Reviewer surfaced OUTSIDE card 7159466a's
 * RCE scope): beyond `browser_run_code_unsafe`, `@playwright/mcp`'s default tool set also mounts two
 * tools that take ABSOLUTE HOST FILE PATHS and read them into a page — verified against the installed
 * `@playwright/mcp` README (`browser_file_upload`'s and `browser_drop`'s `paths` params) —
 * `browser_file_upload` and `browser_drop`. (`browser_drag` was checked and excluded: it takes only
 * page-snapshot element refs, no host path.) Combined with `browser_navigate` to an attacker-controlled
 * page, that's a host-secret EXFILTRATION primitive (read `~/.ssh/id_rsa` / `.env`, POST from a
 * cooperating page) — NOT RCE, but the same threat model as PLAYWRIGHT_DISALLOWED_TOOLS: a human
 * enabling `browserTesting` on the untrusted-chat-facing companion (`assistant`) profile.
 *
 * UNLIKE `browser_run_code_unsafe` (which no legitimate workflow needs and is disallowed for EVERY
 * role), these two ARE legitimately needed for upload/drag-drop testing on the worker rigs (QA Tester /
 * Web Designer) — so this set is ROLE-SCOPED: {@link disallowedToolsForSpawn} unions it in ONLY when
 * `role === "assistant"` AND the Playwright MCP is mounted, leaving worker/manager/other roles
 * byte-identical (they keep file_upload/drop). Same posture as `RESTRICTED_NATIVE_TOOLS` — blast-radius
 * control scoped to the chat-reachable companion, not a blanket restriction.
 */
export const ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS: readonly string[] = [
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_drop",
];

/**
 * The `--allowedTools` contribution from every resolved capability grant (agent-tooling P4) — the
 * `createPty` allow-list analog of `buildMcpServers`' mount loop. The two legacy slugs keep their exact
 * hardcoded allow entries; an owner-added capability contributes its own `toolAllowlist` from the catalog.
 * NEVER throws: an unknown slug or malformed `toolAllowlistJson` degrades to "no extra allow for THIS one
 * capability" (buildMcpServers separately log-and-skips its MCP mount) — never crashes the whole spawn.
 * Pure + exported so the hermetic test can assert the malformed-JSON degradation with no real spawn.
 */
export function capabilityToolAllowlist(grants: CapabilityGrant[], catalog: CapabilityDefRow[]): string[] {
  return grants.flatMap((grant) => {
    if (grant.slug === "browser-testing") return ["mcp__playwright"];
    if (grant.slug === "document-conversion") return ["mcp__markitdown__convert_to_markdown"];
    const def = catalog.find((c) => c.slug === grant.slug);
    if (!def) return [];
    try { return JSON.parse(def.toolAllowlistJson) as string[]; } catch { return []; }
  });
}

interface Subscriber {
  onData: (b: Buffer) => void;
  onControl: (e: TerminalControl) => void;
}

/**
 * One entry in a session's busy-gated inbound FIFO. The `id` is a stable, server-minted handle (set
 * at enqueue) so the human-facing UI can delete / edit / reorder a SPECIFIC queued entry: the FIFO
 * head drains autonomously between the UI's poll and a click, so addressing by array index would hit
 * the wrong (shifted) entry — an id op instead targets exactly one message and is a safe no-op once
 * that message has drained. Internal to the host; the queue is in-memory and dies with the pty.
 *
 * `source` records who enqueued it: 'human' (only the REST composer, POST /input) or 'system'
 * (everything programmatic — worker reports, idle/context/busy nudges, resume notes, escalations).
 * It is the trust boundary the human-facing mutators enforce: delete/edit/reorder may only touch a
 * 'human' entry, so an agent's queued report can never be rewritten or reordered out from under it.
 *
 * `onDeliver` is an OPTIONAL, additive delivery callback (card 2ca18433): set ONLY by SessionService's
 * durable-message helpers, it fires the instant this held entry is actually HANDED to the recipient — at
 * the next Stop drain (drainPending) or via inbox_pull (consumePending) — so the durable queued-message
 * event can be marked delivered. It is NEVER invoked on the immediate idle-submit path (that returns
 * delivered:true synchronously and persists nothing), so the load-bearing M1/M2 busy-gate ordering is
 * untouched; for every existing (non-messaging) entry it is undefined → a no-op. Internal to the host
 * (stripped from getPendingEntries, never persisted), the callback dies with the pty like the queue.
 *
 * It takes an OPTIONAL `reason`: the drain/pull paths call it with NO arg (a plain delivery), while a
 * caller that RETIRES a held entry rather than delivering it — `flushPending`'s consumer (worker_redirect)
 * — passes a reason ("superseded") so the resolution event records WHY. Back-compatible: every existing
 * no-arg call leaves reason undefined (unchanged behaviour).
 */
export type QueueSource = "human" | "system";
/**
 * An originating chat ROUTE pinned to a turn (Loom Companion multi-channel reply routing). An ALIAS of
 * `@loom/shared`'s canonical `CompanionRoute` — importing FROM shared, never from the companion layer, so
 * the pty host takes NO dependency on the companion module (it's a lower-level primitive shared by ALL
 * sessions). Optional on QueuedMessage: a message with NO route is a plain non-companion turn (every
 * existing caller ⇒ undefined ⇒ byte-identical). The route also KEYS drainPending's coalescing so
 * cross-route messages never merge into one turn (see drainPending).
 */
export type TurnRoute = CompanionRoute;
/**
 * Coalescing classification (owner-directed, 2026-07-03): `"warning"` = a Loom operational nudge
 * (idle/context/busy-stuck watchdogs, restart/boot continuation notes, rate-limit/usage nudges,
 * memory-recall injection) — always safe to concatenate with its neighbors into one turn. `"agent"` =
 * a message AUTHORED by an agent or a human TO the recipient (a Lead's `session_message`, a human
 * composer turn, a worker→manager report, a manager→worker direction/redirect, a companion inbound or
 * proactive reminder/heartbeat) — drained ALONE, one-per-turn, UNLESS `coalesceAgentMessages` is on
 * (see drainPending). Defaults to `"warning"` at the `enqueueStdin` call boundary so every pre-existing
 * caller that predates this classification (tests, and any call site this change didn't touch) keeps
 * the old full-coalesce behavior byte-identical; every real production call site is classified
 * explicitly (see host.ts's callers). Bias for anything genuinely ambiguous: `"agent"` — the harm this
 * classification exists to prevent is coalescing agent messages, so a warning wrongly delivered
 * one-per-turn is merely a few extra benign turns.
 */
export type QueuedMessageKind = "warning" | "agent";
/**
 * `questionId` OPTIONALLY tags a queued entry as a decision-inbox answer-push-nudge (card bbc46336
 * follow-up) for the question it announces. Only the answer route sets it; every other caller leaves it
 * undefined. It exists solely so `purgeQueuedByQuestionIds` can find and drop a nudge that's gone stale —
 * `question_pull` consumes ALL of a session's answered questions atomically, so a batch of N answers
 * produces N queued nudges but only the FIRST pull is productive; the rest would otherwise drain as
 * separate turns and each find nothing left to pull.
 */
/**
 * `giveUpRequeues` (card 441499ee) OPTIONALLY counts how many times THIS EXACT message has already been
 * put back on `live.pending` after a submit give-up (see `fireEnterAndVerify`'s GIVE-UP RECOVERY branch
 * and `GIVE_UP_REQUEUE_LIMIT`) — undefined/0 for every message that has never given up. Identity-scoped
 * to the message object itself (never inferred from matching text), so two legitimately identical
 * messages are counted independently and a message that keeps giving up can't requeue forever.
 *
 * `giveUpGen` (card 441499ee, hardening against a false-negative give-up) tags a requeued entry with the
 * `submitGeneration` its ORIGINAL (failed) submit ran under. The give-up discriminator can itself be
 * wrong — a confirming hook can arrive AFTER give-up already fired, proving the original turn actually
 * started (see `purgeConfirmedGiveUpRequeue`) — so this is the correlation a late confirmation uses to
 * find and purge the now-redundant requeued copy before it can ever drain and double-deliver the same
 * text. undefined for every entry that was never requeued.
 *
 * `giveUpHeldUntil` (card 73d5c34a) is the epoch-ms deadline before which this SAME requeued entry is
 * ineligible for `drainPending` — see `isGiveUpHeld`/`GIVE_UP_HOLD_MS`. Stamped alongside `giveUpGen` in
 * `requeueGiveUpOrigin`, never elsewhere; undefined for every entry that was never requeued (so a normal
 * message's drain eligibility is untouched — `isGiveUpHeld` is false whenever this is undefined).
 *
 * `onGiveUpExhausted` (card ccb407eb) is the SAME shape of hook `onDeliver` is — a caller-supplied closure
 * PtyHost invokes and otherwise knows nothing about — but fired on the OPPOSITE outcome: `requeueGiveUpOrigin`
 * calls it instead of silently discarding a message whose `giveUpRequeues` has exceeded
 * `GIVE_UP_REQUEUE_LIMIT`. Deliberately NOT reusing `onDeliver` for this: `onDeliver` fires (and, via
 * `enqueueDurableMessage`'s wiring, marks the durable record "delivered") the instant a held message is
 * HANDED to the recipient — see `resolveQueuedMessage`'s doc — which for a message that ends up giving up
 * has usually ALREADY fired by the time exhaustion is detected; a second call is just an idempotent no-op,
 * not a channel this branch can repurpose. `onGiveUpExhausted` is PtyHost's only hook for "this message's
 * final in-session attempt failed and its budget is spent" — everything upstream of that (re-mint a fresh
 * dispatch, or park it and tell the sender) is sessions/service.ts's `enqueueDurableMessage` /
 * `handleGiveUpExhausted`'s concern, not PtyHost's; PtyHost stays DB-agnostic exactly as it already is for
 * every other durability guarantee. undefined for every entry that never had one wired (every existing
 * caller, and any `enqueueStdin` caller that doesn't need durability) — a strict no-op, never invoked.
 */
/**
 * `logicalId` (card 4a0af485) is the STABLE identity of the logical content this entry carries, unified
 * across two id spaces that used to be separate: PtyHost's own per-enqueue `id` (above — regenerated on
 * every enqueue, including a remint) and sessions/service.ts's cross-remint `rootMsgId` (which already
 * survives a remint, but PtyHost never saw it). `enqueueStdin` defaults `logicalId` to the entry's own
 * freshly-minted `id` when a caller doesn't supply one — every existing caller (that never plumbs a
 * logicalId) still gets a valid, unique-to-itself value, so this is fully additive. `enqueueDurableMessage`
 * (sessions/service.ts) is the one caller that supplies its OWN `rootMsgId` here instead, so a value that
 * survives across an automatic re-mint OR an auto-joined manual resend (see `hasAmbiguousMatch`) is the
 * SAME value PtyHost tracks in `Live.ambiguousDispatches` — this is what lets a late confirmation purge a
 * duplicate copy that arrived via a completely different dispatch (a remint, or a manager's own resend),
 * not just a same-generation retry.
 */
/**
 * `mintedAtGen` (card 4af5aefa) — the value of `Live.submitGeneration` at the moment THIS entry was
 * minted, set ONLY by the paste-recovery re-injection (`host.ts`'s Stop-hook tripwire call site). Never
 * used to suppress or reorder anything (that would recreate this card's own defect one level up —
 * acting on a proxy for engine visibility rather than what's actually observable). Its ONLY consumer is
 * `annotatePasteRecoveryAge`, which compares it against the generation count at ACTUAL WRITE time to
 * disclose a fact we genuinely know (how many turns ran since this was queued) — never touched by any
 * other caller, so every existing enqueue stays byte-identical.
 *
 * `submitGeneration` is a PER-SESSION counter that starts at 0 for every fresh `Live` (a `worker_recycle`
 * successor, or a session resumed after a `daemon_restart`) — so `mintedAtGen`, a value from a
 * DIFFERENT session's counter, is MEANINGLESS once that boundary is crossed: comparing a predecessor's
 * gen 47 against a successor's gen 0 doesn't mean "47 generations ago", it silently means nothing
 * (`annotatePasteRecoveryAge`'s own `currentGen <= mintedAtGen` guard reads that as "nothing to
 * disclose yet" and stays quiet — the exact silent-degrade card `1c47454b` names). Every caller that
 * carries a `QueuedMessage` across such a boundary (`SessionService.carryPendingToSuccessor`, the
 * `daemon_restart` replay in `resumeFleetOnBoot`) MUST NOT thread `mintedAtGen` through to the far side
 * — see `mintedAtWallClock` below for the field that actually survives a boundary honestly.
 */
/**
 * `mintedAtWallClock` (card 1c47454b) — `Date.now()` at the SAME moment `mintedAtGen` is stamped (the
 * paste-recovery mint site only). Unlike `mintedAtGen`, an absolute wall-clock timestamp is NOT
 * session-relative, so it is the one piece of age evidence that survives a `worker_recycle` /
 * `daemon_restart` boundary honestly: `carryPendingToSuccessor` and the restart replay both thread THIS
 * field onto the far side (while deliberately leaving `mintedAtGen` behind — see its own doc). Its only
 * consumer is `annotatePasteRecoveryAge`. When `mintedAtGen` is absent (i.e. the entry just crossed a
 * boundary), this is the ONLY age evidence available, so it stands alone to disclose an absolute mint
 * time instead of a now-meaningless generation count. Card 2d36337e: when `mintedAtGen` IS present (a
 * genuinely in-session mint), this field is now ALSO read — appended alongside the generation-count
 * wording, since a relative count alone can't tell the recipient whether this predates a SPECIFIC later
 * message they've already read. Never touched by any other caller, so every existing enqueue stays
 * byte-identical.
 */
export type QueuedMessage = { id: string; text: string; source: QueueSource; onDeliver?: (reason?: string) => void; route?: TurnRoute; kind: QueuedMessageKind; questionId?: string; ownerText?: string; proactive?: boolean; senderId?: string | null; giveUpRequeues?: number; giveUpGen?: number; giveUpHeldUntil?: number; onGiveUpExhausted?: () => void; logicalId: string; mintedAtGen?: number; mintedAtWallClock?: number };
/**
 * Distinguishes `enqueueStdin`'s `delivered:false` outcomes, which otherwise read identically at a
 * glance: `"session-dead"` = no live pty at all — the text was DROPPED, nothing will ever deliver it.
 * `"held"` = queued FIFO on a live-but-busy/not-ready session — it WILL deliver at the next turn
 * boundary. Card 78a16dc5's shape guard (see `sanitizeLoneSurrogates`/`isUntaggedSystemNudge`)
 * DELIBERATELY never drops a "warning"-kind entry — see those doc comments for why a hard drop was
 * rejected (a Code Reviewer catch: it could silently swallow a real `run_gate` failure nudge, stranding a
 * worker parked on it with no durable pending-op left to recover from) — so there is no "malformed"
 * member here; every `kind:"warning"` entry is either sanitized or logged, never dropped on shape alone.
 * A caller that only checked `delivered:false` could conflate "dropped" with "queued".
 */
export type EnqueueDeliveryReason = "session-dead" | "held";
/**
 * `enqueueStdin`'s full return shape (card `13e32e1d`, phase 2 of `7acee6d4`). `delivered` NEVER changes
 * meaning — callers and tests read it as-is (delivered now vs not-yet). The problem this type fixes is
 * that a `held` outcome (a SUCCESSFUL, durable enqueue — it WILL be RETRIED until land) used to report
 * through `delivered:false` ALONE, reading identically to an actual drop. These fields are ADDITIVE,
 * present ALONGSIDE `delivered`/`reason`, and only meaningful on the `held` path:
 *   - `queued: true` — this text is durably recorded and will be retried at the recipient's next turn
 *     boundary; this is success, not failure. NOT an unconditional delivery guarantee though — a message
 *     that keeps giving up (the recipient's Enter never confirms) can still exhaust its redelivery budget
 *     and terminally PARK (`session_message_gave_up`, `handleGiveUpExhausted` in sessions/service.ts) —
 *     surfaced to the sender rather than silently dropped, but genuinely never delivered. `queued: false`
 *     on the `session-dead` path makes the negative explicit too, instead of leaving it to be inferred
 *     from the absence of the field.
 *   - `landsAt: "next-turn-boundary"` — WHEN the NEXT delivery attempt lands: at the recipient's next
 *     Stop/turn-boundary drain (or the reconcile tick), not "eventually" or "if you're lucky". Silent
 *     about this before this card.
 *   - `busyForMs` — how long the recipient has been mid-turn as of this call (undefined when the hold
 *     isn't due to busy — e.g. not-ready/composer-dirty/rate-limited), so a caller can tell "queued behind
 *     a long-running turn" from "queued behind one that just started".
 * `position` and `msgId` are unchanged in meaning (msgId is added by the higher-level durable-message
 * wrapper in sessions/service.ts, not by enqueueStdin itself — see `enqueueDurableMessage`).
 *
 * `deliveryState` (card 9da2a435, additive; CR follow-up [3] on top of an earlier `confirmed:boolean` that
 * was rejected for carrying zero bits — it was present only alongside `delivered:true` and NEVER varied,
 * so it discriminated nothing a caller could act on): `"handed-off" | "queued" | "dropped"`, ALWAYS
 * present, one-to-one with which branch of this function actually ran — the honest per-call outcome,
 * spelled out instead of left to be inferred by cross-referencing `delivered`/`reason`/`queued`.
 * `"handed-off"` (the immediate-submit branch) makes explicit what `delivered:true` has always actually
 * meant and never stopped meaning: the text was HANDED to `submit()` as a turn attempt — NOT that the
 * engine confirmed receiving it. That confirmation (`fireEnterAndVerify`'s hook round-trip) is asynchronous
 * and can still GIVE UP after this call already returned — the live specimen behind this card was exactly
 * that: `worker_message` returned `{delivered:true}` for a message that never reached the worker's
 * transcript. A caller that needs to know the real outcome must correlate `msgId` against a later
 * `worker_list`/`worker_status` read (`staleDirective`/`parkedDirective` — see `staleDirectiveProjection`
 * in mcp/orchestration.ts), which DOES read the durable `session_message_gave_up` trail this synchronous
 * return value cannot see yet. `"queued"` (the held branch) and `"dropped"` (the `session-dead` branch)
 * are the SAME per-branch identity `delivered`/`reason`/`queued` already convey — `deliveryState` doesn't
 * add new information there, it just gives a caller one field to read instead of three.
 */
export type EnqueueResult = {
  delivered: boolean;
  position?: number;
  reason?: EnqueueDeliveryReason;
  queued?: boolean;
  landsAt?: "next-turn-boundary";
  busyForMs?: number;
  deliveryState: "handed-off" | "queued" | "dropped";
};
/**
 * Card 3f09f9ce: `enqueueStdin`'s TAIL (`giveUpHeldUntil` onward) as a single named options object — an
 * additive overload alongside the original positional tail (see `enqueueStdin`'s own doc), so a call site
 * can name each field instead of leaving a reader to count commas. Positions 1-10 (`sessionId`..`senderId`)
 * are unaffected and stay positional either way.
 */
export type EnqueueStdinTail = {
  giveUpHeldUntil?: number;
  onGiveUpExhausted?: () => void;
  logicalId?: string;
  mintedAtGen?: number;
  mintedAtWallClock?: number;
};
/**
 * Shape guard (card 78a16dc5) for a `kind:"warning"` entry only (Loom's OWN operational nudges:
 * idle/context/busy-stuck watchdogs, restart/boot continuation notes, rate-limit/usage nudges,
 * memory-recall injection — see `QueuedMessageKind`). An `"agent"`-kind entry (a worker report, a
 * manager's direction, a human composer turn, a replayed kickoff) is legitimately free-form text, so
 * NEITHER check below is ever applied there — not sanitized, not logged, delivered byte-identical.
 *
 * Both tiers SANITIZE-OR-LOG, they NEVER DROP. An earlier version of this guard DROPPED a "warning"
 * entry with a lone surrogate — a Code Reviewer catch on this same card found that a drop there is a
 * real stall hazard, not just defense-in-depth: the async `run_gate` FAILURE nudge (sessions/service.ts,
 * kind:"warning") embeds `gateDetail.stderrTail`, a raw CODE-UNIT slice of captured gate stdout/stderr
 * (gate-runner.ts). If that stderr contains a non-BMP character (an emoji in a test name/assertion/diff)
 * split exactly at the slice boundary, the tail begins with a lone surrogate — and the durable
 * `pending_gate_ops` row is already marked `state:"settled"` (via `PendingOpRegistry.attach`'s `onSettle`
 * hook) BEFORE this enqueue, so a dropped nudge here is the ONLY remaining path to the result: a worker
 * parked on its gate-completion nudge would stall indefinitely with no way back. That is the exact
 * silent-stall class the `/worker` doctrine warns
 * about, in the very machinery this card exists to harden — so dropping is never an acceptable outcome
 * for this guard, however corrupted the shape. Sanitizing removes the hazard entirely while still fixing
 * the byte-level corruption (the delivered message is always well-formed).
 *
 * `sanitizeLoneSurrogates` — replaces any LONE (unpaired) UTF-16 surrogate (`LONE_SURROGATE_RE`) with
 * U+FFFD (the replacement character): exactly the string-level signature of BYTES that were split mid
 * multi-byte UTF-8 sequence and then decoded/concatenated anyway — the actual corruption this card was
 * filed over (two genuinely different source texts spliced together mid-word). Logs the anomaly (with a
 * short excerpt) and returns the SANITIZED (now well-formed) text; a caller with nothing to sanitize gets
 * the identical string back (cheap to check via `!==`). Equivalent in spirit to the ES2024
 * `String.prototype.isWellFormed()`/`toWellFormed()`, hand-rolled via regex so this doesn't require
 * bumping the repo's shared `lib` target off ES2023 for one call site.
 *
 * `isUntaggedSystemNudge` — LOG-ONLY, never drops or modifies the text. Missing the `[loom:` prefix every
 * REAL call site (resume-nudge.ts, the idle/context watchers, …) happens to use today is NOT itself
 * corruption — it was initially treated as a hard DROP condition, but that turned out to be an invariant
 * the codebase does not actually hold everywhere (a "warning"-kind sender with legitimate untagged text —
 * e.g. the companion persona-reinject path before it was tagged — surfaced immediately once the guard
 * shipped, and a static audit could not prove no OTHER untagged sender exists uncaught). So a missing tag
 * is logged as an anomaly (for someone to go tag the sender properly) but the message is delivered as-is.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function sanitizeLoneSurrogates(text: string, kind: QueuedMessageKind): { text: string; sanitized: boolean } {
  if (kind !== "warning") return { text, sanitized: false };
  const cleaned = text.replace(LONE_SURROGATE_RE, "�"); // U+FFFD REPLACEMENT CHARACTER
  return { text: cleaned, sanitized: cleaned !== text };
}
function isUntaggedSystemNudge(text: string, kind: QueuedMessageKind): boolean {
  return kind === "warning" && !text.startsWith("[loom:");
}

interface Live {
  pty: IPty;
  pid: number;
  cwd: string;
  // Discriminates the two pty species sharing this map. "claude" = an interactive Claude session
  // (the full machinery below: readiness gate, hook-driven busy, injection queue, mode-cycles…).
  // "shell" = a plain human-spawned interactive shell (pwsh/cmd/bash) — RAW passthrough only; ALL the
  // Claude-only logic (deliverHook/readiness/drain/reconcile/boot-reconcile) SKIPS it. A shell is NOT a
  // DB Session, so the orchestration watchers (which iterate DB sessions) never see it either.
  // "canned" = a TEST-ONLY no-process entry (seedCanned) that pre-loads the ring with recorded bytes so
  // `/ws/term` attach replays a faithful screen at a pinned geometry with no real spawn (card a53e6bc9).
  // Shares the shell's Claude-only-skip exemptions but is excluded from listShells (not a real terminal).
  kind: "claude" | "shell" | "canned";
  command?: string;   // shell only: the executable spawned (for GET /api/terminals)
  label?: string;     // shell only: human label for the tile
  geometry: PtyGeometry; // claude: the pinned grid (info only, never resized). shell: current size, resizable.
  // Card a2407ed4: a random per-session credential, minted fresh in `spawn()` on EVERY (re)spawn — fresh,
  // resume, fork, recycle all go through that ONE chokepoint, so this is never stale relative to the
  // settings.json baked at the same call. `/internal/hook` requires the caller to present this exact value
  // before a hook is allowed to touch this session (`verifyHookToken`) — closing the ZERO-EFFORT path
  // (guess an enumerable sessionId, POST) that let any co-resident caller forge a hook against ANY live
  // session with no further requirement. It does NOT authenticate the caller and does NOT achieve isolation
  // — under same-OS-user co-residency with no sandbox, a caller that deliberately reads THIS session's own
  // settings.json (where the token also rides, alongside the sessionId/port already there) can still
  // extract it; that ceiling is inherited, not closed. What this buys: targeting a DIFFERENT session now
  // requires reading THAT session's own secret, not a bare guess — and a leaked token is scoped to the one
  // session it belongs to, never a fleet-wide bypass. Empty string for shell/canned kinds (never checked —
  // verifyHookToken/deliverHook both gate on kind==="claude" first).
  hookToken: string;
  engineSessionId: string | null;
  ring: { chunks: Buffer[]; bytes: number };
  subscribers: Set<Subscriber>;
  alive: boolean;
  // Card bb3d9005 (S1): flips true SYNCHRONOUSLY at the same moment `live.pty.kill()` is issued — NOT
  // at the async `'exit'` event, which is what `alive` itself waits for. The gap matters: node-pty's
  // useConptyDll kill() path destroys `_inSocket` (a raw net.Socket with NO 'error' listener attached —
  // only the OUT socket gets one) synchronously inside kill(), but the pty process can take tens of ms
  // to actually exit, and `alive` stays true the whole time. A write reaching a destroyed `_inSocket`
  // during that window throws an unhandled 'error' and crashes the WHOLE daemon (every live session,
  // every project) — not just this one pty. Every write call site that re-checks aliveness immediately
  // before calling `ptyWrite`/`writeChunked` must check `alive && !killed`, not `alive` alone. Never
  // reset back to false (a fresh spawn/resume always gets a brand-new Live object, never a reused one).
  killed: boolean;
  // Epoch ms when THIS pty process started — set once at creation for every kind. Distinct from the DB
  // session's createdAt (unchanged across a resume/recycle/upgrade): this is the CURRENT live process's
  // own start, so a resume/fork/recycle/companion-upgrade (all through createPty) each get a fresh value.
  // Surfaced via `liveStartedAt` so a reader (e.g. the companion capability panel) can tell whether a
  // grant changed AFTER the running process last (re)read its tool surface — i.e. whether a respawn is
  // still pending to apply it.
  startedAt: number;
  logStream: fs.WriteStream;
  // Flips true the first time logStream emits 'error' (see attachLogErrorGuard) — degrades THIS
  // session's log-writing to a no-op for the rest of its life. A WriteStream auto-destroys on error,
  // so a bare listener alone isn't enough: without this flag, every subsequent .write() to the dead
  // stream would re-emit 'error' (handled, but re-logged/re-thrown-from-emit on every pty data chunk).
  // The pty/session itself is never affected — only its on-disk transcript log goes silent.
  logBroken: boolean;
  busy: boolean;        // a turn is in flight (locally tracked; mirrored to DB via onBusy)
  ready: boolean;       // the TUI has booted (first SessionStart, after mode-cycles) — gate for injection.
                        // DISTINCT from busy: busy="turn in flight", ready="engine up + safe to submit".
                        // A fresh/resumed pty is NOT ready until SessionStart, so a boot-recovery nudge
                        // queues instead of racing the still-booting composer (the 2026-06-03 restart bug).
  // Card c469d54e: handle of whichever readiness-fallback timer THIS FIELD currently tracks for this
  // session — EITHER the spawn-armed one (READY_FALLBACK_MS from spawn, covers a genuinely missed
  // SessionStart) OR, once SessionStart has fired and re-armed it, the mode-cycle-scoped one
  // (MODE_CYCLE_FALLBACK_MS from SessionStart, capped by READY_FALLBACK_ABSOLUTE_CEILING_MS from spawn).
  // At most ONE after the re-arm has completed — see the SessionStart handler's own comment for the
  // narrow window where a fault mid-re-arm can leave the OLD, uncleared timer ALSO still live (not
  // tracked by this field once overwritten, but real and still capable of firing) — that is the
  // documented, safe-to-degrade-into residual, not a contradiction of "at most one tracked here". null
  // once markReady has run (whichever call actually clears it).
  readyFallbackTimer: NodeJS.Timeout | null;
  busySince: number | null;  // epoch ms when busy rose — for stuck-busy self-heal (BUSY_STALE_MS)
  lastOutputAt: number; // epoch ms of the last pty output — "is the engine actually producing?"
  composerLen: number;  // best-effort length of the human's UNCOMMITTED raw-terminal draft. >0 ("composer-dirty")
                        // HOLDS programmatic delivery so a queued turn can never land ON the human's half-typed
                        // text; reset to 0 by a box-freeing key (Enter/Ctrl-C/Esc/kill-line) or backspace-to-empty.
                        // The PRECISE collision signal (supersedes the old keystroke time-grace). Tracked in writeStdin.
  // Card 0f9268cc: the TEXT-carrying twin of `composerLen` — same lifecycle (nextRawDraftState mirrors
  // nextComposerLen's parsing), tracked ONLY so writeStdin can capture the composed text into
  // `lastRawSubmit` at the moment of a genuine Enter-submit. Never read outside writeStdin.
  rawDraftText: string;
  // Card 3ce3fa39: cumulative count of characters that MAY still be physically sitting in the composer from
  // an earlier submit() whose give-up (RECOVERY or SUPPRESSED) or heal-if-stuck clear was never CONFIRMED
  // to have actually landed — see submit()'s own doc for why the clear is deliberately DEFERRED to the next
  // submit() rather than attempted at give-up time. ADDITIVE, never overwritten by a give-up: a second
  // unresolved give-up on top of an already-dirty composer must not lose track of the first.
  // ⚠️ Card d4b3fa6c — NOT AUTHORITATIVE ALONE, DOCUMENTED LIMITATION (deliberately not "fixed" — see below):
  // a GIVE-UP SUPPRESSED mark (`fireEnterAndVerify`'s "engine produced output after the final Enter write"
  // branch) never calls `requeueGiveUpOrigin`, so it seeds neither `ambiguousDispatches`/`giveUpConfirmQueue`
  // nor `composerDirtyLenClearedByGen` — meaning BOTH of this field's clear paths (`clearComposerDirtyOnConfirm`
  // via `purgeConfirmedGiveUpRequeue`, and the `composerDirtyLenClearedByGen === submitGeneration` gate below)
  // are structurally UNREACHABLE for a SUPPRESSED-only mark on its OWN generation. The field then reads
  // stale-nonzero against a GENUINELY EMPTY composer — confirmed twice in production, in two different
  // lifecycle states (idle post-turn; busy mid-first-turn, turnSeq still 0) — and clears ONLY once some
  // wholly UNRELATED, LATER submit() (a fresh message) issues its own defensive clear-prefix and that gets
  // confirmed. See `pty-giveup-suppressed-composerdirty-sticky.mjs` for the reproduction: the staleness
  // survives BOTH the same generation's own UserPromptSubmit confirm AND its later Stop. A CANDIDATE FIX
  // (enrolling the SUPPRESSED mark into `ambiguousDispatches`/`giveUpConfirmQueue` the same way, minus the
  // `live.pending` requeue) was evaluated and REJECTED: `healIfStuck`'s own backstop unconditionally calls
  // `requeueGiveUpOrigin` for a still-unconfirmed generation regardless of whether it was already marked
  // dirty (only the dirty-MARK is gated on `composerDirtyMarkedForGen`, not the requeue call) — so an
  // already-enrolled SUPPRESSED generation would get double-enrolled into `giveUpConfirmQueue`, corrupting
  // its FIFO-position correlation and risking a LATER, unrelated confirming hook being misattributed to an
  // already-resolved generation. The safe direction here is fail-toward-DIRTY: consumers must treat a
  // non-zero read as a SUSPICION, not proof, and call `worker_flush`'s submit-only, write-nothing recheck
  // BEFORE trusting it or reaching for a destructive remedy (worker_recycle/worker_stop) — see
  // worker_list/worker_status/my_context's own tool descriptions and the `/orchestrate` doctrine.
  composerDirtyLen: number;
  // Card c148f118: the OPTIMISTIC counterpart to `composerDirtyLen` above — same additive write-side
  // bookkeeping (every add mirrors a `composerDirtyLen` add, at the SAME sites, same amounts), EXCEPT
  // that the defensive clear-prefix branch (submit(), the `composerDirtyLen > 0 && composerLen === 0`
  // case) zeroes THIS field the moment it issues the backspace burst — optimistically ASSUMING that burst
  // actually empties the composer, rather than leaving the prior total to keep compounding the way
  // `composerDirtyLen` deliberately does. `composerDirtyLen` never makes that assumption (see its own
  // doc — always the conservative "what if no clear I've ever attempted actually landed" reading); this
  // field always does. Read TOGETHER, not as alternatives: `composerDirtyLenBelieved === composerDirtyLen`
  // means no clear attempt is currently unresolved (either nothing's dirty, or everything has already
  // been decisively confirmed) — nothing to doubt. `composerDirtyLenBelieved < composerDirtyLen` means a
  // defensive clear WAS attempted and its outcome is still unverified; the gap between the two is exactly
  // how many characters are in doubt, bounding the truth between "the clear worked" (this field) and "the
  // clear did nothing" (`composerDirtyLen`) instead of collapsing both possibilities onto one identical
  // number the way the pre-c148f118 code did (see the specimen recorded in submit()'s own comment, card
  // 2960c3bf). Reset to 0 by the SAME three decisive-confirm sites that reset `composerDirtyLen` (the
  // `composerDirtyLenClearedByGen`-gated UserPromptSubmit/Stop hooks, and `clearComposerDirtyOnConfirm`'s
  // `composerDirtyMarkedForGen` gate) — a genuine confirmation proves the WHOLE ordered byte stream
  // landed, so both readings collapse back to the same true zero together. Like `composerDirtyLen`, this
  // is pure write-side bookkeeping, never a readback of real terminal content — "optimistic" describes
  // the ASSUMPTION, not a verification.
  composerDirtyLenBelieved: number;
  // Card 3ce3fa39: the `submitGeneration` whose submit() most recently issued a defensive clear-prefix for
  // `composerDirtyLen` — null when no clear-prefix is currently outstanding. GATES the reset: a confirming
  // hook resets `composerDirtyLen` to 0 ONLY when it fires while `submitGeneration` still equals THIS value
  // (i.e. the confirmation genuinely belongs to the submit that attempted the clear). This is NOT redundant
  // with `enterConfirmed` alone — first-hand confirmed in production: a wrongly-SUPPRESSED give-up leaves
  // `enterConfirmed` false, and a hook belonging to unrelated concurrent engine activity can still fire and
  // flip it true WITHOUT any submit() (let alone one carrying our clear-prefix) ever having run in between.
  // An ungated reset on that hook would silently un-mark the composer as dirty before the clear it's
  // supposedly proof of was ever even attempted — reopening exactly the hole this card closes.
  composerDirtyLenClearedByGen: number | null;
  // Card 3ce3fa39: the `submitGeneration` (captured BEFORE any out-of-band bump) whose give-up has already
  // contributed to `composerDirtyLen` — null when the current outstanding generation hasn't been marked
  // yet. GATES the mark side the same way `composerDirtyLenClearedByGen` gates the reset side: a wrongly-
  // SUPPRESSED give-up marks dirty immediately (see `fireEnterAndVerify` — it's the ONLY chance to catch a
  // suppression whose busy later resolves via unrelated activity well before any staleness window, exactly
  // specimen B's real shape), and `busy` deliberately stays true afterward — so `healIfStuck` can ALSO
  // observe the SAME still-unconfirmed generation later (its own backstop for a suppression staleness
  // itself never resolves). Without this guard both sites would mark the identical abandoned text twice.
  composerDirtyMarkedForGen: number | null;
  // Card b9b8f8db: the `submitGeneration` whose submit() actually wrote FRESH body bytes (the plain paste,
  // or the full defensive clear+repaste) — null/mismatched for a generation that took the Enter-only
  // redelivery path (a redrain of an already-attempted message; see submit()'s `isGiveUpRedelivery`), which
  // writes no body at all. GATES composerDirtyLen's ADDITIVE mark side (fireEnterAndVerify's SUPPRESSED/
  // RECOVERY branches, healIfStuck) the same way `composerDirtyMarkedForGen` gates double-marking: an
  // Enter-only generation that itself later gives up must NOT also add its (unwritten) body length to
  // composerDirtyLen — nothing new was physically typed, so nothing new is possibly stranded. Without this
  // gate, composerDirtyLen would still inflate by a further `lastPrompt.length` on every failed Enter-only
  // retry even though the fix's whole point is that cycle writes zero body bytes.
  composerBodyWrittenForGen: number | null;
  pending: QueuedMessage[]; // FIFO of messages held while busy / while the human types — drained on Stop + reconcile. Each carries a stable id so the UI can delete/edit/reorder a specific entry safely (an id op is a no-op once that entry has drained).
  stopping: boolean;    // a Stop is in flight — SUPPRESS drain/submit so a queued turn can't re-arm busy past it
  // Card d88163b7 (CR fix): a CALLER-held drain suppression — SUPPRESS drain/submit (mirrors `stopping`,
  // but is a DISTINCT flag: see `holdDrain`/`releaseDrain`) for a window BEFORE the caller has decided to
  // actually stop the session, so nothing can start a NEW turn (via drainPending's Stop-hook auto-drain
  // or enqueueStdin's idle-submit path) that a later `pty.stop()` would then kill with no recovery.
  // DELIBERATELY NOT `stopping` itself: `onExit` classifies a death as `intended: live.stopping`, so
  // setting `stopping` early (before we've actually decided to interrupt) would misreport a genuine
  // mid-hold crash as an intended stop.
  drainHeld: boolean;
  rateLimited: boolean; // §19c park: the turn died on a usage cap; the pty is alive but PARKED. SUPPRESS
                        // drain/submit (mirror of `stopping`) so the ~10s reconcile drain can't submit pending
                        // into the capped account and CLOBBER lastPrompt — the killed turn resumeAfterRateLimit
                        // must replay. Set when the StopFailure is detected as rate_limit; cleared on resume.
  // Card 2521bf51 (a human Enter never arms busy, so the drain races the turn it just started): epoch ms
  // deadline until which drainPending SUPPRESSES a queued turn after a genuine human Enter-SUBMIT
  // (`nextRawDraftState`'s `draft.submitted !== null`) — set by writeStdin instead of draining promptly,
  // because unlike `busy` (only ever armed by submit()'s own M1 optimistic set), nothing tells Loom a
  // human-typed turn is genuinely in flight until claude's OWN `UserPromptSubmit` hook actually fires,
  // asynchronously, after it has processed the Enter. Draining on local byte-counting alone (composerLen
  // hitting 0) would submit the queued turn into a composer claude may still be transitioning out of —
  // the exact race this card fixes. Cleared to `null` the instant a confirming hook (UserPromptSubmit or
  // Stop — either is proof the turn genuinely started, see the Stop handler's own reasoning) arrives, so
  // the common case resolves promptly. The DEADLINE is a bounded backstop only, for the rare case BOTH
  // hooks are lost for this turn: past it, drainPending treats the hold as expired and proceeds — so a
  // queued message is guaranteed to eventually drain (via the reconcile tick), never wedge forever. NOT
  // `busy`/M1: deliberately a separate, narrower gate so the M1 invariant (submit()'s own synchronous
  // busy=true) stays untouched — this only ever governs the human-submit gap `busy` doesn't cover — WITH
  // ONE EXCEPTION: a Stop/UserPromptSubmit belonging to a DIFFERENT, already-in-flight turn (one that was
  // running BEFORE this hold was armed) is not proof the human's own just-typed Enter has started —
  // see `humanSubmitHeldArmedDuringTurn`'s own doc for how that variant is discriminated (card 3ff89cbc).
  humanSubmitHeldUntil: number | null;
  // Card 3ff89cbc: true when `humanSubmitHeldUntil` (above) was armed WHILE an unrelated turn was already
  // mid-flight (`live.busy` at arm time, snapshotted at the same writeStdin call that arms the hold). A
  // Stop that fires while this is true can only be that PRE-EXISTING turn's own Stop — claude runs one
  // turn at a time, so nothing else could be ending — and must NOT be read as confirmation that the
  // human's own Enter has started. The Stop handler consumes this latch (flips it false) instead of
  // clearing the hold on that first Stop; a LATER Stop (the belt-and-suspenders path for a lost
  // UserPromptSubmit hook — see the Stop handler's own reasoning) then finds the latch already false and
  // clears normally. UserPromptSubmit's own clear is UNAFFECTED by this latch (always correct — a turn
  // fires UserPromptSubmit at most once, so the very next one after arming can only be a genuinely NEW
  // turn, i.e. the human's own) and resets it to false alongside its clear, so a stale `true` never
  // outlives the hold it was armed for. Always false when armed with nothing already in flight, so the
  // ordinary (no pre-existing turn) case is byte-identical to before this card.
  humanSubmitHeldArmedDuringTurn: boolean;
  // Card dbc6bcac: latches once the Stop null-stats branch's diagnostic has confirmed this session's
  // transcript is genuinely missing via `engineTranscriptExists`'s EXPENSIVE fallback path — a synchronous
  // O(projects) `readdirSync` of `~/.claude/projects` (the same hot-path-sync-scan class as the c12b550
  // freeze P0, scoped here to one broken session). While set, a further miss skips that fallback scan
  // entirely instead of re-paying it on every subsequent Stop. Reset to false the moment a cheap direct
  // existsSync check finds the transcript again — a session that recovers still deserves a fresh diagnosis.
  transcriptMissingDiagnosedOnce: boolean;
  // Card 7114838d: latches once the UserPromptSubmit frame-splice detector has confirmed (or refuted)
  // its own unverified premise — that the engine's hook payload actually carries a `prompt` field at
  // all — for THIS session, so a genuinely-absent field is reported explicitly and ONCE rather than the
  // detector silently comparing `undefined` and never firing again for every subsequent turn.
  promptFieldAbsentDiagnosedOnce: boolean;
  lastPrompt: string | null; // the most-recent submitted turn — re-sendable if the cap kills it (§19c-b)
  // Card 25813ecc: the ORIGINAL fresh-spawn kickoff intent, seeded ONCE at spawn() from
  // `opts.startupPrompt ?? null` and never written again by anything else — unlike `lastPrompt`, which
  // every submit() (including a resume's drainPending-triggered delivery of a QUEUED message) unconditionally
  // overwrites. `markReady` reads THIS field, not `lastPrompt`, to decide what "the kickoff" is — so the
  // answer is correct by construction (it names the one thing that can never be another turn's text),
  // not by capturing `lastPrompt` before some other write gets a chance to clobber it. A resume/fork never
  // passes `opts.startupPrompt`, so this is null there — no kickoff to guarantee, exactly as intended.
  startupPrompt: string | null;
  // Card 0f9268cc: the raw-terminal-channel counterpart of `lastPrompt`, so the paste-tripwire can see a
  // paste/long text typed or pasted directly into the terminal panel (/ws/term -> writeStdin), NOT just a
  // structured submit() turn. `lastPrompt` is set ONLY by submit(); writeStdin never touched it, so a
  // human-terminal paste-collapse was categorically invisible to the tripwire before this. Set by writeStdin
  // when a raw Enter (outside a bracketed-paste span) frees a non-empty draft — the text at that instant,
  // mirroring what submit() captures for the structured path. Cleared (a) by submit() itself, since a
  // structured submit starting means any earlier raw baseline is now stale/superseded, and (b) after the
  // Stop/StopFailure chokepoint consumes it, so a leftover value never gets attributed to a LATER turn.
  // Best-effort by design, same spirit as composerLen/nextComposerLen — see nextRawDraftState.
  lastRawSubmit: string | null;
  // Card b4b9b707: mirrors lastRawSubmit's capture (same writeStdin call site, same nextRawDraftState
  // reconstruction) but is a SEPARATE field with its OWN lifecycle, dedicated to owner-text attribution —
  // NOT a reuse of lastRawSubmit — so this feature can never perturb lastRawSubmit's own paste-tripwire
  // consume/clear timing at Stop (see that field's doc). THE SECURITY INVARIANT: submit() is the SOLE
  // gateway every Loom-originated turn goes through (kickoff/nudge/redirect/worker-report drain/rate-limit
  // replay/companion/the REST composer — see submit()'s callers), and it clears this field FIRST, before
  // writing a single byte of its own text. So this field can be non-null when UserPromptSubmit fires ONLY
  // when the triggering keystrokes reached the pty via writeStdin — i.e. a human typing into /ws/term
  // (writeStdin's one production caller, gateway/server.ts's raw `{type:"stdin"}` relay — never an
  // agent/system path). Consumed (read + cleared) at the UserPromptSubmit hook — see deliverHook.
  pendingRawOwnerSubmit: string | null;
  // Epoch ms when pendingRawOwnerSubmit was captured. Bounds how long a captured-but-never-consumed raw
  // line can sit around before a LATER, unrelated UserPromptSubmit could misattribute it — e.g. a bare "y"
  // typed to answer a permission/resume-gate TUI prompt (which never itself starts a new top-level turn,
  // so nothing clears or overwrites the field) must not still be sitting here to attribute to some
  // different real prompt minutes later. See RAW_OWNER_SUBMIT_TTL_MS / the UserPromptSubmit consumption
  // check. This is a UX/correctness bound, not a trust one — a stale value is always genuinely
  // human-typed text, just possibly typed for a different purpose than the turn it would land on.
  pendingRawOwnerSubmitAt: number | null;
  // True once ANY turn has ever started for this session (the first UserPromptSubmit hook observed).
  // Gates the fresh-spawn kickoff guarantee (scheduleKickoffGuarantee) and healIfStuck's short pre-first-
  // turn stale window (FIRST_TURN_STALE_MS) — see both for why "never started a turn" needs distinct
  // handling from "mid a long turn". Irrelevant for shell/canned entries (seeded true — no kickoff to guarantee).
  firstTurnStarted: boolean;
  // True once the CURRENT outstanding submit()'s Enter is confirmed to have actually started a turn
  // (a `UserPromptSubmit` hook, or a `Stop`/`StopFailure` — either proves a turn ran even if the
  // UserPromptSubmit hook itself was lost). False from the moment submit() writes the paste until
  // confirmed. `sendEnterAndVerify` checks this to decide whether to re-send the Enter or give up (card
  // 9549e322 — the swallowed/dropped lone-Enter bug).
  enterConfirmed: boolean;
  // Bumped by submit() on every call, and by every OUT-OF-BAND busy-clearing path (healIfStuck,
  // interruptForRedirect, stop) — see `sendEnterAndVerify`. `enterConfirmed` ALONE is not enough to
  // scope a verify/retry chain: a fast turn can confirm+Stop (setting enterConfirmed=true) and a NEW
  // submit() can then reset it back to false for the NEXT turn WHILE the FIRST turn's verify timer is
  // still pending (CR-caught, card 9549e322 review) — that stale timer would read the reset false and
  // wrongly retry-Enter into the NEW turn's window, and could even give-up→setBusy(false) mid-turn. Each
  // `sendEnterAndVerify` chain captures the generation it was scheduled under and bails the instant the
  // live value no longer matches, regardless of what `enterConfirmed` currently reads.
  submitGeneration: number;
  // Card 441499ee: the exact QueuedMessage entry/entries this IN-FLIGHT submit()'s text came from — set
  // in submit(), read ONLY by `fireEnterAndVerify`'s GIVE-UP RECOVERY branch so a give-up can put the
  // ORIGINAL message(s) back on `live.pending` (identity-preserved, never re-derived from text) instead of
  // discarding them after the caller was already told `delivered:true`. null ONLY for resumeAfterRateLimit's
  // direct replay (a give-up there has no origin to restore — unchanged). `scheduleKickoffGuarantee`'s own
  // direct submit() USED to be origin-less too — card 0050a17e (Code Review catch) gave it a synthetic
  // single-element origin instead, once that call became the PRIMARY delivery path for every spawn rather
  // than a rare fallback: an unconfirmed give-up there now correctly re-queues the kickoff instead of
  // silently discarding it. Overwritten (not appended) by every submit() call; a stale reference from an
  // already-confirmed/superseded turn is harmless because the give-up branch itself bails on
  // `enterConfirmed`/a mismatched `submitGeneration` before ever reading it.
  giveUpOrigin: QueuedMessage[] | null;
  // Card 09e655d5: FIFO of generations that GIVE-UP RECOVERY requeued and which may still receive a late
  // confirming hook — pushed in `requeueGiveUpOrigin`, consulted (never `submitGeneration`) by
  // `purgeConfirmedGiveUpRequeue` to decide WHICH generation a hook confirms. `submitGeneration` alone is
  // only a proxy for "which turn just proved it started": it breaks the instant a SECOND generation has
  // also given up (and so also advanced `submitGeneration`) before the FIRST's late hook arrives — that
  // hook would then misattribute to the CURRENT generation instead of the one it actually confirms. The
  // queue's FRONT is always the OLDEST still-ambiguous generation (real turns run serially through the one
  // pty stream, so hooks resolve in the same order their generations were submitted); see
  // `purgeConfirmedGiveUpRequeue`'s doc for why only `Stop`/`StopFailure` advances past it. Empty for every
  // session with no outstanding give-up ambiguity — i.e. almost always — so the common path stays a single
  // length check.
  giveUpConfirmQueue: number[];
  // Card 4a0af485: epoch-ms of the CURRENT generation's FIRST Enter write (`fireEnterAndVerify`'s
  // `attempt===1` only — never overwritten by a retry) — reset to null at the top of every fresh submit().
  // The reference point `CONFIRMED ... latencyMs=` logging measures against; separate from `giveUpOrigin`
  // because it must survive a give-up (the give-up branch doesn't clear it) so `requeueGiveUpOrigin` can
  // stamp an accurate `writtenAt` onto `ambiguousDispatches` for the generation that just gave up.
  currentGenFirstWrittenAt: number | null;
  // Card 4a0af485: logicalId → a cheap content signature (never the full text — see the field's own
  // memory-safety note below) for every generation that has EVER given up and is still awaiting a possible
  // late confirmation, keyed by `QueuedMessage.logicalId` (NOT `submitGeneration` — a logicalId survives a
  // cross-remint re-mint at sessions/service.ts, a bare generation number does not). Populated by
  // `requeueGiveUpOrigin` for EVERY message it processes (both the kept-and-requeued branch and the
  // budget-exhausted-to-onGiveUpExhausted branch — the latter is exactly the PARKED case whose late
  // confirmation this exists to still catch, since PtyHost's OWN `pending` retains nothing for it past that
  // point). Consulted by `purgeConfirmedGiveUpRequeue` (a confirming hook's `hook.prompt`, when present, is
  // matched against every entry here BEFORE falling back to the old FIFO-position logic) and by
  // `hasAmbiguousMatch` (sessions/service.ts's `enqueueDurableMessage` auto-join check for a manual resend
  // with no explicit `resendOf`). MEMORY-SAFETY: bounded by COUNT (`AMBIGUOUS_DISPATCH_CAP`), never by
  // elapsed time — see that constant's own doc for why this map is NOT expected to stay near-empty as an
  // independent claim (it grows monotonically with every give-up unless promptly cleaned up on resolution);
  // see `capAmbiguousDispatches`. Stores `{len, hash, batchId}` (an `fnv1a32` signature — the SAME cheap
  // hash `ptyWrite`'s own log line already uses — plus the `gen` every member of ONE `requeueGiveUpOrigin`
  // call is seeded under, i.e. that call's batch identity; see that method's own doc), never the message's
  // full text — the text itself is ALREADY retained for free wherever it still needs to be (live.pending,
  // or the DB's `session_message_queued` row), so this map adds no new full-text retention on the most
  // load-bearing path. A signature collision (or an engine-echo that isn't byte-identical to what Loom
  // wrote — untested as of card 4a0af485; see the pre-registered prediction at the prompt-mismatch site) is
  // a FALSE-NEGATIVE MISS for this map, never a false-positive purge: a miss just falls through to the
  // existing FIFO-position fallback, no worse than before that card existed. ⚠️ CORRECTION (card
  // bc0774c4): that "never a false-positive purge" claim was ALSO wrong on a separate axis — two GENUINELY
  // DISTINCT dispatches that happen to carry byte-identical text produce two entries here with the SAME
  // `{len,hash}` but DIFFERENT `batchId`s, and were, before that card, indistinguishable from one coalesced
  // batch's members: one confirming hook purged BOTH. `batchId` is what closes it —
  // `purgeConfirmedGiveUpRequeue` now purges a content match only when every matched entry shares ONE
  // `batchId`; a match spanning more than one is left untouched entirely rather than guessed at, restoring
  // the "never a false-positive purge" property for real — see that method's own doc for why guessing
  // (even an age-based tie-break) was rejected in favor of resolving nothing.
  ambiguousDispatches: Map<string, { len: number; hash: string; writtenAt: number; batchId: number }>;
  // Card 1bd1f045: monotonic per-session sequence number for the `[pty-write]` byte/call-sequence log —
  // bumped by `ptyWrite()` on every REAL `live.pty.write()` call (see that method's doc). THE load-bearing
  // field: it is what makes a duplicated or replayed emission visible AS SUCH (two records sharing a
  // content signature at distinct seq) rather than reading as plausible traffic — discriminating whether
  // the daemon itself double-wrote (card 9ed20572) or something below it replayed already-consumed bytes
  // (card 3ce3fa39). Observation-only counter; never read for control flow.
  writeSeq: number;
  // Loom Companion (multi-channel reply routing): the ORIGINATING chat route of the IN-FLIGHT turn, or null
  // when the turn wasn't formed from a companion inbound / proactive-home submit. Set SYNCHRONOUSLY in
  // submit() (both the idle-submit and drain paths), read by getActiveTurnOrigin when the companion's
  // chat_reply fires — so a reply resolves to the EXACT route of the turn it answers (no shared/last-inbound
  // field, no cross-delivery). `lastPromptRoute` mirrors `lastPrompt` so a rate-limit-killed companion turn
  // replays to its ORIGINAL route on resume. Both null on every non-companion turn ⇒ byte-identical.
  activeTurnRoute: TurnRoute | null;
  lastPromptRoute: TurnRoute | null;
  // Loom Companion (proactive event-line producer): whether the IN-FLIGHT turn was FORMED from a
  // daemon-driven proactive submit (heartbeat/reminder/attention-push alert) — caller-supplied at
  // enqueueStdin/submit(), never sniffed from the text. Persists like activeTurnRoute (simply overwritten
  // by the next submit(), not cleared at Stop — unlike activeTurnOwnerText). `lastPromptProactive` mirrors
  // `lastPromptRoute` so a rate-limit-killed proactive turn's replay (resumeAfterRateLimit) is still tagged
  // correctly. Read by getActiveTurnIsProactive when the companion's chat_reply fires, so the outbound
  // frame + persisted history row can be tagged for the web chat's amber event-line render.
  activeTurnProactive: boolean;
  lastPromptProactive: boolean;
  // Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3): the
  // LITERAL authenticated owner inbound bytes forming the IN-FLIGHT turn, or null when the turn wasn't
  // formed from an authorized owner inbound (proactive/heartbeat/reminder/cross-channel-mirror/memory-
  // recall → null). Set alongside activeTurnRoute in submit() but — UNLIKE activeTurnRoute, which simply
  // gets overwritten by the next submit() — is explicitly CLEARED at turn end (the Stop/StopFailure hook):
  // an ACT lever's owner-text attestation must never see a stale prior turn's text. lastPromptOwnerText
  // mirrors lastPromptRoute so a rate-limit-killed companion turn replays with its attestation intact.
  activeTurnOwnerText: string | null;
  lastPromptOwnerText: string | null;
  // Companion injection-guard Primitive A WIDENING (card 2b26035c, "recent-turns verbatim acceptance"): a
  // BOUNDED, most-recent-first ring of the last RECENT_OWNER_TURNS_WINDOW authenticated owner-turn texts.
  // Pushed alongside activeTurnOwnerText in submit() whenever a turn carries real ownerText — so it is
  // built from the EXACT SAME server-attested owner inbound bytes as Primitive A, just retained across
  // turn boundaries instead of being cleared at Stop. A proactive/heartbeat/system turn (ownerText
  // undefined) never pushes an entry, so this can never accumulate model-authored or injected text —
  // only the TURN SCOPE widens, never the source. Lets a lever accept a candidate that's a verbatim
  // substring of a RECENT turn (e.g. a cross-turn correction/re-phrase), not just the one in flight.
  // GROUP companion note: in a group-scope route, each turn's ownerText is already whichever ALLOWLISTED
  // sender's message formed it (chat-gateway.ts's per-turn sender-authz gate, unchanged by this card) —
  // so this window can span MULTIPLE allowlisted senders' recent turns, not just one person's. This is
  // intentional, not an escalation: every entry is still an authenticated, authorized-user turn (never
  // model-authored/injected), and a lever committing content still separately requires the COMMITTING
  // turn's own current-turn owner-auth (Primitive A) plus the trust window/confirm round-trip — the
  // widened quote-source never substitutes for either of those.
  recentOwnerTurns: string[];
  // Card c2c750a9: a BOUNDED, oldest-first ring of the last `COMPOSER_ACCUM_WINDOW` submitted turns'
  // (`gen`, text) — pushed once per `submit()` call, at the same point `gen` itself is minted, so it
  // always ends with the CURRENT submission by the time `[prompt-echo]` reads it later. Feeds
  // `detectComposerAccumulation`'s window (see that function's own doc for the two-stage sum+hash design
  // it exists to serve). Deliberately keyed on `gen`, never `seq` — `gen` is per-Live (reset on every
  // fresh spawn/resume, never persisted), so this needs no separate per-boot-epoch bookkeeping. Storing
  // full TEXT (not just a length+hash signature like `ambiguousDispatches`) is intentional here: the
  // detector's CONFIRMATION stage must hash the actual concatenation in gen order, which a signature alone
  // cannot reconstruct — bounded to a handful of entries, this is cheap.
  recentWrittenTurns: { gen: number; text: string }[];
  // Card d005f55b DoD-2 — the REPORTED-side counterpart to `recentWrittenTurns` above: a BOUNDED,
  // oldest-first ring of the last `COMPOSER_ACCUM_WINDOW` generations' own REPORTED length+hash. Pushed
  // once per `UserPromptSubmit` hook that carries a usable `prompt` field — the SAME point `[prompt-echo]`
  // already logs these two fields — BEFORE that generation's own accumulation checks run, so "the prior
  // entry" a check reads never means the entry this same hook is about to push for itself. Deliberately
  // length+hash only, never full text (matches `Live.ambiguousDispatches`'s existing minimal-signature
  // discipline — see that field's own doc): `fnv1a32Continue` (this file) lets a caller extend a prior
  // entry's own hash onto new trailing text and get an exact concatenation hash without ever holding the
  // prior entry's bytes. `f5f6515a`'s detector sums `recentWrittenTurns` (what Loom WROTE); this ring lets
  // `detectComposerAccumulationOverDivergedPrior` instead test what the composer actually reported for an
  // EARLIER generation, once that earlier generation's own report had already diverged from what Loom
  // wrote for it — see that function's own doc and card d005f55b's §THE COMPOUNDING MECHANISM for the
  // arithmetic this exists to catch (`reported(N) = written(N) + reported(N-1)`, not `written(N) +
  // written(N-1)`, once N-1 itself was a mismatch).
  recentReportedTurns: { gen: number; len: number; hash: string }[];
  // Card b68d1f5b Code Review — a SEPARATE, dedicated, integer-only history for
  // `detectPastePlaceholderLengthLoss`'s `gen` discriminator, deliberately NOT reusing
  // `recentWrittenTurns` above: that ring's `COMPOSER_ACCUM_WINDOW` (8) was sized for card c2c750a9's OWN
  // sum+hash job, not this one, and a stale placeholder whose explaining write had already rotated out of
  // an 8-entry window read as a fresh loss on a completely correct send — the exact false alarm this card
  // exists to eliminate (see `abeac33a`'s 15-minute-gap specimen). Pushed once per `submit()` call, same
  // chokepoint and same `gen` as `recentWrittenTurns` above, via `computeWrittenLineCounts(text)` — so it
  // never stores the text itself, only the two small candidate-line-count integers that text produced;
  // that's what lets `PASTE_LOSS_EXPLAIN_WINDOW` be MUCH larger (8x) than `COMPOSER_ACCUM_WINDOW` without
  // materially growing `Live`'s footprint. See paste-tripwire.ts's own doc on `PASTE_LOSS_EXPLAIN_WINDOW`
  // and on `detectPastePlaceholderLengthLoss`'s bound for the full reasoning and the stated residual.
  recentWrittenLineCounts: WrittenLineCountEntry[];
  // Card 2c58bdd3 — `detectBarePastePlaceholderTripwire`'s own `gen` discriminator history: the EXACT
  // placeholder token strings (not line counts — see paste-tripwire.ts's doc on why this key differs from
  // `recentWrittenLineCounts` above) observed embedded in a turn's recorded transcript text, oldest-first,
  // bounded at `PASTE_TRIPWIRE_TOKEN_WINDOW`. Pushed at the Stop-hook chokepoint (not at `submit()` time —
  // unlike the two rings above, this one records what the TRANSCRIPT reported, not what Loom wrote),
  // whenever `matchEmbeddedPlaceholderToken` finds a token in that turn's recorded text, regardless of
  // whether the tripwire itself fired for it — a later turn's stale re-render of this SAME token is what
  // this history exists to recognize.
  recentPlaceholderTokens: SeenPlaceholderTokenEntry[];
  // Companion Trust Window (Companion Capability & Permission-Lever Framework, card 0): the AUTHENTICATED
  // sender id of the IN-FLIGHT turn's inbound message, for a GROUP-scope companion route only — null for a
  // DM route (the chatId alone already identifies the single owner, mirroring VoicePrefRoute's own
  // group-only senderId rule) and null for every non-companion-inbound turn. Mirrors activeTurnOwnerText's
  // lifecycle exactly: set alongside it in submit(), CLEARED at the Stop/StopFailure hook (a stale prior
  // turn's sender must never be attributed to a later turn), with lastPromptSenderId mirroring
  // lastPromptOwnerText so a rate-limit-killed companion turn's replay keeps the same sender identity.
  activeTurnSenderId: string | null;
  lastPromptSenderId: string | null;
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
  // Serializes every cycleToMode() invocation for THIS session (the boot convergence, the plan
  // auto-heal, and any manager-driven worker_set_mode override) onto one queue, so no two ever press
  // Shift+Tab or read the footer concurrently — see cycleToMode's doc comment (card 9c03f5a6: an
  // uncoordinated race between the boot cycle and a manual override interleaved their keystrokes/reads
  // and could settle on EITHER cycle's target, observed as worker_set_mode landing on the boot default
  // ("auto") regardless of what was requested). Always resolved (never rejects) so the chain can't wedge.
  modeCycleChain: Promise<void>;
  mcpPromptHandled: boolean;  // guard: dismiss the plugin-MCP enable-prompt with Esc at most once per session
  bootScan: string;           // bounded rolling buffer of early boot output, scanned for that prompt
  resumeGateHandled: boolean; // TERMINAL: true once Enter has actually been sent for the resume-from-summary
                              // gate (confirmed-or-given-up) — see resolveResumeGate. Also gates whether
                              // resumeGateScan keeps accumulating (stays false through the whole verify-retry).
  resumeGateDetected: boolean; // true once the gate text is first recognized — guards the detect→drive
                                // trigger from re-arming on every subsequent chunk while resumeGateHandled
                                // is still false (the verify-retry is in flight).
  resumeGateScan: string;     // bounded rolling buffer scanned for that gate (separate from bootScan)
  isResume: boolean;          // spawned with --resume (vs a fresh spawn) — for the landed-mode log only
  modeLogged: boolean;        // guard: log the landed permission mode at most once per session (observability)
  // RESUME ONLY: the EXPLICIT permission mode to feedback-cycle the footer to after SessionStart (set by
  // SessionService.resume). null on a fresh spawn — host.ts instead DERIVES the equivalent target from
  // startupModeCycles (see the SessionStart handler); both converge via the same cycleToMode primitive.
  resumeModeTarget: LandedMode | null;
  // The session's role — used ONLY by logLandedMode's auto-heal to know whether ExitPlanMode is
  // disallowed for this session (see disallowedToolsForRole). null for a shell / a role-less spawn.
  role: SessionRole | null;
  // Card df5e37e7: whether the daemon has observed at least one HTTP hit on THIS session's
  // loom-orchestration MCP route (/mcp-orch/:sessionId → markMcpSeen) since the CURRENT pty instance
  // was (re)spawned. `ready` (SessionStart) only proves the TUI booted — it says nothing about whether
  // the CLI's own async MCP-client handshake to loom-orchestration has finished, so a resume-continuation
  // nudge submitted right after `ready` can race ahead of it and the model's first tool call hard-fails
  // with "MCP server 'loom-orchestration' is not connected" (observed after a fleet-wide daemon_restart).
  // The daemon's MCP transport is stateless-per-request (see mcp/orchestration.ts), so it has NO other
  // way to observe client-side connection state — "we received a request" is the closest proxy, since the
  // CLI performs its `initialize` handshake unprompted at boot. Reset to false on every (re)spawn (this is
  // a fresh Live object each time). See markMcpSeen/waitForMcpSeen. General-purpose: not loom-orchestration
  // specific by construction — a future caller could mark/wait on this for any per-session MCP route.
  mcpSeen: boolean;
  // Resolvers waiting on `mcpSeen` flipping true (or on this pty dying) — see waitForMcpSeen. Drained
  // (called + emptied) by markMcpSeen on success and by pty.onExit on death, so a waiter never outlives
  // its pty instance.
  mcpSeenWaiters: Array<(seen: boolean) => void>;
  // Card 68459420 (sender-directed arm for [loom:prompt-mismatch]): set the instant a mismatch is
  // identified as a REPLAY of a prior generation — `reported` matched an entry in `recentWrittenTurns`
  // byte-for-byte. A recipient can never verify this half itself (it only ever sees what arrived, not what
  // was intended for it) — this is a PULL surface (see getLastMismatchReplay) for the party who CAN act,
  // read at the point it already looks (worker_list/worker_status), rather than a longer session-facing
  // notice: a precondition at the point of use beats an advisory in the attention path (see pinned
  // memory `shipping-a-detector-is-not-someone-reading-it`). Deliberately never cleared once set — a
  // manager that hasn't yet looked should still see it on a LATER read; this is a discovery aid, not a
  // live/transient flag, and overwritten (not accumulated) on a subsequent occurrence.
  // Card b7158b99 — CORRECTION: this field does NOT establish a loss, and never did reliably — a replay
  // at this generation is compatible with the composer still holding this generation's own intended text,
  // which a LATER generation's own submission can fuse back in whole (see `lastMismatchFusion` below,
  // which would then name THIS generation in its own `spanGens`); whether that happens is unknowable until
  // that later generation, if any, actually occurs (see `detectComposerAccumulation`'s own coverage-limit
  // doc, this file). Read as "a replay was detected, possibly recoverable by a later fusion", never as "an
  // established loss" — the session-facing notice's own wording carries the same correction.
  lastMismatchReplay: { gen: number; replayedGen: number; reportedLen: number; intendedLen: number; detectedAt: number } | null;
  // Card f5f6515a DoD-4: the SENDER-directed arm for a FUSED match — `lastMismatchReplay` above only ever
  // fires on a byte-for-byte match against ONE single prior generation's own write; it stays null for a
  // mismatch whose reported text is a CONCATENATION of more than one generation's writes (the composer
  // accumulated instead of clearing — the exact shape `detectComposerAccumulation` exists to confirm). Set
  // ONLY when `detectComposerAccumulation` CONFIRMS (sum AND hash both match) — ANY confirmed span, no
  // upper bound (Code Reviewer HIGH + §RESOLVED, card f5f6515a): an earlier version of this field capped at
  // `spanGens.length <= 2`, reasoned from "every hash-confirmed specimen measured so far is span=2" — that
  // reasoning does not survive scrutiny. This card's own MOTIVATING gen=4 specimen (a stale CLI paste-
  // collapse placeholder + the preceding generation's full text + the current generation's own text,
  // 26+4819+1123=5968) is NOT a member of this population at all: a stale placeholder is not text Loom
  // itself wrote, so it is never in `recentWrittenTurns`, and no contiguous suffix of that ring can ever
  // sum to a placeholder-inclusive reported length (span=[gen3,gen4] sums to 4819+1123=5942, short by
  // exactly the 26-char placeholder) — `detectComposerAccumulation` structurally cannot confirm that
  // specimen at ANY span. That leaves exactly ONE real specimen (the manager's own live gen=9, span=2) —
  // not a principled basis for a hard cutoff at 2 rather than 3 or 8. The detector's own CONFIRMED result
  // is equally rigorous at any span up to its window cap (exact length-sum AND exact fnv1a32 hash, over a
  // window of at most 8 ⇒ at most 7 candidate spans checked — independently audited by Code Review, which
  // could not force a false positive at any span tried) — a CONFIRMED result is a CONFIRMED result
  // regardless of how many generations it spans. Capping this field below what the notice itself now
  // honors (see the `confirmedFusion` local, this file) would silently reintroduce the exact two-surface
  // disagreement (Code Reviewer CRITICAL+HIGH) this doc was rewritten to remove.
  // `replayedEntry === undefined` guards against setting this for a shape `lastMismatchReplay` already
  // covers — NOT because a single-entry match is itself producible by `detectComposerAccumulation` (it only
  // ever tries spans of 2+ entries, so a length-1 span is structurally impossible here), but because a
  // CONCATENATION could coincidentally equal some OTHER single prior entry's own text (e.g. an intervening
  // empty/short write) — exactly the shape `replayedEntry` already claims more precisely, so this guard
  // keeps the two fields mutually exclusive even in that coincidence, rather than double-firing.
  // ⚠️ THE CONTRACT IS DUPLICATION, NOT LOSS (Code Reviewer CRITICAL, card f5f6515a — shipped wrong once
  // already, do not restate `lastMismatchReplay`'s "ESTABLISHED loss / re-send" language here). A confirmed
  // fusion's span is a CONTIGUOUS SUFFIX whose LAST entry is always the current generation's own write
  // (`recentWrittenTurns.push` happens at submit() time, before this turn's own hook ever fires — see that
  // call site) — the content Loom intended for THIS turn therefore ALWAYS arrived; it is the tail of the
  // fused turn, never missing. The risk runs the OPPOSITE direction from `lastMismatchReplay`'s: an EARLIER
  // `spanGens` entry's own content may have been ACTED ON A SECOND TIME if its own turn already ran — the
  // remedy is checking for a duplicate action, never re-sending (there is nothing to re-send).
  // `spanGens` is oldest-first (mirrors `detectComposerAccumulation`'s own return shape) so a reader can see
  // which generations were involved without a second lookup. CO-TRIGGERED with the session-facing notice's
  // own fusion branch — the SAME `confirmedFusion` expression, in the SAME synchronous block, always
  // together, never independently (an earlier draft of this card's own kickoff said "independently"; that
  // was wrong and corrected here) — what differs between the two is the READER, not the trigger: this
  // field serves the session's own WATCHING manager (worker_list/worker_status); the notice serves the
  // session learning about ITSELF. Same PULL-surface posture as `lastMismatchReplay` otherwise — never
  // cleared once set, overwritten (not accumulated) by a later occurrence.
  lastMismatchFusion: { gen: number; spanGens: number[]; reportedLen: number; intendedLen: number; detectedAt: number } | null;
  // Card 59757189 DoD-1/3 — the UNMATCHABLE counterpart to `lastMismatchReplay`/`lastMismatchFusion` above:
  // set the instant a mismatch matches NONE of the recognized/confirmed shapes above (not a single-entry
  // replay, not a confirmed fusion, not a diverged-prior fusion, not a wrapper-deficit or ANSI-strip
  // benign shape) — the exact population `3ff61275` left unaddressed (that card shipped only DoD-7's
  // WHICH-payload identity floor, never the content itself). CAPTURED AT THE MOMENT OF DETECTION,
  // directly from `intended` (the local in this same synchronous block) — deliberately NOT a later lookup
  // into `recentWrittenTurns` (this file, `COMPOSER_ACCUM_WINDOW`=8 above): that ring is a BOUNDED,
  // oldest-first window that will have rotated past this generation by the time any reader asks (the
  // reporter's own correction on the predecessor card: "the content was in hand at detection time and
  // discarded milliseconds later"). Stored IN FULL, no head-bounding — mirrors `recentWrittenTurns`'s own
  // existing precedent of retaining full per-generation text with no length cap, rather than inventing an
  // unmotivated new size bound here.
  // DoD-3 (decidability): `null` (the field's own type) combined with `getLastMismatchUnmatched`'s own
  // `undefined` for an unknown/not-live session are the ONLY "not captured" states. An unmatchable
  // mismatch, once it fires, ALWAYS populates a real object here — so a reader can never confuse
  // "captured, here it is" (a non-null object — even one whose `intendedText` happens to be the empty
  // string) with "nothing was ever captured" (`null`/`undefined`). Never cleared once set (same posture as
  // `lastMismatchReplay`/`lastMismatchFusion`); overwritten — not accumulated — by a later unmatchable
  // occurrence, so this always reflects the MOST RECENT one.
  lastMismatchUnmatched: { gen: number; intendedLen: number; intendedText: string; detectedAt: number } | null;
  /**
   * Card c0323f8a — the SIGNATURE of the last `[loom:prompt-mismatch]` session-facing notice actually
   * enqueued (see the `setTimeout(() => this.enqueueStdin(...))` call site below). Unlike
   * `lastMismatchReplay`/`lastMismatchFusion` above (read-only PULL surfaces for a WATCHING manager,
   * overwritten unconditionally on every detection, never gating anything), this field's ONLY job is
   * SUPPRESSING an exact repeat: if the underlying `UserPromptSubmit` hook fires more than once for the
   * SAME logical turn, this whole detection block re-runs from scratch and, before this field existed,
   * re-enqueued a BYTE-IDENTICAL notice as a genuinely fresh turn — never tagged, since it is a fresh
   * mint, not a redrive of an already-queued entry (the `[loom:possible-duplicate root:…]` machinery
   * only ever tags a REDELIVERY of a message that was already durably queued or gave up; this notice is
   * neither).
   *
   * ⚠️ THIS IS A DATA-LOSS ALARM — suppressing a genuinely NEW mismatch here would hide a real loss,
   * silently. The soundness of suppressing on an exact `(gen, writtenHash, reportedHash)` triple match
   * rests entirely on `gen` (`Live.submitGeneration`) being unable to repeat across two DIFFERENT
   * underlying events, which is a stronger property than merely "gen advances". PROOF, established by
   * READING THE CODE, not by observing a production incident:
   * 1. `submitGeneration` is mutated ONLY by `++`, at exactly FOUR sites in this file, all monotonic
   *    increments, none a reset/decrement: `submit()` itself (`const gen = ++live.submitGeneration;`),
   *    `healIfStuck`'s out-of-band stale-busy bump, `stop()`'s bump on graceful/hard stop, and
   *    `interruptForRedirect`'s bump on an Esc-cancel.
   * 2. The ONLY place it is ever set to a value OTHER than an increment is `submitGeneration: 0` at Live
   *    construction — and for a real Claude session there is exactly ONE construction site, `spawn()`
   *    (this file). Every `SessionService` spawn path (fresh spawn, resume, fork, a `worker_recycle`
   *    successor, boot-reconcile resume) calls `this.pty.spawn(...)` — the SAME method, unconditionally —
   *    so a resume does NOT reuse an existing Live and dodge the reset; `isResume: !!opts.resumeId` is a
   *    flag on THIS SAME constructor literal, not a separate code path.
   * 3. This field is initialized to `null` at the SAME construction site (see the three `Live` literals
   *    below) — so it resets in lockstep with `submitGeneration` across every boundary that resets gen. A
   *    stale signature can never survive into a fresh gen sequence.
   * 4. The specific case this project has ON RECORD as a real engine quirk — card 8a5bd0d0, the engine
   *    firing a second `SessionStart` under a rotated `session_id` for the SAME live pty (see that
   *    handling above) — does NOT construct a new Live and does NOT touch `submitGeneration`; it mutates
   *    only `live.engineSessionId` in place. Checked specifically because it was the most plausible way
   *    this proof could be wrong; it isn't.
   * ⇒ Within one Live's lifetime, two reads of the identical `gen` can only happen if no `submit()` ran
   * between them — meaning `live.lastPrompt` (Loom's own intended write for that generation) is STILL the
   * same string both times. There is no way for a second, genuinely-distinct loss to exist "at gen=N"
   * without a new submit() first, and a new submit() always bumps gen — so a full triple match cannot
   * represent two different events.
   * ⚠️ WHAT THIS DOES NOT PROVE: it does not establish HOW, in production, the detection block gets
   * re-entered a second time with an unchanged `gen`. A literal synchronous double `deliverHook`
   * (`UserPromptSubmit`) call for one turn is itself structurally blocked from reaching this a second
   * time (`submitWasOutstanding = !live.enterConfirmed`, and this same case sets `enterConfirmed = true`
   * before the detector runs, so a genuine back-to-back duplicate takes a different, harmless branch) —
   * the real trigger for the specimens that motivated this field is UNCONFIRMED. This field guards
   * against the symptom regardless of the trigger; it is not evidence the trigger is understood.
   *
   * Never cleared, overwritten (not accumulated) by the next notice actually sent — mirrors the
   * PULL-surface fields' own "last one wins" posture. See `lastMismatchNoticeSuppressed` below for the
   * durable, manager-visible record of when this field's match actually suppressed something — this field
   * alone is not manager-visible.
   */
  lastMismatchNoticeSignature: { gen: number; writtenHash: string; reportedHash: string } | null;
  /**
   * Card c0323f8a (manager review) — the durable, PULL-surface counterpart to a suppression decided by
   * `lastMismatchNoticeSignature` above. A suppressed alarm and no alarm are indistinguishable to any
   * future reader unless something records that a suppression actually happened — a `console.log` line is
   * fine for a human tailing the daemon's own stdout, but invisible to a manager, which is who actually
   * needs to know an alarm was swallowed. Mirrors `lastMismatchReplay`/`lastMismatchFusion`'s own posture
   * (read-only, never gates anything, overwritten — not accumulated as a struct — by the next SUPPRESSED
   * occurrence) with one addition: `count` accumulates across repeated suppressions of the SAME signature,
   * so "suppressed once" and "suppressed five times in a row" read differently. Reset to a fresh `count:1`
   * the moment a DIFFERENT signature suppresses (which cannot happen without an intervening real notice —
   * see `lastMismatchNoticeSignature`'s own proof), so `count` is always "how many repeats of the CURRENT
   * signature have been suppressed", never a lifetime total across unrelated events.
   */
  lastMismatchNoticeSuppressed: { gen: number; writtenHash: string; reportedHash: string; count: number; detectedAt: number } | null;
}

export interface SpawnOpts {
  sessionId: string;          // Loom session id
  cwd: string;                // = project repoPath
  permission: PermissionPolicy;
  geometry: PtyGeometry;
  sessionEnv: Record<string, string>;
  /** New session: the agent startup prompt (injected once). Resume: omit. */
  startupPrompt?: string;
  /** Resume: Claude engine session id. */
  resumeId?: string;
  /** Fork: with resumeId, mint a fresh engine id (--fork-session) so the copy diverges from the source. */
  fork?: boolean;
  /** Fork: the pre-assigned engine session id for the fork (--session-id), persisted up front by the caller. */
  forkSessionId?: string;
  /** Role decides the extra MCP surface at spawn: manager/worker → loom-orchestration, platform →
   *  loom-platform (each with its allowlist); plain sessions get only loom-tasks. */
  role?: SessionRole;
  /**
   * Profile-pinned model id (resolved from the session's Profile, e.g. "claude-opus-4-8"). When set,
   * emit `--model <id>` into the spawn recipe. Undefined/absent ⇒ NO `--model` — byte-identical to
   * today (the engine default). Threaded ONLY by the fresh-start paths; a `--resume`/`--fork-session`
   * spawn omits it and inherits the conversation's model from the engine transcript.
   */
  model?: string;
  /** When set (docLint on), wires the vault-lint PostToolUse hook scoped to this vault (Pillar D). */
  vaultPath?: string;
  /**
   * Opt-in browser-automation (resolved from the session's Profile, gated). When true, inject a
   * per-session stdio Playwright MCP (@playwright/mcp) so the agent can drive a headless browser, and
   * allowlist its tool surface. Default OFF — every existing spawn is byte-identical when unset/false.
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion (resolved from the session's Profile, gated). When true, inject a
   * per-session stdio markitdown MCP (`markitdown-mcp`) so the agent can convert files to Markdown, and
   * allowlist its tool surface. Default OFF — every existing spawn is byte-identical when unset/false.
   */
  documentConversion?: boolean;
  /**
   * Card C2 (Codescape wiring epic `369dde3c`): the project's RAW `codescape.enabled` config flag — NOT
   * yet combined with `isLoomDev()` (buildMcpServers applies that gate itself). Default OFF — every
   * existing spawn is byte-identical when unset.
   */
  codescapeEnabled?: boolean;
  /** Card C2: the session's project id (used for non-Codescape purposes too, e.g. connection-secret scoping). */
  projectId?: string;
  /**
   * Card 088afc94 (P4 wiring): the project's PRIMARY repo path — used to resolve codescape's OWN project
   * id via its manifest (never Loom's `projectId` above; see `codescapeHttpMcpServer`'s doc for why).
   * ALWAYS the project's main checkout, never a worker's own worktree (codescape indexes one graph per
   * project). Default undefined — every existing spawn is byte-identical (the codescape branch requires
   * this to be present).
   */
  repoPath?: string;
  /**
   * Card 088afc94 (P4 wiring): this session's codescape worktree scope (`codescapeWorktreeId(taskId)`) —
   * present for a worker tied to a task, absent for every other role (and a taskless worker), which fall
   * back to the bare `/mcp/<codescapeId>` project route. Default undefined ⇒ bare route.
   */
  worktreeId?: string | null;
  /**
   * Agent-tooling P4: registry-capability grants BEYOND the two legacy booleans above (resolved from the
   * session's Profile/row, RAW — see resolveProfileCapabilities). Default [] — every existing spawn is
   * byte-identical when unset/empty. Threaded on EVERY spawn path (fresh/resume/fork/recycle), pinned on
   * the session row like browserTesting so a respawn mounts the same capabilities.
   */
  capabilities?: CapabilityGrant[];
  /**
   * Opt-in RESTRICTED-tools (resolved from the session's Profile, gated; blast-radius control). When true,
   * the curated dangerous native tools ({@link RESTRICTED_NATIVE_TOOLS}) are UNIONed into this spawn's
   * `--disallowedTools` (on top of the role's human-prompt disallow), removing them from the model's tool
   * list. Default OFF — every existing spawn is byte-identical when unset/false (the disallow list stays
   * exactly `disallowedToolsForRole(role)`). Threaded on EVERY spawn path from the pinned session row.
   */
  restrictedTools?: boolean;
  /**
   * Profile-resolved skill-name SUBSET pinned on the session row (mirrors browserTesting): injectSkills
   * delivers ONLY these skills. null/empty/absent ⇒ ALL store skills (byte-identical to today). Threaded
   * on EVERY spawn path (fresh/resume/fork/recycle/boot) — read from the row, never re-resolved — so the
   * subset survives a respawn. Keyed per session so a concurrent session sharing the cwd is never stripped.
   */
  skills?: string[] | null;
  /**
   * RESUME ONLY (card f05e4897). The permission mode the resumed session must land in — the mode a
   * FRESH spawn of this config reaches (default `auto`). When set, host.ts feedback-cycles the footer
   * to it after SessionStart (bounded + graceful), instead of the FRESH path's blind `startupModeCycles`
   * presses. A `--resume` boots at the gate-free acceptEdits mode (probe-verified — `--resume` honours
   * `--permission-mode`, it does NOT restore the persisted mode), so without this nudge it would stay
   * one short of auto. Omit for fresh/fork/recycle spawns (they use the blind relative count and work).
   */
  resumeModeTarget?: LandedMode;
  /**
   * Card f9b47cd1: the `-n <name>` session name (see pty/session-name.ts) — a legible resume-picker
   * label, computed UPSTREAM by the caller (sessions/service.ts) from role/agent/project/task, exactly
   * like `model`/`startupPrompt`. Threaded on every FRESH-spawn path; omitted on `--resume`/
   * `--fork-session` (the caller never computes one there — see buildSpawnArgs' doc). createPty
   * ADDITIONALLY gates this on the installed claude version (meetsMinVersion) before it ever reaches
   * buildSpawnArgs, so an old claude's argv is byte-identical regardless of what the caller passed.
   */
  sessionName?: string;
}

export interface PtyHostEvents {
  onEngineSessionId(sessionId: string, engineId: string): void;
  /** Persist the turn-in-flight flag (rising on UserPromptSubmit, falling on Stop/StopFailure). */
  onBusy(sessionId: string, busy: boolean): void;
  /** Persist measured engine-context occupancy, refreshed at each turn boundary (Stop). */
  onContextStats(sessionId: string, stats: ContextStats): void;
  /**
   * Card 343441bd: a real worker turn just completed — bump the persisted turn counter (staleDirective's
   * "opportunities to act" clock). Fired EXACTLY ONCE per GENUINE Stop/StopFailure completion, from inside
   * that case's try block, immediately before `drainPending` — deliberately NOT at the `setBusy(false,
   * "stop-hook")` falling edge itself, and deliberately NOT from any of the other FIVE setBusy(false)
   * sites in this file:
   *   - `healIfStuck`'s two sites and `sendEnterAndVerify`'s give-up-recovery two — a submit that was
   *     NEVER CONFIRMED to have started; the worker had no real opportunity to act, so counting them would
   *     inflate turnsSinceDelivery for non-opportunities and could FALSE-FIRE the no-false-alarm-critical
   *     staleDirective signal.
   *   - `interruptForRedirect`'s settle site — a real turn that WAS running, cut short by a manager's own
   *     `worker_redirect`; skipping it only UNDER-counts, which can make staleDirective fire later or not
   *     at all, never earlier/falsely, so it's safe to exclude.
   *   - the two usage-cap PARK `break`s inside the Stop/StopFailure case itself (the §19c rate-limit
   *     StopFailure park, and the weekly-cap text-sentinel park) — a capped/parked turn is EQUALLY a
   *     non-opportunity (the worker never got to act; a rate-limited worker is a different signal, owned
   *     by the rate-limit park), so the call site sits AFTER both breaks, not at the setBusy(false) edge
   *     they also pass through. Every OTHER path between that edge and drainPending (a failed/successful
   *     context-stats read, the paste-placeholder tripwire) falls through to the call site, so it still
   *     fires for every turn that reaches drain — never zero, never twice.
   * A future edit must NOT wire this to any of those five setBusy(false) sites, and must NOT move it back
   * above the two park breaks — doing either reintroduces exactly the false-alarm risk this scoping was
   * designed to avoid. A wedged/stuck worker is a DIFFERENT signal, owned by the busy-stuck watchdog.
   *
   * OPTIONAL (unlike its siblings above) so the many existing test doubles that construct a `PtyHostEvents`
   * object (the shared `SeamHost` fake-pty double in test/_seam-host-fixture.mjs, used across 115 daemon
   * tests) don't all need updating just to add a no-op for a callback their scenario never exercises —
   * the call site below uses `?.`. Production (index.ts) always wires a real implementation.
   */
  onTurnCompleted?(sessionId: string): void;
  /**
   * Card 417cea0a: a confirming hook proved, BY CONTENT MATCH, that a give-up-tracked message actually
   * landed — fired from `purgeConfirmedGiveUpRequeue`'s single-`batchId` CONFIRMED branch, right where
   * the "CONFIRMED logicalId=… latencyMs=…" log line already fires (this is that same signal, exposed to
   * a caller instead of only ever reaching stdout). `logicalId` is the chain's `rootMsgId` (see
   * `QueuedMessage.logicalId`'s own doc — stable across every re-mint). PtyHost itself cannot tell whether
   * `logicalId` was ever terminally PARKED (`session_message_gave_up` outcome:"parked") vs. still
   * mid-chain when this confirmation arrived — that needs the DB, which this class deliberately does not
   * hold (mirrors `getCapabilityCatalog`/`getIntegrationPaths` above) — so the implementer (sessions/
   * service.ts) is the one that decides whether this is news (a previously-parked message, worth a
   * `[loom:redelivery-confirmed]` sender notice) or a no-op (an ordinary mid-chain confirmation).
   * ⛔ NEVER fired from the `batchIds.size > 1` branch just above (see that branch's own doc, card
   * bc0774c4) — a content match spanning more than one give-up batch is left completely unresolved by
   * design, so a message parked under a colliding signature will NOT produce a confirmed-after-park
   * notice; there is nothing here to attribute the confirmation to. OPTIONAL, same rationale as
   * `onTurnCompleted` above — every existing `PtyHostEvents` test double is unaffected until it opts in.
   */
  onGiveUpConfirmed?(sessionId: string, logicalId: string, latencyMs: number): void;
  /**
   * Card a8f8a8f2: `scheduleKickoffGuarantee`'s synthetic turn-1 origin (the DIRECT `submit()` that
   * delivers a fresh session's startup prompt) exhausted `GIVE_UP_REQUEUE_LIMIT` on that ONE message —
   * the entire task dispatch (the session's brief/kickoff) is about to be dropped with nothing further
   * PtyHost itself can do about it (no DB, no manager/task lookup — same layering boundary as
   * `onGiveUpConfirmed` above). OPTIONAL, same rationale as `onGiveUpConfirmed`/`onTurnCompleted`: every
   * existing `PtyHostEvents` test double is unaffected until it opts in. The implementer (sessions/
   * service.ts, via index.ts) decides how to park + notify — see `handleKickoffGiveUpExhausted`'s own doc.
   *
   * Card 00bd3b4a: `msgId`/`rootMsgId` are the synthetic origin's OWN `id`/`logicalId` (see
   * `QueuedMessage.logicalId`'s doc) — passed through so the implementer can record the SAME durable
   * `session_message_gave_up` (outcome:"parked") event every OTHER give-up-exhausted path already records
   * (`handleGiveUpExhausted`'s park branch), keyed the same way `onGiveUpConfirmed`'s `logicalId` above
   * already correlates against. Without this, a late confirming hook that content-matches this exact
   * `rootMsgId` (line 5490's `requeueGiveUpOrigin` seeds `Live.ambiguousDispatches` for this message
   * REGARDLESS of which branch it took, so a late match fires `onGiveUpConfirmed` even after exhaustion)
   * has no durable "parked" record to retract — `handleGiveUpConfirmed`'s lookup finds nothing and silently
   * no-ops, so the notice this hook already sent can never be corrected. This was the structural gap card
   * 00bd3b4a's incident exposed: a healthy, 35-turn-deep worker whose kickoff confirmed LATE (per pinned
   * memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`) got a categorical
   * "nothing began at all" notice with no way for Loom to ever say otherwise once the confirmation caught up.
   *
   * Card 7772176d: `kickoffText` (the pristine `live.startupPrompt` this synthetic origin was built from)
   * is now passed through too — the implementer needs the actual text to give the kickoff the SAME
   * cross-turn-boundary re-mint an ordinary durable message gets from `handleGiveUpExhausted` before ever
   * parking (see that method's doc for why park-only, with no retry at all, under-serves a kickoff exactly
   * as it would any other message). Nothing upstream of `scheduleKickoffGuarantee`'s own closure ever
   * persisted this text anywhere else this handler could read it back from, so it must ride the event.
   */
  onKickoffGiveUpExhausted?(sessionId: string, msgId: string, rootMsgId: string, kickoffText: string): void;
  /**
   * §19c: the turn ended in a usage-limit StopFailure. `until` is the ISO resume instant; the
   * pty is left ALIVE (a cap doesn't kill it). Wired to persist the park + record global awareness.
   * `detail.detector` (card 33d5aef1) names which of the two park sites below fired — `"stop_failure"`
   * (the structured StopFailure{error:"rate_limit"} check) or `"weekly_text_sentinel"` (the weekly/account
   * TEXT sentinel fallback, which never carries a `resetsAtSeconds`) — so the durable `session_rate_limited`
   * event can distinguish them; ⛔ don't back-infer one from the other's absence downstream of this call.
   */
  onRateLimited(sessionId: string, until: string, detail: { resetsAtSeconds?: number; message: string; detector: "stop_failure" | "weekly_text_sentinel" }): void;
  /**
   * Card b68d1f5b DoD-1/DoD-2: `detectPastePlaceholderLengthLoss` (paste-tripwire.ts) found a `[Pasted
   * text #N +M lines]` placeholder in a turn's recorded text that no known Loom write explains — a
   * delivery gap the existing `detectBarePastePlaceholderTripwire`+recovery mechanism structurally cannot
   * see (that one needs `submittedText`, i.e. text LOOM ITSELF wrote; this fires precisely when nothing
   * Loom wrote explains the placeholder — the human/raw-terminal-paste gap card b68d1f5b names). PtyHost
   * itself cannot recover or notify beyond the session itself (no DB, no manager lookup — same layering
   * boundary as `onKickoffGiveUpExhausted` above); the implementer (sessions/service.ts, via index.ts)
   * decides how to fail LOUD to both the recipient (this session) and — where one exists — the sender
   * (e.g. a worker's manager, the one party who can actually resend). OPTIONAL, same rationale as
   * `onGiveUpConfirmed`/`onKickoffGiveUpExhausted`: every existing `PtyHostEvents` test double is
   * unaffected until it opts in.
   */
  onPasteLengthLoss?(sessionId: string, candidate: PasteLengthLossCandidate): void;
  /**
   * Card 47c11741: the bare-placeholder tripwire's own one-shot RECOVERY re-injection (`PASTE_RECOVERY_TAG`,
   * paste-tripwire.ts) ALSO collapsed — the give-up path, right where the combined `[paste-tripwire]`
   * console.warn (this file's Stop-hook call site) already fires. Distinct from `onPasteLengthLoss` above:
   * that one fires when Loom never wrote the lost text at all (the human/raw-paste gap); THIS one fires
   * when Loom DID write it (twice) and DID detect both collapses, but the automatic-recovery budget is
   * exhausted (one-shot by design — see the call site's own doc for why a second automatic attempt isn't
   * warranted). PtyHost itself cannot notify beyond the session (no DB, no manager lookup — same layering
   * boundary as `onPasteLengthLoss`/`onKickoffGiveUpExhausted` above); the implementer (sessions/
   * service.ts) decides how to fail loud to both the recipient and — where one exists — the sender,
   * reusing `handlePasteLengthLoss`'s established shape rather than inventing a second one. `token` is
   * whatever `matchEmbeddedPlaceholderToken` found in this turn's recorded text (may be `null` — the
   * give-up itself never depends on a token match). OPTIONAL, same rationale as its siblings above: every
   * existing `PtyHostEvents` test double is unaffected until it opts in.
   */
  onPasteTripwireGiveUp?(sessionId: string, info: { token: string | null; engineSessionId: string | null }): void;
  /**
   * The pty exited. `intended` distinguishes a DELIBERATE Loom termination (any pty.stop() — graceful/
   * idle/user-stop/recycle/merge-stop/run-teardown, which set `live.stopping`) from an UNEXPECTED process
   * death (the process died without a stop() — a crash / clean self-exit). It is the load-bearing
   * discriminator the crash-recovery watchdog keys off (recorded at onExit time; a whole-daemon
   * restart/crash never reaches here, so those are excluded for free). See PtyHost.stop / Live.stopping.
   */
  onExit(sessionId: string, code: number | null, info: { intended: boolean }): void;
}

/**
 * The interactive HUMAN-prompt tools Claude Code exposes that would BLOCK an unattended, Loom-driven
 * session on input that can never come from the human:
 *   - `AskUserQuestion` — surfaces a multiple-choice question to the human and waits on their pick.
 *   - `ExitPlanMode` / `EnterPlanMode` — the plan-mode approval prompts (entering plan mode and asking
 *     the human to approve a plan), both model-callable tools.
 * A Loom-driven session's stdin is owned by Loom (a worker by its manager via worker_message/redirect;
 * an operator by the daemon), so any of these blocks the turn forever waiting on a human who will never
 * answer — AND it's a doctrine violation (a worker's only channel is worker_report UP; it must never
 * address the user). `/worker` doctrine already forbids it, but a model reached for the prompt anyway,
 * so we make it STRUCTURALLY impossible at spawn (board card 8dd1dd1c).
 */
export const HUMAN_PROMPT_TOOLS: readonly string[] = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"];

/**
 * The engine's NATIVE task-tracking tools (TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate —
 * NOT the `mcp__loom-tasks__tasks_*` board tools, a disjoint namespace). A board-driven role's real task
 * surface IS the loom-tasks board (manager/platform/auditor coordinate via the MCP board, never these),
 * so leaving the native tools registered buys nothing but a recurring "task tools haven't been used
 * recently…" `<system-reminder>` the session reasons past every turn (confirmed live: a manager
 * explicitly dismissed it mid-orchestration). The engine's reminder is gated on the native Task tools
 * being present in the session's tool list (no settings.json flag suppresses it — `claude-settings.ts`
 * has no such knob); removing them from the tool list removes the reminder's trigger condition, mirroring
 * how {@link HUMAN_PROMPT_TOOLS} is removed below rather than merely denied. (Platform card 33f9f181)
 */
export const TASK_TRACKING_TOOLS: readonly string[] = ["TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate"];

/**
 * The set of roles whose stdin is Loom-driven and which must NEVER block on a human — so they spawn with
 * {@link HUMAN_PROMPT_TOOLS} disallowed:
 *   - `worker`            — driven by its manager (worker_message/redirect); channel up is worker_report.
 *   - `setup`             — the user-facing "Platform" operator; acts on the user's behalf, never blocks.
 *   - `auditor`           — the Platform Auditor (scheduled, read-mostly transcript reviewer).
 *   - `workspace-auditor` — the Workspace Auditor (read-mostly reviewer of the user's own workspace).
 *   - `run`               — a fully autonomous, human-LESS, Loom-driven session; nobody can answer a
 *                           prompt, so a model that called one would block until the hard run-timeout
 *                           reaped it (a wasted full-timeout window + a `timed_out` run).
 *   - `assistant`         — the long-lived Loom Companion; its "human" reaches it over a CHAT channel and
 *                           it answers via `chat_reply`, so its stdin is never a live TUI human — an
 *                           interactive prompt would block on input that never comes.
 * DELIBERATELY EXCLUDED (left byte-identical): `manager`/orchestrator + `platform` (the human-driven
 * Platform Lead) legitimately surface decisions to the human; a plain (role-less) session is out of
 * scope.
 *
 * SEPARATELY, the set of BOARD-DRIVEN roles — `manager`/orchestrator, `platform`, `auditor` — spawn with
 * {@link TASK_TRACKING_TOOLS} disallowed (a disjoint concern from the human-prompt disallow above; `auditor`
 * gets BOTH sets, unioned). `workspace-auditor`/`setup`/`worker`/`run`/`assistant`/plain are left
 * byte-identical on this dimension: their real task surface isn't the loom-tasks board the same way, and
 * scoping narrowly avoids suppressing a signal a role might still find useful.
 *
 * Pure + exported so the spawn-args test asserts the per-role mapping with no real claude. (board card
 * 8dd1dd1c; task-tracking-tools split: Platform card 33f9f181)
 */
export function disallowedToolsForRole(role?: SessionRole | null): string[] {
  const out: string[] = [];
  switch (role) {
    case "worker":
    case "setup":
    case "auditor":
    case "workspace-auditor":
    case "run":
    case "assistant":
      out.push(...HUMAN_PROMPT_TOOLS);
      break;
    default:
      break; // manager / platform / plain — no human-prompt disallow
  }
  switch (role) {
    case "manager":
    case "platform":
    case "auditor":
      out.push(...TASK_TRACKING_TOOLS);
      break;
    default:
      break; // worker / setup / workspace-auditor / run / assistant / plain — no task-tracking disallow
  }
  return out;
}

/**
 * The CURATED, HARDCODED set of dangerous NATIVE tools a `restrictedTools` session spawns WITHOUT —
 * removed from the model's tool list via `--disallowedTools` (blast-radius control for a chat-reachable
 * Companion driven by UNTRUSTED inbound chat; CLAUDE.md load-bearing rule #5). Four categories:
 *
 *  RAW SHELL / HOST-WRITES (the direct-damage surface):
 *   - `Bash`         — arbitrary shell / process execution.
 *   - `Edit` / `Write` / `NotebookEdit` — host filesystem writes (auto-accepted under acceptEdits).
 *   - `MultiEdit`    — the multi-hunk write tool. Included DEFENSIVELY: it is NOT present in the current
 *                      engine's native toolset (Edit's replace_all subsumed it), so disallowing it is a
 *                      harmless no-op today — kept so a future re-introduction can't silently re-open a
 *                      host-write vector.
 *
 *  SUBAGENT DELEGATION (closes the residual BYPASS — the important one):
 *   - `Task` / `Agent` — the subagent-launch tool. Without this a restricted companion could spawn a
 *                      general-purpose subagent that re-acquires Bash/Write, defeating the whole
 *                      restriction (we can't rely on a subagent inheriting the parent's --disallowedTools).
 *                      Removing the delegation tool makes that inheritance question MOOT. BOTH names are
 *                      listed on purpose: the classic Claude Code name is `Task`, but the CURRENT engine
 *                      exposes it as `Agent` — disallowing a non-present name is a harmless no-op, so listing
 *                      both closes the bypass regardless of which name the spawned `claude` registers.
 *
 *  NETWORK EGRESS (exfil / SSRF for an agent reading untrusted chat):
 *   - `WebFetch` / `WebSearch` — outbound network. A companion exposed to untrusted input should not have a
 *                      data-exfiltration / SSRF channel; a companion that genuinely needs web runs with the
 *                      flag OFF (the human widens deliberately).
 *
 * NOT restricted: Read/Glob/Grep (read-only — a companion needs context) and the MCP tools
 * (my_context/chat_reply/skill_*). FIXED by construction — never agent- or free-form-configurable; the
 * human WIDENS by turning the flag OFF. Frozen so a caller can't mutate the shared constant.
 */
export const RESTRICTED_NATIVE_TOOLS: readonly string[] = Object.freeze([
  "Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Task", "Agent", "WebFetch", "WebSearch",
]);

/**
 * The FULL `--disallowedTools` list for a spawn: the role's disallow list ({@link disallowedToolsForRole}
 * — the human-prompt tools, the task-tracking tools, or both) UNIONed (de-duped, role tools first) with
 * {@link RESTRICTED_NATIVE_TOOLS} iff `restrictedTools` is on, with {@link CODESCAPE_WRITE_TOOLS} iff
 * `codescapeMounted` is true (the mounted Codescape MCP still advertises its 5 write tools even though
 * they're never allowlisted — see CODESCAPE_WRITE_TOOLS's doc for why that alone isn't enough), AND with
 * {@link PLAYWRIGHT_DISALLOWED_TOOLS} iff `playwrightMounted` is true (the mounted Playwright MCP's
 * `--allowedTools` grant is the whole-server wildcard, which includes the RCE-equivalent
 * `browser_run_code_unsafe` — see PLAYWRIGHT_DISALLOWED_TOOLS's doc), AND — ONLY when `role ===
 * "assistant"` — with {@link ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS} (the host-file-reading
 * file_upload/drop pair; role-scoped because worker rigs legitimately need them — see that const's
 * doc). When ALL of restrictedTools/codescapeMounted/playwrightMounted are off/falsy this returns
 * EXACTLY `disallowedToolsForRole(role)` — so the flag-off argv is BYTE-IDENTICAL to today (no
 * restricted/codescape/playwright tokens appended). Pure + exported so the spawn-args test asserts the
 * union + the byte-identical-off invariant with no real claude. (Companion blast-radius card; Codescape C2
 * hardening; card 7159466a Playwright hardening; card f1609e1a assistant file_upload/drop hardening.)
 */
export function disallowedToolsForSpawn(role?: SessionRole | null, restrictedTools?: boolean, codescapeMounted?: boolean, playwrightMounted?: boolean): string[] {
  const base = disallowedToolsForRole(role);
  if (!restrictedTools && !codescapeMounted && !playwrightMounted) return base; // OFF: exactly the role's disallow list (byte-identical to today)
  const merged = [...base];
  if (restrictedTools) for (const t of RESTRICTED_NATIVE_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (codescapeMounted) for (const t of CODESCAPE_WRITE_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (playwrightMounted) for (const t of PLAYWRIGHT_DISALLOWED_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (playwrightMounted && role === "assistant") for (const t of ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped — role-scoped
  return merged;
}

/**
 * Collect every capability-injected env value riding an assembled mcpServers map's `env` blocks
 * (agent-tooling P4 credential tie — see resolveCapabilityServer). This reads STRUCTURALLY (any string
 * value under any server's `env`), not by name — so it is deliberately NOT "secrets only": a
 * `wantsScratchDir` row's non-secret scratch-dir path (injected via `outputDirEnvVar`, see registry.ts)
 * rides the exact same `env` block and is swept in here too. That's intentional and harmless in both
 * directions this list is used for: `redactSecrets` stripping a value that was never sensitive is a no-op
 * risk-wise, and `mcpConfigHasSecret` treating a scratch-dir-only row as "has a secret" only means that
 * config gets the (strictly safer) file-diversion treatment it would get anyway, never less protection
 * than a config with a real secret. Pure, exported for the hermetic test.
 */
export function collectMcpEnvSecrets(mcpServers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const server of Object.values(mcpServers)) {
    const env = (server as { env?: Record<string, string> } | undefined)?.env;
    if (env) for (const v of Object.values(env)) if (v) out.push(v);
  }
  return out;
}

/**
 * True iff the assembled mcpServers map carries at least one capability-injected env value (secret OR
 * non-secret, e.g. a `wantsScratchDir` row's output-dir path — see {@link collectMcpEnvSecrets}'s doc for
 * why that over-inclusion is deliberate and harmless).
 */
export function mcpConfigHasSecret(mcpServers: Record<string, unknown>): boolean {
  return collectMcpEnvSecrets(mcpServers).length > 0;
}

/** Redact every literal occurrence of each secret in `secrets` from `text`. A no-op for an empty list. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
}

/**
 * Assemble the `claude` argv (extracted so the ordering is unit-testable).
 *
 * Card 0050a17e: the startup/kickoff prompt does NOT ride argv at all, for ANY role — it USED TO be
 * positional, behind a `--` end-of-options separator (H2's dash-prompt fix), but that put its FULL
 * TEXT on the Windows `CreateProcess` command line, which has a hard 32766-character ceiling
 * (`WINDOWS_COMMAND_LINE_LIMIT`) — a large agent brief + kickoff (project memory, real CLAUDE.md/SKILL.md
 * excerpts) could blow through it and refuse the spawn outright (the diagnosed occurrence this card
 * fixes). `o.startupPrompt` is accepted here purely so callers don't need a separate code path, but it
 * is NEVER emitted into `args` — the caller (createPty/spawn) instead boots claude with no trailing
 * prompt (identical to how a resume/fork spawn already boots) and delivers the SAME text later via
 * `submit()` once the session reaches `ready` (see `scheduleKickoffGuarantee`). All real flags precede
 * the (now prompt-free) end of the argv; there is no `--` separator at all unless some other future
 * option needs one.
 */
export function buildSpawnArgs(o: {
  resumeId?: string;
  fork?: boolean;
  forkSessionId?: string;
  settingsPath: string;
  mode: string;
  mcpServers: Record<string, unknown>;
  /**
   * Agent-tooling P4 credential-tie hardening: when set, `--mcp-config` uses this FILE PATH instead of
   * inlining `o.mcpServers` as JSON — the caller (createPty) sets this ONLY when `mcpConfigHasSecret`
   * is true, so a capability secret never rides the `claude` process's own argv (world-readable via
   * `/proc/PID/cmdline`, `ps`, Windows WMI CommandLine). DELIBERATELY a conditional branch, not a
   * blanket switch to files: every secret-free spawn (every session today, incl. the whole self-hosting
   * orchestration fleet) MUST stay on the byte-identical inline form — this is the load-bearing spawn
   * recipe, and always-file-ing it would risk the resume-after-daemon_restart path for zero benefit on
   * the overwhelmingly common secret-free case. Undefined/omitted ⇒ byte-identical to before this option
   * existed (inline `o.mcpServers` JSON).
   */
  mcpConfigPath?: string;
  /**
   * Card 0050a17e: accepted for API convenience (callers pass the same opts they used to) but DELIBERATELY
   * NEVER emitted into argv — see this function's own doc. Kept as a named field (not dropped from the
   * signature) so `createPty`'s existing call site and the preflight measurement don't need a shape change.
   */
  startupPrompt?: string;
  /** Profile-pinned model id → `--model <id>`. Undefined/empty ⇒ NO `--model` (byte-identical to today). */
  model?: string;
  /**
   * Role-scoped tools to forbid the model from EVER calling (the interactive human-prompt tools, for a
   * Loom-driven role — see {@link disallowedToolsForRole}). Emitted as `--disallowedTools <name…>` (the
   * documented variadic flag, which REMOVES the tools from the model's tool list, not merely auto-denies).
   * Empty/absent ⇒ NO `--disallowedTools` (byte-identical to today for every out-of-scope role).
   */
  disallowedTools?: string[];
  /**
   * Card f9b47cd1: `-n <name>` — a legible resume-picker label (Claude Code's own session-naming
   * feature). The CALLER (createPty) has ALREADY version-gated this against the installed claude
   * (meetsMinVersion(getCachedClaudeVersion())) before it ever reaches this pure function, so this
   * itself does no gating — it just emits when present. Emitted ONLY when set, so a resume/fork spawn
   * (the caller never computes one there) or a pre-2.1.196 claude (the caller passes undefined) stays
   * byte-identical to before this option existed.
   */
  sessionName?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  // Fork: resume the conversation but mint a FRESH engine session id so the copy diverges and the
  // source transcript is untouched. We PRE-ASSIGN that id (--session-id) rather than let claude
  // auto-generate it, because --fork-session mints the new id lazily (on the first turn, not at
  // SessionStart) — so capturing it from the hook would grab the OLD id. Pre-assigning lets us
  // persist the fork's id up front. (Only meaningful alongside --resume.)
  if (o.fork && o.resumeId) {
    args.push("--fork-session");
    if (o.forkSessionId) args.push("--session-id", o.forkSessionId);
  }
  args.push("--settings", o.settingsPath);
  args.push("--permission-mode", o.mode);
  // Profile-pinned model: a real flag (precedes `--`). Emitted ONLY when set, so a profile-less /
  // model-null / resume / fork spawn is byte-identical (no `--model`) and inherits the engine default
  // (or, on resume, the conversation's own model from the transcript).
  if (o.model) args.push("--model", o.model);
  // Role-scoped disallow of the interactive human-prompt tools. Placed BEFORE --strict-mcp-config so its
  // variadic value list is terminated by that flag — keeping the variadic `--mcp-config` the LAST flag,
  // its value sitting right before the `--` separator (the H2 ordering invariant). Emitted ONLY when
  // non-empty, so every out-of-scope role's argv is byte-identical (additive-when-applicable discipline).
  if (o.disallowedTools && o.disallowedTools.length) args.push("--disallowedTools", ...o.disallowedTools);
  // Card f9b47cd1 session naming: also BEFORE --strict-mcp-config, so `-n`'s single value can never eat
  // into the variadic `--mcp-config` that follows. Emitted ONLY when present (see this param's doc).
  if (o.sessionName) args.push("-n", o.sessionName);
  // Agent-tooling P4: a secret-bearing spawn passes the FILE PATH (never the JSON, never the secret);
  // every other spawn stays the byte-identical inline JSON form (o.mcpConfigPath undefined).
  args.push("--strict-mcp-config", "--mcp-config", o.mcpConfigPath ?? JSON.stringify({ mcpServers: o.mcpServers }));
  // Card 0050a17e: `o.startupPrompt` is DELIBERATELY never emitted here — see this function's own doc.
  return args;
}

/**
 * Windows `CreateProcess`'s command-line ceiling (MSDN: "the maximum length of this string is 32,767
 * characters, including the Unicode terminating null character"). Empirically re-derived against the
 * REAL `node-pty` dependency this daemon spawns through (a binary-searched `node.exe` spawn, card
 * abcf0eba): a command line of exactly 32766 characters (as computed by {@link windowsCommandLine})
 * spawns successfully; 32767 fails with `Cannot create process, error code: 206`
 * (`ERROR_FILENAME_EXCED_RANGE`) — confirming both the constant AND that {@link windowsCommandLine}
 * below matches node-pty's own quoting at the real OS boundary, for the array-args inputs this daemon
 * actually passes (see that function's own doc: it's a behaviourally-equivalent ADAPTATION, not a
 * byte-for-byte port — card 9fea4196). So `> WINDOWS_COMMAND_LINE_LIMIT` is the exact refusal
 * threshold, not a padded guess.
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32766;

/**
 * A behaviourally-equivalent ADAPTATION of node-pty's own argv→command-line quoting (its
 * `windowsPtyAgent.ts` `argsToCommandLine`, MIT-licensed, itself documented as following the
 * `CommandLineToArgvW` MSDN convention) — **not a byte-for-byte port** (measured: 935 chars theirs vs
 * 831 ours, source-normalised, against node-pty@1.1.0 — card 9fea4196). It covers ONLY the array-args
 * path node-pty takes when `args` is an array, which is every call this daemon ever makes. node-pty's
 * `isCommandLine` branch — `args` passed as a raw STRING, handled as
 * `` argsToCommandLine(file, []) + " " + args `` with no per-character quoting/escaping at all — is
 * deliberately NOT implemented here; the runtime guard below turns that unimplemented case into a
 * loud, named error instead of silently mis-quoting it (a `readonly string[]` TYPE alone doesn't
 * protect this function: it's exported and reachable from compiled JS, where the type has already
 * erased). On the array-args path, this adaptation is verified byte-identical to node-pty's real
 * output over a branch-derived corpus (test/node-pty-quoting-parity.mjs, Windows-only) — a
 * hand-maintained copy, not an import, precisely so a future node-pty quoting change reds that TEST
 * instead of silently drifting or moving a build-time import (see the test's own header). Deliberately
 * NOT imported from the `node-pty` package in PRODUCTION: that function lives under its compiled
 * `lib/` path, not the package's public entrypoint, so importing it here would pin the real spawn path
 * to an unsupported internal surface a future node-pty bump could silently move or change. This is our
 * OWN copy, used purely to COMPUTE a length — it never spawns anything itself.
 */
export function windowsCommandLine(file: string, args: readonly string[]): string {
  // node-pty's isCommandLine branch (raw string args) is not implemented here — see this function's
  // own doc. A TS type is compile-time only; this function is reachable from compiled JS where the
  // type has erased, so the array-only assumption needs a real runtime check, not just a signature.
  if (!Array.isArray(args)) {
    throw new Error(
      "windowsCommandLine: array args only — node-pty's isCommandLine (raw string args) branch is not implemented here (see card 9fea4196)",
    );
  }
  const argv = [file, ...args];
  let result = "";
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) result += " ";
    const arg = argv[argIndex] ?? "";
    const hasLopsidedEnclosingQuote = (arg[0] !== "\"") !== (arg[arg.length - 1] !== "\"");
    const hasNoEnclosingQuotes = arg[0] !== "\"" && arg[arg.length - 1] !== "\"";
    const quote = arg === "" || ((arg.indexOf(" ") !== -1 || arg.indexOf("\t") !== -1) &&
      arg.length > 1 && (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes));
    if (quote) result += "\"";
    let bsCount = 0;
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i];
      if (p === "\\") {
        bsCount++;
      } else if (p === "\"") {
        result += "\\".repeat(bsCount * 2 + 1);
        result += "\"";
        bsCount = 0;
      } else {
        result += "\\".repeat(bsCount);
        bsCount = 0;
        result += p;
      }
    }
    if (quote) {
      result += "\\".repeat(bsCount * 2);
      result += "\"";
    } else {
      result += "\\".repeat(bsCount);
    }
  }
  return result;
}

/**
 * Card abcf0eba part (a): preflight the EXACT, post-escaping, platform-aware command-line length a
 * spawn is about to produce, and fail ACTIONABLY instead of letting a bare Windows `CreateProcess`
 * `error code: 206` reach the caller with no indication of what's oversized (see WINDOWS_COMMAND_LINE_LIMIT's
 * doc for how this constant was grounded — an exact, empirically-confirmed boundary, not a guess).
 *
 * Takes the REAL `bin`+`args` this spawn is about to hand `node-pty` (computed by the SAME
 * `buildSpawnArgs` call the real spawn uses) so there is no risk of the preflight and the actual spawn
 * ever disagreeing about what "the command line" is — one measurement, reused for both the check and
 * (if it passes) the real spawn.
 *
 * Windows-only: POSIX `execve`'s argv/environ ceiling (`ARG_MAX`) is measured differently (combined
 * argv+environ bytes) and is typically several MB — multiple orders of magnitude above the settings
 * path / MCP config / disallowed-tools list this daemon actually puts on argv — so this is deliberately
 * NOT enforced on POSIX; the caller gates this function on `process.platform === "win32"` (see
 * `createPty`).
 *
 * Card 0050a17e removed the per-part "which knob to shorten" breakdown this used to take (a labeled
 * split of the startup prompt's own contributors, e.g. a worker's agent base brief vs its
 * kickoffPrompt): the startup prompt no longer rides argv AT ALL (buildSpawnArgs never emits it — see
 * that function's own doc), so a breakdown of ITS contributors would now describe text that isn't even
 * part of `cmdLine` — actively misleading, not just stale. What CAN still contribute to `args` today —
 * the settings path, the inline `--mcp-config` JSON, `--disallowedTools`, `-n <name>` — has no natural
 * single "shorten this" knob the way the old prompt-only breakdown did, so the refusal message below
 * just names the total length/limit/overage; there's no per-part split to reintroduce until a real
 * incident shows which of those needs one.
 */
export function preflightWindowsCommandLine(
  bin: string,
  args: readonly string[],
): { ok: true } | { ok: false; message: string } {
  const cmdLine = windowsCommandLine(bin, args);
  if (cmdLine.length <= WINDOWS_COMMAND_LINE_LIMIT) return { ok: true };
  const over = cmdLine.length - WINDOWS_COMMAND_LINE_LIMIT;
  return {
    ok: false,
    message: `Spawn refused: the assembled command line is ${cmdLine.length} characters, ` +
      `${over} over the Windows CreateProcess limit of ${WINDOWS_COMMAND_LINE_LIMIT} ` +
      `(this is what produces the raw, unhelpful "Cannot create process, error code: 206" OS failure). ` +
      `Shorten the MCP config / settings path / disallowed-tools list for this spawn — the whole spawn ` +
      `is refused until the combined command line fits.`,
  };
}

/**
 * Assemble the environment for a `claude` worker pty — extracted as a PURE, testable seam mirroring
 * buildMcpServers / buildSpawnArgs. Behavior-preserving for the INHERITED env: the CLAUDECODE/CLAUDE_CODE_*
 * scrub (those vars would make the nested `claude` believe it is running inside another claude) and the
 * sessionEnv merge are unchanged — PLUS three git-safety vars that close the "git wedges the UNATTENDED
 * worker pty" class:
 *   - GIT_PAGER=cat / PAGER=cat — git (and other pager-using tools) can never launch `less` and block
 *     forever on `q`. Without this a worker's post-commit `git diff`/`git log` could page and never
 *     return, freezing the turn at busy → a FALSE [loom:worker-stuck] trip + its worker_report queued
 *     undelivered (the bug this fixes).
 *   - GIT_TERMINAL_PROMPT=0 — git FAILS FAST on an auth/credential prompt instead of hanging on it
 *     (mirrors git/writer.ts; same unattended-wedge class as the pager).
 * The three are set BEFORE the sessionEnv merge, so a project that deliberately overrides any of them via
 * config.sessionEnv still wins (no capability regression). Every other byte of the env is identical to
 * before. Exported so the hermetic spawn-env test asserts the vars, the scrub, and the override.
 *
 * Also carries `LOOM_WORKTREE=spawnCwd` — a stable anchor an agent's OWN Bash calls can reference (e.g.
 * `cd "$LOOM_WORKTREE" && …`) to make a cwd-dependent command deterministic regardless of what an
 * earlier call's `cd` left behind. Loom cannot reset the Bash tool's cwd itself (that shell state is
 * internal to the upstream Claude Code CLI process, invisible past its pty), so this is the strongest
 * reachable mitigation: a known-good absolute anchor, not a reset. Uniform across every session kind —
 * for a worker `spawnCwd` is the worktree root; for a manager/companion/plain session it's just that
 * session's own cwd (repo/project root). Set before the sessionEnv merge, like the git-safety vars, so a
 * deliberate override still wins.
 */
export function buildSpawnEnv(
  processEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string>,
  spawnCwd: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (v !== undefined) env[k] = v;
  }
  // Git-safety vars for the unattended worker pty (close the "git blocks the pty" wedge class). Set
  // BEFORE the sessionEnv merge so a project's deliberate override still wins.
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LOOM_WORKTREE = spawnCwd;
  Object.assign(env, sessionEnv);
  return env;
}

/**
 * The `LOOM_SCRATCH_DIR` env addition for a browser-testing spawn — `@playwright/mcp`'s `checkFile`
 * guard only allows a write inside `--output-dir` (which `buildMcpServers` always points at
 * `sessionScratchDir`) or the subprocess's inherited cwd, so a browser-capable agent needs to be TOLD
 * that path to stage a `browser_file_upload` source file or persist an explicit-path screenshot inside
 * an allowed root — its generic harness scratchpad is neither.
 *
 * Gated on `mcpServers.playwright` itself (the ACTUAL mount decision), not a raw `browserTesting` flag,
 * so this can never disagree with whether the Playwright MCP mounted — a resolution failure (see
 * `playwrightMcpServer`) leaves both the MCP and this var absent. Returns `{}` for every other spawn
 * (fully additive — byte-identical env when off).
 */
export function browserScratchEnv(
  mcpServers: Record<string, unknown>,
  sessionId: string,
): Record<string, string> {
  return mcpServers.playwright ? { LOOM_SCRATCH_DIR: sessionScratchDir(sessionId) } : {};
}

/**
 * The host's default interactive shell, used to PREFILL the "+ Shell" modal (the human can override).
 * Windows: prefer PowerShell 7 (pwsh), else Windows PowerShell, else cmd — returned as an ABSOLUTE path
 * (node-pty's Windows agent doesn't search %PATH%). Unix: $SHELL, else /bin/bash. This is a convenience
 * default only — it confers no privilege; the spawn is still gated to the human REST path.
 */
export function detectDefaultShell(): string {
  if (process.platform === "win32") {
    for (const c of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      const abs = resolveExecutable(c);
      if (abs !== c) return abs; // resolveExecutable returns the name unchanged when not found on PATH
    }
    return resolveExecutable("cmd.exe"); // System32 is always on PATH, so this resolves
  }
  return process.env.SHELL || "/bin/bash";
}

/**
 * Best-effort reap of any descendant process a torn-down pty's root process leaves behind — the backstop
 * for a child that ESCAPES node-pty's own orphan-free containment (its conpty kill path walking
 * _getConsoleProcessList() on Windows — not a Job Object, node-pty@1.1.0 has none — / a process-group
 * kill on POSIX) by detaching into its own process group/session — e.g. a `pnpm dev` vite dev-server the
 * agent backgrounds via its own Bash tool while verifying UI work (Web-Designer/QA workers), which then
 * outlives the session and walks the port range (board card 621ef252 — six stale vite servers observed).
 *
 * Called from the pty's `onExit` — the ONE chokepoint every exit path shares (a graceful/hard stop, a
 * recycle's predecessor stop, or an unexpected crash) — so it's DURABLE: it runs even when the root
 * process died without going through PtyHost.stop() at all.
 *
 * By the time this runs the root process is ALREADY DEAD (onExit only fires after exit), which rules out
 * `taskkill /T` on Windows — verified empirically that it refuses to walk the descendant tree once the
 * given PID is no longer a running process (it just errors "process not found" and stops). What DOES
 * still work: a process's `ParentProcessId` is stamped at CREATION and stays queryable via WMI/CIM long
 * after the parent has exited (verified). So we enumerate the FULL process list ourselves — Windows via
 * `Get-CimInstance Win32_Process` (CIM, not the deprecated `wmic`), POSIX via `ps -eo pid,ppid` — walk the
 * descendant tree from `rootPid` in-process, and force-kill each survivor directly (each already confirmed
 * a live pid by appearing in the snapshot, so a plain `process.kill` suffices — no further tree tool needed).
 *
 * Fire-and-forget: spawns a helper process asynchronously and never throws or blocks the caller. A missing
 * OS tool, an empty process list, or a pid already gone is a silent no-op. Narrow accepted race: OS PID
 * reuse could in principle attribute an unrelated process's children to a long-dead `rootPid` — the same
 * class of risk already accepted elsewhere in Loom for pid-keyed process tracking. That SAME reuse race
 * can also fabricate a parent-map CYCLE (e.g. `A.ppid=B` and `B.ppid=A`) — impossible in a real process
 * tree but reachable via a reused pid — so the walk below tracks `seen` pids and never revisits one; without
 * it a cycle would spin the `while (stack.length)` loop forever and freeze the daemon's event loop (`sweep`
 * runs synchronously in-process on `cmd`'s `close` event, not in the spawned helper).
 */
export function reapOrphanedDescendants(rootPid: number): void {
  const sweep = (out: string): void => {
    const byParent = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)[,\s]+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (pid === ppid) continue; // guard a malformed/self-referential row
      let list = byParent.get(ppid);
      if (!list) { list = []; byParent.set(ppid, list); }
      list.push(pid);
    }
    const seen = new Set<number>();
    const stack = [rootPid];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue; // bounds the walk to each pid at most once — breaks any parent-map cycle
      seen.add(p);
      for (const child of byParent.get(p) ?? []) {
        try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
        stack.push(child);
      }
    }
  };
  const cmd = process.platform === "win32"
    ? spawnProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }",
      ], { stdio: ["ignore", "pipe", "ignore"] })
    : spawnProcess("ps", ["-eo", "pid,ppid"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  cmd.stdout?.on("data", (d) => { out += d; });
  cmd.on("error", () => { /* helper unavailable — best-effort, never throws */ });
  cmd.on("close", () => sweep(out));
}

/**
 * One live OS process, as far as {@link reapProcessesRootedInWorktree} needs to know about it. Any field
 * the platform can't supply is `null` (e.g. POSIX gives no separate executable-path-vs-cwd distinction for
 * a gone/permission-denied pid; win32's CIM query gives no cwd at all) — the caller ORs across whichever
 * fields ARE populated, so a partial read still matches.
 */
export interface WorktreeProcess {
  pid: number;
  exePath: string | null;
  cwd: string | null;
  commandLine: string | null;
}

/** Injectable process lister for {@link reapProcessesRootedInWorktree} (defaults to the real OS
 *  enumerator). Takes the same `timeoutMs` the caller is bounding by, so an enumerator that itself spawns
 *  a helper process (win32) can bound + kill that helper on timeout rather than merely being raced and
 *  abandoned by an outer wrapper — see {@link enumerateProcessesWin32}. Must REJECT (never resolve `[]`)
 *  on a genuine enumeration failure — {@link reapProcessesRootedInWorktree}'s catch is what turns a
 *  rejection into a loud, classified log line plus `enumerationFailed: true`, instead of a result that
 *  looks identical to "no matching process exists". A rejection MAY carry `timedOut: true` (see
 *  {@link enumerateProcessesWin32}'s timeout branch) — {@link enumerateWithRetry} retries ONLY that
 *  specific shape, never a spawn error / empty-output / parse-error rejection (card ed9c448d). */
export type ProcessEnumerator = (timeoutMs: number) => Promise<WorktreeProcess[]>;
/** Injectable process killer for {@link reapProcessesRootedInWorktree} (defaults to a real OS kill). */
export type ProcessKiller = (pid: number) => void;

/** Normalize a path for substring matching: backslashes → forward slashes, lowercased, no trailing slash. */
function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * Is `proc` rooted under `worktreePath` — by executable path, cwd, OR command line? This is the
 * SAFETY-CRITICAL predicate: {@link reapProcessesRootedInWorktree} kills only what this returns true for,
 * so a false positive here would kill an unrelated (possibly live) process. Guards against a PREFIX
 * collision (worktree `…/worktrees/abc` must NOT match a process rooted in a SIBLING `…/worktrees/abcdef`
 * — worktree dirs are keyed by a 12-hex task-hash, so this is a defense-in-depth belt, not a load-bearing
 * assumption) by requiring the match to land on a path-segment boundary: the candidate string must EQUAL
 * the normalized worktree path or contain it immediately followed by `/`. Pure (no I/O) — unit-testable
 * without spawning anything.
 */
export function processRootedInWorktree(proc: WorktreeProcess, worktreePath: string): boolean {
  const target = normalizePathForMatch(worktreePath);
  const targetWithSep = `${target}/`;
  const matches = (s: string | null): boolean => {
    if (!s) return false;
    const n = normalizePathForMatch(s);
    return n === target || n.includes(targetWithSep);
  };
  return matches(proc.exePath) || matches(proc.cwd) || matches(proc.commandLine);
}

/** Real POSIX process enumerator: walk `/proc/<pid>` reading `exe`/`cwd` (symlinks) and `cmdline` (NUL-
 *  joined argv). Any per-pid read failure (permission denied, or the pid exited mid-scan) is swallowed —
 *  that pid is simply reported with whatever fields DID resolve, or omitted if none did. */
async function enumerateProcessesPosix(_timeoutMs: number): Promise<WorktreeProcess[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir("/proc");
  } catch {
    return [];
  }
  const procs: WorktreeProcess[] = [];
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (pidStr) => {
    let exePath: string | null = null;
    let cwd: string | null = null;
    let commandLine: string | null = null;
    try { exePath = await fs.promises.readlink(`/proc/${pidStr}/exe`); } catch { /* gone/denied */ }
    try { cwd = await fs.promises.readlink(`/proc/${pidStr}/cwd`); } catch { /* gone/denied */ }
    try {
      const raw = await fs.promises.readFile(`/proc/${pidStr}/cmdline`, "utf8");
      const joined = raw.split("\0").filter(Boolean).join(" ");
      if (joined) commandLine = joined;
    } catch { /* gone/denied */ }
    if (exePath || cwd || commandLine) procs.push({ pid: Number(pidStr), exePath, cwd, commandLine });
  }));
  return procs;
}

/** Matches any raw ASCII control character (0x00–0x1F) — built from char codes so the source never embeds
 *  a literal control character itself. Strips ESC (0x1B) among others, which is what neutralizes an
 *  embedded terminal escape sequence — e.g. the bracketed-paste terminator `\x1b[201~` becomes the inert
 *  literal text `[201~` once its leading ESC is gone. See its use in {@link enumerateProcessesWin32}, and
 *  (exported) in sessions/service.ts to sanitize gate output before it's piped through `enqueueStdin`. */
export const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");

/**
 * Parse {@link enumerateProcessesWin32}'s raw PowerShell stdout (a `ConvertTo-Json -Compress` array) into
 * {@link WorktreeProcess} records. Pure + exported so a test can drive it directly with a crafted payload
 * instead of spawning a real `powershell.exe` — see `test/worktree-process-reap.mjs`'s deterministic
 * enumeration-failure regression guard.
 *
 * THROWS on a malformed payload (never silently drops to an empty array) — this is the other half of the
 * fix for a real P1: a live self-hosting daemon host had `[Console]::OutputEncoding` defaulting to a
 * single-byte, non-UTF8 codepage (IBM850/CP850 — confirmed via `[Console]::OutputEncoding` + `chcp`), so
 * any character in ANY live process's `CommandLine` that codepage's best-fit encoder couldn't cleanly
 * round-trip could corrupt the ALREADY-CORRECTLY-ESCAPED JSON `ConvertTo-Json` had produced — breaking
 * `JSON.parse` for the WHOLE array, not just the one affected process. {@link enumerateProcessesWin32} now
 * forces `[Console]::OutputEncoding` to UTF8 (verified live: the same query against 465 real processes on
 * that host threw a JSON parse error without it, and parsed cleanly with it) — but the NEXT surprise in
 * that payload must not go silent either, so this function throws with the JSON position + a short
 * excerpt around it, and the caller ({@link enumerateProcessesWin32}) turns that into a rejection instead
 * of a bare `[]`. That silent-collapse was itself the reason a total enumeration failure went undetected:
 * `reapProcessesRootedInWorktree` runs from SEVEN call sites in sessions/service.ts (the merge-confirm
 * pre-gate reap, post-merge `gcWorktreeDir`, worker-stop cleanup, boot/GC sweeps), all of which would
 * silently do nothing on this failure with no observable difference from "nothing needed killing".
 *
 * `ConvertTo-Json` can also leave a raw, UN-ESCAPED control character inside a `CommandLine` string
 * (observed live against real running processes on this host) — a JSON structural character is never
 * below 0x20, so blanking those out is always safe. A leading BOM is stripped defensively too: forcing
 * `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` is documented as BOM-emitting for some .NET
 * writer shapes, though verified empirically NOT to appear for this exact assignment + query shape — a
 * BOM would otherwise break `JSON.parse` at character 0.
 */
export function parseWin32CimStdout(raw: string): WorktreeProcess[] {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const sanitized = withoutBom.replace(CONTROL_CHAR_RE, " ");
  const text = sanitized || "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = (err as Error).message;
    const offsetMatch = /position (\d+)/.exec(message);
    const offset = offsetMatch ? Number(offsetMatch[1]) : null;
    const excerpt = offset != null ? text.slice(Math.max(0, offset - 60), offset + 60) : text.slice(0, 120);
    throw new Error(`${message} (payload length ${text.length}; excerpt around the failure: ${JSON.stringify(excerpt)})`);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((r: Record<string, unknown>) => ({
    pid: Number(r["ProcessId"]),
    exePath: (r["ExecutablePath"] as string | null) ?? null,
    cwd: null,
    commandLine: (r["CommandLine"] as string | null) ?? null,
  }));
}

/** Cap (bytes) on the captured stderr tail kept for diagnostics from a failing win32 CIM query — mirrors
 *  the ~4KB output-tail discipline `codescape/supervisor.ts`'s `runBounded` already uses. */
const STDERR_TAIL_BYTES = 4096;

/**
 * Classify {@link enumerateProcessesWin32}'s outcome once the CIM query's `powershell.exe` has CLOSED
 * CLEANLY — i.e. neither the self-timeout nor a spawn error fired, both handled separately by the caller.
 * Pure + exported so a test can drive it directly with a crafted stdout/stderr pair instead of spawning a
 * real `powershell.exe` — mirrors {@link parseWin32CimStdout}'s own testability shape, and this is the
 * direct follow-up to the failure class that doc-comment explains: the residual gap was that a
 * `powershell.exe` closing FAST and CLEANLY with EMPTY stdout (an execution-policy refusal, a CIM/WMI
 * service problem, a host/profile issue — never surfaced because stderr used to be discarded) sailed
 * through `parseWin32CimStdout`'s `sanitized || "[]"` fallback and came back as a silent, valid-looking
 * `[]` — indistinguishable, at every one of `reapProcessesRootedInWorktree`'s seven call sites, from "no
 * matching process exists". `@(Get-CimInstance Win32_Process | …)` enumerates EVERY live process on the
 * host, and the querying `powershell.exe` is itself always in that result set — so empty stdout on a clean
 * close is ALWAYS anomalous, never a legitimate "nothing running" answer, which is what makes failing on
 * it safe rather than a guess. Treated as the `empty-output` failure kind, same severity as a parse error.
 * `stderrTail` — a bounded capture of the child's own stderr, previously discarded via `stdio: "ignore"` —
 * is folded into whichever failure fires, since a genuine PowerShell error message is exactly the
 * diagnostic this path used to throw away.
 */
export function classifyWin32EnumerationClose(stdout: string, stderrTail: string): WorktreeProcess[] {
  const stderrSuffix = stderrTail ? ` — stderr: ${stderrTail}` : "";
  if (!stdout.replace(CONTROL_CHAR_RE, "").trim()) {
    throw new Error(
      `win32 process enumeration failed (empty-output): powershell.exe closed cleanly but produced no stdout — a live host always has at least the querying process itself, so empty output is always anomalous${stderrSuffix}`,
    );
  }
  try {
    return parseWin32CimStdout(stdout);
  } catch (err) {
    throw new Error(`win32 process enumeration failed (parse-error): ${(err as Error).message}${stderrSuffix}`);
  }
}

/** Real win32 process enumerator: `Get-CimInstance Win32_Process` for every live process's ExecutablePath
 *  + CommandLine (win32 exposes no per-process cwd via CIM, so `cwd` is always null here — Path +
 *  CommandLine is what the live-evidence investigation found sufficient: the esbuild service's OWN
 *  executable runs FROM inside the worktree, and vite's global node.exe carries the worktree path in its
 *  CommandLine). `@(...)` forces array context so ConvertTo-Json returns a JSON ARRAY even for 0 or 1
 *  processes (bare `ConvertTo-Json` on a single object would otherwise emit a bare object, not `[obj]`).
 *  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` is prepended INSIDE the same `-Command`
 *  string — see {@link parseWin32CimStdout}'s doc for why: a non-UTF8 console codepage can corrupt the
 *  CIM query's own JSON output for reasons having nothing to do with the worktree being searched for.
 *
 *  SELF-BOUNDED: unlike the outer {@link withReapTimeout} race (which only stops the CALLER waiting, the
 *  same limitation `withTimeout` in git/worktrees.ts documents for its own callers), this function arms
 *  its OWN timer and force-kills the `powershell.exe` child it spawned if the query hasn't closed by
 *  `timeoutMs` — so a wedged/slow CIM query (WMI contention, a loaded host) can never leave an orphaned
 *  helper process behind, the same leak class this whole feature exists to prevent.
 *
 *  LOUD ON FAILURE: every failure path (spawn error, this self-timeout, empty stdout on a clean close, or
 *  a parse failure — see {@link classifyWin32EnumerationClose}) REJECTS with a classified, descriptive
 *  Error instead of silently resolving `[]` — {@link reapProcessesRootedInWorktree}'s catch logs it and
 *  reports `enumerationFailed: true`, so a total enumeration failure is never indistinguishable from "no
 *  matching process exists" again. stderr is CAPTURED (bounded to a ~4KB tail, not discarded via
 *  `stdio: "ignore"` like before) and folded into whichever classified error fires, so a genuine
 *  PowerShell error message is preserved as a diagnostic instead of thrown away. */
function enumerateProcessesWin32(timeoutMs: number): Promise<WorktreeProcess[]> {
  return new Promise((resolve, reject) => {
    const cmd = spawnProcess("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const captureStderr = (chunk: Buffer): void => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_BYTES && stderrChunks.length > 1) stderrBytes -= stderrChunks.shift()!.length;
    };
    const stderrTail = (): string => {
      const s = Buffer.concat(stderrChunks).toString("utf8").trim();
      return s.length > STDERR_TAIL_BYTES ? s.slice(-STDERR_TAIL_BYTES) : s;
    };
    let settled = false;
    const finish = (result: WorktreeProcess[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (kind: string, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = stderrTail();
      const error: Error & { timedOut?: boolean } = new Error(`win32 process enumeration failed (${kind}): ${detail}${tail ? ` — stderr: ${tail}` : ""}`);
      // Stamped ONLY for the self-timeout branch (never spawn-error) — enumerateWithRetry's retry
      // decision keys off this flag, not the message text, so it can never be fooled by a coincidental
      // substring match in a genuine spawn-error's detail.
      if (kind === "timeout") error.timedOut = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      // Force-kill the query helper itself so a wedged CIM call never leaks an orphaned powershell.exe —
      // mirrors killRemoveChild's win32 posture (taskkill /T /F, then a plain kill as belt-and-suspenders).
      if (cmd.pid) { try { spawnProcess("taskkill", ["/pid", String(cmd.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ } }
      try { cmd.kill(); } catch { /* already gone */ }
      fail("timeout", `CIM query produced no output within ${timeoutMs}ms — force-killed the helper (pid ${cmd.pid ?? "?"})`);
    }, timeoutMs);
    // Explicit utf8 decoding — without it a multibyte sequence split across chunk boundaries could
    // corrupt a CommandLine path and MISS a match (fail-safe: under-kill, not over-kill, since the
    // wedge-retry sweep catches a missed process next pass).
    cmd.stdout?.setEncoding("utf8");
    cmd.stdout?.on("data", (d) => { out += d; });
    cmd.stderr?.on("data", captureStderr);
    cmd.on("error", (err) => fail("spawn-error", err.message));
    cmd.on("close", () => {
      if (settled) return;
      try {
        finish(classifyWin32EnumerationClose(out, stderrTail()));
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  });
}

/** Real process killer: `taskkill /pid <pid> /T /F` on win32 (kills any subtree the survivor itself
 *  spawned too), `SIGKILL` on posix — mirrors {@link killRemoveChild}'s posture (unconditional, immediate,
 *  best-effort — an already-gone pid is a silent no-op). */
function killProcessById(pid: number): void {
  if (process.platform === "win32") {
    try { spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone / no permission */ }
}

/** Reject after `ms` — bounds {@link reapProcessesRootedInWorktree}'s (possibly-retried, see
 *  {@link enumerateWithRetry}) enumerate step so a wedged/slow helper (a hung `powershell.exe`, an
 *  unreadable `/proc`) can never block worktree teardown indefinitely, even one that ignores the
 *  `timeoutMs` it was called with entirely (an injected/broken seam). */
function withReapTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process enumeration exceeded ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Max attempts + flat retry delay for {@link enumerateWithRetry} — exported so a test can assert against
 *  the real constants (e.g. an observed attempt count) instead of a hardcoded duplicate that would silently
 *  drift from a future retune. See {@link enumerateWithRetry}'s doc for the worst-case budget arithmetic
 *  these feed in {@link reapProcessesRootedInWorktree}. */
export const REAP_ENUMERATE_MAX_ATTEMPTS = 2;
export const REAP_ENUMERATE_RETRY_DELAY_MS = 500;

/**
 * Card ed9c448d — ROOT CAUSE (established, not assumed): the observed failure (`test/merge-spawn-
 * tracked.mjs`'s "(merge retain)" scenario, gate tail "CIM query produced no output within 10000ms", at
 * `cap=2 concurrent=2` — genuine host contention) is NEITHER "10s is a permanently broken bound" NOR "the
 * query is unconditionally too expensive to ever finish" — {@link reapProcessesRootedInWorktree}'s catch
 * already treats a failed enumeration as fully non-fatal (fail-closed, logged, `enumerationFailed: true`,
 * never thrown past that function at any of its seven call sites in sessions/service.ts, every one of
 * which ALSO wraps the call in its own best-effort try/catch) — so "failure handled too harshly" is
 * likewise ruled out; the failure was already survivable, just not RECOVERABLE. What actually happens is
 * the SAME shape card f0718488 established for the codescape version probe (`readInstalledBuild`, this
 * file's sibling in `codescape/supervisor.ts`): `Get-CimInstance Win32_Process` enumerates EVERY live
 * process, so under a loaded host (two concurrent merge gates competing for CPU/WMI) a single attempt can
 * transiently miss its own timeout window even though the query would have completed given a little more
 * patience or a slightly quieter moment — contention on this host is bursty, not constant, so a SECOND
 * attempt has a real chance of landing where the first one didn't. Widening the 10s bound would not fix a
 * query that's still contended at 15s or 20s (and this project has a standing rule that widening a
 * constant is not a structural fix — the `7b634e58` family); retrying the SAME bound on a fresh attempt
 * does, for exactly the reason the codescape precedent already proved. Retried ONLY when the rejection is
 * flagged `timedOut: true` (see {@link enumerateProcessesWin32}'s `fail` helper) — a genuine spawn error,
 * empty-output, or parse-error is a real defect, not contention, and retrying one of those would just
 * repeat a guaranteed failure at the cost of extra teardown latency for nothing.
 *
 * Returns the successful attempt's process list plus the number of attempts actually made — read by
 * `test/worktree-process-reap.mjs`'s enumeration-timeout-then-success case, and by a persistent-failure
 * case that counts invocations of its own fake enumerator — so both are asserted on observed attempt
 * counts / observable outcome, NEVER wall-clock (card ca87fc6a is the sibling this deliberately does not
 * repeat). Rethrows the LAST error once attempts are exhausted, or immediately for a non-timeout error.
 */
async function enumerateWithRetry(enumerate: ProcessEnumerator, timeoutMs: number): Promise<{ procs: WorktreeProcess[]; attempts: number }> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < REAP_ENUMERATE_MAX_ATTEMPTS) {
    attempt++;
    try {
      const procs = await enumerate(timeoutMs);
      return { procs, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const timedOut = (err as { timedOut?: boolean } | null)?.timedOut === true;
      if (!timedOut || attempt >= REAP_ENUMERATE_MAX_ATTEMPTS) throw err;
      await sleepMs(REAP_ENUMERATE_RETRY_DELAY_MS);
    }
  }
  // Unreachable in practice (the loop above always returns or throws), kept only so TS sees every path
  // settle without needing a non-null assertion on `lastErr`.
  throw lastErr;
}

/**
 * THE PREVENTION for dangling worktrees (task 8e5a7a5e — live evidence 2026-07-03/04): before a worktree
 * dir is removed, kill any OS process still ROOTED in it — by executable path, cwd, or command line (see
 * {@link processRootedInWorktree}) — that {@link reapOrphanedDescendants}'s pty-tree walk MISSES because
 * it detached/re-parented away from the pty's process tree entirely (an esbuild long-lived service
 * process, a backgrounded vite dev-server, a lingering tsserver/watcher). Without this, such a survivor
 * keeps a file handle open inside the worktree and the subsequent `removeWorktree` hits
 * `ERROR_SHARING_VIOLATION` on Windows (the confirmed root cause of the owner's 8 wedged dead-leftover
 * worktrees) — this closes the window BEFORE that removal is even attempted, rather than reacting to it.
 *
 * SAFETY (this function is the one new code path this task's mandatory Code-Reviewer pass exists for): the
 * match is scoped to EXACTLY the one `worktreePath` the caller is about to tear down, at a path-segment
 * boundary ({@link processRootedInWorktree} — no prefix-collision false-positive across sibling worktree
 * dirs). It is the CALLER's responsibility to only ever invoke this with a worktree that is genuinely being
 * removed (never a live/protected one) — every call site in SessionService (gcWorktreeDir, the single
 * removal chokepoint shared by finalizeMerge, boot-reconcile Pass B, and the wedge-retry sweep) already
 * upholds that invariant for `removeWorktree` itself, so wiring this in right before that same call inherits
 * the same guarantee for free, without this function needing to know anything about sessions/liveness itself.
 *
 * BOUNDED + BEST-EFFORT: the enumerate step is time-boxed both by the outer {@link withReapTimeout} race
 * AND, for the real win32 enumerator, by its OWN internal timer that force-kills its spawned helper (see
 * {@link enumerateProcessesWin32}) — so a wedged query can never leak a helper process on top of failing
 * to find its target. ANY failure (a missing OS tool, an enumeration timeout, a malformed CIM payload, a
 * kill that errors) is still swallowed here — this must never throw or block teardown, mirroring every
 * other best-effort helper in the worktree-removal path — but a REAL P1 (a non-UTF8 PowerShell console
 * codepage on this project's own self-hosting host silently zeroed EVERY enumeration for as long as any
 * live process's CommandLine held a character that codepage couldn't cleanly round-trip, across all
 * SEVEN call sites of this function in sessions/service.ts) proved that "swallowed" must not also mean
 * "invisible": a failure here is now logged with a classified reason via `console.error` and reported
 * back as `enumerationFailed: true`, so it no longer looks identical to a clean `killedPids: []`. See
 * {@link parseWin32CimStdout}'s doc for the mechanism. Injectable via `deps` (enumerate/kill/timeoutMs) so
 * a test can drive it with a fake process list — or a fake enumerator that REJECTS — instead of the real
 * OS.
 *
 * ACCEPTED RISK (both fail-safe / under-kill, not over-kill — reviewed and deliberately kept): (1) the
 * command-line arm of {@link processRootedInWorktree} intentionally over-matches a process that merely
 * NAMES the doomed worktree path in its argv without being rooted there — this is load-bearing, not a
 * bug, because on win32 vite's global node.exe carries the worktree path ONLY in its CommandLine (CIM
 * exposes no per-process cwd), so narrowing the match would miss the exact survivor this function exists
 * to catch. (2) {@link killProcessById}'s win32 path (`taskkill /pid <pid> /T /F`) kills the matched pid's
 * whole subtree, which widens the blast radius past the one matched process — theoretically reaching an
 * ancestor-of-the-daemon if one were ever wrongly rooted in a worktree, though not realistic for a
 * checkout-launched daemon (the daemon's own pid is separately excluded below regardless).
 *
 * SELF-EXCLUSION: the daemon's OWN pid (`process.pid`) is never a kill candidate, regardless of what
 * `processRootedInWorktree` says — a defense-in-depth backstop against the (currently theoretical, but
 * cheap-to-rule-out) case where the daemon's own cwd/exePath/commandLine happens to satisfy the match
 * (e.g. a misconfigured LOOM_HOME nested under the very worktree being torn down). The task's own DoD
 * requires this can never happen; this makes it structurally impossible rather than merely unlikely.
 *
 * `deps.excludePids` (Code Review finding on card 864e79fe): additional pids a caller knows are
 * genuinely rooted in `worktreePath` but must survive anyway — specifically, a worker's OWN claude pty
 * when this is invoked BEFORE that worker has been stopped (confirmWorkerMerge's pre-gate sweep, run
 * while the confirming worker may still be live). Without this, the sweep would kill the worker's own
 * process on every gated confirm — on a subsequent gate FAILURE that would strand a worker meant to
 * survive for re-tasking. This is deliberately separate from the unconditional `process.pid`
 * self-exclusion above: that one is a blanket, always-on backstop for the daemon itself; this one is a
 * caller-supplied, call-site-specific allowance.
 */
export async function reapProcessesRootedInWorktree(
  worktreePath: string,
  deps: { enumerate?: ProcessEnumerator; kill?: ProcessKiller; timeoutMs?: number; excludePids?: number[] } = {},
): Promise<{ killedPids: number[]; enumerationFailed?: boolean; enumerationAttempts?: number }> {
  const enumerate = deps.enumerate ?? (process.platform === "win32" ? enumerateProcessesWin32 : enumerateProcessesPosix);
  const kill = deps.kill ?? killProcessById;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const excluded = new Set(deps.excludePids ?? []);
  // WORST-CASE BUDGET (every attempt hits the full per-attempt timeout — do not retune REAP_ENUMERATE_
  // MAX_ATTEMPTS/REAP_ENUMERATE_RETRY_DELAY_MS without redoing this arithmetic): REAP_ENUMERATE_MAX_
  // ATTEMPTS(2) * timeoutMs(10,000ms default) + (REAP_ENUMERATE_MAX_ATTEMPTS - 1)(1) *
  // REAP_ENUMERATE_RETRY_DELAY_MS(500ms) = 20,500ms for the default timeoutMs. This is the OUTER
  // withReapTimeout bound too — it must cover the retry loop's own genuine worst case, not just one
  // attempt, or it would fire mid-retry and manufacture a fresh timeout out of a legitimate second attempt
  // still in flight. Spent only on the best-effort worktree-teardown path (every call site wraps this
  // function in its own try/catch — see this function's own catch below), so the added worst-case delay
  // costs nothing beyond a slower teardown under exactly the contention that caused the original timeout.
  const totalBudgetMs = REAP_ENUMERATE_MAX_ATTEMPTS * timeoutMs + (REAP_ENUMERATE_MAX_ATTEMPTS - 1) * REAP_ENUMERATE_RETRY_DELAY_MS;
  try {
    const { procs, attempts } = await withReapTimeout(enumerateWithRetry(enumerate, timeoutMs), totalBudgetMs);
    const killedPids: number[] = [];
    for (const proc of procs) {
      if (proc.pid === process.pid) continue; // NEVER the daemon's own process — see SELF-EXCLUSION above
      if (excluded.has(proc.pid)) continue; // caller-supplied survivor — see excludePids doc above
      if (!processRootedInWorktree(proc, worktreePath)) continue;
      try { kill(proc.pid); killedPids.push(proc.pid); } catch { /* best effort */ }
    }
    return { killedPids, enumerationAttempts: attempts };
  } catch (err) {
    // LOUD ON FAILURE: still fail-CLOSED (never widen the kill set on a failure — return nothing to kill,
    // exactly like before) but no longer SILENT — a total enumeration collapse used to be indistinguishable
    // from "no matching process exists" (finish([]) on every failure path), which is what let worktree
    // process cleanup silently no-op host-wide, undetected, for as long as the underlying trigger
    // persisted. Never rethrown past this caller — best-effort by construction, teardown must never block.
    // A rejection reaching here already survived {@link enumerateWithRetry}'s own timeout-only retry (or
    // was never eligible for one — a genuine spawn/parse/empty-output error), so this remains the terminal,
    // fully-exhausted outcome.
    console.error(`[reap] ${worktreePath}: process enumeration FAILED this cycle — found/killed NOTHING (fail-closed, not proof nothing needed killing): ${(err as Error).message}`);
    return { killedPids: [], enumerationFailed: true };
  }
}

/**
 * Attach the fail-safe 'error' listener every per-session log WriteStream MUST have (card 7a6cc239): a
 * Node writable that emits 'error' with zero listeners throws it back out of `.emit()` — unhandled, that
 * crashes the ENTIRE daemon process (every live manager/worker pty lost), not just this one session's
 * logging. Latent today only because `ensureDirs()` guarantees the log dir exists at boot; a disk-full,
 * a permission change, an AV/indexer lock, or a corrupt volume on an actual write would still hit it.
 * On error this DEGRADES — flips `live.logBroken` so `writeLog` becomes a no-op for the rest of this
 * session's life — rather than rethrow; the pty/session itself is unaffected, only its on-disk log stops.
 * Call once, synchronously, right after constructing each `live` entry (same tick as `createWriteStream`,
 * so there's no race with the stream's own always-async error emission).
 */
function attachLogErrorGuard(sessionId: string, live: Live): void {
  live.logStream.on("error", (err) => {
    if (live.logBroken) return; // already degraded — don't re-log/spam on a re-emitted error
    live.logBroken = true;
    try {
      // eslint-disable-next-line no-console
      console.error(`[pty] ${sessionId} log stream error — disabling this session's on-disk log (session continues): ${err.message}`);
    } catch { /* logging the error must never itself throw */ }
  });
}

/**
 * Write to a session's log stream, guarded against a previously-errored/destroyed stream (see
 * attachLogErrorGuard) — a no-op once `live.logBroken` is set, so a broken log never re-attempts or
 * re-throws. The try/catch is defense in depth (matches this file's existing style around `.end()`);
 * `logBroken` is what actually stops repeat work, not the catch.
 */
function writeLog(live: Live, buf: Buffer): void {
  if (live.logBroken) return;
  try { live.logStream.write(buf); } catch { live.logBroken = true; }
}

/**
 * Owns all interactive `claude` ptys. Independent of any browser — sessions live here.
 * Implements the spike-validated gate-free spawn recipe (acceptEdits + allowlist,
 * --strict-mcp-config WITH an explicit --mcp-config so the .mcp.json prompt never blocks,
 * absolute bin path for the Windows node-pty agent, env scrub + main-screen scrollback).
 */
export class PtyHost {
  private live = new Map<string, Live>();
  /**
   * M2 tripwire: true ONLY while deliverHook is finalizing a turn (between lowering busy and draining
   * the FIFO). deliverHook is fully synchronous, so an external `enqueueStdin` can NEVER observe this
   * as true — unless a future edit introduces an `await` into that window. enqueueStdin asserts on it.
   */
  private finalizingTurn = false;
  /** Stuck-busy self-heal threshold (ms). Defaults to BUSY_STALE_MS; index.ts overrides with the
   *  resolved `platform.timeouts.busyStaleMs` at boot (BOOT-BOUND). */
  private readonly busyStaleMs: number;
  /** See PlatformConfig.coalesceAgentMessages (shared). Defaults false (one-per-turn agent delivery);
   *  index.ts overrides with the resolved `platform.coalesceAgentMessages` at boot (BOOT-BOUND). Read
   *  ONCE here (not per-message) by drainPending. */
  private readonly coalesceAgentMessages: boolean;
  /**
   * Agent-tooling P4: read access to the OWNER-ADDED capability catalog + the P1 secret store, wired in
   * by index.ts at boot (it holds `db`; PtyHost deliberately does not). Both default to a harmless no-op
   * (empty catalog / no secret) so a PtyHost built without these opts — every existing hermetic test —
   * behaves byte-identically: the two BUILTIN capabilities never consult either callback.
   */
  private readonly getCapabilityCatalog: () => CapabilityDefRow[];
  private readonly resolveConnectionSecret: (connectionId: string, projectId?: string) => string | undefined;
  /**
   * Card 8dc5ebb9: read access to the DB-persisted host-tool integration paths
   * (`PlatformConfigOverride.integrations`), wired in by index.ts at boot (it holds `db`; PtyHost
   * deliberately does not — mirrors `getCapabilityCatalog` above). Called PER-SPAWN inside createPty
   * (never boot-bound), so a Settings change reaches the very next new session with no daemon restart.
   * Defaults to a harmless no-op (`{}`) so a PtyHost built without this opt — every existing hermetic
   * test — behaves byte-identically: both resolvers fall back to their env var exactly as before.
   */
  private readonly getIntegrationPaths: () => { codescape?: string };
  /**
   * Card 088afc94 (P4 wiring): read access to the codescape supervisor's live port + its bound
   * `resolveProjectId` (cache-then-manifest — see codescape/supervisor.ts), wired in by index.ts at boot
   * (mirrors `getIntegrationPaths` above — PtyHost stays supervisor-unaware). `port:null` / a
   * `resolveProjectId` that always resolves `null` both clean-skip the codescape MCP mount for every
   * spawn — the byte-identical default for every existing hermetic test that doesn't wire this.
   */
  private readonly getCodescapeSupervisorState: () => { port: number | null; resolveProjectId: (repoPath: string) => string | null };
  constructor(
    private events: PtyHostEvents,
    opts?: {
      busyStaleMs?: number; coalesceAgentMessages?: boolean;
      getCapabilityCatalog?: () => CapabilityDefRow[];
      resolveConnectionSecret?: (connectionId: string, projectId?: string) => string | undefined;
      getIntegrationPaths?: () => { codescape?: string };
      getCodescapeSupervisorState?: () => { port: number | null; resolveProjectId: (repoPath: string) => string | null };
    },
  ) {
    this.busyStaleMs = opts?.busyStaleMs ?? BUSY_STALE_MS;
    this.coalesceAgentMessages = opts?.coalesceAgentMessages ?? false;
    this.getCapabilityCatalog = opts?.getCapabilityCatalog ?? (() => []);
    this.resolveConnectionSecret = opts?.resolveConnectionSecret ?? (() => undefined);
    this.getIntegrationPaths = opts?.getIntegrationPaths ?? (() => ({}));
    this.getCodescapeSupervisorState = opts?.getCodescapeSupervisorState ?? (() => ({ port: null, resolveProjectId: () => null }));
  }

  spawn(opts: SpawnOpts): void {
    // Code review (2026-08-05, card c469d54e): a readiness-fallback timer's callback re-looks-up its Live
    // by sessionId at fire time (`this.live.get(sessionId)`) rather than closing over the Live object
    // itself — so a timer left over from a PREVIOUS spawn of this SAME sessionId (e.g. a resume/recycle
    // that overwrites the map entry below before the outgoing entry's own timer ever fired) would find the
    // NEW Live instead of a dead one when it eventually fires, and could call markReady on it mid-cycle —
    // reproducing this card's exact race via a different trigger. Pre-existing in kind (spawn() has always
    // overwritten the map entry without clearing whatever timer the outgoing one had pending), but this
    // card's own re-arm widens the max staleness (spawn+20s → up to spawn+45s) and finally makes it cheap
    // to close, since the handle now exists on Live. Clear it before the overwrite.
    const outgoing = this.live.get(opts.sessionId);
    if (outgoing?.readyFallbackTimer) clearTimeout(outgoing.readyFallbackTimer);
    // Card a2407ed4: minted HERE, before createPty — createPty is what actually calls
    // writeSessionSettings (it builds the settings.json the fresh pty boots from), so the token baked
    // into that file and the token stored on `Live` below must be the SAME value, not two independent
    // randoms. Fresh every spawn/resume/fork/recycle (this whole method runs on every one of those) — see
    // Live.hookToken's own doc for what it does and does not close.
    const hookToken = randomUUID();
    const pty = this.createPty(opts, hookToken);
    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      kind: "claude",
      geometry: opts.geometry,
      hookToken,
      // A fork carries its PRE-ASSIGNED engine id (forkSessionId); a plain resume reuses resumeId;
      // a brand-new session has none yet (captured on SessionStart).
      engineSessionId: opts.forkSessionId ?? opts.resumeId ?? null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      killed: false,
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.sessionId}.log`)),
      logBroken: false,
      busy: false,
      ready: false, // flipped on the first SessionStart (after mode-cycles) — see Live.ready / markReady
      readyFallbackTimer: null, // armed just below; re-armed by the SessionStart handler — see its own doc
      mcpSeen: false, // flipped on the first observed loom-orchestration MCP hit — see Live.mcpSeen / markMcpSeen
      mcpSeenWaiters: [],
      busySince: null,
      lastOutputAt: Date.now(),
      composerLen: 0,
      composerDirtyLen: 0,
      composerDirtyLenBelieved: 0,
      composerDirtyLenClearedByGen: null,
      composerDirtyMarkedForGen: null,
      composerBodyWrittenForGen: null,
      rawDraftText: "",
      pending: [],
      stopping: false,
      drainHeld: false,
      rateLimited: false,
      humanSubmitHeldUntil: null,
      humanSubmitHeldArmedDuringTurn: false,
      transcriptMissingDiagnosedOnce: false,
      promptFieldAbsentDiagnosedOnce: false,
      // Card 0050a17e: seed `lastPrompt` HERE, synchronously at spawn() — NOT left for the eventual
      // post-ready `submit()` call (scheduleKickoffGuarantee) to set it. Reason: the fresh-spawn kickoff
      // now waits for `ready` (SessionStart + mode-cycles) before `submit()` ever runs, and a crash in
      // that window (before the FIRST submit()) must still leave something to re-submit on resume
      // (§19c-b) — a genuinely no-op-looking simplification ("submit() already sets this unconditionally,
      // so this seed is redundant") would silently reopen that exact window and lose the kickoff. Keep
      // this line even though it duplicates what submit() will later (redundantly, harmlessly) write. It
      // carries NO companion route (a startup turn is never a companion inbound), so the route fields
      // start null.
      lastPrompt: opts.startupPrompt ?? null,
      startupPrompt: opts.startupPrompt ?? null, // immutable kickoff intent — see field's own doc
      lastRawSubmit: null,
      pendingRawOwnerSubmit: null,
      pendingRawOwnerSubmitAt: null,
      firstTurnStarted: false, // flips true on the first UserPromptSubmit — see scheduleKickoffGuarantee/healIfStuck
      enterConfirmed: true, // no submit() outstanding yet — nothing has called submit() for this pty at spawn time — see submit()'s reset
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      giveUpConfirmQueue: [],
      currentGenFirstWrittenAt: null,
      ambiguousDispatches: new Map(),
      activeTurnRoute: null,
      lastPromptRoute: null,
      activeTurnOwnerText: null,
      lastPromptOwnerText: null,
      recentOwnerTurns: [],
      recentWrittenTurns: [],
      recentReportedTurns: [],
      recentWrittenLineCounts: [],
      recentPlaceholderTokens: [],
      activeTurnSenderId: null,
      lastPromptSenderId: null,
      activeTurnProactive: false,
      lastPromptProactive: false,
      lastMismatchReplay: null, lastMismatchFusion: null, lastMismatchUnmatched: null, lastMismatchNoticeSignature: null, lastMismatchNoticeSuppressed: null,
      // Boot is always gate-free (acceptEdits); cycle to the target mode once the TUI is up (SessionStart).
      startupModeCycles: opts.permission.startupModeCycles ?? 0,
      startupCyclesDone: false,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: false,
      bootScan: "",
      resumeGateHandled: false,
      resumeGateDetected: false,
      resumeGateScan: "",
      isResume: !!opts.resumeId,
      modeLogged: false,
      resumeModeTarget: opts.resumeModeTarget ?? null,
      role: opts.role ?? null,
    };
    this.live.set(opts.sessionId, live);
    attachLogErrorGuard(opts.sessionId, live);

    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now(); // engine is producing → not stuck (feeds the BUSY_STALE_MS heal)
      // A per-project "N new MCP servers found — enable?" prompt (e.g. docker/sentry, inherited from
      // ~/.mcp.json up-tree) can block the unattended boot BEFORE SessionStart. The PRIMARY fix now
      // pre-decides those servers in ~/.claude.json (ensureTrusted → disabledMcpjsonServers) so the
      // prompt never appears. This Esc scan is the BELT-AND-SUSPENDERS fallback for anything not
      // pre-decided (e.g. a plugin-provided server not in any .mcp.json): dismiss it once with Esc
      // ("reject all"). NOTE: the single fire-and-forget Esc can intermittently drop on Windows ConPTY
      // (card dacb8571) — that's why prevention, not this dismissal, is the real fix. Bounded rolling scan.
      if (!live.mcpPromptHandled) {
        live.bootScan = (live.bootScan + d).slice(-8192);
        const flat = collapseBoot(live.bootScan);
        if (/MCPserver/i.test(flat) && /rejectall/i.test(flat)) {
          live.mcpPromptHandled = true;
          live.bootScan = "";
          // eslint-disable-next-line no-console
          console.log(`[pty] ${opts.sessionId} dismissing plugin-MCP enable-prompt (Esc = reject all)`);
          setTimeout(() => { if (live.alive) this.ptyWrite(opts.sessionId, live, ESC_KEY, "esc-mcp-dismiss"); }, 300);
        }
      }
      // Resuming a large/old session shows a "resume from summary / as-is" gate BEFORE SessionStart
      // whose DEFAULT (option 1) summarizes — silently compacting away the manager's full context — and
      // which blocks the whole resume (mode-cycles + the queued boot nudge never run; the readiness
      // fallback then drains the nudge INTO the gate, selecting that default → the 2026-06-03 incident).
      // PRIMARY prevention is writeSessionSettings' CLAUDE_CODE_RESUME_THRESHOLD_MINUTES/TOKEN_THRESHOLD
      // env override (should keep this gate from ever rendering at all); this is the belt-and-suspenders
      // fallback via resolveResumeGate, which CONFIRMS the cursor actually reached option 2 before Enter
      // (see its doc comment for the 2026-07-10 incident this replaces the old blind Down+Enter for).
      // `resumeGateHandled` stays false — and this scan keeps accumulating — for the WHOLE verify-retry,
      // not just until first detection; `resumeGateDetected` guards the one-shot trigger below instead.
      if (!live.resumeGateHandled) {
        live.resumeGateScan = (live.resumeGateScan + d).slice(-8192);
        if (!live.resumeGateDetected && isResumeSummaryGate(collapseBoot(live.resumeGateScan))) {
          live.resumeGateDetected = true;
          // eslint-disable-next-line no-console
          console.log(`[pty] ${opts.sessionId} resume-summary gate detected → driving cursor to "Resume full session as-is" (verify-retry)`);
          setTimeout(() => this.resolveResumeGate(opts.sessionId), RESUME_GATE_SETTLE_MS);
        }
      }
      this.appendRing(live, buf);
      writeLog(live, buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // Code review (2026-08-05, card c469d54e): clear whatever readiness-fallback timer this dying Live
      // still holds — belt-and-suspenders alongside the clear at the TOP of spawn() above (which handles
      // the overwrite-on-resume case); this handles every OTHER exit path (a deliberate stop, a crash) so
      // a stale timer never outlives the Live it was armed for, even if this sessionId is never respawned.
      if (live.readyFallbackTimer) { clearTimeout(live.readyFallbackTimer); live.readyFallbackTimer = null; }
      // The pty is gone → empty the held queue so a stale "Queued (N)" can't linger after exit (the
      // live entry survives in the map with alive=false, and getPending reads live.pending). Covers
      // EVERY exit path — a Stop-initiated stop, a crash, a clean session end — not just stopWorker.
      live.pending.length = 0;
      // A session that died while something was awaiting waitForMcpSeen must resolve that wait NOW
      // (false — it will never connect) rather than leaving the waiter to time out on its own: the
      // waiter's own .then() (enqueueStdin) already no-ops safely on a dead session either way, but
      // resolving immediately here avoids holding the closure for the full MCP_READY_TIMEOUT_MS.
      if (live.mcpSeenWaiters.length > 0) {
        const waiters = live.mcpSeenWaiters;
        live.mcpSeenWaiters = [];
        for (const w of waiters) w(false);
      }
      // Reap any descendant (e.g. a backgrounded `pnpm dev`) that escaped node-pty's own orphan-free
      // containment — the durable backstop for board card 621ef252. Fires on EVERY exit path, including
      // an unexpected crash that never went through stop().
      reapOrphanedDescendants(live.pid);
      // eslint-disable-next-line no-console
      console.log(`[pty] exit ${opts.sessionId} code=${exitCode} intended=${live.stopping}`);
      try { live.logStream.end(); } catch { /* ignore */ }
      this.broadcastControl(live, { type: "exit", code: exitCode });
      // `intended` = a deliberate Loom stop() was issued (live.stopping). An UNEXPECTED death never went
      // through stop(), so stopping stays false — the signal the crash-recovery watchdog keys off.
      this.events.onExit(opts.sessionId, exitCode, { intended: live.stopping });
    });

    // A new session's kickoff turn doesn't actually submit() until `ready` (SessionStart + mode-cycles —
    // see scheduleKickoffGuarantee), which can take a real, variable amount of time. Set busy optimistically
    // right away anyway, so GET /api/sessions reads "busy" for that whole window instead of a misleading
    // "idle" — the UserPromptSubmit hook re-asserts the same value once the turn actually starts
    // (idempotent). Resume injects no prompt, so no set.
    if (opts.startupPrompt) this.setBusy(opts.sessionId, true, "spawn-startup-prompt");

    // Readiness fallback: if SessionStart never arrives (a missed hook), don't strand a queued boot
    // injection forever — mark ready after a grace so it still drains. Bounded; a no-op if already ready.
    // Card c469d54e: if SessionStart DOES arrive, its handler cancels THIS timer and re-arms a fresh one
    // scoped from that moment (MODE_CYCLE_FALLBACK_MS) — so this callback firing genuinely means "still not
    // ready" at the spawn-relative deadline, which — once that re-arm has happened — can only mean the hook
    // itself never showed up. The log line below still just states what's actually checked (`!ready`),
    // never "SessionStart never arrived", because a false alarm here is otherwise indistinguishable from a
    // real missed hook to anyone reading the log later.
    live.readyFallbackTimer = setTimeout(() => {
      const l = this.live.get(opts.sessionId);
      if (l?.alive && !l.ready) {
        console.log(`[pty] ${opts.sessionId} readiness fallback (still not ready ${READY_FALLBACK_MS}ms after spawn) — marking ready`);
        this.markReady(opts.sessionId);
      }
    }, READY_FALLBACK_MS);
  }

  /**
   * Spawn a PLAIN interactive shell (pwsh/cmd/bash/…) in a project's repo cwd — the human's "open a
   * terminal in this repo" path, a sibling to spawn() that bypasses ALL the Claude-only machinery.
   * Bare node-pty spawn with inherited env (no CLAUDE_* scrub, no settings/MCP/skills/trust wiring),
   * registered in the `live` map with kind:"shell" so deliverHook/readiness/drain/reconcile skip it and
   * the orchestration watchers (which iterate DB Sessions, not this map) never see it.
   *
   * ╔═ TRUST BOUNDARY — HUMAN-ONLY ════════════════════════════════════════════════════════════════╗
   * ║ `command` is an arbitrary host executable path = HOST RCE BY DESIGN — the same hazard class as ║
   * ║ orchestration.gateCommand (which is rejected by the agent-facing config validator for exactly  ║
   * ║ this reason). spawnShell is therefore reachable ONLY from the HUMAN REST endpoint              ║
   * ║ POST /api/terminals (loopback-only) and is DELIBERATELY NOT exposed as any MCP tool. If a       ║
   * ║ manager/worker agent could spawn an arbitrary shell it would escape the acceptEdits sandbox →   ║
   * ║ full host compromise. Do NOT add a loom-orchestration / loom-platform / loom-tasks tool for it. ║
   * ╚═════════════════════════════════════════════════════════════════════════════════════════════════╝
   */
  spawnShell(opts: { id: string; cwd: string; command: string; args: string[]; geometry: PtyGeometry; label: string }): void {
    const pty = this.createShellPty(opts);
    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      kind: "shell", command: opts.command, label: opts.label,
      geometry: opts.geometry,
      hookToken: "", // a shell has no hook relay; unreachable anyway (deliverHook/verifyHookToken gate on kind==="claude")
      engineSessionId: null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      killed: false,
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      logBroken: false,
      // The Claude-only state below is inert for a shell (nothing reads it once kind:"shell" gates the
      // hook/readiness/drain paths), but the Live shape is shared, so seed neutral values.
      busy: false, ready: true, readyFallbackTimer: null, busySince: null, // a shell is ready immediately — no fallback timer is ever armed for it
      mcpSeen: true, mcpSeenWaiters: [], // a shell/canned entry never mounts loom-orchestration — inert/unreachable, seeded true like ready
      lastOutputAt: Date.now(), composerLen: 0, composerDirtyLen: 0, composerDirtyLenBelieved: 0, composerDirtyLenClearedByGen: null, composerDirtyMarkedForGen: null, composerBodyWrittenForGen: null, rawDraftText: "",
      pending: [], stopping: false, drainHeld: false, rateLimited: false, humanSubmitHeldUntil: null, humanSubmitHeldArmedDuringTurn: false, transcriptMissingDiagnosedOnce: false, promptFieldAbsentDiagnosedOnce: false, lastPrompt: null, startupPrompt: null, lastRawSubmit: null,
      pendingRawOwnerSubmit: null, pendingRawOwnerSubmitAt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      giveUpConfirmQueue: [],
      currentGenFirstWrittenAt: null,
      ambiguousDispatches: new Map(),
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [], recentWrittenTurns: [], recentReportedTurns: [], recentWrittenLineCounts: [], recentPlaceholderTokens: [],
      activeTurnSenderId: null, lastPromptSenderId: null,
      activeTurnProactive: false, lastPromptProactive: false,
      lastMismatchReplay: null, lastMismatchFusion: null, lastMismatchUnmatched: null, lastMismatchNoticeSignature: null, lastMismatchNoticeSuppressed: null,
      startupModeCycles: 0, startupCyclesDone: true,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateDetected: true, resumeGateScan: "",
      isResume: false, modeLogged: true, // a shell has no claude footer/permission mode to read
      resumeModeTarget: null, // a shell never cycles a permission mode
      role: null, // a shell has no role; unreachable anyway (modeLogged:true skips the auto-heal read)
    };
    this.live.set(opts.id, live);
    attachLogErrorGuard(opts.id, live);
    // Shell onData is minimal: NO boot-prompt / resume-gate scanning (those are Claude-TUI artifacts).
    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now();
      this.appendRing(live, buf);
      writeLog(live, buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // eslint-disable-next-line no-console
      console.log(`[pty] shell exit ${opts.id} code=${exitCode}`);
      try { live.logStream.end(); } catch { /* ignore */ }
      this.broadcastControl(live, { type: "exit", code: exitCode });
      // A shell is NOT a DB Session — do NOT call events.onExit (which persists Session/MCP state). It is
      // ephemeral with no resumable state, so just drop it from the live map; the web's list refetch
      // then removes its tile. (Explicitly excluded from boot-reconcile / restart-intent for the same reason.)
      this.live.delete(opts.id);
    });
  }

  /**
   * TEST-ONLY (card a53e6bc9): register a no-process "live" entry so `/ws/term` attach replays a pinned
   * geometry + recorded bytes with NO real claude/shell spawn — closing the gap left by the seed
   * endpoint's plain `liveSessions` DB row (card d01311b6), whose WS attach is a genuine no-op (no pty to
   * subscribe to) and so can only prove card CHROME, never faithful terminal RENDERING. `subscribe()`
   * doesn't care that `pty` is a stub — it only reads `ring`/`geometry`/`engineSessionId`/`alive` — so the
   * existing replay-then-stream path (ring replay + a `geometry` control frame on attach) serves the
   * canned bytes verbatim with no new WS code path and no client-side monkeypatching. Nothing ever calls
   * the stub's write/resize/kill (a canned entry outlives the spec; cleanup is `dropCanned`), so it stays
   * static for its whole life.
   */
  seedCanned(opts: { id: string; cwd: string; geometry: PtyGeometry; bytes: Buffer }): void {
    const stub: IPty = {
      pid: -1, cols: opts.geometry.cols, rows: opts.geometry.rows, process: "canned",
      handleFlowControl: false,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      resize: () => {}, clear: () => {}, write: () => {}, kill: () => {}, pause: () => {}, resume: () => {},
    };
    const live: Live = {
      pty: stub, pid: stub.pid, cwd: opts.cwd,
      kind: "canned", geometry: opts.geometry,
      role: null, // a canned entry has no role; unreachable anyway (modeLogged:true skips the auto-heal read)
      hookToken: "", // a canned entry has no hook relay; unreachable anyway (deliverHook/verifyHookToken gate on kind==="claude")
      engineSessionId: null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      killed: false,
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      logBroken: false,
      busy: false, ready: true, readyFallbackTimer: null, busySince: null, // a canned entry is ready immediately — no fallback timer is ever armed for it
      mcpSeen: true, mcpSeenWaiters: [], // a shell/canned entry never mounts loom-orchestration — inert/unreachable, seeded true like ready
      lastOutputAt: Date.now(), composerLen: 0, composerDirtyLen: 0, composerDirtyLenBelieved: 0, composerDirtyLenClearedByGen: null, composerDirtyMarkedForGen: null, composerBodyWrittenForGen: null, rawDraftText: "",
      pending: [], stopping: false, drainHeld: false, rateLimited: false, humanSubmitHeldUntil: null, humanSubmitHeldArmedDuringTurn: false, transcriptMissingDiagnosedOnce: false, promptFieldAbsentDiagnosedOnce: false, lastPrompt: null, startupPrompt: null, lastRawSubmit: null,
      pendingRawOwnerSubmit: null, pendingRawOwnerSubmitAt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      giveUpConfirmQueue: [],
      currentGenFirstWrittenAt: null,
      ambiguousDispatches: new Map(),
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [], recentWrittenTurns: [], recentReportedTurns: [], recentWrittenLineCounts: [], recentPlaceholderTokens: [],
      activeTurnSenderId: null, lastPromptSenderId: null,
      activeTurnProactive: false, lastPromptProactive: false,
      lastMismatchReplay: null, lastMismatchFusion: null, lastMismatchUnmatched: null, lastMismatchNoticeSignature: null, lastMismatchNoticeSuppressed: null,
      startupModeCycles: 0, startupCyclesDone: true,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateDetected: true, resumeGateScan: "",
      isResume: false, modeLogged: true,
      resumeModeTarget: null,
    };
    if (opts.bytes.length) this.appendRing(live, opts.bytes);
    this.live.set(opts.id, live);
    attachLogErrorGuard(opts.id, live);
  }

  /** TEST-ONLY: drop a `seedCanned` entry (no process to kill — just forget the map entry + close its log). */
  dropCanned(id: string): void {
    const live = this.live.get(id);
    if (!live || live.kind !== "canned") return;
    try { live.logStream.end(); } catch { /* ignore */ }
    this.live.delete(id);
  }

  /**
   * Resize a SHELL terminal's pty to fit the viewer's pane. Enabled for shells only — Claude ptys are
   * pinned (the fixed 120×40 / no-resize invariant exists for alt-screen repaint; a resize would garble
   * the Ink TUI), so this is a no-op for kind:"claude". Idempotent and best-effort.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.kind !== "shell") return;
    if (cols <= 0 || rows <= 0) return;
    try { live.pty.resize(cols, rows); } catch { /* ignore */ }
    live.geometry = { cols, rows };
  }

  /** List live shell terminals (for GET /api/terminals — the web re-attaches after a detach/reload). */
  listShells(): { id: string; cwd: string; command: string; label: string; alive: boolean }[] {
    const out: { id: string; cwd: string; command: string; label: string; alive: boolean }[] = [];
    for (const [id, live] of this.live) {
      if (live.kind !== "shell") continue;
      out.push({ id, cwd: live.cwd, command: live.command ?? "", label: live.label ?? "", alive: live.alive });
    }
    return out;
  }

  /**
   * Bare node-pty spawn for a shell — the ONE testable seam for spawnShell (mirrors createPty for the
   * Claude path): the claude-free shell test (test/shell-terminal.mjs) subclasses PtyHost and overrides
   * this to return a FAKE pty, so it exercises the kind:"shell" registration + Claude-only-skip logic
   * with no real process. Production NEVER overrides it. Resolves the command to an ABSOLUTE path
   * (node-pty's Windows agent doesn't search %PATH%) and inherits the daemon's env wholesale — a plain
   * shell behaves like the host's (no CLAUDE_* scrub: that exists only to boot a nested `claude`).
   */
  protected createShellPty(opts: { id: string; cwd: string; command: string; args: string[]; geometry: PtyGeometry }): IPty {
    const bin = resolveExecutable(opts.command);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // eslint-disable-next-line no-console
    console.log(`[pty] spawnShell ${opts.id} bin=${bin} cwd=${opts.cwd}`);
    // Card 03016805: useConptyDll is a NO-OP on non-Windows and, on Windows, a no-op unless
    // LOOM_PTY_USE_CONPTY_DLL=1 (default OFF) — see isPtyUseConptyDllEnabled's own doc.
    return spawn(bin, opts.args, {
      name: "xterm-256color",
      cols: opts.geometry.cols,
      rows: opts.geometry.rows,
      cwd: opts.cwd,
      env,
      useConptyDll: isPtyUseConptyDllEnabled(),
    });
  }

  /**
   * Build the interactive `claude` pty for a session — the spike-validated, gate-free spawn recipe
   * (absolute bin path for the Windows node-pty agent, env scrub of CLAUDECODE/CLAUDE_CODE_*,
   * --strict-mcp-config WITH an explicit --mcp-config so the .mcp.json prompt never blocks,
   * acceptEdits + allowlist, main-screen scrollback). Extracted as the ONE testable seam: the
   * deterministic busy/drain unit test (test/pty-busy-drain.mjs) subclasses PtyHost and overrides
   * this to return a FAKE pty — exercising the M1/M2 state machine with no real claude and no
   * ~/.claude.json trust writes. Production NEVER overrides it; the recipe below is the only real one.
   */
  // `hookToken` is OPTIONAL here (not on `spawn()`, which always mints and passes one) SOLELY so the
  // large existing test population that overrides `createPty(opts) { ...; return super.createPty(opts); }`
  // (a 1-arg override, predating card a2407ed4) keeps compiling and calling the real settings-writing path
  // unchanged — those tests exercise other behavior and don't care about the token's value. Defaults to
  // "" (an inert placeholder in settings.json — no real relay process ever presents an empty token, so
  // verifyHookToken's `token.length > 0` guard rejects it same as a missing one).
  protected createPty(opts: SpawnOpts, hookToken?: string): IPty {
    const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
    // Pre-accept the workspace-trust dialog so warmup never blocks. SYNCHRONOUS on the hot path BY
    // DESIGN — the trust flags MUST be persisted to ~/.claude.json before the pty spawns, else the
    // unattended `claude` blocks on the trust prompt and never reaches SessionStart (the load-bearing
    // trust-before-spawn invariant). This cannot move off the hot path à la markitdown.
    // Why the bounded cross-process lock inside (claude-config withTrustLock) does NOT freeze the event
    // loop on an orchestration fan-out: spawn()→createPty()→ensureTrusted() is a fully synchronous call
    // chain (no await), and JS is single-threaded — so two in-process spawns CANNOT interleave. Each
    // ensureTrusted acquires the O_EXCL lock and releases it (in finally) within one synchronous call
    // stack before the event loop can start the next spawn, so the lock is NEVER contended in-process
    // and the sleepSync wait loop is unreachable from a single daemon's own fan-out. A burst of N
    // first-spawns is N sequential synchronous read-modify-writes (the lock adds only an uncontended
    // openSync(wx)+rmSync each). The contended path (sleepSync up to trustLockMs) is reachable ONLY
    // across processes — a second Loom daemon sharing this home — which is exactly the cross-process
    // clobber the lock exists to prevent; there the bounded 5s best-effort degrade is correct. The
    // already-trusted fast path is lock-free and covers the steady state.
    ensureTrusted(opts.cwd);
    // Mirror Loom's managed skills into <cwd>/.claude/skills (project-local; shadow personal). Never
    // let a skills hiccup block a spawn — a session must boot even if skill delivery fails. The Obsidian
    // signal rides opts.sessionEnv (set by obsidianSessionEnv ONLY when obsidian.autoStart is on) — the
    // local `env` isn't built yet here, so derive it from opts.sessionEnv. Off ⇒ byte-identical injection.
    const obsidianEnabled = opts.sessionEnv?.LOOM_OBSIDIAN_AUTOSTART === "1";
    try { injectSkills(opts.cwd, opts.sessionId, opts.skills ?? null, opts.role, obsidianEnabled); } catch (e) { console.log(`[pty] injectSkills failed (non-fatal): ${(e as Error).message}`); }
    // Both managers AND workers get the orchestration MCP — but a role-gated surface: managers
    // get the full coordination tools, workers get only worker_report + the read-only my_context
    // (resolved server-side). A
    // platform-lead instead gets the loom-platform MCP (project/agent creation, Pillar C). acceptEdits
    // does NOT auto-approve MCP tools (the §9 lesson — why mcp__loom-tasks is in the default allow),
    // so allowlist the role's MCP server too, else the agent hangs on a prompt.
    // manager/worker AND the Companion (assistant) allowlist the loom-orchestration server (acceptEdits
    // doesn't auto-approve MCP tools — the §9 lesson); the assistant's registered surface is just
    // my_context + the companion-gated chat_reply, so the server-level allow is all it needs.
    const wantsOrch = opts.role === "manager" || opts.role === "worker" || opts.role === "assistant";
    const wantsPlatform = opts.role === "platform";
    const wantsAudit = opts.role === "auditor";
    const wantsUserAudit = opts.role === "workspace-auditor";
    const wantsSetup = opts.role === "setup";
    const wantsRun = opts.role === "run";
    const wantsOperator = opts.role === "operator";
    // A browser-testing session ALSO needs its Playwright MCP tools allowlisted — acceptEdits doesn't
    // auto-approve MCP tools (the §9 lesson), so without this the worker would hang on a permission
    // prompt the first time it calls a browser tool. Orthogonal to role (a browser session is a worker),
    // so it layers ON TOP of the role surface rather than replacing it. (P5: auditor → loom-audit only;
    // R2: run → loom-run only — acceptEdits doesn't auto-approve submit_result either, so allowlist it.)
    const roleAllow = wantsOrch ? ["mcp__loom-orchestration"]
      : wantsPlatform ? ["mcp__loom-platform"]
      : wantsAudit ? ["mcp__loom-audit"]
      : wantsUserAudit ? ["mcp__loom-user-audit"]
      : wantsSetup ? ["mcp__loom-setup"]
      : wantsRun ? ["mcp__loom-run"]
      : wantsOperator ? ["mcp__loom-operator"]
      : [];
    // A document-conversion session ALSO needs its markitdown MCP tool allowlisted (acceptEdits doesn't
    // auto-approve MCP tools — the §9 lesson), so it layers ON TOP of the role surface like browserTesting.
    // Agent-tooling P4: generalize the legacy hardcoded tool-allows into ONE loop over every resolved
    // capability grant (mirrors buildMcpServers' loop) — the legacy slugs keep their exact hardcoded
    // allow entries; an owner-added capability contributes its own `toolAllowlist` from the catalog.
    // ACCEPTED for v1 (code review): this queries the owner-added catalog on EVERY spawn, even one with
    // zero capabilities enabled — a cheap indexed SELECT (capability_defs is expected to stay small), not
    // worth a cache for the read frequency here. Revisit if the catalog ever grows large or spawns get hot.
    const capabilityCatalog = this.getCapabilityCatalog();
    const capabilityAllow = capabilityToolAllowlist(resolveProfileCapabilities(opts), capabilityCatalog);

    // §6 scoping: route by session id in the URL path; daemon derives the project server-side. The
    // mcpServers map (loom-tasks + role surface + opt-in Playwright) is assembled by the testable seam.
    // The HUMAN-only python.interpreterPath rides the session env (config → pythonSessionEnv); read it here
    // and hand it to the shared-venv markitdown resolver (only consulted when documentConversion is on).
    // Computed BEFORE extraAllow (moved up from below) so a mounted "codescape" entry can gate its OWN
    // tool allowlist off the actual mount decision, rather than re-deriving the same isLoomDev()/port/
    // project-enabled condition a second time here.
    const codescapeState = this.getCodescapeSupervisorState();
    const mcpServers = buildMcpServers({
      sessionId: opts.sessionId, port: PORT, role: opts.role, browserTesting: opts.browserTesting, documentConversion: opts.documentConversion,
      pythonInterpreterPath: opts.sessionEnv?.LOOM_PYTHON_INTERPRETER,
      capabilities: opts.capabilities, capabilityCatalog, resolveConnectionSecret: this.resolveConnectionSecret,
      codescapeEnabled: opts.codescapeEnabled, projectId: opts.projectId,
      repoPath: opts.repoPath, worktreeId: opts.worktreeId,
      codescapePort: codescapeState.port, codescapeResolveProjectId: codescapeState.resolveProjectId,
      integrationPaths: this.getIntegrationPaths(),
    });
    // Card C2: the Codescape MCP tools ALSO need allowlisting (acceptEdits doesn't auto-approve MCP tools —
    // the §9 lesson), gated on the mcpServers map actually carrying the entry (not re-derived here).
    const extraAllow = [
      ...roleAllow,
      ...capabilityAllow,
      ...(mcpServers.codescape ? CODESCAPE_TOOL_ALLOW : []),
    ];
    const permission = extraAllow.length
      ? { ...opts.permission, allow: [...opts.permission.allow, ...extraAllow] }
      : opts.permission;
    const settingsPath = writeSessionSettings(opts.sessionId, permission, hookToken ?? "", opts.vaultPath);
    // Role-scoped disallow of the interactive human-prompt tools (AskUserQuestion / Exit|EnterPlanMode):
    // a Loom-driven role (worker/setup/auditor/workspace-auditor) must never block on a human — UNIONed with
    // the curated dangerous native tools when this session's Profile set restrictedTools (Companion
    // blast-radius control), with the 5 Codescape write tools when the mcpServers map actually carries a
    // "codescape" entry (a mounted-but-unallowlisted MCP tool still PROMPTS under acceptEdits, which a
    // Loom-driven role can never answer — see CODESCAPE_WRITE_TOOLS), AND with browser_run_code_unsafe when
    // the mcpServers map actually carries a "playwright" entry (its --allowedTools grant is the whole-server
    // wildcard — see PLAYWRIGHT_DISALLOWED_TOOLS), AND — ONLY for the untrusted-chat-facing "assistant" role
    // — with the host-file-reading file_upload/drop pair (see ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS).
    // Computed from the session role + pinned flags at the
    // single spawn chokepoint, so EVERY path (fresh/resume/fork/recycle/boot) inherits it; with
    // restrictedTools off and codescape/playwright unmounted this is exactly disallowedToolsForRole(role) ⇒
    // byte-identical argv. See disallowedToolsForSpawn.
    const disallowedTools = disallowedToolsForSpawn(opts.role, opts.restrictedTools, !!mcpServers.codescape, !!mcpServers.playwright);
    // Card f9b47cd1: gate `-n <name>` on the installed claude version HERE (the single spawn chokepoint),
    // NOT in the caller — an older claude REJECTS the unknown flag and would break EVERY spawn (the
    // load-bearing gate-free recipe). getCachedClaudeVersion() is a NON-BLOCKING read (see its doc) —
    // never a fresh `execSync` probe from this hot path. opts.sessionName is already undefined on every
    // resume/fork spawn (the caller never computes one there), so this is the ONLY place version-gating
    // needs to happen.
    const sessionName = opts.sessionName && meetsMinVersion(getCachedClaudeVersion()) ? opts.sessionName : undefined;
    // Agent-tooling P4 credential-tie hardening: a capability secret must NEVER ride the claude process's
    // own argv. Diverting to a 0600 per-session FILE is CONDITIONAL on the map actually carrying one —
    // every secret-free spawn (every session today) keeps the byte-identical inline --mcp-config <json>
    // form (see buildSpawnArgs' mcpConfigPath doc). The file is rewritten every spawn (fresh/resume/fork/
    // recycle all call createPty, which rebuilds mcpServers fresh each time), mirroring writeSessionSettings.
    const capabilitySecrets = collectMcpEnvSecrets(mcpServers);
    const mcpConfigPath = capabilitySecrets.length ? writeSessionMcpConfig(opts.sessionId, mcpServers) : undefined;
    const args = buildSpawnArgs({ resumeId: opts.resumeId, fork: opts.fork, forkSessionId: opts.forkSessionId, settingsPath, mode: permission.mode, mcpServers, mcpConfigPath, startupPrompt: opts.startupPrompt, model: opts.model, disallowedTools, sessionName });

    // Card abcf0eba part (a) / 0050a17e: preflight the EXACT command line this spawn is about to hand
    // node-pty — Windows-only (see preflightWindowsCommandLine's doc: POSIX's ARG_MAX is orders of
    // magnitude larger). Uses the SAME bin+args the real spawn below uses, so the check and the spawn
    // can never disagree about "the command line" — and since `args` never carries the startup prompt
    // any more (buildSpawnArgs' own doc), this now guards only the settings/MCP-config/disallowed-tools
    // argv, not the prompt (which used to be, and no longer is, this preflight's main concern). Thrown
    // SYNCHRONOUSLY, before any process is created — the caller's existing try/catch around
    // `this.pty.spawn(...)` (sessions/service.ts spawnWorker, card ae6c24e1) already reconciles a
    // synchronous createPty throw to processState:'exited' instead of leaving a live phantom, so this
    // refusal gets that same honest handling for free.
    if (process.platform === "win32") {
      const preflight = preflightWindowsCommandLine(bin, args);
      if (!preflight.ok) throw new Error(preflight.message);
    }

    // Inherited env (CLAUDE_*/CLAUDECODE scrubbed) + sessionEnv merge + the three git-safety vars that
    // keep an unattended worker pty from wedging on a pager / credential prompt, plus LOOM_WORKTREE (the
    // cwd anchor an agent's own Bash calls can reference). See buildSpawnEnv.
    const env = buildSpawnEnv(process.env, opts.sessionEnv, opts.cwd);
    // Obsidian auto-start: when the resolved config turned it on (LOOM_OBSIDIAN_AUTOSTART rode in via
    // sessionEnv → obsidianSessionEnv), hand the vault preflight helper its ABSOLUTE path so a vault skill
    // can `node "$LOOM_OBSIDIAN_PREFLIGHT"`. The asset path is daemon-side (not knowable in browser-pure
    // shared), so it's injected HERE, the single createPty chokepoint. Additive-when-off: with autoStart
    // off the var is absent and every existing spawn's env is byte-identical. A deliberate override wins.
    if (env.LOOM_OBSIDIAN_AUTOSTART === "1" && !env.LOOM_OBSIDIAN_PREFLIGHT) {
      env.LOOM_OBSIDIAN_PREFLIGHT = ENSURE_OBSIDIAN_SCRIPT;
    }
    // LOOM_SCRATCH_DIR: tell a browser-testing agent WHERE its Playwright tools' own write boundary is.
    // See browserScratchEnv for the gating rationale. Ensure the dir actually EXISTS (best-effort) so the
    // agent can Write a file into it immediately (e.g. to stage a browser_file_upload source).
    const scratchEnv = browserScratchEnv(mcpServers, opts.sessionId);
    if (scratchEnv.LOOM_SCRATCH_DIR) {
      try { fs.mkdirSync(scratchEnv.LOOM_SCRATCH_DIR, { recursive: true }); } catch { /* best-effort; never block spawn */ }
      Object.assign(env, scratchEnv);
    }

    // Belt-and-suspenders (agent-tooling P4): redact any capability secret out of the LOGGED argv even
    // though mcpConfigPath should already keep it off `args` itself when present — never log raw secret
    // values under any circumstance. A no-op (capabilitySecrets empty) for every existing spawn.
    const argsLog = capabilitySecrets.length ? redactSecrets(JSON.stringify(args), capabilitySecrets) : JSON.stringify(args);
    // eslint-disable-next-line no-console
    console.log(`[pty] spawn ${opts.sessionId} bin=${bin} cwd=${opts.cwd} resume=${opts.resumeId ?? "none"} args=${argsLog}`);
    // Card 03016805: useConptyDll is a NO-OP on non-Windows and, on Windows, a no-op unless
    // LOOM_PTY_USE_CONPTY_DLL=1 (default OFF) — see isPtyUseConptyDllEnabled's own doc. When on, node-pty's
    // WindowsPtyAgent.kill() takes the branch that skips forking conpty_console_list_agent (the confirmed
    // AttachConsole-failed trigger) entirely — this does NOT flip the production default.
    const pty = spawn(bin, args, {
      name: "xterm-256color",
      cols: opts.geometry.cols,
      rows: opts.geometry.rows,
      cwd: opts.cwd,
      env,
      useConptyDll: isPtyUseConptyDllEnabled(),
    });
    return pty;
  }

  /**
   * Card a2407ed4: called by `/internal/hook` BEFORE `deliverHook`, to check a caller-presented token
   * against the target session's own `Live.hookToken` (see that field's doc for what this does and does
   * NOT close). FAIL-CLOSED by construction: no live session, a non-"claude" kind (shell/canned never had
   * a relay to begin with), or a missing/empty/mismatched token all return false — there is no branch that
   * lets a hook through without an exact match. This is deliberately safe against a daemon restart: EVERY
   * automatic resume path (resumeFleetOnBoot -> SessionService.resume -> this.spawn, and fresh/fork/recycle
   * identically) re-enters `spawn()` — the ONE site that mints a fresh token — before the resumed process's
   * own hook-relay can present anything, and a `Live` entry is NEVER mutated in place without going back
   * through `spawn()` (see that field's own "never a reused Live object" invariant, `reconcile()` only
   * touches busy/queue state). So there is no live "claude" session whose token can go stale out from under
   * a still-running relay — a mismatch here only ever means a genuinely wrong/forged/absent token.
   */
  verifyHookToken(sessionId: string, token: string | undefined): boolean {
    const live = this.live.get(sessionId);
    if (!live || live.kind !== "claude") return false;
    return typeof token === "string" && token.length > 0 && token === live.hookToken;
  }

  /** Called by the hook endpoint when a relayed hook arrives. Routes the busy state machine. */
  deliverHook(
    sessionId: string,
    // StopFailure also carries error/error_details (and a future claude may carry resetsAt) — the
    // relay + /internal/hook forward the whole hook object; we read them for §19c usage-limit detect.
    // `prompt` (card 7114838d): UserPromptSubmit's own report of what was actually submitted — read for
    // the frame-splice detector below. Narrow BY CHOICE, same established pattern as the other extra
    // fields here — extend, don't widen to `unknown`.
    hook: { hook_event_name?: string; session_id?: string; error?: string; error_details?: unknown; resetsAt?: number; prompt?: string },
  ): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (live.kind !== "claude") return; // shells/canned entries have no hook relay; the busy/readiness machine is Claude-only
    // eslint-disable-next-line no-console
    console.log(`[hook] ${sessionId} ${hook.hook_event_name ?? "?"} session_id=${hook.session_id ?? "-"}`);
    switch (hook.hook_event_name) {
      case "SessionStart":
        // SessionStart only fires once boot is past the (now-dismissed) MCP prompt — stop scanning.
        live.mcpPromptHandled = true; live.bootScan = "";
        // Capture the engine session id — and track a ROTATION. Card 7c1fc117 (confirmed via a real
        // production incident, not just a theory): the engine can fire a SECOND SessionStart, reporting a
        // DIFFERENT session_id, for the SAME live pty process — NO new Loom spawn, no resume, no fork —
        // most likely an internal auto-compact restarting the engine's own session bookkeeping under a
        // fresh transcript file. The OLD guard (`!live.engineSessionId`, capture-once) silently discarded
        // that second hook: `live.engineSessionId` stayed pinned at the FIRST (now-abandoned) id forever,
        // so every downstream reader keyed off it (readContextStats — the manager-recycle context
        // counter — engineTranscriptExists' resumability check, the "sessionId" broadcast) kept reading a
        // transcript the engine had already stopped writing to, while the REAL, growing conversation went
        // on in a file Loom never knew existed. A later report of the SAME id (the overwhelmingly common
        // case — a plain resume/fork correctly re-reports what it was given) is still a no-op below.
        if (typeof hook.session_id === "string" && hook.session_id !== live.engineSessionId) {
          if (live.engineSessionId) {
            // eslint-disable-next-line no-console
            console.warn(`[pty] ${sessionId} engine session id ROTATED mid-session: ${live.engineSessionId} -> ${hook.session_id} (SessionStart fired without a new spawn) — updating tracked id`);
          }
          live.engineSessionId = hook.session_id;
          this.events.onEngineSessionId(sessionId, hook.session_id);
          this.broadcastControl(live, { type: "sessionId", id: hook.session_id });
        }
        // Claude is up → cycle the permission mode off the gate-free boot default into the target mode
        // (the human Shift+Tab step), once per (re)spawn. BOTH a fresh spawn and a `--resume` boot at the
        // gate-free `mode` (acceptEdits) — `claude --resume` HONOURS `--permission-mode` and does NOT
        // restore the persisted mode (probe-verified on 2.1.163; card f05e4897). Both FRESH and RESUME now
        // share ONE strategy — ABSOLUTE feedback cycling (cycleToMode, card b99d3d67): derive the target
        // mode and drive the footer to it by reading it and pressing Shift+Tab until it lands, instead of
        // FRESH's old BLIND relative cycling (a dropped/mistimed press could half-land on `plan` and stay
        // there — a worker has no `ExitPlanMode` tool to self-exit). RESUME already carries an explicit
        // absolute `resumeModeTarget` (set by SessionService.resume); FRESH derives the equivalent target
        // from the SAME `startupModeCycles` config count a blind cycle would have used
        // (modeAfterCyclesFromAcceptEdits — default 2 → auto), so both converge to the identical target a
        // fresh spawn of the config reaches. Bounded + graceful (see cycleToMode); `startupModeCycles:0`
        // means "leave the boot mode" — no cycling at all, straight to ready.
        // The session is marked READY (which releases any queued injection) only AFTER the cycle lands —
        // so a boot-recovery nudge can't interleave with the Shift+Tabs. That interleave was the
        // 2026-06-03 restart bug: the nudge stranded un-submitted in the composer and the mode stuck
        // mid-cycle on plan.
        if (!live.startupCyclesDone) {
          live.startupCyclesDone = true;
          const target = live.resumeModeTarget ?? (live.startupModeCycles > 0 ? modeAfterCyclesFromAcceptEdits(live.startupModeCycles) : null);
          if (target) {
            // Card c469d54e (THE FIX): a cycle is about to run, so the spawn-armed READY_FALLBACK_MS timer
            // — sized assuming the cycle starts near spawn+0 — can no longer be trusted; under host
            // contention SessionStart itself can arrive late enough to leave the cycle less runway than its
            // own sized worst case, letting the OLD timer fire mid-cycle and release a queued kickoff INTO
            // the pty while cycleToMode is still pressing Shift+Tab / reading the footer (confirmed against
            // the 2026-08-01 mass-restart's raw log — see MODE_CYCLE_FALLBACK_MS's own doc). Re-arm a fresh,
            // bounded fallback scoped from NOW instead, so a healthy cycle always gets its full budget.
            //
            // ⚠️ THIS SHRINKS THE RACE, IT DOES NOT ELIMINATE IT: this re-arm only helps once THIS CODE
            // ACTUALLY RUNS — the precise condition is when `deliverHook` is DISPATCHED for the SessionStart
            // hook (not merely when the hook itself arrives at the process; a hook that arrives at 18s but
            // whose deliverHook call is only DISPATCHED at 21s, e.g. queued behind other synchronous work on
            // an overloaded event loop, hits the residual below exactly the same as a hook that arrived late
            // in the first place). If that dispatch happens AT OR PAST the ORIGINAL spawn+READY_FALLBACK_MS
            // mark, this exact race can still be lost (the old timer already fired, or is about to, before
            // this line ever runs) — a strictly worse contention level than the 2026-08-01 incident (worst
            // observed SessionStart-to-fallback gap there was ~11.6s, well under READY_FALLBACK_MS's own
            // margin here — see docs/investigations/c469d54e-ready-fallback-race/findings.md). The absolute
            // ceiling below still guarantees the kickoff is never stranded forever in that residual case — see
            // READY_FALLBACK_ABSOLUTE_CEILING_MS's own doc — it just doesn't guarantee that residual case is
            // corruption-free. Do not claim this closes the race for arbitrary contention.
            //
            // ⚠️ ORDER IS LOAD-BEARING: arm the NEW timer BEFORE clearing the OLD one. If anything throws
            // between the two lines below (or a future edit reorders them), the result is TWO live timers,
            // never zero — the worst case is the old one firing at spawn+READY_FALLBACK_MS, i.e. degrading
            // to EXACTLY today's pre-fix behavior (markReady's `live.ready` guard makes a double-fire a
            // no-op). Clearing first and failing before the re-arm would instead risk ZERO live timers if
            // cycleToMode itself then never manages to call its onDone — a queued kickoff stranded forever,
            // which is strictly worse than the bug this card fixes. Degrading toward the old bug is safe;
            // degrading toward a stranded kickoff is not — do not reverse this order.
            const elapsedSinceSpawn = Date.now() - live.startedAt;
            const boundedDelay = Math.max(0, Math.min(MODE_CYCLE_FALLBACK_MS, READY_FALLBACK_ABSOLUTE_CEILING_MS - elapsedSinceSpawn));
            const newFallbackTimer = setTimeout(() => {
              const l = this.live.get(sessionId);
              if (l?.alive && !l.ready) {
                console.log(`[pty] ${sessionId} mode-cycle fallback (still not ready ${boundedDelay}ms after SessionStart) — marking ready`);
                this.markReady(sessionId);
              }
            }, boundedDelay);
            const oldFallbackTimer = live.readyFallbackTimer;
            live.readyFallbackTimer = newFallbackTimer;
            if (oldFallbackTimer) clearTimeout(oldFallbackTimer);
            this.cycleToMode(sessionId, target, () => this.markReady(sessionId));
          } else {
            this.markReady(sessionId);
          }
        } else {
          this.markReady(sessionId); // idempotent: a repeat SessionStart still ensures readiness
        }
        break;
      case "UserPromptSubmit": {
        // Observed for EVERY turn, including the fresh-spawn startup-prompt arg — the FIRST one proves a
        // turn actually started, closing scheduleKickoffGuarantee's fallback window and healIfStuck's
        // short pre-first-turn stale window (see both). Idempotent after the first.
        live.firstTurnStarted = true;
        // Card fca6af6d (REVERSE-order race, follow-up to b4b9b707): capture whether a submit() was
        // OUTSTANDING for THIS hook BEFORE the line below flips enterConfirmed to true — this is the
        // discriminator between the two cases a non-null pendingRawOwnerSubmit can mean below.
        //   - outstanding-submit was false (no submit in flight) → this hook confirms a genuine
        //     raw-terminal-originated turn (writeStdin's Enter IS what started it) → attribute.
        //   - outstanding-submit was true (a submit()'s Enter is being confirmed) → ANY pendingRawOwnerSubmit
        //     seen here can only have raced in during the async gap between that submit() clearing the
        //     field and ITS OWN hook firing (submit() is the sole writer that clears it, and it clears it
        //     before writing a byte — see the field's doc) — a raced-in HUMAN line, but not this turn's
        //     own attestation. Attributing it here would credit the agent-originated submit's turn with
        //     words the human typed for some other (possibly never-realized) turn. Discard, don't attribute.
        const submitWasOutstanding = !live.enterConfirmed;
        live.enterConfirmed = true; // proof the outstanding submit()'s Enter registered — cancels sendEnterAndVerify's retry loop (card 9549e322)
        // Card 3ce3fa39: GATED reset — only when THIS hook fires while `submitGeneration` still equals the
        // generation that actually issued the clear-prefix (see `composerDirtyLenClearedByGen`'s doc). An
        // ungated reset here would be WRONG: a hook belonging to unrelated engine activity (no submit() of
        // ours in flight) can still land and flip enterConfirmed true — first-hand confirmed in production —
        // and must NOT be read as proof our clear-prefix (which may not even have been attempted yet) landed.
        if (live.composerDirtyLenClearedByGen === live.submitGeneration) {
          live.composerDirtyLen = 0;
          live.composerDirtyLenBelieved = 0; // card c148f118: a decisive confirm collapses both readings to the same true zero
          live.composerDirtyLenClearedByGen = null;
        }
        // Card 4a0af485: captured BEFORE the purge call below, which can itself delete an entry — if there
        // was NO ambiguity at all before this hook fired, this hook can only be about the CURRENT
        // generation (nothing else it could possibly be confirming), which is what makes the CONFIRMED log
        // below safe. (If ambiguity DID exist, whether this hook is about the current generation or an
        // older ambiguous one is exactly the question the purge call resolves — see its own return value.)
        const hadNoAmbiguityBeforeThisHook = live.ambiguousDispatches.size === 0;
        const reportedPromptForPurge = typeof hook.prompt === "string" ? hook.prompt : undefined;
        const resolvedByContentMatch = this.purgeConfirmedGiveUpRequeue(sessionId, live, false, reportedPromptForPurge); // card 441499ee/09e655d5/4a0af485 — see the method doc; UserPromptSubmit purges without advancing the queue
        // Card b4b9b707: attribute a raw-terminal-typed line to THIS turn's ownerText. SECURITY INVARIANT
        // (see Live.pendingRawOwnerSubmit's doc): submit() clears this field FIRST, before writing a byte,
        // so a non-null value here can ONLY have originated from writeStdin — never from any Loom-issued
        // submit() (kickoff/nudge/redirect/worker-report drain/rate-limit replay/companion/composer).
        // TTL-bounded (RAW_OWNER_SUBMIT_TTL_MS): a raw Enter that lands on a non-composer TUI surface (a
        // permission/resume-gate prompt) never itself starts a new turn, so nothing clears or overwrites
        // the field afterward — if it sits unconsumed past the TTL, discard it rather than risk
        // attributing stale human text to a later, unrelated prompt. Consumed (cleared) either way —
        // attributed or discarded as stale, it must never survive this check to a later turn.
        if (live.pendingRawOwnerSubmit !== null) {
          const fresh = live.pendingRawOwnerSubmitAt !== null && Date.now() - live.pendingRawOwnerSubmitAt <= RAW_OWNER_SUBMIT_TTL_MS;
          // Card fca6af6d: fresh alone is not enough — a raced-in raw line confirmed by a submit()'s OWN
          // outstanding Enter (submitWasOutstanding) must NOT be credited to that submit-originated turn.
          if (fresh && !submitWasOutstanding) this.attributeOwnerText(live, live.pendingRawOwnerSubmit);
          live.pendingRawOwnerSubmit = null;
          live.pendingRawOwnerSubmitAt = null;
        }
        // Card 7114838d: frame-splice detector — LOG-ONLY, fixes nothing (see 3ce3fa39, the card this
        // unblocks). `daemon-output.log`'s `[pty-write]`/`[submit-write]` lines prove only that a write was
        // CALLED, never that ConPTY actually APPLIED it — nothing at the write layer distinguishes "written
        // and applied" from "written and dropped/spliced". This comparison can, because its two sides come
        // from genuinely INDEPENDENT sources: the engine's own report of what it actually submitted
        // (`hook.prompt`) vs. the daemon's own record of what it intended to write for this turn
        // (`live.lastPrompt`) — not two views of the same mocked/written state.
        // Deliberately `console.log` (stdout), same stream as `[pty-write]`/`[submit-write]`/`[stdin-write]`
        // — this detector's whole point is correlating a splice against the write records around it, and
        // `console.warn` (stderr) is a SEPARATELY buffered/timestamped stream, so line order between the two
        // in the combined log file is not guaranteed. Regardless of stream, correlate by the log's EPOCH-MS
        // TIMESTAMPS, never by line order — the corpus is mixed with other stderr output too.
        // Gated on submitWasOutstanding (captured above, BEFORE this hook flipped enterConfirmed): per
        // Live.lastPrompt's doc, that field is set ONLY by Loom-originated submit() calls, never by a raw
        // human-typed turn — an ungated always-compare would misfire on EVERY raw-terminal turn, comparing
        // it against a stale lastPrompt left over from an earlier, unrelated Loom-originated turn.
        // CHECKED (manager review, card 7114838d) so this isn't a SYSTEMATIC benign mismatch on every turn:
        // `live.lastPrompt` is set from the EXACT literal `text` argument submit() receives (host.ts's own
        // `live.lastPrompt = text` in submit()), and callers build any `[loom:from-manager]\n…`-style frame
        // BEFORE calling in (e.g. sessions/service.ts `messageWorker`'s `const framed = ...`) — so
        // `lastPrompt` already holds the FULL POST-FRAMING text, same form as what's typed into the composer.
        // `writeChunked` (submit()'s writer) writes that string byte-for-byte with no daemon-side
        // normalization (no trim, no CRLF conversion, no appended newline — Enter is a SEPARATE write). What
        // remains genuinely UNCONFIRMED — because it lives entirely on the engine/CLI side, outside this
        // repo — is whether Claude Code's own hook reports that identical string back verbatim (e.g. any
        // Ink-side trimming). The tests below synthesize hook.prompt and so cannot answer that; only the
        // first real hook after deploy can. `lenDelta`/tail-length fields below exist so THAT observation is
        // self-classifying the moment it lands, rather than needing a follow-up investigation.
        //
        // PRE-REGISTERED 2026-07-29, card 7114838d — the four bullets below were PREDICTIONS, made BEFORE
        // any real observation existed. As of that writing, whether UserPromptSubmit's hook payload carries
        // a `prompt` field at all was ITSELF unverified (that's the whole reason this detector exists — see
        // the paragraph above). Predictions:
        //   - SILENCE ⇒ Claude Code echoes the framed string back identically. Detector armed and working;
        //     no splice observed yet. This is the expected steady state.
        //   - `prompt-field-absent` (fires once) ⇒ the hook payload doesn't carry the prompt text at all.
        //     This card's premise dies here, cleanly — 3ce3fa39 goes back to the accept-risk-vs-real-
        //     terminal choice with nothing new to add.
        //   - Mismatch with TINY tails (both `tailReportedLen`/`tailIntendedLen` small) and/or a small
        //     `lenDelta`, divergence near the very END ⇒ benign normalization on Claude Code's own side
        //     (e.g. trailing-whitespace trimming). NOT a splice — report it, don't suppress it; the
        //     comparison would need relaxing/scoping, not this detector declared broken.
        //   - Mismatch with LARGE tails on BOTH sides, divergence MID-STRING, `lenDelta` roughly the size of
        //     a whole stranded message ⇒ the real thing: a live frame splice, captured with full context.
        //   - ⭐ OBSERVED 2026-08-04 (card 201d0d95, session 363002b9 gen=8, real production traffic — not a
        //     test): whole-content EXACT REPLACEMENT by an UNRELATED, OLDER, ALREADY-CONFIRMED prior
        //     generation's own text — `reportedHash` matched a PRIOR generation's `writtenHash` byte-for-byte
        //     (not this generation's own), `divergesAtChar` landed right after the shared literal prefix
        //     (the message-type tag), and `reportedLen` did not correspond to any splice/concatenation of the
        //     intended text — a clean duplicate of a fully separate past submission, confirmed independently
        //     via the archived transcript (the duplicate turn was byte-identical to the original, ~168s
        //     apart, both len=1864). This is NONE of the four predictions above: not silence, not
        //     absent-field, not benign end-of-string normalization, and not a mid-string splice with an ADDED
        //     tail — it is a REPLACEMENT, and its effect is to DOUBLE a real prior turn's delivery while
        //     DROPPING the new one, not merely to lose it. See `[loom:prompt-mismatch]` below, added by that
        //     same card, for how this class is now surfaced to the affected session.
        // ⛔ OBLIGATION FULFILLED 2026-08-04 (card 201d0d95): the pre-registration above has now recorded its
        // first real observation, per its own rule — the four ORIGINAL predictions stay (still the right
        // shape to recognize a splice/normalization/absent-field), but they are no longer untested; one has
        // fired. A FUTURE first-observation of any of the remaining three untested predictions should get the
        // same treatment: append what was actually seen, cite the card, don't just believe the prediction.
        if (submitWasOutstanding) {
          // Card 4a0af485 (DoD#4 — measure the engine-confirmation lag distribution): only when there was
          // NO ambiguity at all before this hook fired (see `hadNoAmbiguityBeforeThisHook`'s own comment
          // above) and the content-match purge above didn't ALREADY attribute this hook to some OTHER,
          // older generation — otherwise this hook's `CONFIRMED` line would have already been logged there,
          // against the generation it actually belongs to, and logging it again here against the CURRENT
          // generation would double-count one real confirmation as two.
          if (hadNoAmbiguityBeforeThisHook && !resolvedByContentMatch) {
            const logicalId = live.giveUpOrigin?.[0]?.logicalId ?? null;
            const latencyMs = live.currentGenFirstWrittenAt !== null ? Date.now() - live.currentGenFirstWrittenAt : null;
            // eslint-disable-next-line no-console
            console.log(`[submit] ${sessionId} CONFIRMED gen=${live.submitGeneration} logicalId=${logicalId ?? "unknown"} latencyMs=${latencyMs ?? "unknown"}`);
          }
          if (typeof hook.prompt !== "string") {
            // SELF-DIAGNOSING (card 7114838d): whether UserPromptSubmit's hook payload actually carries the
            // prompt text at all was, until now, an UNCONFIRMED premise — Loom had simply never looked. Say
            // so explicitly, ONCE per session, instead of silently comparing `undefined` and never firing —
            // a detector that goes quiet when its input is missing is indistinguishable from one that's
            // working and finding nothing. If this line is never seen after deploy, that itself answers the
            // question: the field isn't there, and this detector has nothing to compare.
            if (!live.promptFieldAbsentDiagnosedOnce) {
              live.promptFieldAbsentDiagnosedOnce = true;
              // eslint-disable-next-line no-console
              console.log(`[prompt-mismatch] ${sessionId} UserPromptSubmit carried no usable 'prompt' field (keys=${JSON.stringify(Object.keys(hook))}) — card 7114838d's premise is UNCONFIRMED for this session; the detector cannot compare and will stay silent`);
            }
          } else {
            // Card 4a0af485 (manager directive #3): an ALWAYS-ON happy-path diagnostic — the mismatch-only
            // block below can go quiet for two entirely different reasons ("always matching" vs "this
            // branch is simply never reached"), and content-matching's own tests all pass regardless of
            // which is true because they synthesize an echo that matches BY CONSTRUCTION. Every content
            // match in this file (hasAmbiguousMatch, purgeConfirmedGiveUpRequeue) depends on ONE premise:
            // does the engine echo `hook.prompt` byte-identically to what Loom wrote? This line measures
            // that premise directly, on every confirmed turn, match or mismatch alike.
            // PREDICTION, stated before real data exists (this file's own pre-registration convention, card
            // 7114838d): if the engine echoes verbatim on a FAST/current-generation confirmation (this is
            // exactly that case — `submitWasOutstanding` means THIS hook confirms the CURRENT generation),
            // there is no known mechanism by which the SAME engine would echo differently for a SLOW/late
            // confirmation of an older, ambiguous generation — but that inference is UNCONFIRMED until real
            // pairs land. A systematic `byteIdentical=false` here would mean the content-match mechanism can
            // never fire in production even though every hermetic test passes — the exact "green you cannot
            // fail" the manager flagged.
            const sigReported = textSignature(hook.prompt);
            const sigWritten = textSignature(live.lastPrompt ?? "");
            // Code Review follow-up (card 4a0af485, Major 4): `byteIdentical`/the two signatures above
            // compare against `live.lastPrompt` — the CURRENT generation's (possibly JOINED) text — which
            // validates only HALF the premise the content-match mechanism depends on. This ALSO reports
            // whether `hook.prompt`'s signature matches ANY entry still tracked in `Live.ambiguousDispatches`
            // (a read-only check — resolving/purging a real match is `purgeConfirmedGiveUpRequeue`'s job,
            // called separately from the same hook), so a reader can tell "the current generation's own echo
            // is byte-identical" apart from "an OLDER, ambiguous generation's echo was ALSO recognized" —
            // the second is the actual, specific premise DoD#2/#3's purge needs validated.
            const ambiguousMatch = [...live.ambiguousDispatches.values()].some((e) => e.len === sigReported.len && e.hash === sigReported.hash);
            // eslint-disable-next-line no-console
            console.log(`[prompt-echo] ${sessionId} gen=${live.submitGeneration} byteIdentical=${hook.prompt === live.lastPrompt} reportedLen=${hook.prompt.length} writtenLen=${(live.lastPrompt ?? "").length} reportedHash=${sigReported.hash} writtenHash=${sigWritten.hash} ambiguousMatch=${ambiguousMatch}`);
            // Card d005f55b DoD-2: snapshot the prior RECORDED reported entry BEFORE this generation's own
            // push just below — so "prior" below never means the entry this same hook is about to add for
            // itself. Pushed unconditionally (match or mismatch alike), mirroring `recentWrittenTurns`'
            // own "once per relevant event, regardless of outcome" cadence — see `Live.recentReportedTurns`'
            // own doc for why this needs to happen every time, not only on a mismatch.
            const priorReportedEntry = live.recentReportedTurns.length > 0 ? live.recentReportedTurns[live.recentReportedTurns.length - 1] : undefined;
            live.recentReportedTurns.push({ gen: live.submitGeneration, len: sigReported.len, hash: sigReported.hash });
            if (live.recentReportedTurns.length > COMPOSER_ACCUM_WINDOW) live.recentReportedTurns.shift();
            if (hook.prompt !== live.lastPrompt) {
              // live.lastPrompt is non-null here: submit() always writes it BEFORE ever setting
              // enterConfirmed=false, and submitWasOutstanding===true means exactly that write already
              // happened for this in-flight turn — the `?? ""` below is defensive only, never expected to fire.
              const reported = hook.prompt;
              const intended = live.lastPrompt ?? "";
              let i = 0;
              const max = Math.min(reported.length, intended.length);
              while (i < max && reported[i] === intended[i]) i++;
              // Show WHERE the divergence starts, not just that one exists — the known specimens all splice
              // mid-token, so a bare "mismatch: true" would satisfy the letter of this and be useless in practice.
              // ALSO make the log SELF-CLASSIFYING (manager review, card 7114838d): `lenDelta` and the two tail
              // lengths let a reader tell a real splice from a wholly-different string at a glance — a splice
              // makes `reported` longer by roughly a whole stranded message with a LARGE tail on both sides at
              // the divergence point; wholly different strings diverge at `divergesAtChar=0`.
              // ⛔ CORRECTED (card cf2fef73, owner-reported false LOSS alarm): this comment used to also claim a
              // trailing-whitespace/normalization artifact diverges near the very END with TINY tails on both
              // sides. MEASURED FALSE for the actual benign case seen in production — an INTERIOR tab, echoed
              // back space-expanded by the terminal, desyncs a byte-wise scan AT the tab and never re-syncs, so
              // everything after it counts as mismatched: a tail as large as any real splice's. Over the
              // retained corpus, 355/368 mismatches had "both tails large" by this shape — almost all of them
              // this benign case, not real splices. TAIL SIZE CANNOT DISCRIMINATE a benign whitespace re-render
              // from a real splice; the whitespace-normalized comparison below is the actual discriminator now
              // used to decide whether the session-facing notice fires.
              // ⛔ ALSO CORRECTED (manager review, card cf2fef73): "wholly different strings diverge at
              // `divergesAtChar=0`" is also not reliable in practice — the single most common benign shape
              // measured in the corpus (a stale collapsed paste-placeholder, `[Pasted text #N +M lines]`,
              // PREPENDED onto an otherwise-correct submission — see the placeholder-prefix check below)
              // diverges at `divergesAtChar=1`, not 0: both strings start with the same `[` byte before
              // splitting. The single most common benign shape in the corpus therefore presents with the
              // MOST ALARMING-LOOKING raw signature available — do not read `divergesAtChar` alone as a
              // reliable "wholly unrelated content" signal either.
              // ⭐ THE GENERAL SHAPE OF THIS BUG: the comparison above is exact, but the property it exists to
              // detect ("was the intended content preserved") is not a byte-exact one — a benign rendering or
              // framing transform changes the bytes without losing anything, and an exact byte-comparison has
              // no way to tell that apart from a real loss. It reports every transformation as a corruption
              // unless the transform is explicitly named and checked for, which is what the two suppression
              // checks below do.
              const around = (s: string, at: number) => JSON.stringify(s.slice(Math.max(0, at - 20), at + 40));
              // eslint-disable-next-line no-console
              console.log(`[prompt-mismatch] ${sessionId} engine-reported submitted prompt DIVERGES from what Loom intended to write — possible frame splice (diagnostic only, does not fix 3ce3fa39). reportedLen=${reported.length} intendedLen=${intended.length} lenDelta=${reported.length - intended.length} divergesAtChar=${i} tailReportedLen=${reported.length - i} tailIntendedLen=${intended.length - i} reportedAround=${around(reported, i)} intendedAround=${around(intended, i)}`);
              // Card c2c750a9: the sum+hash composer-accumulation detector — CONSUMES the very fields
              // [prompt-echo]/[prompt-mismatch] already log, on every mismatch, rather than adding a new
              // signal. Two DISTINCT outcomes, logged under two DISTINCT tags on purpose (never conflate
              // them — that is the whole point of keeping the two stages separate, see
              // detectComposerAccumulation's own doc for the reorder counterexample this guards against):
              // CONFIRMED (sum AND hash both match, in gen order) is a real accumulation; a sum-only match
              // whose hash confirmation REFUSES is a coincidence (same total length, different content or
              // order) that must never be reported as one, but is still worth a quiet trace of what the
              // trigger stage alone would have flagged.
              const accumulation = detectComposerAccumulation(reported.length, sigReported.hash, live.recentWrittenTurns);
              if (accumulation?.confirmed) {
                // eslint-disable-next-line no-console
                console.log(`[composer-accumulation] ${sessionId} CONFIRMED gen=${live.submitGeneration} spanGens=${JSON.stringify(accumulation.spanGens)} sumOfWrittenLens=${accumulation.sumOfWrittenLens} reportedLen=${reported.length} concatenatedHash=${accumulation.concatenatedHash} — the engine reported back everything Loom wrote since the composer last genuinely cleared (Loom wrote each of these EXACTLY ONCE — this is not a redelivery, see card 736de9c0). LIMIT: detectable only because THIS write caught the residual — an accumulation with no later write on this session is structurally invisible to this detector.`);
              } else if (accumulation && !accumulation.confirmed) {
                // eslint-disable-next-line no-console
                console.log(`[composer-accumulation-candidate] ${sessionId} sum-matched but hash confirmation REFUSED gen=${live.submitGeneration} spanGens=${JSON.stringify(accumulation.spanGens)} sumOfWrittenLens=${accumulation.sumOfWrittenLens} reportedLen=${reported.length} concatenatedHash=${accumulation.concatenatedHash} reportedHash=${sigReported.hash} — same total length as a candidate accumulation span, but the content/order doesn't match; NOT reported as [composer-accumulation].`);
              }
              // Card d005f55b DoD-2 — its OWN verdict kind, never folded into [composer-accumulation] above
              // (that tag's own CONFIRMED claim is specifically "Loom wrote each of these EXACTLY ONCE",
              // which is false here by construction: the prior generation's own content reached the composer
              // via ITS OWN already-diverged report, not via a Loom write). Only tried when the clean
              // detector above did NOT already confirm — see detectComposerAccumulationOverDivergedPrior's
              // own doc for why these two are mutually exclusive by construction (a clean confirmed span
              // sums WRITTEN lengths; this candidate sums one REPORTED length, and both matching the same
              // reportedLen at once is not excluded by the code but has no known specimen).
              const divergedPriorAccumulation = !accumulation?.confirmed
                ? detectComposerAccumulationOverDivergedPrior(reported.length, sigReported.hash, intended, priorReportedEntry)
                : null;
              if (divergedPriorAccumulation) {
                // eslint-disable-next-line no-console
                console.log(`[composer-accumulation-diverged-prior] ${sessionId} CONFIRMED gen=${live.submitGeneration} priorGen=${divergedPriorAccumulation.priorGen} sumOfLens=${divergedPriorAccumulation.sumOfLens} reportedLen=${reported.length} — the engine reported back generation ${divergedPriorAccumulation.priorGen}'s own REPORTED echo (NOT what Loom wrote for it — that generation's own report had already diverged) fused with THIS generation's own written text. Card d005f55b — a compounding accumulation over a previously-diverged generation, a DISTINCT verdict kind from a clean [composer-accumulation]; see that card's §THE COMPOUNDING MECHANISM.`);
              }
              // Card d005f55b — manager-supplied LIVE evidence, 2026-08-06 (sessions 494db005/f6eeeb52):
              // confirms Candidate #3 as a real, measured DEFICIT shape (reported shorter than intended by
              // exactly the possible-duplicate tag's own 40-char length) — see
              // detectPossibleDuplicateWrapperDeficit's own doc. Logged unconditionally here (independent
              // signal), same posture as the two diagnostics just above; the SESSION-facing notice's own
              // priority (below) still defers to a stronger exact match (replayedEntry/confirmedFusion/
              // confirmedDivergedPrior) when one also applies.
              const wrapperDeficit = detectPossibleDuplicateWrapperDeficit(reported, intended);
              if (wrapperDeficit) {
                // eslint-disable-next-line no-console
                console.log(`[prompt-mismatch-wrapper-deficit] ${sessionId} gen=${live.submitGeneration} reportedLen=${reported.length} intendedLen=${intended.length} strippedTagLen=${wrapperDeficit.strippedTag.length} strippedTag=${JSON.stringify(wrapperDeficit.strippedTag)} — the engine's report matches EXACTLY this generation's own intended text with a possible-duplicate tag stripped (byte-for-byte). Card 854d1632 (measured, not a guess): best explained as a STALE, out-of-order confirmation of an EARLIER bare write, compared against an already-advanced (wrapped) generation — NOT corruption, NOT content loss.`);
              }
              // Card a640c110 — sibling diagnostic to the wrapper-deficit one just above: see
              // detectAnsiEscapeStripDeficit's own doc. Logged unconditionally here (independent signal),
              // same posture as every other diagnostic in this block; the SESSION-facing notice's own
              // priority (below) still defers to a stronger exact match when one also applies.
              const ansiStripDeficit = detectAnsiEscapeStripDeficit(reported, intended);
              if (ansiStripDeficit) {
                // eslint-disable-next-line no-console
                console.log(`[prompt-mismatch-ansi-strip] ${sessionId} gen=${live.submitGeneration} reportedLen=${reported.length} intendedLen=${intended.length} strippedAnsiLen=${ansiStripDeficit.strippedAnsiLen} — the engine's report matches EXACTLY this generation's own intended text with all ANSI/CSI escape sequences stripped (byte-for-byte). Card a640c110 (measured, not a guess): the engine's own echo strips ANSI/CSI styling — NOT corruption, NOT content loss.`);
              }
              // Card 201d0d95 Q1: SURFACE the mismatch to the session itself — until now every branch above
              // was LOG-ONLY (daemon-output.log), and the shipped doctrine (orchestrate/SKILL.md) only ever
              // documented the byteIdentical=true happy path, so a manager had no way to learn a submission
              // had been silently substituted, nor that whatever WAS submitted might be a re-delivery of an
              // earlier message. Fires on every byteIdentical=false confirmation reaching this point — not
              // only the exact-single-generation-replay shape that motivated it — since ANY mismatch here
              // means a turn is about to run (or just ran) on content Loom did not intend for this
              // generation. Report OBSERVED FIELDS ONLY (lengths/hashes/gens) — never assert a CLI-internal
              // CAUSE, which lives outside this repo and is unverified (card 201d0d95 DoD-2's own stated
              // limit). Name BOTH halves, since a notice naming only one leaves the other invisible: the
              // intended text may not have reached the engine at all (a possible LOSS), and separately, the
              // content that WAS submitted may itself be a duplicate re-delivery of an earlier generation (a
              // possible DUPLICATE) — checked directly against `live.recentWrittenTurns` (the same ring
              // `detectComposerAccumulation` already reads), a single-entry exact match rather than a
              // concatenated-span match, so this can name the specific prior generation when one matches.
              //
              // Platform sweep, 2026-08-05, over RETAINED logs (a FLOOR, not an all-time rate): 3,816
              // [prompt-echo] records, 288 mismatches (7.5%), 15 SUBSTITUTION-SIGNATURE occurrences across 14
              // sessions (0.39% of submissions) — recurred within one session (gen 5 and gen 8), and CURRENT
              // (a session live on this fleet the same day). In ALL 15, the replay was of the IMMEDIATELY
              // PRECEDING RECORDED generation (N←N-1, never older) and reportedLen < writtenLen (the newer,
              // larger payload is always what's lost). LIMITS on that count: only THIS card's own gen=7/8 pair
              // was eyeballed on raw lines — the other 14 are matched by signature only, not individually
              // inspected; the other 273 mismatches were NOT classified into this shape and must not be
              // folded into it (plausibly the pre-registered benign/accumulation classes instead); a gen
              // number can be absent from the echo record, so "N-1" means the previous *recorded* generation.
              // This is a MEASURED REGULARITY, not a mechanism — the notice below states it as an observed
              // pattern to help a reader find the right earlier message, never as a claimed CAUSE.
              // findLast, not find: Loom's own `warning`-kind nudges are REPEATEDLY re-sent byte-identical
              // text by construction (idle/context/busy-stuck watchdogs, boot continuation notes), so the
              // SAME string legitimately appearing at more than one generation in this ring is an ordinary
              // occurrence, not a contrived one. `find` would return the OLDEST match — if identical text was
              // also written at an earlier, non-adjacent generation, that would mislabel a genuine N-1 replay
              // as an "unusual shape", manufacturing apparent counter-evidence against the measured N<-N-1
              // regularity this notice itself cites. `findLast` returns the MOST RECENT matching generation,
              // which is the one an actual replay-of-the-immediately-preceding-submission would produce.
              const replayedEntry = live.recentWrittenTurns.findLast((e) => e.text === reported);
              const priorEntry = live.recentWrittenTurns.length >= 2 ? live.recentWrittenTurns[live.recentWrittenTurns.length - 2] : undefined;
              const isImmediatePrior = replayedEntry !== undefined && priorEntry !== undefined && replayedEntry.gen === priorEntry.gen;
              // Card d005f55b DoD-3 (the card's own floor item): only reached once an exact replay AND
              // both confirmed-accumulation shapes above have already refused — see
              // findRecognizedSubstring's own doc for why this asserts no new confidence, only names what
              // WAS recognized so the fallback wording below can say a REMAINDER is unaccounted-for instead
              // of reading identically to a genuinely uncharacterized mismatch.
              // Card d005f55b DoD-3: search PRIOR writes only (`slice(0, -1)` drops the current
              // generation's own just-pushed entry, always the ring's last) — see findRecognizedSubstring's
              // own doc for why including the current generation would trivially "recognize" the caller's
              // own turn on nearly every unmatched-longer mismatch and never surface a genuinely prior one.
              const unmatchedRecognized = (replayedEntry === undefined && !accumulation?.confirmed && !divergedPriorAccumulation)
                ? findRecognizedSubstring(reported, live.recentWrittenTurns.slice(0, -1))
                : null;
              if (unmatchedRecognized) {
                const excerpt = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s);
                // eslint-disable-next-line no-console
                console.log(`[prompt-mismatch-unmatched-remainder] ${sessionId} gen=${live.submitGeneration} recognizedGen=${unmatchedRecognized.gen} matchedLen=${unmatchedRecognized.matchedLen} reportedLen=${reported.length} leadingRemainderLen=${unmatchedRecognized.leadingRemainder.length} trailingRemainderLen=${unmatchedRecognized.trailingRemainder.length} leadingRemainder=${excerpt(unmatchedRecognized.leadingRemainder)} trailingRemainder=${excerpt(unmatchedRecognized.trailingRemainder)} — card d005f55b DoD-3: otherwise-unmatched, but reported CONTAINS generation ${unmatchedRecognized.gen}'s own recorded write as a substring; the remainder(s) above are NOT accounted for. No mechanism or confirmation is claimed by this alone.`);
              }
              const replayNote = replayedEntry
                ? isImmediatePrior
                  ? `The submitted content exactly matches what this session itself wrote for the IMMEDIATELY PRECEDING generation (gen=${replayedEntry.gen}) — the shape every measured occurrence of this class of mismatch has shown so far. If that generation's own turn already ran, this is likely a DUPLICATE re-delivery of it, not new content — check the message sent just before this one.`
                  : `The submitted content exactly matches what this session itself wrote for an EARLIER generation (gen=${replayedEntry.gen}, not the immediately preceding one) — if that generation's own turn already ran, this may be a DUPLICATE re-delivery of it, not new content. This is an unusual shape: every measured occurrence of this class of mismatch so far replayed only the immediately preceding generation.`
                // Card d005f55b DoD-3: a WEAKER, additive recognition — not an exact replay/accumulation
                // match, so this stays in the "possible LOSS" family below, but names what WAS recognized
                // instead of reading as a plain "matched nothing" (see findRecognizedSubstring's own doc).
                : unmatchedRecognized
                  ? `The submitted content could not be matched EXACTLY to any of this session's own recent writes, but it DOES contain generation ${unmatchedRecognized.gen}'s own recorded write as a substring (${unmatchedRecognized.matchedLen} of ${reported.length} total chars recognized) — ${unmatchedRecognized.leadingRemainder.length} char(s) before it and ${unmatchedRecognized.trailingRemainder.length} char(s) after it are NOT accounted for by anything Loom has a record of writing on this session. This is a partial recognition only, not a confirmed replay or accumulation — nothing here establishes what the unrecognized remainder is or where it came from.`
                : priorEntry !== undefined
                  ? "The submitted content does not match any of this session's own recent writes that Loom still has a record of. Every measured occurrence of this class of mismatch so far replayed the IMMEDIATELY PRECEDING submission — check the message sent just before this one for what may have been duplicated, even though this specific case could not be matched directly."
                  // Card f5f6515a (manager msg 71e5f76d): guards against the "check the message sent just
                  // before this one" advice firing when NO prior submission structurally exists to check —
                  // keyed on `priorEntry` (the actual ring content), not a literal `gen === 1`, so a resumed/
                  // forked session presenting a thin `recentWrittenTurns` for reasons other than being on
                  // its first generation is handled correctly too, not just a true first-ever submission.
                  : "The submitted content does not match any of this session's own recent writes that Loom still has a record of. There is no earlier write recorded for this session in Loom's own tracking — this may genuinely be its first submission, or a resume/recycle boundary where that tracking restarted — so there is no 'message sent just before this one' to check.";
              // Card cf2fef73 (owner-reported, false LOSS alarm on benign whitespace re-rendering): before
              // treating this mismatch as notice-worthy to the SESSION, check whether `reported` and
              // `intended` reconcile once whitespace is normalized — tabs and runs of spaces collapsed, line
              // endings normalized. A terminal that echoes a submitted TAB back space-expanded produces
              // byte-identical CONTENT, but the byte-wise scan above diverges AT the tab and never re-syncs
              // (see the corrected comment above `divergesAtChar` for why tail size can't tell this apart
              // from a real splice). FAIL CLOSED: normalization only ever SUPPRESSES the notice, never adds
              // one — a mismatch that reconciles under normalization is benign and skipped below; one that
              // does NOT reconcile keeps firing exactly as it does today, unconditionally, including the real
              // substitution class (card 201d0d95) this notice exists to catch. The diagnostic
              // `[prompt-mismatch]` / `[prompt-echo]` / `[composer-accumulation*]` logs above are UNCONDITIONAL
              // on this check — only the session-facing alarm below is gated, so the raw corpus is preserved.
              const normalizeForMismatchNotice = (s: string) => s.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/ +/g, " ");
              const isBenignWhitespaceRerender = normalizeForMismatchNotice(reported) === normalizeForMismatchNotice(intended);
              // Card cf2fef73 (manager review, second population — MEASURED the largest single benign class
              // in the corpus): a STALE PLACEHOLDER PREFIX. The engine echoes back OLDER, already-collapsed
              // paste-placeholder frame(s) (Claude Code's own paste-collapse UI — a SEPARATE mechanism from
              // detectPastePlaceholderLengthLoss/eef4883c/0f9268cc, which this card does not touch) PREPENDED
              // onto what is otherwise the correctly-submitted `intended` text, unchanged. Content is fully
              // present — `reported` is LARGER than `intended` by exactly the prefix's own length, the wrong
              // direction for a loss. TWO PLACEHOLDER FORMS are measured in production: `[Pasted text #N +M
              // lines]` (with a line count) and `[Pasted text #N]` (no line count) — and PLACEHOLDERS STACK:
              // a real specimen carried THREE concatenated, MIXING both forms (`[Pasted text #11][Pasted
              // text #12 +38 lines][Pasted text #13 +40 lines]`, delta=71=17+27+27 exactly). The strip is
              // therefore GLOBAL — one-or-more repetitions of the token, matched as a single leading run —
              // not a single-shot match: a single-shot strip would leave later placeholders in the
              // remainder on a stacked run, so `remainder !== intended`, so the identity below would FAIL
              // and the notice would FIRE on a provably benign case — fail-OPEN in exactly the dense-paste
              // case where a false alarm costs the most (manager review, card cf2fef73). PRECISE,
              // non-heuristic, fails closed by construction (no band/threshold/tail arithmetic) regardless
              // of how many placeholders matched or which form(s): only suppress when `reported` is EXACTLY
              // `<the whole leading placeholder run>` + `intended`, byte-for-byte after stripping it — a
              // placeholder run that instead REPLACED real content (measured: both a `lenDelta=-579`
              // specimen for form 1 and negative-delta specimens for form 2, `reported` SHORTER — a genuine
              // loss) does not match this shape and keeps firing, unchanged.
              const stalePlaceholderPrefixMatch = /^(?:\[Pasted text #\d+(?: \+\d+ lines)?\])+/.exec(reported);
              const isStalePlaceholderPrefix = stalePlaceholderPrefixMatch !== null && reported.slice(stalePlaceholderPrefixMatch[0].length) === intended;
              // Card 2b57b5a9 (n=13, 10 distinct positions, zero exceptions): a stray U+000C (form
              // feed) lands in the engine-reported echo at an EXACT MULTIPLE of PTY_WRITE_CHUNK_UNITS,
              // mid-token. Root cause (DoD-4): `repaint()` writes a raw Ctrl-L directly to the pty,
              // unsynchronized with `writeChunked` — when a viewer's repaint (Terminal.tsx's post-
              // attach "geometry" handler) lands in `writeChunked`'s inter-chunk pacing gap while a
              // bracketed-paste run is still open, the engine treats the stray byte as literal pasted
              // content instead of a repaint trigger, landing exactly at the chunk seam. RECONCILIATION,
              // not signature, is the suppression bar (binding per this card, from a dissolved
              // counter-specimen `f1a8dce1`): stripping the ONE form feed at that exact seam must make
              // the remainder byte-IDENTICAL to `intended` — a genuinely lost/truncated payload cannot
              // satisfy that, so this can never mask a real loss. Mirrors `isStalePlaceholderPrefix`'s
              // own exact-strip-and-compare discipline; only the position (a seam, not a fixed prefix)
              // differs. `i > 0` excludes a divergence AT the very start (before any chunk was ever
              // written) — not a chunk seam.
              const isChunkSeamFormFeed = i > 0 && i % PTY_WRITE_CHUNK_UNITS === 0 && reported[i] === "\u000c" &&
                reported.slice(0, i) + reported.slice(i + 1) === intended;
              if (!isBenignWhitespaceRerender && !isStalePlaceholderPrefix && !isChunkSeamFormFeed) {
                // Card 68459420 — DoD-3: a Platform sweep (2026-08-05) found a FOURTH population outside
                // the three characterized above: reported LONGER than intended AND matching NO recent
                // write of this session (first specimen: gen=12, wrote 2985 reported 3829 — the notice's
                // OWN replayNote text below already flags this shape as unusual, since every OTHER
                // measured occurrence replayed the immediately preceding generation). Characterize it
                // ONLY — tag it so it can be swept and counted, exactly like the sweep note above this
                // block already does for the replay shape. Do NOT fold it into that shape (it explicitly
                // failed the replay match) and do NOT invent a suppression for it: this population is not
                // yet understood, and cf2fef73's own worker set the precedent for refusing to guess here
                // (card 2b57b5a9, the form-feed specimen).
                // Card f5f6515a (Code Reviewer MEDIUM): `!accumulation?.confirmed` added — this tag's own
                // condition (`reported.length > intended.length`, no recentWrittenTurns match via
                // `replayedEntry`) is satisfied by EVERY confirmed fusion too (a fusion is, by construction,
                // longer than the current turn's own intended text and never matches a SINGLE ring entry).
                // Left unguarded, every confirmed fusion inflated this "UNCHARACTERIZED" count while the
                // `[composer-accumulation]` line logged one statement earlier already disproves the claim —
                // a Platform sweep grepping/counting this tag to gauge whether the population needs a card
                // would be counting events this file already has a full, hash-confirmed answer for.
                // `accumulation` (not `confirmedFusion`) — this check runs before `confirmedFusion` is
                // computed further down, and doesn't need its `replayedEntry === undefined` re-check here
                // (already the leading condition on this same line).
                // Card d005f55b: `!divergedPriorAccumulation` added for the SAME reason `!accumulation?.confirmed`
                // was — a confirmed diverged-prior fusion is, by the same construction, reported LONGER than
                // intended and never matches a single ring entry, so left unguarded it would ALSO inflate this
                // UNCHARACTERIZED count for a shape `[composer-accumulation-diverged-prior]` one statement
                // earlier already has a full, hash-confirmed answer for.
                if (replayedEntry === undefined && reported.length > intended.length && !accumulation?.confirmed && !divergedPriorAccumulation) {
                  // eslint-disable-next-line no-console
                  console.log(`[prompt-mismatch-unmatched-longer] ${sessionId} gen=${live.submitGeneration} reportedLen=${reported.length} intendedLen=${intended.length} lenDelta=${reported.length - intended.length} — UNCHARACTERIZED population (card 68459420): reported LONGER than intended, matches none of this session's recent writes, and is neither of the two known benign prefix/whitespace shapes above. Distinct from the measured replay-of-immediately-preceding-generation regularity — do not assume a mechanism or fold this into that shape.`);
                }
                // Card 68459420 — DoD-1: the SENDER-directed arm. When `replayedEntry` is found, the
                // notice's own replayNote below already asserts this as a replay of a prior generation —
                // an ESTABLISHED loss, not a possible one — but the RECIPIENT can never verify that: it
                // only ever sees what arrived, never what was intended for it. Record it here (read-only
                // PULL surface, see getLastMismatchReplay) so the party who CAN act — this session's
                // manager/parent, via worker_list/worker_status — learns of it the next time it already
                // looks, per DoD-4 (a precondition at the point of use beats a longer advisory).
                if (replayedEntry !== undefined) {
                  live.lastMismatchReplay = { gen: live.submitGeneration, replayedGen: replayedEntry.gen, reportedLen: reported.length, intendedLen: intended.length, detectedAt: Date.now() };
                }
                // Card f5f6515a DoD-4: the FUSED counterpart to the single-entry replay above — reuses the
                // SAME `accumulation` result `detectComposerAccumulation` already computed (no second
                // matcher), captured ONCE here and reused below for BOTH the pull-surface field and the
                // notice wording (manager review, card 5eef504d): the session-facing notice used to be
                // composed from ONLY `replayedEntry`, never consulting this already-CONFIRMED result sitting
                // one variable away — a real recipient (the manager's own gen=9) was told "could not be
                // matched... possible LOSS" about an event Loom had already established as a confirmed
                // accumulation. NOT an ordering bug — `accumulation` (line ~4534) and this notice's own
                // wording are computed back-to-back in the SAME synchronous block, no async gap — a pure
                // OMISSION in what the notice consulted, not a timing race. `replayedEntry === undefined`
                // guards against ever firing for a shape `lastMismatchReplay` already covers — not because a
                // single-entry match is itself producible by `detectComposerAccumulation` (it only ever
                // tries spans of 2+ entries), but because a concatenation could coincidentally equal some
                // OTHER single prior entry's own text, which `replayedEntry` already claims more precisely;
                // this keeps the two fields mutually exclusive even in that coincidence. NO span upper bound
                // (Code Reviewer HIGH, card f5f6515a — an earlier `spanGens.length <= 2` here left the
                // session-facing notice below FALSELY telling a session "could not be matched... possible
                // LOSS" about a genuinely span>=3 CONFIRMED fusion, provably false in the very same
                // synchronous block; see `Live.lastMismatchFusion`'s own doc for why that cap's supporting
                // evidence didn't survive scrutiny either). A typed local (not a bare boolean) so
                // `accumulation`'s non-null, confirmed shape stays narrowed for every later use below.
                const confirmedFusion = (replayedEntry === undefined && accumulation?.confirmed) ? accumulation : null;
                if (confirmedFusion) {
                  live.lastMismatchFusion = { gen: live.submitGeneration, spanGens: confirmedFusion.spanGens, reportedLen: reported.length, intendedLen: intended.length, detectedAt: Date.now() };
                }
                // Card d005f55b DoD-2: same posture as `confirmedFusion` above, for the diverged-prior
                // candidate — already computed once, alongside `accumulation`, and reused here for the
                // notice text below. Mutually exclusive with `confirmedFusion` by construction (see
                // `detectComposerAccumulationOverDivergedPrior`'s own doc): a clean fusion, being the
                // stronger confirmation, takes precedence in the vanishingly-unlikely case both matched.
                const confirmedDivergedPrior = (replayedEntry === undefined && !confirmedFusion && divergedPriorAccumulation) ? divergedPriorAccumulation : null;
                // Card d005f55b — manager-supplied LIVE evidence: same precedence posture as
                // `confirmedDivergedPrior` above (a stronger exact match, were one to also apply, wins) —
                // reuses `wrapperDeficit`, already computed above alongside its own diagnostic log.
                // Card 854d1632 v5 (measured, not a guess): deliberately does NOT require
                // `replayedEntry === undefined`, unlike `confirmedFusion`/`confirmedDivergedPrior` above.
                // A benign wrapper deficit IS, essentially by construction, a recognized replay — the stale,
                // out-of-order confirmation of an EARLIER bare write naturally matches that earlier write's
                // own recorded text byte-for-byte, so `replayedEntry` is non-null in exactly the case this
                // verdict exists to explain. Gating on it here reproduced the card's live incident: the
                // classifier fired (see the diagnostic log above) but the session-facing notice below still
                // took the `lossClause`'s "ESTABLISHED loss" branch, because `replayedEntry !== undefined`
                // nulled this verdict first. Safe to reorder past `confirmedFusion`/`confirmedDivergedPrior`
                // without touching their own `replayedEntry === undefined` guards: both are ALREADY always
                // null whenever `replayedEntry !== undefined` (it's baked into their own conditions), so
                // `!confirmedFusion && !confirmedDivergedPrior` alone still correctly defers to either when
                // one applies — nothing here changes their own precedence. The real-loss case (a verbatim
                // replay with NO wrapper on this generation's own intended text) stays unaffected:
                // `detectPossibleDuplicateWrapperDeficit` returns null immediately when `intended` carries no
                // possible-duplicate tag to strip, regardless of `replayedEntry` — see its own doc.
                const confirmedWrapperDeficit = (!confirmedFusion && !confirmedDivergedPrior && wrapperDeficit) ? wrapperDeficit : null;
                // Card a640c110 — same precedence posture as `confirmedWrapperDeficit` just above (a
                // stronger exact match, were one to also apply, wins) — reuses `ansiStripDeficit`, already
                // computed above alongside its own diagnostic log. Also deliberately does NOT require
                // `replayedEntry === undefined` (mirrors `confirmedWrapperDeficit`'s own reasoning): an
                // exact ANSI-stripped match is strictly MORE informative than the ambiguous replay framing
                // the fallback below would otherwise give it, so it should win precedence whenever it fires,
                // regardless of whether `reported` also happens to coincide with some earlier recorded
                // write. Guarded against `confirmedWrapperDeficit` too so the two exact-strip shapes stay
                // mutually exclusive in the vanishingly-unlikely case both matched.
                const confirmedAnsiStripDeficit = (!confirmedFusion && !confirmedDivergedPrior && !confirmedWrapperDeficit && ansiStripDeficit) ? ansiStripDeficit : null;
                // Card 68459420 — DoD-2: split the two claims and address each to the party that can act
                // on it, rather than asking the RECIPIENT to verify a loss only the SENDER can see. The
                // duplicate-check advice in `replayNote` was correct and used correctly (per the card's
                // own live specimen) — kept unchanged.
                //
                // Card b7158b99 — CORRECTION: the `replayedEntry !== undefined` branch below used to state
                // the loss as ESTABLISHED here, at THIS generation's own detection time. That is FALSE in
                // general and was measured false on a real specimen (a manager's own session, gen=8/9/10):
                // `reported` at gen=9 was a verbatim replay of gen=8 (exactly what this branch detects), but
                // gen=9's own 5313-char intended text was never actually gone — it was still sitting in the
                // composer, uncleared, and gen=10's own submission fused it back in whole
                // (`detectComposerAccumulation` CONFIRMED spanGens=[8,9,10], sum 1083+5313+579=6975 matching
                // the engine's own reported length and hash exactly). The `confirmedFusion` branch below
                // fires ITS OWN "ESTABLISHED — nothing was lost" notice for gen=10 when that happens — so by
                // the time this generation's OWN notice fires, whether ITS content will be recovered by a
                // later fusion is not a knowable fact yet, it is a FUTURE EVENT that has not happened. This
                // is not merely unmeasured — `detectComposerAccumulation`'s own doc (this file, ~line 152)
                // states the coverage limit structurally: recovery is detectable ONLY at the NEXT write on
                // this session, and is "structurally invisible" if no next write ever comes. So the honest
                // framing at THIS point in time is "cannot yet be established either way" — never "possible"
                // (that undersells a real, measured recurring shape) and never "ESTABLISHED loss" (that
                // overclaims a fact the code cannot know yet). The prescribed action changes to match: do
                // NOT tell the reader to get a re-send now — a re-send composed on top of a later fusion
                // recovery would hand the recipient the same content twice. Tell them to wait one generation
                // and re-check (a `[loom:prompt-mismatch]` fusion notice, or `lastMismatchFusion` naming this
                // generation in its own `spanGens`, means it was recovered) before asking anyone to re-send.
                // The unmatched-mismatch branch below is UNCHANGED — it already used the cautious "possible
                // LOSS" framing pre-existing this card, which this reasoning does not contradict (an
                // unmatched mismatch has no known prior entry to ever be fused back from, so there is no
                // pending-recovery half to name for it the way there is for a recognized replay).
                const lossClause = replayedEntry !== undefined
                  ? `The submitted content is a REPLAY of an earlier generation — the text Loom intended for THIS turn did not reach you as its own turn. This is NOT an established loss: the composer may still hold it, and a LATER generation's own submission may fuse it back in whole (if that happens you will see a SEPARATE, later notice saying plainly that nothing was lost) — whether that happens is unknowable until that later generation, if any, actually occurs. You cannot verify this yourself either way: you only ever see what arrived, never what was intended for you. Do not ask anyone to re-send yet — wait one generation and re-check before treating this as a confirmed loss. If you are a Loom-driven session, say so in your next report up.`
                  : `This means the text Loom intended for this turn may not have reached you at all — a possible LOSS, though (unlike a confirmed replay) this content could not be matched to any of this session's own recent writes, so it is not established the way a recognized replay is.`;
                // Card f5f6515a DoD-4 (manager review 5eef504d): a confirmed fusion gets its OWN complete
                // notice text rather than a patched `lossClause`/`replayNote` — those two are built around a
                // loss/replay dichotomy with no "possible LOSS" branch that's safe to reuse for a case where
                // NOTHING was lost. REQUIRED (manager, card f5f6515a): the phrase "possible LOSS" must never
                // appear here — that phrase is what sent a real reader (the manager's own gen=9) chasing a
                // loss that never happened. Reuses `confirmedFusion` — the exact SAME `accumulation` result
                // captured above, no new matcher. The genuinely-unmatched and single-entry-replay branches
                // below are BYTE-IDENTICAL to before this change; only the new branch is added.
                // Card f5f6515a (Code Reviewer HIGH follow-up): named EVERY earlier generation in the span,
                // not just `spanGens[0]` — now that the span cap is removed (see `confirmedFusion`'s own
                // comment), a confirmed fusion can legitimately cover 3+ generations, and naming only the
                // first would silently under-report which turns may have been acted on twice.
                const earlierFusedGens = confirmedFusion ? confirmedFusion.spanGens.slice(0, -1) : [];
                // Card 59757189 DoD-1/3 — CAPTURE AT DETECTION, for the UNMATCHABLE case only: none of the
                // confirmed/recognized shapes above claimed this mismatch (not a single-entry replay, not a
                // confirmed fusion, not a diverged-prior fusion, not a wrapper-deficit or ANSI-strip benign
                // shape) — this is exactly the generic fallback branch further below (the final arm of the
                // `mismatchText` ternary). `3ff61275` (predecessor, DoD-7) deliberately left this population
                // unaddressed, shipping only the WHICH-payload identity clause. `recentWrittenTurns` (this
                // file, `COMPOSER_ACCUM_WINDOW`=8 above) is NOT a substitute for capturing HERE: it is a
                // bounded, oldest-first ring that a later reader (via `getLastMismatchUnmatched`) may find
                // has already rotated past this generation — `intended`, still in scope in this exact
                // synchronous block, is the only place this content still exists once detection has passed
                // (the reporter's own correction on the predecessor card: "the content was in hand at
                // detection time and discarded milliseconds later"). See `Live.lastMismatchUnmatched`'s own
                // doc for the storage/decidability contract (stored in full, no head-bounding; `null`/
                // `undefined` are the only "not captured" states).
                const isUnmatchableMismatch = replayedEntry === undefined && !confirmedFusion && !confirmedDivergedPrior && !confirmedWrapperDeficit && !confirmedAnsiStripDeficit;
                if (isUnmatchableMismatch) {
                  live.lastMismatchUnmatched = { gen: live.submitGeneration, intendedLen: intended.length, intendedText: intended, detectedAt: Date.now() };
                }
                // Card 3ff61275 DoD-7 (MINIMUM VIABLE FIX — scoped floor beneath DoD-1's still-pending
                // content-retention question, request 0eb43216): every branch below narrates THIS turn's
                // own write (gen=${live.submitGeneration}) but, until now, identified it by that bare gen
                // number alone — no wall-clock anchor, no message identity. THE THIRD FIELD INSTANCE
                // (escalation f1a8dce1) is exactly this gap: a gen=1 mismatch notice, delivered at gen=2,
                // was read by its recipient ~16 minutes later with an unrelated gen=3 approval already in
                // hand — nothing in the notice text let it tell "this happened 19 minutes ago" apart from
                // "this is about what I'm holding right now", so it misattributed the alarm to the wrong
                // payload and escalated a false total-data-loss report. All FIVE branches below (fusion,
                // divergedPrior, wrapperDeficit, ansiStripDeficit, and the generic fallback) share this
                // EXACT lead-in sentence and are equally exposed to the same failure mode regardless of
                // their own conclusion — an "ESTABLISHED, nothing lost" notice is just as mis-attributable
                // as a "possible LOSS" one if the recipient can't tell which payload it's about, so the
                // identity clause is added once here, to the shared lead-in, rather than to only the
                // fallback branch that happened to be the one hit so far.
                // `writeWallClockAt`: the SAME field the `[submit] CONFIRMED` log line a few dozen lines
                // above already reads for this identical generation (`live.currentGenFirstWrittenAt`) — the
                // real Enter-write timestamp for THIS generation, not a detection-time `Date.now()` that
                // would silently drift from when the content actually landed.
                // `writeMsgId`: the SAME `live.giveUpOrigin?.[0]?.logicalId` pattern that same log line
                // already uses for this identical generation — the originating message's stable id, where
                // one is recorded.
                // DoD-2 (decidability): both are rendered as an explicit "unrecorded"/"none recorded" word
                // when absent — never an empty/blank field a reader could misread as "there was no write".
                const writeWallClockAt = live.currentGenFirstWrittenAt !== null ? new Date(live.currentGenFirstWrittenAt).toISOString() : "an unrecorded time";
                const writeMsgId = live.giveUpOrigin?.[0]?.logicalId ?? "none recorded";
                const writeIdentity = `written at ${writeWallClockAt}, msgId=${writeMsgId}`;
                const mismatchText = confirmedFusion
                  ? `[loom:prompt-mismatch] Loom wrote ${intended.length} chars for this turn (gen=${live.submitGeneration}, ${writeIdentity}), but the engine's own report of what it submitted is ${reported.length} chars and does not match byte-for-byte ` +
                    `(writtenHash=${sigWritten.hash} reportedHash=${sigReported.hash}). ESTABLISHED — nothing was lost: the engine's report is a CONFIRMED accumulation (spanGens=${JSON.stringify(confirmedFusion.spanGens)}) — the text Loom intended for THIS turn is in what arrived, fused together with generation(s) ${earlierFusedGens.join(", ")}'s own text because the composer had not fully cleared since ${earlierFusedGens.length > 1 ? "those earlier writes" : "that earlier write"}. If any of generation(s) ${earlierFusedGens.join(", ")}'s own turn already ran, you may be about to act on a piece of it a second time — check your own artifacts for that before treating everything in this turn as new. ` +
                    `What YOU can check yourself: your own artifacts (an action you just took, a decision you just made) for whether you've now acted on any of this content twice — that duplicate check is yours to make. There is no loss half to verify here: the full text intended for this turn did arrive.`
                  // Card d005f55b DoD-2: its OWN complete notice text, never patched onto `lossClause`/
                  // `replayNote` (same reasoning `confirmedFusion`'s own branch above was given, card
                  // f5f6515a review 5eef504d) and never worded as a plain CONFIRMED fusion (card d005f55b's
                  // own explicit instruction) — the prior generation's own content was ALREADY not what
                  // Loom intended for it, so this turn's exposure is weaker than a clean fusion's, even
                  // though nothing of THIS turn's own text was lost either.
                  : confirmedDivergedPrior
                    ? `[loom:prompt-mismatch] Loom wrote ${intended.length} chars for this turn (gen=${live.submitGeneration}, ${writeIdentity}), but the engine's own report of what it submitted is ${reported.length} chars and does not match byte-for-byte ` +
                      `(writtenHash=${sigWritten.hash} reportedHash=${sigReported.hash}). ESTABLISHED, DISTINCT FROM A CLEAN FUSION — nothing of THIS turn's own content was lost: the engine's report is a CONFIRMED accumulation over generation ${confirmedDivergedPrior.priorGen}'s own REPORTED echo, NOT what Loom wrote for that generation — generation ${confirmedDivergedPrior.priorGen}'s own submission had ALREADY diverged from what Loom intended before this turn ever ran (see [composer-accumulation-diverged-prior] above; card d005f55b). If generation ${confirmedDivergedPrior.priorGen}'s own turn already ran, you may be about to act on UNVERIFIED content a second time — that generation's own reported content was never confirmed to be what Loom actually sent it, so treat it with more caution than an ordinary duplicate. ` +
                      `What YOU can check yourself: your own artifacts for whether you've now acted on any of generation ${confirmedDivergedPrior.priorGen}'s own content twice. There is no loss half to verify for THIS turn specifically — this turn's own intended text is in what arrived.`
                  // Card 854d1632 (manager measurement, 2026-08-06, SUPERSEDES an earlier "the tag itself
                  // did not reach you" / "TREAT THIS TURN'S CONTENT AS A POSSIBLE DUPLICATE ANYWAY" draft
                  // of this branch — that draft was WRONG about the mechanism and has been corrected):
                  // verified via `[submit-write]`/`[prompt-echo]` pairs that a wrapped write DOES reach the
                  // engine and IS echoed back byte-identically in the ordinary case. This shape is best
                  // explained as a STALE, out-of-order confirmation — the hook belongs to an EARLIER, bare
                  // write, arriving after `live.lastPrompt` already advanced to a LATER, wrapped re-mint of
                  // the same content — an ATTRIBUTION/ORDERING artifact, NOT corruption or loss. Must NOT
                  // claim anything is missing or unreached; must NOT reuse `lossClause`'s "possible LOSS"
                  // framing (card d005f55b's own explicit instruction, same reasoning as the two branches
                  // above). Does not chase the wrapper's actual delivery path — that question is answered
                  // and tracked separately, card 854d1632.
                  : confirmedWrapperDeficit
                    ? `[loom:prompt-mismatch] Loom wrote ${intended.length} chars for this turn (gen=${live.submitGeneration}, ${writeIdentity}), but the engine's own report of what it submitted is ${reported.length} chars and does not match byte-for-byte ` +
                      `(writtenHash=${sigWritten.hash} reportedHash=${sigReported.hash}). NOT A LOSS — this looks like a STALE, out-of-order confirmation: the engine's report matches this turn's own intended text with a possible-duplicate tag ("${confirmedWrapperDeficit.strippedTag.trim()}") stripped, byte-for-byte — best explained as confirmation of an EARLIER, unwrapped write arriving after Loom had already moved on to this later, wrapped generation, not as anything failing to reach you. Every byte of that earlier content did arrive; this is an attribution/ordering artifact, not corruption. ` +
                      `What YOU can check yourself: if that earlier write's own turn already ran, this stale confirmation may be describing IT, not this generation — check your own artifacts for whether you've now acted on the same underlying content twice.`
                  // Card a640c110 — its OWN complete notice text, same posture as `confirmedWrapperDeficit`'s
                  // own branch just above (never patched onto `lossClause`/`replayNote`, never worded as a
                  // possible LOSS): a DIFFERENT benign shape (the engine's own echo stripping ANSI/CSI
                  // styling out of this generation's own intended text), not the wrapper-deficit shape's
                  // stale-confirmation-of-an-earlier-write mechanism — so worded on its own terms, not
                  // borrowed from that branch's "EARLIER write" framing.
                  : confirmedAnsiStripDeficit
                    ? `[loom:prompt-mismatch] Loom wrote ${intended.length} chars for this turn (gen=${live.submitGeneration}, ${writeIdentity}), but the engine's own report of what it submitted is ${reported.length} chars and does not match byte-for-byte ` +
                      `(writtenHash=${sigWritten.hash} reportedHash=${sigReported.hash}). NOT A LOSS — this looks like the engine's own echo stripping ANSI/CSI escape sequences: the engine's report matches this turn's own intended text with all ANSI/CSI escape sequences (${confirmedAnsiStripDeficit.strippedAnsiLen} char(s) of escape codes) removed, byte-for-byte. Every byte of the actual content did arrive; this is a rendering/echo artifact, not corruption or content loss. ` +
                      `What YOU can check yourself: nothing — this shape has no duplicate-check or re-send action to take; the content for this turn is confirmed complete.`
                    : `[loom:prompt-mismatch] Loom wrote ${intended.length} chars for this turn (gen=${live.submitGeneration}, ${writeIdentity}), but the engine's own report of what it submitted is ${reported.length} chars and does not match byte-for-byte ` +
                      `(writtenHash=${sigWritten.hash} reportedHash=${sigReported.hash}). ${lossClause} ${replayNote} ` +
                      `What YOU can check yourself: your own artifacts (an action you just took, a decision you just made) for whether you've now acted on the same content twice — that duplicate check is yours to make. The loss half above is not: only the sender can tell whether their content actually arrived.`;
                // Deferred via setTimeout(0), same reason as the paste-recovery injection above (card 0f9268cc):
                // this must land as the notice's OWN pty submission, never appended to another payload — the
                // standing rule this very finding established, since the whole point is that a payload can
                // itself be substituted — and must run OUTSIDE this hook handler's own synchronous call stack.
                // kind:"warning" (an operational nudge, not agent-authored content) so it coalesces like other
                // Loom watchdog notices rather than competing for the one-per-turn "agent" delivery slot.
                //
                // SELF-REFERENCE, NOTED AND BOUNDED — manager review, card 201d0d95: this notice is ITSELF
                // delivered as a pty submission, which sets `live.lastPrompt` for ITS OWN generation exactly
                // like any other turn — so a substituted mismatch-notice is structurally possible ("a mismatch
                // notice about a mismatch notice"), and nothing downstream can currently tell a replayed NOTICE
                // apart from a replayed ordinary payload. Deliberately NOT guarded (no recursion cap, no
                // dedup): at the measured 0.39%-of-submissions base rate (see the sweep note above), the
                // expected chain length is ~1/(1-0.0039) ≈ 1.004 — a guard would be defending against a event
                // this arithmetic says essentially never compounds — and `kind:"warning"` coalescing further
                // dampens any chain that did start by merging with whatever else is already queued, rather than
                // stacking. If a cheap, non-invasive way to let a recipient distinguish "this IS a
                // prompt-mismatch notice, replayed" from "this is a replayed ordinary message" turns up (e.g. a
                // recognizable tag check mirroring `isPasteRecoveryAttempt`), that is a follow-up, not scope
                // creep here — this comment exists so a future reader who spots the recursion finds this
                // reasoning instead of re-deriving it or reaching for an unneeded guard.
                // Card c0323f8a — EXACT-REPEAT SUPPRESSION, orthogonal to the SELF-REFERENCE note above
                // (that one is about this notice's OWN delivery mismatching; this one is about the
                // DETECTION that produced `mismatchText` re-running for the SAME underlying event). A
                // `(gen, writtenHash, reportedHash)` triple match against the last notice actually sent
                // means this exact event already got a notice — the SOUNDNESS of suppressing on this match
                // (this is a DATA-LOSS ALARM; a false suppression hides a real loss, silently) is proved on
                // `lastMismatchNoticeSignature`'s own doc, not restated here.
                //
                // ⚠️⚠️ REQUIRED FRAMING (manager review, card c0323f8a) — do not describe this as fixing an
                // OBSERVED duplicate. Guards a re-mint path that is CODE-REACHABLE but has NO OBSERVED
                // INSTANCE. Two real production specimens were examined directly against daemon-output.log
                // (each session's own `[prompt-echo]` line — emitted exactly once per detector entry,
                // confirmed via a positive control: every `UserPromptSubmit` hook pairs 1:1 with one such
                // line) and BOTH showed the detector ran ONCE, not twice, for the duplicated generation:
                //   - The card's own motivating fusion specimen (session 3c676f17…, gen=26,
                //     writtenHash=62638edc reportedHash=2ed5441f): exactly ONE `[prompt-echo]` line for
                //     gen=26 in the ENTIRE available log history (verified: `62638edc`/`2ed5441f` appear on
                //     exactly 2 lines total, both timestamped together, both describing this ONE detection
                //     — not two). The resulting notice ALSO shows exactly one clean physical pty-write (one
                //     chunk hash, one matching byteIdentical=true confirming echo) — no duplicate transmission
                //     visible at the daemon level either. If this specimen genuinely reached its recipient
                //     twice, the mechanism is invisible to every layer this daemon instruments.
                //   - A manager's own gen=28 specimen: also exactly one `[prompt-echo]` line, yet the notice
                //     was received twice — ONE MINT, TWO DELIVERIES. This fix (a mint-layer guard) would NOT
                //     have prevented that specimen either; the duplication there happened downstream of the
                //     mint, at a layer this fix does not touch.
                // So: every real specimen examined so far is explained by something OTHER than a re-mint.
                // This field's protection remains real and code-confirmed (see below), but it is a guard
                // against a path that is reachable in principle, not a fix for anything observed.
                //
                // WHAT IS NOT PROVEN: how, in production, the detection block would get re-entered a second
                // time with an unchanged `gen`, if it ever does — a literal synchronous double
                // `UserPromptSubmit` hook call for one turn is itself structurally blocked from reaching
                // here twice (`submitWasOutstanding = !live.enterConfirmed`, and this same case sets
                // `enterConfirmed = true` before the detector runs — see the top of this case). Suppress the
                // resend (still logged, and durably recorded below — never silent) rather than mint a
                // byte-identical second turn the recipient has no way to distinguish from new direction.
                // `lastMismatchReplay`/`lastMismatchFusion` above are deliberately UNTOUCHED by this check
                // (they already fired, unconditionally, before this point) — they are a manager-facing PULL
                // surface recording "a mismatch was detected", not "a notice was sent",
                // so a suppressed resend must still update them like any other detection.
                const noticeSignature = { gen: live.submitGeneration, writtenHash: sigWritten.hash, reportedHash: sigReported.hash };
                const isExactRepeatNotice = live.lastMismatchNoticeSignature !== null
                  && live.lastMismatchNoticeSignature.gen === noticeSignature.gen
                  && live.lastMismatchNoticeSignature.writtenHash === noticeSignature.writtenHash
                  && live.lastMismatchNoticeSignature.reportedHash === noticeSignature.reportedHash;
                if (isExactRepeatNotice) {
                  // eslint-disable-next-line no-console
                  console.log(`[prompt-mismatch-notice-suppressed] ${sessionId} gen=${noticeSignature.gen} writtenHash=${noticeSignature.writtenHash} reportedHash=${noticeSignature.reportedHash} — exact repeat of the last notice already sent for this event; not re-sending a byte-identical turn.`);
                  // Card c0323f8a (manager review) — DURABLE, manager-visible record of the suppression
                  // (see `lastMismatchNoticeSuppressed`'s own doc): a console line alone is invisible to
                  // the manager who actually needs to know an alarm was swallowed. `count` accumulates
                  // across repeats of the SAME signature (guaranteed to be this one — `isExactRepeatNotice`
                  // already proved the match), reset to 1 whenever a genuinely different signature is
                  // recorded (the `else` branch below, which can only run after a real notice fired).
                  const prior = live.lastMismatchNoticeSuppressed;
                  const sameAsPrior = prior !== null && prior.gen === noticeSignature.gen
                    && prior.writtenHash === noticeSignature.writtenHash && prior.reportedHash === noticeSignature.reportedHash;
                  live.lastMismatchNoticeSuppressed = { ...noticeSignature, count: (sameAsPrior ? prior.count : 0) + 1, detectedAt: Date.now() };
                } else {
                  live.lastMismatchNoticeSignature = noticeSignature;
                  setTimeout(() => { this.enqueueStdin(sessionId, mismatchText, "system", undefined, undefined, "warning"); }, 0);
                }
              }
            }
          }
        }
        this.setBusy(sessionId, true, "user-prompt-submit-hook"); // rising edge — fires for the startup-prompt arg and injected prompts alike
        // Card 2521bf51: a real turn is now confirmed in flight — clear any bounded human-submit hold
        // (see `humanSubmitHeldUntil`'s own doc); `live.busy` above already blocks drainPending anyway,
        // this just resolves the wait promptly rather than leaving it to expire on its own bound.
        // Card 3ff89cbc: UNCONDITIONAL, unlike the Stop/StopFailure clear below — a turn fires
        // UserPromptSubmit at most once, so the very next one after the hold was armed can only be a
        // genuinely NEW turn (the human's own), never the pre-existing turn's own second confirmation.
        // Reset the latch alongside the clear so a stale `true` never outlives this hold.
        live.humanSubmitHeldUntil = null;
        live.humanSubmitHeldArmedDuringTurn = false;
        break;
      }
      case "Stop":
      case "StopFailure": {
        // ┌─ M2 INVARIANT (busy-gate drain ordering) — DO NOT INTRODUCE AN `await` IN THIS BRANCH ─┐
        // │ From the setBusy(false) below to the drainPending below, execution MUST stay strictly  │
        // │ SYNCHRONOUS. The busy-gate works because once the turn ends we lower busy and IMMEDIATELY│
        // │ drain the FIFO head in the same tick — before control returns to the event loop, so no  │
        // │ concurrent enqueueStdin can observe busy=false and submit() its own turn first. If a    │
        // │ future edit `await`s anywhere in this window (e.g. an async context-stats read), an     │
        // │ enqueueStdin scheduled during that yield would slip a second turn in, interleaving two  │
        // │ turns into one session and breaking FIFO serialization. The `finalizingTurn` tripwire    │
        // │ below makes that regression LOUD: enqueueStdin asserts it is never seen true (see there).│
        // └────────────────────────────────────────────────────────────────────────────────────────┘
        // A Stop/StopFailure can only fire for a turn that actually ran, so it is itself proof the
        // outstanding submit()'s Enter registered — even on the rare path where UserPromptSubmit's own
        // hook was lost. Neutralize any still-pending verify-retry BEFORE the M2 window below.
        live.enterConfirmed = true;
        // Card 2521bf51: same "Stop is itself proof" reasoning clears any bounded human-submit hold too
        // (see `humanSubmitHeldUntil`'s own doc) — belt-and-suspenders for the rare path where the
        // UserPromptSubmit rising edge above was the one that got lost, not this Stop.
        // Card 3ff89cbc: EXCEPT when THIS Stop is itself the pre-existing, unrelated turn's own Stop —
        // the one that was already mid-flight when the hold was armed (`humanSubmitHeldArmedDuringTurn`,
        // see its own doc). Unlike UserPromptSubmit above, a Stop here is genuinely ambiguous between
        // "the pre-existing turn just ended" (not proof of anything about the human's own not-yet-started
        // Enter) and "the human's own turn just ended, confirming it via the belt-and-suspenders path"
        // (legitimate). Consume the latch instead of clearing on this first, ambiguous Stop; once
        // consumed, the pre-existing turn has genuinely ended, so a LATER Stop for this same hold can only
        // be the human's own and is trusted normally.
        if (live.humanSubmitHeldArmedDuringTurn) {
          live.humanSubmitHeldArmedDuringTurn = false;
        } else {
          live.humanSubmitHeldUntil = null;
        }
        // Card 3ce3fa39: same GATED reset as UserPromptSubmit's — see composerDirtyLenClearedByGen's doc.
        if (live.composerDirtyLenClearedByGen === live.submitGeneration) {
          live.composerDirtyLen = 0;
          live.composerDirtyLenBelieved = 0; // card c148f118: a decisive confirm collapses both readings to the same true zero
          live.composerDirtyLenClearedByGen = null;
        }
        this.purgeConfirmedGiveUpRequeue(sessionId, live, true); // card 441499ee/09e655d5 — see the method doc; before any early park-break below on purpose; Stop/StopFailure advances the queue past its front
        this.finalizingTurn = true;
        try {
          this.setBusy(sessionId, false, "stop-hook"); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
          // Companion injection-guard Primitive A: CLEAR the just-ended turn's attested owner text here —
          // unlike activeTurnRoute (which persists until the next submit() overwrites it), owner text must
          // never survive past the turn it attests, so a later non-owner-authored turn can't inherit it. A
          // rate-limited park below still replays it via lastPromptOwnerText (resumeAfterRateLimit).
          live.activeTurnOwnerText = null;
          // Companion Trust Window: CLEAR the just-ended turn's attested sender id alongside owner text —
          // same "never survive past the turn it attests" rationale. lastPromptSenderId (set in submit())
          // still carries it for a rate-limited replay.
          live.activeTurnSenderId = null;
          // Refresh context occupancy at the turn boundary — ONE single-pass tail-read of the transcript
          // (card b16320bc review: this used to be read TWICE — once here, once again below for the
          // weekly-cap text sentinel — doubling synchronous parse work of a potentially multi-MB JSONL on
          // this M2-sensitive Stop-hook chokepoint; `stats.lastAssistantText` now comes from this SAME
          // read). Cheap SYNCHRONOUS tail-read; done for EVERY session (the host doesn't know role — a
          // manager's own occupancy matters too, "who recycles the manager"). Keep it sync — see the M2
          // box above before making this (or anything here) async.
          const stats = live.engineSessionId ? readContextStats(live.cwd, live.engineSessionId) : null;
          if (stats) {
            this.events.onContextStats(sessionId, stats);
          } else if (live.engineSessionId) {
            // FAIL-VISIBLE (card 7c1fc117): a Stop always follows a completed assistant turn, so a null
            // read here is ALWAYS anomalous — never a normal "nothing to measure yet" case — and used to
            // be swallowed with zero signal, permanently freezing the persisted context counter (the
            // recycle-nudge watcher's only input) with no trace. Distinguish the two null causes so a
            // future freeze is diagnosable at a glance instead of re-investigated from scratch: the
            // transcript file itself is missing/unresolvable (cheap re-check via engineTranscriptExists,
            // which shares readContextStats' own resolveTranscriptFile resolution) vs. the file exists but
            // no assistant line in it carries a `usage` field.
            //
            // Card dbc6bcac: `engineTranscriptExists`'s FALLBACK path (only reached once its own cheap
            // direct existsSync check misses) is a synchronous O(projects) `readdirSync` of
            // `~/.claude/projects` — fine as a one-off, but this branch is anomalous-path-only, so a
            // persistently-broken session (transcript that never comes back) would otherwise re-pay that
            // scan on EVERY subsequent Stop. Check the cheap direct path ourselves first — if it hits,
            // there's nothing to throttle (this is the common, inexpensive "found-but-no-usage" case, and
            // it also means a session already latched as missing has RECOVERED, so unlatch for a fresh
            // diagnosis next time). Only when the direct check misses do we consult the latch: skip the
            // expensive fallback scan (and the log) entirely once it's already confirmed this session's
            // transcript is genuinely missing — a repeat scan would find the same nothing.
            const directHit = fs.existsSync(engineTranscriptPath(live.cwd, live.engineSessionId));
            let reason: "found-but-no-usage-line" | "file-not-found" | null = null;
            if (directHit) {
              reason = "found-but-no-usage-line";
              live.transcriptMissingDiagnosedOnce = false;
            } else if (!live.transcriptMissingDiagnosedOnce) {
              reason = engineTranscriptExists(live.cwd, live.engineSessionId) ? "found-but-no-usage-line" : "file-not-found";
              if (reason === "file-not-found") live.transcriptMissingDiagnosedOnce = true;
            }
            if (reason !== null) {
              // eslint-disable-next-line no-console
              console.warn(`[context] ${sessionId} context-stats read failed (${reason}, engineSessionId=${live.engineSessionId}) — ctxInputTokens will NOT advance this turn`);
            }
          }
          // Bare-pasted-text-placeholder tripwire (card eef4883c, DETECTION ONLY — see paste-tripwire.ts's
          // doc for the 8a39f544 background). Compares the SUBMITTED turn against the transcript's
          // recorded turn for that same turn (`stats.lastUserText`, from the SAME single-pass read above
          // — no extra file I/O). Card 0f9268cc: prefer `lastRawSubmit` (the raw-terminal channel's
          // counterpart of `lastPrompt` — see its doc) when set, since a non-null value here can only mean
          // a raw Enter-submit happened AFTER the last structured submit() cleared it, making it the more
          // recent — and thus more likely relevant to THIS turn — baseline; fall back to `lastPrompt`
          // (the structured-submit path, the tripwire's original coverage) otherwise. Consumed (cleared)
          // right after, win or lose, so a leftover raw baseline never gets attributed to a LATER Stop.
          // Card 78e4b3f2: strip a leading possible-duplicate tag BEFORE any tripwire logic sees this text —
          // `lastPrompt`/`lastRawSubmit` hold what was ACTUALLY written, which for a re-delivered turn (an
          // in-session requeue that redrained) now carries our tag. Left untouched, `isPasteRecoveryAttempt`
          // below would read `startsWith(PASTE_RECOVERY_TAG)` as false for a re-delivered recovery
          // re-injection (paste-tripwire.ts's own `buildPasteRecoveryText` output IS routed through
          // `enqueueStdin`, so it CAN acquire a `giveUpGen` requeue like any other message — verified
          // reachable, not assumed), defeating the one-shot recovery bound that function exists to enforce.
          const rawSubmittedText = live.lastRawSubmit ?? live.lastPrompt;
          const submittedText = rawSubmittedText !== null ? stripPossibleDuplicateFrame(rawSubmittedText) : null;
          live.lastRawSubmit = null;
          // A future recurrence of a submitted paste silently collapsing to a bare placeholder is now
          // LOGGED instead of silent — over EITHER delivery channel. Card 2c58bdd3: pass the CURRENT gen +
          // `live.recentPlaceholderTokens` so the tripwire can tell a genuine fresh collapse of THIS turn
          // apart from a stale CLI-side re-render of an OLDER, already-delivered turn's own placeholder
          // token — see that function's own doc for the false-positive shape this closes (investigation
          // `773b3914`) and for why this history is keyed on the exact token, not `live.recentWrittenLineCounts`.
          if (detectBarePastePlaceholderTripwire(submittedText, stats?.lastUserText, live.submitGeneration, live.recentPlaceholderTokens)) {
            // Card 0f9268cc: one-shot auto-RECOVERY on top of detection. `submittedText` is provably
            // non-null here (detectBarePastePlaceholderTripwire's own first guard requires it truthy).
            // ONE combined console.warn (not two) — a caller/test counting "did the tripwire fire" via
            // warn-count must see exactly one line per detection, recovery or not.
            //
            // PREVENTION WAS CONSIDERED AND DECLINED (owner decision) — do not re-litigate without a
            // reliable repro. A Loom-free bare-`claude` diagnostic (test/_probe-paste-collapse-trigger.mjs,
            // test/_probe-paste-collapse-production-repeat.mjs) drove 24 real-CLI submissions varying
            // bracket-paste wrap presence/absence, single/multi-line, and size (120-5000 chars), including
            // the EXACT production submit() path repeated 15x: 24/24 came back FULL — zero reproductions
            // in either condition. That means any "feed it differently to avoid the collapse" change is
            // UNVALIDATABLE (there is no reproducible baseline to show it helps), and it would touch
            // LOAD-BEARING transport for no demonstrated gain: the chunking here exists because a single
            // large `pty.write` is TRUNCATED by Windows ConPTY (see writeChunked's doc), and the bracket-
            // paste wrap protects multi-line text from the CLI's own readline. Trading an unreproducible
            // rare loss for a reproducible truncation regression is a strictly bad trade. Revisit ONLY if a
            // reliable repro emerges to validate against.
            const isRecoveryAttempt = isPasteRecoveryAttempt(submittedText!);
            const actionNote = isRecoveryAttempt
              ? "RECOVERY re-injection ALSO collapsed — giving up automatic recovery after one attempt; this needs a human to resend the content manually."
              : "auto-recovering: re-injecting the lost content as a corrective turn (one-shot — a second collapse on the recovery itself will not retry again).";
            // eslint-disable-next-line no-console
            console.warn(`[paste-tripwire] ${sessionId} submitted turn resolved to a bare pasted-text placeholder (engineSessionId=${live.engineSessionId ?? "?"}, claudeVersion=${getCachedClaudeVersion() ?? "?"}) — content may have been lost to an upstream CLI paste-collapse race (see card eef4883c / 8a39f544). ${actionNote}`);
            if (isRecoveryAttempt) {
              // Card 47c11741: the give-up itself — until now this fired ONLY the console.warn above and
              // nothing else (no db.appendEvent, no nudge, zero consumers outside this log line). Purely
              // additive: the warn above is untouched, this just gives the give-up a real, queryable
              // channel on top of it.
              this.events.onPasteTripwireGiveUp?.(sessionId, { token: matchEmbeddedPlaceholderToken(stats?.lastUserText), engineSessionId: live.engineSessionId ?? null });
            }
            if (!isRecoveryAttempt) {
              // Defer OUTSIDE the M2 synchronous window (see the box above deliverHook's Stop/StopFailure
              // case) — enqueueStdin's idle-submit path would trip the finalizingTurn guard if called
              // synchronously from here. A bare setTimeout(0) is a macrotask: it cannot fire until this
              // whole deliverHook call (through the `finally` below) has returned control to the event
              // loop, so `finalizingTurn` is guaranteed false by the time this runs.
              const recoveryText = buildPasteRecoveryText(submittedText!);
              // Card 4af5aefa: snapshot the mint generation HERE, synchronously — NOT inside the
              // setTimeout(0) closure below. This Stop-hook's OWN drainPending call (further down,
              // outside this `if`) can dispatch an already-queued message and bump `live.submitGeneration`
              // before that closure ever runs; capturing there would silently record the WRONG (already-
              // advanced) baseline instead of "how many turns have run since detection."
              const mintedAtGen = live.submitGeneration;
              // Card 1c47454b: stamped alongside `mintedAtGen`, same reasoning (capture NOW, not inside the
              // setTimeout(0) closure) — an absolute wall-clock time that survives a session boundary
              // `mintedAtGen` cannot (see QueuedMessage.mintedAtWallClock's own doc).
              const mintedAtWallClock = Date.now();
              // Card 4a0af485 (adopting the shared primitive for 38c687bb, the paste-recovery site named
              // there as "carries no id in EITHER space" — that card's own recipient-side consumption
              // check is its own scope, not this one): mint a logicalId so this re-injection is no longer
              // untracked. Fresh, not derived from the original turn — a raw human/agent-authored turn that
              // collapsed has no durable msgId of its own to inherit.
              setTimeout(() => { this.enqueueStdin(sessionId, recoveryText, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { logicalId: randomUUID(), mintedAtGen, mintedAtWallClock }); }, 0);
            }
          }
          // Card 2c58bdd3: record whatever placeholder token THIS turn's recorded text carried — win or
          // lose above — into `live.recentPlaceholderTokens`, so a LATER turn's stale re-render of this
          // SAME exact token can be recognized (the `gen` discriminator on the check above). Deliberately
          // unconditional on whether the tripwire fired: even a token that guard (1)/(3) already ruled
          // benign this turn is still evidence the literal string existed in the transcript at this gen,
          // which is exactly what a future re-render would repeat.
          const observedToken = matchEmbeddedPlaceholderToken(stats?.lastUserText);
          if (observedToken) {
            live.recentPlaceholderTokens.push({ gen: live.submitGeneration, token: observedToken });
            if (live.recentPlaceholderTokens.length > PASTE_TRIPWIRE_TOKEN_WINDOW) live.recentPlaceholderTokens.shift();
          }
          // Card b68d1f5b DoD-1 — the gen-aware, calibrated length check: catches an UNEXPLAINED
          // `[Pasted text #N +M lines]` placeholder even when `detectBarePastePlaceholderTripwire` above
          // stayed silent (no `submittedText` to compare, or `submittedText` too short/single-line to
          // gate on) — the human/raw-terminal-paste class this card exists for. Deliberately a SEPARATE
          // check from the one above, not a replacement: `live.recentWrittenLineCounts` (its OWN dedicated,
          // longer-horizon, integer-only history — see that field's doc for why this is NOT
          // `live.recentWrittenTurns`, card c2c750a9's ring) is what lets it stay silent on a placeholder
          // that's actually EXPLAINED — either the current gen's own fresh collapse (already owned +
          // recovered by the block above) or a stale CLI-side re-render of an older, already-delivered gen
          // still inside the window (card abeac33a's finding) — see detectPastePlaceholderLengthLoss's own
          // doc for the full discriminator AND its stated bound. Runs on `stats?.lastUserText` regardless
          // of whether the block above fired, since it can find something that one structurally cannot.
          for (const candidate of detectPastePlaceholderLengthLoss(stats?.lastUserText, submittedText, live.recentWrittenLineCounts)) {
            // eslint-disable-next-line no-console
            console.error(`[paste-length-loss] ${sessionId} UNEXPLAINED ${candidate.token} (engineSessionId=${live.engineSessionId ?? "?"}, gen=${live.submitGeneration}) — no known Loom write accounts for these lines; estimated ~${candidate.estimatedBytesLost} bytes (${candidate.statedLines} lines @ ~${PASTE_LOSS_CALIBRATED_BYTES_PER_LINE} B/line, card abeac33a calibration) never reached the engine and Loom holds no copy to auto-recover (see card b68d1f5b). Failing loud to recipient + sender.`);
            this.events.onPasteLengthLoss?.(sessionId, candidate);
          }
          // §19c usage-limit park: a StopFailure with error==="rate_limit" means the turn died on the
          // cap. The pty stays alive; we record the resume-at and do NOT drain a new turn into a capped
          // account (the pending queue is held intact for #19c-b's resume). billing_error / a clean Stop
          // fall through to the normal drain. (The `finally` below still clears the tripwire on this break.)
          if (hook.hook_event_name === "StopFailure") {
            const det = detectUsageLimit(hook);
            if (det.limited) {
              const until = rateLimitedUntil(det.resetsAtSeconds);
              // PARK: suppress drain/submit until resume. Skipping the synchronous drain below is not enough —
              // the ~10s reconcile timer (and any incoming enqueueStdin) would otherwise drain pending into the
              // capped account and submit() would CLOBBER lastPrompt, losing the killed turn we must replay.
              live.rateLimited = true;
              this.events.onRateLimited(sessionId, until, { resetsAtSeconds: det.resetsAtSeconds, message: `usage limit — resumes ${until}`, detector: "stop_failure" });
              break;
            }
          }
          // Weekly/account usage-cap TEXT sentinel fallback (card b16320bc): the interactive CLI answers
          // THAT cap with an ordinary assistant message + a CLEAN Stop, not a StopFailure — so the
          // structured check above never fires and the worker would otherwise stall, replying bare "No
          // response requested" to every later nudge with no visible park. Test the LAST assistant turn's
          // text-only reply (tool_use/tool_result excluded — see ContextStats.lastAssistantText) from the
          // SAME `stats` read above for the sentinel; on a match, park through the EXACT SAME path as the
          // structured detector above (no resetsAtSeconds — plain text carries no machine-readable reset —
          // so rateLimitedUntil falls back to the default backoff / the already-polled usage-window reset,
          // same as a reset-less StopFailure).
          if (stats?.lastAssistantText && isWeeklyUsageLimitSentinel(stats.lastAssistantText)) {
            const until = rateLimitedUntil(undefined);
            live.rateLimited = true;
            this.events.onRateLimited(sessionId, until, { message: `usage limit — resumes ${until}`, detector: "weekly_text_sentinel" });
            break;
          }
          // Card 343441bd: bump the completed-turn counter HERE, immediately before drain — NOT up at the
          // setBusy(false) falling edge above. Both usage-cap PARKS (§19c rate-limit StopFailure, the
          // weekly-cap text sentinel) `break` OUT of this try block before reaching this point: a capped/
          // parked turn is a NON-opportunity for the worker to act (same reason give-up-recovery's
          // setBusy(false) sites are excluded — see onTurnCompleted's own doc), so counting it would
          // inflate turnsSinceDelivery for an opportunity that never happened and could FALSE-FIRE the
          // no-false-alarm-critical staleDirective signal. Every OTHER path between the falling edge and
          // here (a failed/successful context-stats read, the paste-placeholder tripwire detect/recover)
          // falls through to this exact line — so this is still the one chokepoint every GENUINE turn
          // completion passes through exactly once; only the two park breaks are excluded, on purpose.
          this.events.onTurnCompleted?.(sessionId);
          // The turn ended → safe to write. Drain ONE queued message (FIFO), re-arming busy so the
          // next Stop releases the next: strict per-session serialization. Writing only at the turn
          // boundary is what keeps a running turn from being corrupted by a mid-turn write.
          this.drainPending(sessionId);
        } finally {
          this.finalizingTurn = false;
        }
        break;
      }
    }
  }

  /**
   * Queue text for submission as a turn. Submits IMMEDIATELY only when the session is idle AND the
   * human's raw composer is clean AND no human submit is awaiting engine confirmation; otherwise HOLDS
   * it FIFO and `drainPending` (on the next Stop, the box-free transition, or the reconcile tick)
   * delivers it. Three reasons not to write now:
   *   - busy: a mid-turn write corrupts the running turn (the original reason for the queue);
   *   - composer-dirty: writing onto the human's half-typed raw-terminal text concatenates the two
   *     into one garbled message (the observed manager/worker collision) — so we HOLD until the human
   *     frees their box (Enter/Ctrl-C/Esc/kill-line, or backspaces it empty). See deferForHumanDraft.
   *   - human-submit-unconfirmed (card 2521bf51): a genuine human Enter-submit frees the box locally
   *     (composerLen hits 0) before claude's own engine has confirmed it actually started the turn — a
   *     message ARRIVING in that gap must HOLD too, not just one already queued before the Enter, or it
   *     races into a composer claude may still be transitioning out of. See `isHumanSubmitHeld`.
   * Also self-heals a STUCK-busy session first, so a report can't strand behind a phantom 'busy'.
   * Returns whether it went out now, or its 1-based queue position. A `delivered:false` result also
   * carries `reason` (see EnqueueDeliveryReason) so a caller can tell a dead-drop (`"session-dead"` —
   * no live pty, nothing will ever deliver this) apart from a hold (`"held"` — queued FIFO, delivered
   * at the next turn boundary UNLESS redelivery is ultimately exhausted, in which case it is PARKED and
   * the sender is notified instead — see `handleGiveUpExhausted` in sessions/service.ts, card 417cea0a);
   * both used to read as the same bare `{delivered:false}`.
   * On the `"held"` path this ALSO carries `queued:true`, `landsAt:"next-turn-boundary"`, and
   * `busyForMs` (see {@link EnqueueResult}) — a held enqueue is a SUCCESS (the text is durably queued
   * and WILL be delivered at that boundary unless its own give-up budget is later exhausted, in which
   * case it is PARKED instead — a real, sender-notified exception, never a silent one; card 417cea0a),
   * and these fields report that honestly instead of leaving a reader to infer it from `delivered:false`
   * alone. `delivered` itself is UNCHANGED — additive fields only.
   *
   * `source` defaults to 'system' so EVERY existing programmatic caller (worker reports, idle/context/
   * busy nudges, resume notes, escalations) stays 'system' unchanged; only the REST composer passes
   * 'human'. A held entry's source is what the human-facing mutators gate on (see QueuedMessage).
   *
   * `kind` defaults to `"warning"` (see QueuedMessageKind) so every caller this change didn't touch
   * keeps today's full-coalesce behavior byte-identical; every production call site that enqueues an
   * agent/human-authored message passes `"agent"` explicitly.
   *
   * `questionId` is an OPTIONAL tail tag (see QueuedMessage.questionId) — undefined for every caller this
   * change didn't touch. Only the decision-inbox answer route sets it, so `purgeQueuedByQuestionIds` can
   * later drop this exact nudge if it goes stale before it drains.
   *
   * `ownerText` (Companion injection-guard Primitive A) is an OPTIONAL trailing arg — appended after the
   * existing params so every positional call site this change didn't touch stays byte-identical. Only the
   * companion inbound submit path (the ONE place an authorized owner's literal chat text forms a turn)
   * passes it; every other caller omits it, leaving Live.activeTurnOwnerText null exactly as before.
   *
   * `proactive` (Loom Companion, proactive event-line producer) is an OPTIONAL trailing arg, appended after
   * `ownerText` for the same byte-identical-by-default reason — defaults false. Only the three daemon-owned
   * proactive watchers (CompanionHeartbeatWatcher, CompanionReminderWatcher, AttentionPushWatcher) pass
   * `true`, so their fired turn's `getActiveTurnIsProactive` reads true and the companion's chat_reply can
   * tag its outbound frame + persisted history row for the web chat's amber event-line render.
   *
   * `giveUpHeldUntil` (card 9e27f4d2) is an OPTIONAL trailing arg, appended last for the same byte-
   * identical-by-default reason — every existing caller omits it by default. `resumeFleetOnBoot`'s
   * restart-intent replay passes it, restoring a give-up-requeued entry's hold deadline (see
   * `getPersistablePendingSnapshot`) onto the freshly re-enqueued entry so a restart
   * landing mid-hold-window doesn't skip the hold entirely. Card f25bf3bf's companion capability re-pin
   * respawn (`SessionService.upgradeCompanionCapabilities`) passes it too, for the same reason — it also
   * reconnects the SAME engine session via `--resume`. `SessionService.carryPendingToSuccessor` (the
   * recycle carry path, same card) deliberately does NOT — see its own doc for why a fresh, non-resumed
   * successor doesn't need the hold. `stillGiveUpHeld` below pushes that
   * invariant into THIS shared unit rather than leaning on caller ordering: code review on this same
   * card flagged that safety here depended only on `replayPending` always running before readiness (true
   * today, but nothing enforces it) — a still-in-the-future `giveUpHeldUntil` now forces the held-push
   * path even if the session happens to already be idle-ready, so the hold can never silently evaporate
   * just because some future caller/reorder takes the immediate branch instead.
   *
   * `onGiveUpExhausted` (card ccb407eb) is likewise an OPTIONAL trailing arg, appended last for the same
   * byte-identical-by-default reason — every existing caller omits it. `enqueueDurableMessage` is the one
   * caller that supplies it, on BOTH the immediate-submit synthesized origin and the held push below, so a
   * durable "agent"/settle-nudge message that later exhausts its give-up budget always has a hook to park
   * or re-mint through, however it happened to be delivered. See {@link QueuedMessage}'s own doc for why
   * this is a distinct hook from `onDeliver`.
   *
   * Card 3f09f9ce: the tail (`giveUpHeldUntil` onward) also accepts a SINGLE OPTIONS OBJECT ({@link
   * EnqueueStdinTail}) in place of the five trailing positional params, via the overload below — additive,
   * so every existing positional call site (and every `.mjs` test double standing in for this method —
   * untyped, so nothing here typechecks them; see the card for the test-double audit this required) keeps
   * working byte-identical. New call sites should prefer the options form: a miscount among 5 same-typed
   * trailing positions typechecks cleanly and fails silently — which is exactly how two call sites
   * silently dropped `logicalId`/`mintedAtGen`/`mintedAtWallClock` before (card 02baa3a5).
   */
  enqueueStdin(sessionId: string, text: string, source?: QueueSource, onDeliver?: () => void, route?: TurnRoute, kind?: QueuedMessageKind, questionId?: string, ownerText?: string, proactive?: boolean, senderId?: string | null, tail?: EnqueueStdinTail): EnqueueResult;
  enqueueStdin(sessionId: string, text: string, source?: QueueSource, onDeliver?: () => void, route?: TurnRoute, kind?: QueuedMessageKind, questionId?: string, ownerText?: string, proactive?: boolean, senderId?: string | null, giveUpHeldUntil?: number, onGiveUpExhausted?: () => void, logicalId?: string, mintedAtGen?: number, mintedAtWallClock?: number): EnqueueResult;
  enqueueStdin(
    sessionId: string,
    text: string,
    source: QueueSource = "system",
    onDeliver?: () => void,
    route?: TurnRoute,
    kind: QueuedMessageKind = "warning",
    questionId?: string,
    ownerText?: string,
    proactive = false,
    senderId?: string | null,
    tailOrGiveUpHeldUntil?: EnqueueStdinTail | number,
    onGiveUpExhaustedPositional?: () => void,
    logicalIdPositional?: string,
    mintedAtGenPositional?: number,
    mintedAtWallClockPositional?: number,
  ): EnqueueResult {
    // Discriminated by SHAPE, not by an arity count: `giveUpHeldUntil` is always `number | undefined` on
    // the positional form and never an object, so an options object at this position is unambiguous.
    const isTailObject = typeof tailOrGiveUpHeldUntil === "object" && tailOrGiveUpHeldUntil !== null;
    const giveUpHeldUntil = isTailObject ? tailOrGiveUpHeldUntil.giveUpHeldUntil : tailOrGiveUpHeldUntil;
    const onGiveUpExhausted = isTailObject ? tailOrGiveUpHeldUntil.onGiveUpExhausted : onGiveUpExhaustedPositional;
    const logicalId = isTailObject ? tailOrGiveUpHeldUntil.logicalId : logicalIdPositional;
    const mintedAtGen = isTailObject ? tailOrGiveUpHeldUntil.mintedAtGen : mintedAtGenPositional;
    const mintedAtWallClock = isTailObject ? tailOrGiveUpHeldUntil.mintedAtWallClock : mintedAtWallClockPositional;
    const live = this.live.get(sessionId);
    // `queued: false` makes the negative explicit: nothing is recorded, nothing will ever deliver this —
    // unlike the `held` path below, where `queued: true` is exactly as durable/successful as it sounds.
    if (!live?.alive) return { delivered: false, reason: "session-dead", queued: false, deliveryState: "dropped" };
    // Shape guard (card 78a16dc5) — see the doc comments on both checks for why NEITHER tier drops: a
    // dropped "warning"-kind entry is a real stall hazard (the async run_gate failure nudge can legitimately
    // contain a lone surrogate — see sanitizeLoneSurrogates' doc comment), so this only ever sanitizes or
    // logs, never withholds delivery on shape alone.
    const { text: sanitizedText, sanitized } = sanitizeLoneSurrogates(text, kind);
    if (sanitized) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${sessionId} sanitized an invalid (not well-formed UTF-16) system nudge — delivering the cleaned text: ${JSON.stringify(sanitizedText.slice(0, 200))}`);
    }
    text = sanitizedText;
    // LOG-ONLY: missing the [loom:* ] tag is an anomaly worth flagging, NOT proof of corruption — a
    // "warning"-kind sender that legitimately omits the tag (an unaudited call site) must still be
    // DELIVERED, not silently dropped. Falls through to the normal enqueue/deliver path below.
    if (isUntaggedSystemNudge(text, kind)) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${sessionId} a "warning"-kind system nudge is missing its [loom:*] tag (delivering anyway — this sender should be tagged): ${JSON.stringify(text.slice(0, 200))}`);
    }
    this.healIfStuck(live, sessionId);
    // Card 9e27f4d2 (code review follow-up): a restored give-up hold still in the future must NEVER take
    // the immediate-submit branch below — that branch delivers unconditionally, with no hold check at
    // all, so a caller-ordering change that reached this call while already idle-ready would silently
    // deliver a "held" entry as if it had never been held. Computed once, reused by both the immediate
    // gate below and the held-push at the bottom.
    const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
    // `ready` gate: a freshly (re)spawned pty is not ready until SessionStart. Submitting before then
    // writes into a still-booting TUI — the Enter is swallowed and the text strands in the composer
    // (the 2026-06-03 restart bug). Hold it FIFO; markReady drains it once the engine is up.
    // Card 2521bf51 (code review Major 1): `!this.isHumanSubmitHeld(live)` — this immediate-submit gate
    // is `drainPending`'s SIBLING (c1d71ff2's own deliberate pair: "Both drain paths ... DEFER while
    // dirty"), and the first pass at this card wired the hold into only one of the two, leaving a message
    // that ARRIVES during the unconfirmed gap (rather than being already queued) able to race straight
    // into a composer claude may still be transitioning out of.
    if (live.ready && !live.busy && !live.stopping && !live.rateLimited && !live.drainHeld && !this.deferForHumanDraft(live) && !stillGiveUpHeld && !this.isHumanSubmitHeld(live)) {
      // M2 GUARD: reaching the idle (busy=false) submit path while a turn is being finalized means an
      // `await` leaked into deliverHook's lower-busy→drain window (see the M2 box there). In correct,
      // synchronous code this is unreachable — enqueueStdin runs as its own event-loop task, never
      // interleaved with deliverHook. Tripping it would mean we're about to race a second turn in.
      if (this.finalizingTurn) {
        throw new Error("M2 invariant violated: enqueueStdin reached the idle-submit path mid turn-finalize — an `await` leaked between setBusy(false) and drainPending in deliverHook (host.ts).");
      }
      // Card 441499ee: this text was never pushed to `live.pending` (it's going out immediately), so if
      // its submit later GIVES UP, there is nothing else recording what it was. Hand submit() a
      // synthesized origin entry (fresh id — this message was never queued before) carrying every field a
      // held entry would have, so a give-up can restore it onto `live.pending` by identity instead of
      // discarding it after this call already returns `delivered:true`.
      {
        const id = randomUUID();
        // Card 4af5aefa: the origin entry keeps the PRISTINE `text` (never mutated on the entry itself —
        // same principle as the possible-duplicate tag), `mintedAtGen` travels alongside it, and
        // `joinSubmittedText` (a single-element array here) is what actually applies the age annotation —
        // same function the drain path uses, so there is exactly one place this logic lives. In practice
        // this is a no-op for the immediate path (nothing has run yet to make it stale), but it stays
        // correct rather than assumed.
        const entry: QueuedMessage = { id, text, source, onDeliver, route, kind, questionId, ownerText, proactive, senderId, logicalId: logicalId ?? id, ...(mintedAtGen !== undefined ? { mintedAtGen } : {}), ...(mintedAtWallClock !== undefined ? { mintedAtWallClock } : {}), ...(onGiveUpExhausted ? { onGiveUpExhausted } : {}) };
        this.submit(sessionId, joinSubmittedText([entry], live.submitGeneration), route, ownerText, proactive, senderId, "immediate", [entry]);
      }
      // M1 GUARD: submit() MUST arm busy=true SYNCHRONOUSLY (the optimistic set), so that a concurrent
      // enqueue arriving next sees busy and QUEUES instead of racing this turn's pending `\r`. If busy
      // is still false here, a future refactor deferred the set behind an await/callback — fail loud.
      if (!live.busy) {
        throw new Error("M1 invariant violated: submit() did not arm busy synchronously — the optimistic busy=true was deferred, so a concurrent enqueue could race the pending Enter (host.ts).");
      }
      // Immediate idle-submit: text handed to submit() as this turn's attempt — NOT invoking onDeliver
      // here (a message delivered straight as a turn is never persisted as `session_message_queued`; the
      // caller only records the durable event on the delivered:false path below), so there's nothing to
      // resolve. This also keeps the load-bearing M1/M2 window byte-identical: no extra work on the
      // synchronous submit. Card 9da2a435: `deliveryState:"handed-off"` makes explicit that this hand-off
      // is NOT yet engine-confirmed — `fireEnterAndVerify`'s async hook round-trip settles that later and
      // can still GIVE UP (see EnqueueResult's doc for why this return value must not be read as a
      // delivery proof).
      return { delivered: true, deliveryState: "handed-off" };
    }
    // Held (busy / not-ready / composer-dirty / rate-limit parked / still give-up-held). Carry the optional
    // delivery callback so that when this entry is finally handed to the recipient (drainPending or
    // consumePending), the durable queued message can be marked delivered. Undefined for every existing
    // (non-messaging) caller → a no-op. `giveUpHeldUntil` is likewise undefined for every existing caller
    // — only the boot restart-replay seam passes it, to restore a give-up hold onto the freshly re-enqueued
    // entry (card 9e27f4d2). Stamped whenever the caller supplied it (even an already-expired deadline —
    // harmless: `isGiveUpHeld` just reads false immediately, same as never having been stamped).
    {
      const id = randomUUID();
      // `mintedAtGen` rides along PRISTINE (card 4af5aefa) — annotated fresh at actual drain time
      // (`joinSubmittedText`, called from `drainPending`), never baked in here.
      live.pending.push({ id, text, source, onDeliver, route, kind, questionId, ownerText, proactive, senderId, logicalId: logicalId ?? id, ...(giveUpHeldUntil !== undefined ? { giveUpHeldUntil } : {}), ...(onGiveUpExhausted ? { onGiveUpExhausted } : {}), ...(mintedAtGen !== undefined ? { mintedAtGen } : {}), ...(mintedAtWallClock !== undefined ? { mintedAtWallClock } : {}) });
    }
    // `queued:true` reports this HELD outcome as the success it is (this text is durably recorded and
    // WILL be delivered at the next turn boundary UNLESS redelivery is ultimately exhausted, in which
    // case it is PARKED and the sender is notified instead of silently dropped — see
    // `handleGiveUpExhausted` in sessions/service.ts, card 417cea0a), instead of leaving a
    // `delivered:false` reader to wonder whether it's a drop. `busyForMs` is only meaningful while the
    // hold is actually busy-caused (not-ready/composer-dirty/rate-limited holds have no busy-since edge
    // to measure from).
    const busyForMs = live.busySince != null ? Date.now() - live.busySince : undefined;
    return { delivered: false, position: live.pending.length, reason: "held", queued: true, landsAt: "next-turn-boundary", busyForMs, deliveryState: "queued" };
  }

  /**
   * Card df5e37e7: record that the daemon has received an HTTP request on this session's
   * loom-orchestration MCP route (called from gateway/server.ts's /mcp-orch/:sessionId handler, before
   * dispatching to OrchestrationMcpRouter — so even a request whose handling later errors still counts
   * as "the client reached us"). Idempotent; a no-op for an unknown/dead session or one already marked.
   * Wakes every pending waitForMcpSeen caller. See Live.mcpSeen for why this proxy signal exists.
   */
  markMcpSeen(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.mcpSeen) return;
    live.mcpSeen = true;
    const waiters = live.mcpSeenWaiters;
    live.mcpSeenWaiters = [];
    for (const w of waiters) w(true);
  }

  /**
   * Card df5e37e7: resolve once this session's loom-orchestration MCP route has been hit (markMcpSeen)
   * or `timeoutMs` elapses, whichever first — NEVER rejects, so a caller's `.then()` is always safe to
   * fire unconditionally. Resolves `true` immediately if already seen; `false` immediately for an
   * unknown/dead session (nothing to wait for); `false` if the session dies while waiting (see
   * pty.onExit) or the timeout fires first. Callers must treat `false` as "proceed anyway" (today's
   * behavior), never as an error — this is a best-effort proxy signal, not a guarantee.
   */
  waitForMcpSeen(sessionId: string, timeoutMs: number = MCP_READY_TIMEOUT_MS): Promise<boolean> {
    const live = this.live.get(sessionId);
    if (!live?.alive) return Promise.resolve(false);
    if (live.mcpSeen) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (seen: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(seen);
      };
      live.mcpSeenWaiters.push(done);
      setTimeout(() => done(false), timeoutMs);
    });
  }

  /**
   * A copy of a session's queued message TEXTS in FIFO order — the back-compat string view. This is
   * the contract service.ts relies on (restart snapshot, recycle carry) and any caller that only needs
   * the text; it is deliberately unchanged by the id-bearing data model. The UI uses getPendingEntries()
   * to get the stable ids it needs to address a specific entry.
   */
  getPending(sessionId: string): string[] {
    return (this.live.get(sessionId)?.pending ?? []).map((m) => m.text);
  }


  /**
   * Loom Companion (multi-channel reply routing): the ORIGINATING route of the session's IN-FLIGHT turn, or
   * null when the current/last turn wasn't formed from a companion inbound / proactive-home submit. The
   * companion's chat_reply reads THIS (via an injected resolver in the gateway) to deliver a reply back to
   * the exact route of the turn it answers. Because turns run serially and the route is pinned when a turn
   * is FORMED (submit/drain) — never when a later inbound is merely queued — an interleaved cross-route
   * inbound can't redirect an in-flight turn's reply. Returns null for an unknown/dead session.
   */
  getActiveTurnOrigin(sessionId: string): TurnRoute | null {
    return this.live.get(sessionId)?.activeTurnRoute ?? null;
  }

  /**
   * Loom Companion (proactive event-line producer): whether the session's IN-FLIGHT (or most-recently
   * formed) turn was a daemon-driven proactive submit — a heartbeat/reminder/attention-push alert — rather
   * than an owner inbound or an ordinary system/human inject. Mirrors {@link getActiveTurnOrigin} exactly
   * (caller-supplied at submit()/enqueueStdin, persists until the next submit() overwrites it, false for an
   * unknown/dead session). The companion's chat_reply reads this to tag its outbound frame + persisted
   * history row so the web chat renders the amber event line instead of an ordinary bubble.
   */
  getActiveTurnIsProactive(sessionId: string): boolean {
    return this.live.get(sessionId)?.activeTurnProactive ?? false;
  }

  /**
   * Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3): the
   * LITERAL authenticated owner inbound bytes forming the session's IN-FLIGHT turn, or null when the
   * current turn wasn't formed from an authorized owner inbound (proactive/heartbeat/reminder/cross-
   * channel-mirror/memory-recall — none of those pass `ownerText` to submit()/enqueueStdin), or once the
   * turn has ended (cleared at the Stop/StopFailure hook — see the Live.activeTurnOwnerText doc for why
   * this does NOT simply persist like getActiveTurnOrigin's route does). An ACT lever that requires owner
   * text is therefore automatically refused on any turn this returns null for — there is nothing to
   * attest. Returns null for an unknown/dead session.
   */
  getActiveTurnOwnerText(sessionId: string): string | null {
    return this.live.get(sessionId)?.activeTurnOwnerText ?? null;
  }

  /**
   * Companion injection-guard Primitive A WIDENING (card 2b26035c, "recent-turns verbatim acceptance") —
   * sibling to {@link getActiveTurnOwnerText}: the bounded, most-recent-first ring of the last
   * {@link RECENT_OWNER_TURNS_WINDOW} authenticated owner-turn texts, so a lever can accept a candidate
   * that's a verbatim substring of a RECENT turn (a cross-turn correction/re-phrase), not just the one
   * currently in flight. UNLIKE `getActiveTurnOwnerText`, this does NOT clear at Stop — that's the whole
   * point (the window must survive past the turn it was formed on). Every entry is still literal,
   * server-attested owner inbound bytes from the SAME source as Primitive A (see Live.recentOwnerTurns'
   * doc) — only the turn scope widens, never the authentication. Empty array for an unknown/dead session
   * or one with no owner-authored turn yet.
   */
  getRecentOwnerTurns(sessionId: string): string[] {
    return this.live.get(sessionId)?.recentOwnerTurns.slice() ?? [];
  }

  /**
   * Companion Trust Window (Companion Capability & Permission-Lever Framework, card 0): the AUTHENTICATED
   * sender id of the session's IN-FLIGHT turn, for a GROUP-scope companion route only — null for a DM
   * route or a non-companion-inbound turn (see Live.activeTurnSenderId). Read by the trust-window/friction
   * helper to key a group route's arm/isWarm window per-sender, so one member's confirm never covers
   * another's acts. Returns null for an unknown/dead session.
   */
  getActiveTurnSenderId(sessionId: string): string | null {
    return this.live.get(sessionId)?.activeTurnSenderId ?? null;
  }

  /**
   * Like getPending, but EXCLUDES durable-tracked messages (those carrying an `onDeliver` callback —
   * the down/cross-tree session_message/message_worker entries persisted as `session_message_queued`),
   * and ALSO returns each surviving entry's give-up-hold state alongside its text — in one pass, so the
   * two halves can never drift out of index alignment (card refactoring 9e27f4d2's original two-method
   * split, `getPersistablePending`/`getPersistablePendingHolds`: they were only valid together if a
   * caller invoked both against the same live state with no `await` between them, a requirement that
   * lived only in a doc comment and was never enforced — this method makes misalignment structurally
   * impossible instead of a documented caution).
   *
   * The daemon_restart intent snapshot uses THIS (card 2ca18433): the durable boot scan
   * (recoverUndeliveredMessagesOnBoot) owns re-enqueueing durable messages on boot, so snapshotting them
   * into intent.pending too would deliver them TWICE on a normal restart. Non-durable held items (worker
   * reports, idle/resume nudges) carry no callback and stay in `texts`, replayed exactly as before.
   *
   * `texts` is a bare `string[]` — DELIBERATELY, not `{text, giveUpHeldUntil}[]` (card 9e27f4d2 code
   * review, first attempt at that card's fix did exactly that and was rejected): `RestartIntent.pending`
   * is un-versioned JSON on disk (`readRestartIntent` is a bare `JSON.parse(...) as RestartIntent`, no
   * schema check) that an OLDER daemon can read — a second stable daemon sharing `~/.loom` from a
   * separate checkout (this project's own documented pattern), or a rollback landing between this
   * daemon's exit-75 and the supervisor's relaunch. An older daemon's `replayPending` calls
   * `enqueueStdin(id, m, ...)` expecting `m` to be a plain string; handed `{text, giveUpHeldUntil}`
   * instead, `kind:"agent"` short-circuits BOTH shape guards (`sanitizeLoneSurrogates`/
   * `isUntaggedSystemNudge`) before either inspects the value, and the object is silently string-coerced
   * to `"[object Object]"` by the eventual `.map(m=>m.text).join()` — the actual message TEXT is gone,
   * no throw, no log. That is the exact LOSS class card 9e27f4d2's own constraint forbids ("fail toward
   * a duplicate, never a loss"), reintroduced by a fix for a duplicate. Keeping the persisted `pending`
   * field a bare `string[]` and carrying holds on `RestartIntent.pendingHolds`, a wholly separate
   * additive field, means an older daemon reading a newer intent sees only strings it already knows how
   * to handle — an unheld duplicate (bad, but the ALREADY-ACCEPTED pre-9e27f4d2 behavior), never a
   * garbled loss. This method's own in-process return shape carries no such on-disk constraint — `holds`
   * sits alongside `texts` right here even though the caller must still write them to SEPARATE
   * `RestartIntent` fields when persisting (see `requestDaemonRestart`).
   *
   * `holds` is `{index: giveUpHeldUntil}` for every entry in `texts` that is currently `isGiveUpHeld`,
   * keyed by that entry's position in `texts`. An ordinary entry has no key at all (byte-identical-by-
   * omission for the common case). Returns `{ texts: [], holds: {}, mintedAt: {} }` for a dead/unknown
   * session or one with nothing queued/held.
   *
   * `mintedAt` (card 1c47454b) is `{index: mintedAtWallClock}`, the SAME additive-sibling-field shape as
   * `holds` and for the identical on-disk-compat reason (see `RestartIntent.pendingHolds`'s doc — an
   * older daemon reading a newer intent must see only strings in `pending`, never a richer shape folded
   * into `texts` itself). This is what lets a still-pending paste-recovery notice's age evidence survive
   * a `daemon_restart`: without it, the notice's `mintedAtWallClock` would die with this process exactly
   * like `mintedAtGen` already (correctly) does not attempt to survive it.
   */
  getPersistablePendingSnapshot(sessionId: string): { texts: string[]; holds: Record<number, number>; mintedAt: Record<number, number> } {
    const texts: string[] = [];
    const holds: Record<number, number> = {};
    const mintedAt: Record<number, number> = {};
    for (const m of this.live.get(sessionId)?.pending ?? []) {
      if (m.onDeliver) continue;
      if (this.isGiveUpHeld(m)) holds[texts.length] = m.giveUpHeldUntil!;
      if (m.mintedAtWallClock !== undefined) mintedAt[texts.length] = m.mintedAtWallClock;
      texts.push(m.text);
    }
    return { texts, holds, mintedAt };
  }

  /**
   * A copy of a session's queued entries (id + text + source + kind) in FIFO order — for the human-facing
   * UI, which needs the stable id to delete/edit/reorder a SPECIFIC entry (see QueuedMessage), and `source`
   * + `kind` to tell which entries it may mutate (see {@link isHumanMutable}): the human's own composed
   * turns and Loom's own `kind:"warning"` nudges are actionable; an agent-authored `kind:"agent"` entry
   * renders read-only. Returns [] for an unknown session. Entries are shallow-copied so a caller can't
   * mutate the live FIFO through them.
   */
  getPendingEntries(sessionId: string): Array<Pick<QueuedMessage, "id" | "text" | "source" | "kind" | "giveUpGen" | "mintedAtGen" | "mintedAtWallClock">> {
    // Strip the internal `onDeliver` callback — the UI only needs {id,text,source,kind}, and a function
    // must never escape the host (it isn't serializable and is meaningless outside this process).
    // `giveUpGen` (card 4a0af485 CR follow-up #7) is additive — small, serializable debugging metadata (was
    // this entry ever itself given up, and under which generation) that lets a test assert the REAL
    // give-up-tag state of an entry instead of hardcoding an assumption about it. `mintedAtGen`/
    // `mintedAtWallClock` (card 1c47454b) are additive for the SAME reason — a test asserting a carried
    // paste-recovery notice's age evidence survived (or was deliberately dropped) a recycle/restart
    // boundary needs to read the REAL post-carry state, not assume it.
    return (this.live.get(sessionId)?.pending ?? []).map(({ id, text, source, kind, giveUpGen, mintedAtGen, mintedAtWallClock }) => ({ id, text, source, kind, giveUpGen, mintedAtGen, mintedAtWallClock }));
  }

  /**
   * Count of currently-queued `kind:"agent"` messages (see QueuedMessageKind) — UNCONSUMED direction
   * (manager redirect/message, a human composer turn, companion inbound), as opposed to `kind:"warning"`
   * operational nudges (idle/context/usage watchdogs, memory-recall), which coalesce and are NOT direction.
   * end_me's inbound-queue safety gate (card 3b015fc7) reads this to REFUSE a self-stop while the caller
   * still holds unconsumed direction — mirrors the worker_report(done) pending-direction guard's intent,
   * generalized from manager-origin-only to every agent-kind sender. Non-mutating (unlike flushPending/
   * consumePending) — a peek, not a drain. Returns 0 for a dead/unknown session.
   */
  pendingAgentCount(sessionId: string): number {
    return (this.live.get(sessionId)?.pending ?? []).filter((m) => m.kind === "agent").length;
  }

  /**
   * CONSUME a session's queued (not-yet-delivered) inbound messages: return them in FIFO order AND
   * CLEAR the queue, so they will NOT also drain later as injected turns. This is the manager's
   * pull-its-own-inbox path (the inbox_pull tool) — strictly better than waiting for drainPending,
   * which only releases ONE per turn boundary. A manager that read its reports proactively (via
   * worker_transcript) can pull-and-discard the redundant queued copies in one shot instead of each
   * draining as a wasted turn.
   *
   * SYNCHRONOUS by construction — it only detaches `live.pending` (no `await`, no submit()), so it
   * never enters deliverHook's M2 lower-busy→drain window and the M2 invariant is untouched. It also
   * adds NO "drain while busy" path: it removes messages, never writes them to the pty. Returns [] for
   * an unknown session. The auto-drain (drainPending/reconcile) safety net is unaffected — a manager
   * that never pulls still gets every message delivered the normal way; a pulled message is gone from
   * the same `live.pending`, so it can't also drain.
   *
   * DELIBERATELY splices EVERY entry, including one still `isGiveUpHeld` (card 9e27f4d2 assessed this
   * against `drainPending`'s hold-respecting skip and left it as-is): the hold exists to keep a
   * BACKGROUND drain/reconcile tick from resubmitting a possibly-already-delivered entry before a late
   * confirming hook can prove it. `inbox_pull` is not a background tick — it is the recipient itself
   * explicitly asking for its own inbox right now, which is exactly the kind of affirmative act the hold
   * is meant to yield to, not protect against. Treating a held entry as delivered here is therefore a
   * reasoned choice, not an accidental bypass.
   */
  consumePending(sessionId: string): string[] {
    const live = this.live.get(sessionId);
    if (!live?.alive) return []; // dead/unknown session: nothing to consume (don't hand back a stale queue)
    const removed = live.pending.splice(0); // empty the queue in place AND keep the removed entries
    // inbox_pull HANDS these to the recipient (it returns them to the agent) — that's delivery, so fire
    // each entry's optional delivery callback (durable-message resolution) so a pulled message is marked
    // delivered and won't be re-enqueued on a later boot. Guarded; undefined for non-messaging entries.
    for (const m of removed) { if (m.onDeliver) { try { m.onDeliver(); } catch { /* never break the pull */ } } }
    return removed.map((m) => m.text); // string contract unchanged
  }

  /**
   * Splice and RETURN a session's entire pending FIFO as its raw id-bearing entries (onDeliver INCLUDED —
   * unlike getPendingEntries, which strips it for the UI). The redirect path (SessionService.redirectWorker)
   * uses this to SUPERSEDE a busy worker's queued direction before enqueueing the one authoritative redirect:
   * it RETIRES the flushed entries rather than delivering them, firing each durable entry's onDeliver with a
   * "superseded" reason so the boot-recovery scan + the worker_report done-guard never re-drive them.
   *
   * DISTINCT from consumePending: this neither delivers nor fires onDeliver itself — the caller decides the
   * fate of each entry (consumePending = "I delivered these"; flushPending = "I'm discarding these, here they
   * are so you can resolve them how you see fit"). SYNCHRONOUS (array splice only — no await, no submit, no
   * pty write), so it never enters deliverHook's M2 lower-busy→drain window. Returns [] for a dead/unknown
   * session. Internal to the host (called by SessionService), never exposed to the UI or an agent.
   */
  flushPending(sessionId: string): QueuedMessage[] {
    const live = this.live.get(sessionId);
    if (!live?.alive) return [];
    return live.pending.splice(0); // empty the queue in place AND hand the removed entries (with onDeliver) back
  }

  /**
   * Drop still-queued entries TAGGED to any of the given `questionIds` (see QueuedMessage.questionId) —
   * the decision-inbox's OWN targeted purge (card bbc46336 follow-up), called from `question_pull` right
   * after it atomically consumes those questions: any OTHER queued answer-nudge for a question that same
   * batch just consumed is now obsolete — left queued, it would drain as its own turn and trigger a
   * wasted empty `question_pull`. UNLIKE flushPending (which empties the WHOLE queue for a supersede), this
   * is a SELECTIVE filter: every entry whose `questionId` is not in the set — including unrelated nudges
   * and manager direction — keeps its slot and relative order untouched, exactly like deleteQueued leaves
   * every entry but the one it targets alone.
   *
   * SYNCHRONOUS BY CONSTRUCTION — only splices `live.pending` (no `await`, no submit(), no pty write), so
   * it never enters deliverHook's M2 lower-busy→drain window and can never observe or touch a message
   * that's already mid-drain: drainPending splices its own delivered run OUT of `live.pending` before this
   * could ever run concurrently (there is no interleaving point between them), so an entry is either still
   * here to be purged or already gone to delivery — never both. Returns the removed entries (onDeliver
   * included, mirroring flushPending) so the caller can resolve them; [] for a dead/unknown session, an
   * empty `questionIds`, or when nothing matched.
   */
  purgeQueuedByQuestionIds(sessionId: string, questionIds: readonly string[]): QueuedMessage[] {
    const live = this.live.get(sessionId);
    if (!live?.alive || questionIds.length === 0) return [];
    const ids = new Set(questionIds);
    const removed: QueuedMessage[] = [];
    for (let i = live.pending.length - 1; i >= 0; i--) {
      const m = live.pending[i]!;
      if (m.questionId != null && ids.has(m.questionId)) {
        removed.push(m);
        live.pending.splice(i, 1);
      }
    }
    return removed.reverse(); // restore original FIFO order (the scan walked back-to-front)
  }

  /**
   * Drop still-queued `[loom:worker-idle]` / `[loom:worker-spawn-broken]` nudges for ONE worker from its
   * manager's pending FIFO (auditor finding 2e3a8e6f — delivery-vs-watchdog TIMING race). Mirrors
   * `purgeQueuedByQuestionIds`'s exact mechanics (synchronous splice, no drain/submit boundary crossed) but
   * keys off the nudge's own literal text prefix — these nudges predate `questionId`-style tagging and
   * already embed the workerSessionId in their text (`classifyIdleWorker`'s queued-report guard matches the
   * same way).
   *
   * WHY THIS EXISTS: `notifyManagerOfIdleWorker` classifies and enqueues a nudge the INSTANT a worker goes
   * idle (or on IdleWatcher's periodic re-check) — correct when computed. But if the manager is BUSY at
   * that moment the nudge just QUEUES (delivered:false) and only drains on the manager's NEXT turn
   * boundary. A manager can reply to that very worker (`messageWorker`/`redirectWorker`) LATER IN THE SAME
   * still-in-flight turn — re-engaging it — and only then end its turn, at which point the STALE queued
   * nudge (computed before the reply) drains as if it were fresh, falsely claiming "it IS parked awaiting
   * your reply" to a manager that already replied. Called on the worker's OWN busy(false→true) edge
   * (index.ts's onBusy hook) — an objective, unambiguous "no longer idle" signal, whether that edge came
   * from a manager reply or the worker resuming on its own — so any not-yet-delivered nudge about it is
   * purged the instant it goes stale, before it can ever drain into the manager's turn. A worker that STAYS
   * idle (no busy edge) never has its queued nudge touched, so a genuinely-stranded worker's nudge still
   * fires exactly as before — this only ever removes a nudge whose premise ("still idle") has since become
   * false.
   */
  purgeQueuedWorkerIdleNudges(managerSessionId: string, workerSessionId: string): QueuedMessage[] {
    const live = this.live.get(managerSessionId);
    if (!live?.alive) return [];
    const prefixes = [`[loom:worker-idle] worker ${workerSessionId} `, `[loom:worker-spawn-broken] worker ${workerSessionId}`];
    const removed: QueuedMessage[] = [];
    for (let i = live.pending.length - 1; i >= 0; i--) {
      const m = live.pending[i]!;
      // Card 78e4b3f2: strip a leading possible-duplicate tag before the prefix match — a re-minted
      // idle/spawn-broken nudge (chainDepth > 0, sessions/service.ts's handleGiveUpExhausted) carries our
      // tag baked into `.text` at the moment it's CREATED (before it's ever enqueued), so it can already be
      // tagged while still sitting in `live.pending` — exactly what this function scans. This is NOT the
      // in-session-requeue case: `.text` for a giveUpGen-tagged entry stays PRISTINE the whole time it's
      // queued (see drainPending/joinSubmittedText's own doc — marking is applied only at the moment of the
      // actual physical write, which also removes the entry from `pending`), so the strip below is a no-op
      // for that case here, never something it needed to handle. Left unstripped for the cross-remint case
      // it DOES apply to, a stale re-delivered nudge would MISS this purge and drain into the manager's
      // turn falsely claiming the worker is still idle — exactly the bug this function exists to prevent
      // (see its own doc).
      if (prefixes.some((p) => stripPossibleDuplicateFrame(m.text).startsWith(p))) {
        removed.push(m);
        live.pending.splice(i, 1);
      }
    }
    return removed.reverse(); // restore original FIFO order (the scan walked back-to-front)
  }

  /**
   * The three human-facing queue mutators (delete / edit / reorder a queued entry). All are addressed
   * by the stable QueuedMessage.id and are SYNCHRONOUS BY CONSTRUCTION — they only touch the
   * `live.pending` array (no `await`, no submit(), never a pty write), exactly like consumePending. So
   * they never enter deliverHook's lower-busy→drain window, the M1/M2 busy-gate invariants are
   * untouched, and they are safe to call at ANY time (busy, idle, or mid turn-finalize): editing or
   * removing a HELD message can't corrupt the running turn because nothing is written to the engine.
   * An op whose id is no longer present (the entry already drained, or a stale client id) is a graceful
   * no-op returning false — the whole reason ids exist (an index would silently hit the wrong, shifted
   * entry). The auto-drain (drainPending/reconcile) safety net is unaffected.
   *
   * MUTABILITY GATE — delete/reorder use {@link isHumanMutable}: a HUMAN-MUTABLE entry is the human's
   * OWN composed turns (`source:"human"`) OR Loom's OWN operational injections (`kind:"warning"` —
   * idle/context/busy-stuck watchdog nudges, restart/boot continuation notes, rate-limit/memory-recall).
   * EDIT is narrower — it uses {@link isHumanEditable} (`source:"human"` only): a `kind:"warning"` Loom
   * nudge may be deleted or reordered but not rewritten, since its wording is Loom's, not the human's
   * (matches the web UI, `SessionQueue.tsx`'s `isEditable = source === "human"`). Any op aimed at an
   * agent-AUTHORED entry (`source:"system"` + `kind:"agent"` — a worker→manager report, manager→worker
   * direction, a Lead session_message, a companion inbound) is REFUSED — it returns false WITH
   * `refused:true` (the REST layer maps that to a 403) and leaves the entry untouched, so an agent's
   * queued message can never be deleted, rewritten, or reordered out from under it. (A missing id stays
   * a plain false with no `refused` — it's not a boundary violation, just a lost race with the drain.)
   */
  deleteQueued(sessionId: string, id: string): { deleted: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { deleted: false };
    const i = live.pending.findIndex((m) => m.id === id);
    if (i < 0) return { deleted: false }; // already drained / unknown id — safe no-op
    if (!this.isHumanMutable(live.pending[i]!)) return { deleted: false, refused: true }; // agent-authored — read-only
    live.pending.splice(i, 1);
    return { deleted: true };
  }

  editQueued(sessionId: string, id: string, text: string): { edited: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { edited: false };
    const m = live.pending.find((m) => m.id === id);
    if (!m) return { edited: false }; // already drained / unknown id — safe no-op
    if (!this.isHumanEditable(m)) return { edited: false, refused: true }; // not the human's own text — read-only
    m.text = text; // identity (id) and FIFO position preserved; only the body changes
    return { edited: true };
  }

  /**
   * Which held entries the HUMAN may DELETE or REORDER. Two classes qualify (owner-directed
   * 2026-07-11 — the human owns the daemon, so both their own and Loom's own queued text are theirs to clear):
   *   • `source:"human"` — the human's OWN composed turns (any kind);
   *   • `kind:"warning"` — Loom's OWN operational injections (idle/context/busy-stuck watchdog nudges like
   *     `[loom:worker-idle]`, restart/boot continuation notes, rate-limit/usage nudges, memory-recall) —
   *     Loom-authored, NOT a message from another agent, so removing/repositioning one harms nobody.
   * The ONE protected class is `source:"system"` + `kind:"agent"` — a message AUTHORED by an agent or a
   * human TO this recipient (worker→manager report, manager→worker direction/redirect, Lead session_message,
   * companion inbound) — which must never be deleted, rewritten, or reordered out from under the running
   * orchestration. (`source:"human"` entries are always `kind:"agent"` in practice, hence the OR, not AND.)
   *
   * NOTE: this is DELETE/REORDER's gate only — EDIT is narrower (see {@link isHumanEditable}): a
   * `kind:"warning"` Loom nudge may be cleared or repositioned, but its wording is Loom's own, not the
   * human's, so it is not rewritable — matches the web UI (`SessionQueue.tsx`'s `isEditable`).
   */
  private isHumanMutable(m: QueuedMessage): boolean {
    return m.source === "human" || m.kind === "warning";
  }

  /**
   * Which held entries the HUMAN may EDIT (rewrite the text of). Narrower than {@link isHumanMutable}:
   * only the human's OWN composed turns (`source:"human"`) qualify — a `kind:"warning"` Loom nudge is
   * deletable/reorderable (see isHumanMutable) but its wording belongs to Loom, not the human, so it is
   * NOT editable. Mirrors the web UI's own gate (`SessionQueue.tsx`'s `isEditable = source === "human"`).
   */
  private isHumanEditable(m: QueuedMessage): boolean {
    return m.source === "human";
  }

  /**
   * Reorder the held FIFO. Only HUMAN-MUTABLE entries (see {@link isHumanMutable}) may move: `orderedIds`
   * is their desired order, and the permutation is applied IN PLACE within the slots those entries
   * currently occupy — every agent-AUTHORED (`source:"system"` + `kind:"agent"`) entry keeps its absolute
   * FIFO position, so a human reorder can never reposition (or jump ahead of) a worker report / manager
   * direction. Reconciled against the CURRENT queue: ids not present are skipped (drained/unknown), and any
   * mutable entry NOT named (e.g. one enqueued after the client's snapshot) is preserved and appended after
   * the named ones in its existing relative order — so a reorder can never silently drop a message. REFUSED
   * (reordered:false, refused:true) if any named id targets an agent-authored entry — the UI never sends
   * one, so this is a guard against a hand-rolled request. Returns reordered:false (no refused) only for a
   * dead/unknown session.
   */
  reorderQueued(sessionId: string, orderedIds: string[]): { reordered: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { reordered: false };
    const byId = new Map(live.pending.map((m) => [m.id, m] as const));
    // Boundary guard: a named id that resolves to an agent-authored entry is a trust-boundary violation —
    // refuse the whole op rather than silently dropping that id (which would let a caller probe the queue).
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && !this.isHumanMutable(m)) return { reordered: false, refused: true };
    }
    // Desired order of the MUTABLE entries: named-first (present, mutable, deduped), then any un-named
    // mutable entries in their existing relative order.
    const seen = new Set<string>();
    const mutableSeq: QueuedMessage[] = [];
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && this.isHumanMutable(m) && !seen.has(id)) { mutableSeq.push(m); seen.add(id); }
    }
    for (const m of live.pending) if (this.isHumanMutable(m) && !seen.has(m.id)) { mutableSeq.push(m); seen.add(m.id); }
    // Rebuild in place: agent-authored entries hold their slot; each mutable slot takes the next from mutableSeq.
    let hi = 0;
    const next = live.pending.map((m) => (this.isHumanMutable(m) ? mutableSeq[hi++]! : m));
    live.pending.splice(0, live.pending.length, ...next);
    return { reordered: true };
  }

  /**
   * True while a programmatic turn must be HELD rather than delivered, because the human has an
   * uncommitted RAW-terminal draft that delivery would land on top of (the concatenation bug). The
   * signal is composer-dirty (`composerLen > 0`) — precise: it holds for exactly as long as a draft
   * exists and releases the instant the box is freed/emptied (writeStdin drains on that transition).
   * It SUPERSEDES the old keystroke time-grace, which couldn't tell a held-then-backspaced-empty box
   * from a still-dirty one. Conservative by construction: it only ever causes us to WAIT, never to
   * touch the human's bytes.
   */
  private deferForHumanDraft(live: Live): boolean {
    return live.composerLen > 0;
  }

  /**
   * PUBLIC read of the same composer-dirty signal (see deferForHumanDraft), for restart-intent capture
   * (SessionService.liveFleetResumeSet): a daemon restart kills this pty — and the uncommitted raw-
   * terminal draft living only in its (and the engine's) in-memory composer state dies with it, with
   * NOTHING to replay (unlike the `pending` FIFO, which is Loom-owned text and survives via the intent
   * snapshot). A draft this size commonly IS a large paste the terminal has collapsed to a
   * "[Pasted text #N]" placeholder — capturing this lets resumeFleetOnBoot tell the resumed agent that
   * loss explicitly instead of leaving it silently unaccounted for. Returns false for an unknown/dead
   * session id (nothing to report) rather than throwing.
   */
  isComposerDirty(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return !!live && this.deferForHumanDraft(live);
  }

  /**
   * Clear a phantom 'busy' (busy with no engine output for a stale window) so its queue can drain.
   * A session that has NEVER started its first turn (`!firstTurnStarted`) uses the much SHORTER
   * FIRST_TURN_STALE_MS instead of `busyStaleMs` — there's no such thing as a legitimately long tool
   * call before turn 1 has even started, so stale output there already means broken (the kickoff
   * delivery in scheduleKickoffGuarantee didn't recover it, or an engine that never got past boot),
   * and it should surface via the onBusy→notifyManagerOfIdleWorker path fast rather than sit masked as
   * "busy" for the full 5-minute window. Once a real turn starts, the normal, more generous window applies.
   *
   * Card b64b3726: also closes the ORPHANED COMPOSER half of a false give-up suppression. sendEnterAndVerify
   * can suppress its own give-up recovery (card 71de1f9c) when it reads output after the final Enter write —
   * but that read can be fooled (our own paste-reassert write provokes a deterministic engine response, or a
   * viewer's repaint() does), and when it is, `live.enterConfirmed` stays false FOREVER: nothing else can ever
   * flip it, because nothing can call submit() again (the sole writer of `lastPrompt`/`enterConfirmed=false`)
   * while `live.busy` stays stuck true — enqueueStdin only submits immediately when `!live.busy`. So a session
   * that reaches THIS stale-busy branch still carrying `enterConfirmed: false` is exactly a give-up that was
   * wrongly suppressed (or any other path that leaves an unconfirmed submit stranded) — the OLD version of
   * this method cleared `busy` but never un-typed the composer, so the stranded injection survived and the
   * NEXT drainPending submit pasted on top of it (reintroducing the exact concatenation card ee082fbb fixed).
   * Reuse that SAME mechanism here — do not invent a second clear path: an exact-count Backspace burst
   * (`live.lastPrompt.length`), gated on `composerLen === 0` (card e1829591 — never touch a real human draft),
   * with `setBusy(false)` threaded through the burst's own completion (writeChunked's `done` callback) so a
   * concurrent enqueueStdin can't interleave a new turn's paste into the still-draining backspaces. This is
   * deliberately UNCONDITIONAL on *why* enterConfirmed is false — robust to vectors nobody has enumerated yet,
   * not just the two this card investigated.
   *
   * A turn that's LEGITIMATELY still confirmed-and-running never reaches this branch at all: UserPromptSubmit
   * sets `enterConfirmed = true` AND re-arms `busySince` (rising edge) the moment the turn actually starts, so
   * a merely-slow-to-confirm turn's staleness clock restarts before `staleMs` can elapse — belt-and-suspenders
   * with the `enterConfirmed` check itself.
   *
   * Card 2c3c4aff: b64b3726 completed the CLEAR but not the RESTORE — the backspace burst un-typed the
   * stranded injection from the composer, but the text itself (still held in `live.giveUpOrigin`, set by
   * the original submit() and never consumed because this out-of-band path never reached
   * `requeueGiveUpOrigin`) was silently discarded, with no signal. This path now restores it onto
   * `live.pending` the SAME way card 441499ee's normal give-up recovery does — see `requeueGiveUpOrigin`.
   */
  private healIfStuck(live: Live, sessionId: string): void {
    const now = Date.now();
    const staleMs = live.firstTurnStarted ? this.busyStaleMs : FIRST_TURN_STALE_MS;
    if (live.busy && live.busySince != null
      && now - live.busySince > staleMs && now - live.lastOutputAt > staleMs) {
      // Card 2c3c4aff: capture the generation THIS stranded submit ran under BEFORE the bump below — it's
      // the same value `requeueGiveUpOrigin` needs to tag the restored entry with (mirrors the `gen` a
      // normal give-up captures at submit() time; see fireEnterAndVerify's GIVE-UP RECOVERY branch).
      const gen = live.submitGeneration;
      // An OUT-OF-BAND busy clear (no Stop hook involved) — bump submitGeneration so a still-pending
      // sendEnterAndVerify chain for whatever turn this was recognizes it's stale and bails instead of
      // retry-Enter'ing (or give-up→setBusy(false)'ing) into whatever submits next. See submitGeneration.
      live.submitGeneration++;
      if (!live.enterConfirmed && live.composerLen === 0 && live.lastPrompt) {
        // Card 3ce3fa39 (superseding card b64b3726's immediate clear): mark possibly-dirty instead of
        // clearing HERE — same reasoning as fireEnterAndVerify's give-up branch. This path is reached ONLY
        // after output has been stale for a FULL staleMs window, i.e. the engine demonstrably isn't reading
        // right now — exactly when an immediate backspace burst is least trustworthy. The next submit()'s
        // own clear-prefix (see its doc) handles it once the engine is provably about to read again.
        // GATED on composerDirtyMarkedForGen (using `gen`, captured BEFORE this method's own bump above) —
        // a wrongly-SUPPRESSED give-up already marks dirty immediately at suppression time; without this
        // guard, THIS backstop firing later for the SAME still-unconfirmed generation would double-count
        // the identical abandoned text (see the field's doc). ALSO gated on `composerBodyWrittenForGen`
        // (card b9b8f8db): a generation that took the Enter-only redelivery path (submit()'s
        // `isGiveUpRedelivery` branch) never wrote a fresh body at all, so there is nothing NEW to mark —
        // doing so anyway would inflate composerDirtyLen for bytes that were never actually (re)typed,
        // reopening a smaller-scale version of the same unbounded-growth bug this card fixes.
        if (live.composerDirtyMarkedForGen !== gen && live.composerBodyWrittenForGen === gen) {
          // eslint-disable-next-line no-console
          console.log(`[heal] ${sessionId} marking an orphaned give-up injection possibly-dirty (${live.lastPrompt.length} chars, composer otherwise empty) while healing stuck busy`);
          live.composerDirtyLen += live.lastPrompt.length;
          live.composerDirtyLenBelieved += live.lastPrompt.length; // card c148f118: same additive mark, mirrored onto the optimistic reading
          live.composerDirtyMarkedForGen = gen;
        }
        // Card 2c3c4aff: this out-of-band path is exactly a give-up that never reached fireEnterAndVerify's
        // own GIVE-UP RECOVERY branch (e.g. wrongly SUPPRESSED) — `live.giveUpOrigin` still holds the
        // original QueuedMessage(s) this stranded text came from (nothing could have overwritten it:
        // submit() is the sole writer and it never ran again while busy stayed stuck true). Restore it via
        // the SAME identity-preserving mechanism card 441499ee hardened the normal give-up path with,
        // instead of silently discarding the cleared text.
        this.setBusy(sessionId, false, "heal-if-stuck-clear");
        this.requeueGiveUpOrigin(sessionId, gen);
      } else {
        this.setBusy(sessionId, false, "heal-if-stuck-stale");
      }
    }
  }

  /**
   * Deliver queued messages when it's safe (idle + composer free). Shared by Stop + reconcile + the
   * markReady / box-free transitions.
   *
   * ONE-PER-TURN for AGENT messages, COALESCE for WARNING messages (owner-directed, 2026-07-03): a
   * queued entry's `kind` (see QueuedMessageKind) decides whether it may share a turn with its
   * neighbors. When `coalesceAgentMessages` is OFF (the default), an `"agent"`-kind head entry drains
   * ALONE — submit() re-arms busy SYNCHRONOUSLY (M1), so the NEXT agent message drains on the next Stop
   * hook (self-chaining); the reconcile timer is the backstop, so nothing is stranded. A `"warning"`-kind
   * head entry still coalesces the leading run of same-route WARNING entries exactly as before — Loom's
   * own operational nudges are safe to concatenate. A run NEVER mixes kinds: it stops at the first
   * differently-kinded entry (in addition to the existing route-key break), so a turn is either all-agent
   * (in practice always exactly one, since agent-kind never coalesces when the toggle is off) or
   * all-warning, never both.
   *
   * When `coalesceAgentMessages` is ON (legacy, opt-in via Settings), `kind` is ignored entirely and the
   * ENTIRE leading same-route run coalesces into ONE concatenated turn — byte-identical to the
   * pre-2026-07 behavior (splice the whole run, join with a visible separator, one submit, one busy
   * re-arm, one `\r`). This was the original motivation for full coalescing: shift()'ing ONE entry per
   * Stop meant 3 superseding manager redirects replayed one-at-a-time. That specific case is now handled
   * upstream by `flushPending` (worker_redirect retires stale queued direction before enqueueing the one
   * authoritative redirect), so at drain time there is normally at most one pending redirect and
   * one-per-turn agent delivery does not regress it.
   *
   * STILL one submit per drain in EITHER mode: the splice + concat + submit are SYNCHRONOUS in one tick,
   * so the load-bearing M1/M2 busy-gate invariants are untouched. Daemon-wide, no role special-casing.
   *
   * Card 73d5c34a: a GIVE-UP-requeued entry that is still `isGiveUpHeld` (see that method) is skipped when
   * choosing what to drain — it stays in `pending` at its current position, untouched, while the search
   * for an eligible head continues past it. This is what stops a held entry (unshifted to the FRONT by
   * `requeueGiveUpOrigin`) from stalling every unrelated queued message behind it: the FIRST non-held
   * entry becomes this drain's effective head, and the same route/kind run-collection below additionally
   * stops at the next held entry it meets (never folding a still-ambiguous entry into a run). If EVERY
   * pending entry is held, this call is a no-op — exactly as if the queue were empty — and the reconcile
   * tick that called us will simply find the same thing next time until a hook purges the hold or it
   * expires (`GIVE_UP_HOLD_MS`).
   */
  private drainPending(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || !live.ready || live.busy || live.pending.length === 0) return;
    // A Stop is in flight → do NOT submit a queued turn. The interrupt lowers busy and fires a Stop
    // hook; draining here would re-arm busy and defeat the stop (the queued turn "fights" the stop —
    // each Ctrl-C just interrupts the freshly-drained turn, so it takes N escalating clicks to land).
    // stop() also clears the queue, so this is belt-and-suspenders for a late enqueue during the stop.
    if (live.stopping) return;
    // PARKED on a usage cap → do NOT drain. The turn died on the rate limit and the pty is held alive for
    // resumeAfterRateLimit to replay lastPrompt; draining here would submit() pending into the still-capped
    // account and OVERWRITE lastPrompt, so the agent would resume with the wrong content and never finish
    // the interrupted turn. The held queue is kept intact and drains normally on the post-resume Stop.
    if (live.rateLimited) return;
    // Card 2521bf51: a genuine human Enter-submit is AWAITING ENGINE CONFIRMATION → do NOT drain. Unlike
    // `busy` (only ever armed by submit()'s own M1 optimistic set), nothing tells Loom a human-typed turn
    // is genuinely in flight until claude's own UserPromptSubmit/Stop hook fires — draining here on local
    // byte-counting alone would submit into a composer claude may still be transitioning out of. See
    // `isHumanSubmitHeld`'s own doc: cleared the instant a confirming hook arrives; the deadline is only
    // the bounded backstop for the rare case BOTH hooks are lost, so this can never wedge forever.
    if (this.isHumanSubmitHeld(live)) return;
    // A caller is HOLDING the drain (card d88163b7's `holdDrain`) → do NOT promote a queued message into a
    // turn. The caller is deciding whether to interrupt this session and needs anything that would start a
    // NEW turn to stay in `pending`, recoverable via `flushPending`, instead of vanishing into an active
    // turn the caller's own `pty.stop()` would then kill with no way to recapture it.
    if (live.drainHeld) return;
    if (this.deferForHumanDraft(live)) return; // HOLD while the human's raw composer is dirty — never land on half-typed text
    // Find the first entry NOT currently held by an unresolved give-up requeue (card 73d5c34a) — held
    // entries stay in place, ineligible, so they can never be the effective head of this drain.
    const startIdx = live.pending.findIndex((m) => !this.isGiveUpHeld(m));
    if (startIdx === -1) return; // every pending entry is held — nothing eligible to drain yet
    const head = live.pending[startIdx]!;
    let drained: QueuedMessage[];
    if (!this.coalesceAgentMessages && head.kind === "agent") {
      // One-per-turn (default): an agent-authored message never shares a turn with anything else.
      drained = live.pending.splice(startIdx, 1);
    } else {
      // ROUTE-KEYED coalescing (Loom Companion multi-channel): coalesce ONLY the LEADING run of pending
      // messages that share the FIRST entry's route key. Messages with NO route (the manager→worker direction
      // path, and every non-companion inject) all share the empty key, so they still coalesce ALL-TOGETHER —
      // byte-identical to the old splice(0). A DIFFERENT route breaks the run: it stays queued and drains as a
      // DISTINCT next turn on the next Stop. So EVERY turn has EXACTLY ONE originating route ⇒ chat_reply
      // resolves it unambiguously and cross-delivery is impossible by construction (no runtime check needed).
      // ALSO bounded to same-KIND entries (never mix a warning and an agent message into one turn) UNLESS
      // coalesceAgentMessages is on, in which case kind is ignored (today's legacy full-coalesce). ALSO
      // bounded to non-held entries (card 73d5c34a) — a held entry immediately past the head stops the run
      // rather than being folded into it, same reasoning as `startIdx` above.
      const key = routeKeyOf(head.route);
      let n = 1;
      while (
        startIdx + n < live.pending.length
        && !this.isGiveUpHeld(live.pending[startIdx + n]!)
        && routeKeyOf(live.pending[startIdx + n]!.route) === key
        && (this.coalesceAgentMessages || live.pending[startIdx + n]!.kind === head.kind)
      ) n++;
      drained = live.pending.splice(startIdx, n); // the leading eligible same-route (+ same-kind, unless toggled) run
    }
    // Card 4a0af485 Major 2: a `giveUpGen`-tagged entry actually being RE-DRAINED (its hold expired or was
    // purged elsewhere, and it's now eligible again) is a fresh, deliberate resubmission attempt — the OLD
    // tracked ambiguity (seeded from its FIRST failed write) is moot the instant this happens. Clear it so
    // it can never linger to wrongly `hasAmbiguousMatch`-join a LATER, unrelated same-content directive; if
    // THIS fresh attempt also gives up, `requeueGiveUpOrigin` re-seeds it with an accurate, fresh
    // `writtenAt`. Scoped to `giveUpGen !== undefined` only (an entry that never itself gave up, e.g. an
    // auto-joined resend that never became ambiguous on its own, has nothing stale to clear here).
    for (const m of drained) { if (m.giveUpGen !== undefined) live.ambiguousDispatches.delete(m.logicalId); }
    // Card 78e4b3f2: `joinSubmittedText` frames any `giveUpGen`-tagged member — a genuine physical
    // re-delivery of a message whose first write was never confirmed — as a possible duplicate, so the
    // recipient can tell it apart from new direction. For THIS mechanism specifically (an in-session
    // requeue), the mark is applied ONLY here, at the actual write — never when the entry is merely
    // requeued/held (`QueuedMessage.text` itself is never mutated by `requeueGiveUpOrigin`'s kept branch,
    // so a reader of a still-giveUpGen-tagged-but-not-yet-redrained entry sees the pristine original): it
    // isn't a re-delivery yet while it's just sitting in `pending` waiting for its retry. This does NOT
    // generalize to every queued entry, though — a CROSS-REMINT (chainDepth > 0, sessions/service.ts's
    // handleGiveUpExhausted) is a SEPARATE trigger that bakes the tag into `.text` at message CREATION,
    // before it's ever enqueued, so a re-minted entry sitting in `pending` already carries the tag (see
    // `purgeQueuedWorkerIdleNudges`'s own doc for a real consumer this distinction mattered to).
    // Card 4af5aefa: `live.submitGeneration` here is still the PRE-increment value — submit() below does
    // its own `++` for THIS write. Code review correction: this is NOT "the last completed turn's own
    // generation number" — `submitGeneration` counts submit ATTEMPTS ISSUED (`submit()`'s own `++`) plus
    // out-of-band bumps (`healIfStuck`, both stop paths), so a give-up that consumed a generation with NO
    // turn ever running would be silently folded into a "turns" count. `annotatePasteRecoveryAge`'s own
    // wording says "submit generations", not "turns", precisely so this snapshot stays true to what it
    // actually counts.
    this.submit(sessionId, joinSubmittedText(drained, live.submitGeneration), drained[0]!.route, drained[0]!.ownerText, drained[0]!.proactive, drained[0]!.senderId, "drain", drained); // one submit, one busy re-arm, FIFO order preserved, ONE route (+ ONE ownerText/proactive/senderId — the head's, mirroring the route); `drained` doubles as the give-up origin (card 441499ee) — same objects, so identity is preserved for free
    // ADDITIVE delivery hook (card 2ca18433): every drained entry was just handed to the recipient as
    // part of this turn — fire each callback (durable-message resolution) AFTER submit, outside the
    // M1/M2 ordering. Guarded so a faulty callback can never disturb the drain. Undefined for every
    // non-messaging entry → a no-op.
    for (const msg of drained) { if (msg.onDeliver) { try { msg.onDeliver(); } catch { /* a delivery-marking fault never breaks the drain */ } } }
  }

  /**
   * Periodic safety net (wired to a timer in index.ts): self-heal stuck-busy sessions and drain any
   * queue that's been waiting (a report queued behind a phantom 'busy', or held while the human typed
   * and has since stopped). Without this, a queued message only ever drains on a Stop hook — which a
   * stuck session never fires.
   */
  reconcile(): void {
    for (const [sessionId, live] of this.live) {
      if (!live.alive || live.kind !== "claude") continue; // shells/canned entries have no busy/queue to heal or drain
      this.healIfStuck(live, sessionId);
      this.drainPending(sessionId);
    }
  }

  /**
   * Write text as a turn and arm busy (the immediate path and the Stop-drain share this). The text
   * goes out as a BRACKETED PASTE (start marker, the chunked text, end marker) then Enter a beat
   * later — so claude treats even multi-line content as one paste unit and the trailing Enter
   * reliably submits (no more reports stuck un-submitted in the box). The markers are written on
   * their own so chunking can't split a marker sequence.
   *
   * M1 INVARIANT (optimistic busy): `setBusy(true)` is the LAST statement and runs SYNCHRONOUSLY —
   * before submit() yields to the event loop. The actual Enter (`\r`) is written async, a beat later;
   * the synchronous busy set is what closes the window between "we decided to submit" and "the turn is
   * really in flight". A concurrent enqueueStdin (its own event-loop task) therefore always sees
   * busy=true and QUEUES rather than racing the still-pending `\r`. DO NOT move this set behind an
   * `await`/callback or make submit() async — that would reopen the race. enqueueStdin asserts the set
   * landed synchronously (the M1 GUARD there).
   *
   * The Enter itself is NOT fire-and-forget (card 9549e322): a lone `\r` can land mid-ingest of a
   * large/coalesced paste, or get dropped outright by Windows ConPTY (the same class of drop already
   * documented for the boot Esc, card dacb8571) — either way the text strands un-submitted with busy
   * stuck true. `enterConfirmed` is reset to false here and `sendEnterAndVerify` re-sends the Enter on
   * a bounded verify/retry schedule until `UserPromptSubmit` (or a Stop, proving a turn ran) confirms
   * it, or gives up and recovers busy so the session doesn't wedge.
   */
  /**
   * Card 1bd1f045: the byte/call-sequence log for the ACTUAL `pty.write()` call — called INLINE at every
   * real write site (never a layer above them), so it records what genuinely reached node-pty, not what
   * the daemon merely composed/handed down. That distinction matters: `[submit-write]` (submit()'s own
   * pre-write log) was overclaimed as proof the write path is clean and retracted twice — everything from
   * here down was, until this card, completely uninstrumented in both directions (see 3ce3fa39).
   *
   * Discriminates the two surviving hypotheses for that card's mid-token splice: if the daemon itself
   * double-emits (e.g. `writeChunked`'s `done` callback firing more than once, unguarded by
   * `submitGeneration` — card 9ed20572), TWO `[pty-write]` records on `tag=chunk` share the same content
   * signature (len, hash) at distinct `seq` WITHIN THE SAME `gen`. If the daemon writes exactly once and
   * corruption still appears at the receiving end, this log shows a single clean record and the fault is
   * BELOW the daemon (ConPTY/node-pty/Windows). Either outcome is a real result.
   *
   * CORRECTED 2026-07-23 (manager measurement, 583 live records): the discriminator above is unusable
   * without the `tag=chunk`+`gen` restrictions — fixed control sequences (enter/bracket-start/bracket-end)
   * are byte-identical by construction and matched repeatedly on healthy traffic, and a by-design re-write
   * (give-up requeue/retry/re-drain — see `purgeConfirmedGiveUpRequeue`) crosses a `gen` boundary rather
   * than duplicating within one. Two traps: `seq` resets across a daemon restart (de-duplicate per boot,
   * never across one), and the give-up clear burst reuses the `chunk` tag and can share a message body's
   * `len` (only the hash differs) — never filter by length alone.
   *
   * `seq` is the load-bearing field: a monotonic per-session counter (Live.writeSeq) that makes a
   * duplicated or out-of-order emission visible AS a sequence anomaly rather than plausible traffic.
   *
   * RECORD SIZE (card review, 2026-07-23): a head+tail excerpt was the first cut but measured at ~100-150
   * bytes/record — at 17 call sites, some firing per-chunk on every 15KB+ payload, that risked shrinking
   * daemon-output.log's rotation window (the SAME forensic corpus 3ce3fa39/9ed20572 depend on) faster than
   * it fills today, which would make a rare recurrence HARDER to catch, not easier. `fnv1a32` replaces the
   * excerpt with a fixed 8-hex-char content fingerprint — every field the card's DoD names (sessionId, seq,
   * submitGeneration, len, a cheap hash) stays, nothing load-bearing for duplicate/replay detection is
   * dropped, and the record shrinks by roughly half regardless of chunk size. `tag` names WHICH call site
   * wrote (bracket-start/chunk/bracket-end/enter/…) so a reader doesn't have to infer it from content.
   *
   * OBSERVATION ONLY: this is a passthrough. It must never alter what's written, its outcome, or its
   * timing relative to a bare `live.pty.write(data)` call — do not add anything here that could change
   * write behaviour.
   */
  private ptyWrite(sessionId: string, live: Live, data: string, tag: string): void {
    const seq = ++live.writeSeq;
    // eslint-disable-next-line no-console
    console.log(`[pty-write] ${sessionId} seq=${seq} tag=${tag} gen=${live.submitGeneration} len=${data.length} h=${fnv1a32(data)}`);
    live.pty.write(data);
  }

  /**
   * Companion injection-guard Primitive A's SINGLE writer for `activeTurnOwnerText` /
   * `lastPromptOwnerText` / the `recentOwnerTurns` ring — factored out of `submit()` (card b4b9b707) so
   * the SAME reviewed logic also serves the raw-terminal attribution path (deliverHook's UserPromptSubmit
   * case). `ownerText` here is always a real, already-known-owner-authored string — the `undefined`/null
   * ("no owner text this turn") case is handled by each CALLER, not this helper, matching submit()'s prior
   * inline shape exactly (byte-identical behavior for the composer/companion path this factors out of).
   */
  private attributeOwnerText(live: Live, ownerText: string): void {
    live.activeTurnOwnerText = ownerText;
    live.lastPromptOwnerText = ownerText;
    // NEVER cleared at Stop — persists across the turn boundary so a later turn's lever call can still see it.
    live.recentOwnerTurns.unshift(ownerText);
    if (live.recentOwnerTurns.length > RECENT_OWNER_TURNS_WINDOW) live.recentOwnerTurns.length = RECENT_OWNER_TURNS_WINDOW;
  }

  private submit(sessionId: string, text: string, route?: TurnRoute, ownerText?: string, proactive = false, senderId?: string | null, reason: string = "queue", origin?: QueuedMessage[]): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    // Card 441499ee: remember the ORIGINAL queued message(s) this turn's text came from — see
    // `Live.giveUpOrigin`'s doc. Of the two direct submit() callers that don't originate from
    // enqueueStdin, only resumeAfterRateLimit's "rate-limit-replay" still calls with `origin` undefined
    // (a give-up there has no origin to restore — unchanged), so this stays byte-identical (null) for
    // it. `scheduleKickoffGuarantee`'s "kickoff-guarantee" caller is NO LONGER one of these — card
    // 0050a17e gave it a synthetic single-element origin (see that call site) once it became the PRIMARY
    // delivery path for every spawn, so an unconfirmed give-up there now correctly re-queues instead of
    // discarding. (Card 25813ecc: this comment previously listed both callers as origin-less — stale
    // since 0050a17e; see `Live.giveUpOrigin`'s own doc, which was updated correctly at the time.)
    live.giveUpOrigin = origin ?? null;
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): `reason` names WHICH of the
    // four call sites is writing this turn — the two queue-mediated ones ("immediate"/"drain", both already
    // busy-gated) and the two DIRECT-write bypasses (resumeAfterRateLimit's "rate-limit-replay", and
    // scheduleKickoffGuarantee's "kickoff-guarantee") that write to the pty WITHOUT going through
    // drainPending's queue. `busyBefore` is the alarm signal: a write landing while the daemon already
    // believes the session is busy means either a real double-turn race, or (more likely, per the a3814193
    // incident) that `live.busy` had already gone stale via one of the out-of-band clears (see the `[busy]`
    // log this same instrumentation adds to setBusy) — this line is what lets a future recurrence be
    // diagnosed straight from daemon-output.log instead of requiring an engine-transcript cross-reference.
    // eslint-disable-next-line no-console
    console.log(`[submit-write] ${sessionId} reason=${reason} busyBefore=${live.busy} len=${text.length} head=${JSON.stringify(text.slice(0, 60))}`);
    live.lastPrompt = text; // remember the in-flight turn so a usage-cap kill is recoverable (§19c-b)
    // Card 0f9268cc: a structured submit() starting supersedes any earlier raw-terminal baseline — the
    // composer-dirty gate (deferForHumanDraft) already stops this from racing a DIRTY raw draft, but a
    // raw submit from an EARLIER, already-Stopped turn could otherwise still be sitting here unconsumed
    // (e.g. its Stop hadn't fired yet, or fired without a readable transcript). Clear it so lastPrompt —
    // this NEW turn's real baseline — isn't shadowed by stale raw-channel text at the next Stop.
    live.lastRawSubmit = null;
    // Card b4b9b707 (SECURITY INVARIANT): submit() is the SOLE gateway every Loom-originated turn goes
    // through, so clearing pendingRawOwnerSubmit HERE — before a single byte of THIS turn's text is
    // written — guarantees it can never survive into a turn submit() originates. See the field's doc.
    live.pendingRawOwnerSubmit = null;
    live.pendingRawOwnerSubmitAt = null;
    // Pin this turn's ORIGINATING route (Loom Companion), SYNCHRONOUSLY — before the async writeChunked, so
    // it's in place the instant the agent processes the turn and can chat_reply. null for every non-companion
    // turn (route undefined). `lastPromptRoute` mirrors `lastPrompt` so a rate-limit replay keeps the route.
    live.activeTurnRoute = route ?? null;
    live.lastPromptRoute = route ?? null;
    // Companion injection-guard Primitive A: pin the turn's literal owner text the SAME way — undefined for
    // every non-owner-authored caller (proactive/heartbeat/reminder/system inject), so activeTurnOwnerText
    // stays null exactly like activeTurnRoute does today. `lastPromptOwnerText` mirrors lastPromptRoute so a
    // rate-limit-killed companion turn's replay (resumeAfterRateLimit) still attests correctly.
    if (ownerText !== undefined) {
      this.attributeOwnerText(live, ownerText);
    } else {
      live.activeTurnOwnerText = null;
      live.lastPromptOwnerText = null;
    }
    // Companion Trust Window: pin the turn's authenticated sender id the SAME way — undefined/null for
    // every non-group-companion caller, so activeTurnSenderId stays null exactly like activeTurnOwnerText
    // does for a non-owner-authored turn. lastPromptSenderId mirrors lastPromptOwnerText for replay.
    live.activeTurnSenderId = senderId ?? null;
    live.lastPromptSenderId = senderId ?? null;
    // Loom Companion (proactive event-line producer): pin whether THIS turn is a daemon-driven proactive
    // submit, caller-supplied — false for every existing caller this change didn't touch. Persists like
    // activeTurnRoute (not cleared at Stop); `lastPromptProactive` mirrors lastPromptRoute for replay.
    live.activeTurnProactive = proactive;
    live.lastPromptProactive = proactive;
    live.enterConfirmed = false; // this submit's Enter has not landed yet — see sendEnterAndVerify
    // NEW generation for THIS submit — the value sendEnterAndVerify's chain captures and checks on every
    // fire, so a chain left over from a PRIOR turn (already superseded by this fresh submit) recognizes
    // it's stale and bails instead of acting on this turn's `enterConfirmed`/`busy` state (CR-caught
    // overlap, card 9549e322 review — see the field doc on `Live.submitGeneration`).
    const gen = ++live.submitGeneration;
    // Card c2c750a9: record THIS generation's own (gen, text) into the composer-accumulation window —
    // once per submit() call (never per Enter-retry, which re-fires without a new submit()), so the ring
    // always holds exactly one entry per generation, oldest-first, ending with this one. Must happen here
    // (not later) so a late/async writeChunked failure still leaves the entry in place — the accumulation
    // this detects is about what the COMPOSER received, not whether the write later succeeded.
    live.recentWrittenTurns.push({ gen, text });
    if (live.recentWrittenTurns.length > COMPOSER_ACCUM_WINDOW) live.recentWrittenTurns.shift();
    // Card b68d1f5b Code Review: SAME chokepoint, SAME gen, but a SEPARATE, longer-horizon, integer-only
    // history for detectPastePlaceholderLengthLoss's gen discriminator — see Live.recentWrittenLineCounts'
    // own doc for why this is not just reading recentWrittenTurns above.
    live.recentWrittenLineCounts.push({ gen, lineCounts: computeWrittenLineCounts(text) });
    if (live.recentWrittenLineCounts.length > PASTE_LOSS_EXPLAIN_WINDOW) live.recentWrittenLineCounts.shift();
    // Card 4a0af485: reset for THIS fresh generation — stamped for real by `fireEnterAndVerify`'s first
    // attempt once the actual Enter write happens (not here — this is only the paste, not the Enter yet).
    live.currentGenFirstWrittenAt = null;
    // Chunk the text — a long turn (e.g. a worker report) sent as one pty.write is truncated by
    // ConPTY. Close the paste + send Enter only AFTER the last chunk lands, else it submits a partial.
    const writeNewTurn = (): void => {
      // Card 3ce3fa39: re-check aliveness here — unlike the original inline shape this was factored out
      // of (where this write was always the FIRST synchronous thing submit() did, covered by submit()'s
      // own entry guard), `writeNewTurn` can now also run as writeChunked's `done` callback for the
      // defensive clear-prefix below — i.e. ASYNCHRONOUSLY, after the session may have died mid-burst
      // (writeChunked fires `done` on its not-alive path too — card 9ed20572). `ptyWrite` itself performs
      // no aliveness check (every caller is expected to), so skipping this guard would write to a dead pty.
      // Card bb3d9005 (S1): `killed` too — `alive` alone stays true through the kill()→'exit' window
      // (see Live.killed's own doc), which this async callback can land inside just as easily.
      const l = this.live.get(sessionId);
      if (!l?.alive || l.killed) return;
      this.ptyWrite(sessionId, l, BRACKET_PASTE_START, "bracket-start");
      this.writeChunked(sessionId, text, () => {
        const l2 = this.live.get(sessionId);
        if (!l2?.alive || l2.killed) return;
        this.ptyWrite(sessionId, l2, BRACKET_PASTE_END, "bracket-end");
        const delay = SUBMIT_ENTER_DELAY_MS + pasteSettleExtraMs(text.length); // scale the first attempt's gap with paste size
        setTimeout(() => this.sendEnterAndVerify(sessionId, 1, gen), delay);
      });
    };
    // Card 3ce3fa39 (the frame-splice bug): `composerDirtyLen` is a possibly-stranded amount an EARLIER
    // submit's give-up/heal-if-stuck left unresolved — see the field's doc for why the clear is deferred
    // here rather than attempted at give-up time. THIS is the moment to actually address it: unlike give-up
    // time (whose whole trigger condition is "the engine wasn't reading"), a fresh submit is the one point
    // where we get real corroboration for free — if THIS write's own Enter goes on to confirm, that proves
    // the engine read the entire ordered byte stream, clear-prefix included, in order. Gated on
    // `composerLen === 0` for the SAME reason every other clear in this file is (card e1829591 — never risk
    // a real human draft); if a human is mid-draft, skip the defensive clear and fall back to the historical
    // stray-concatenation risk in that one already-rare edge case, unchanged from before this card.
    // Force-close first (a fresh zero-length START+END pair, the SAME bytes sendEnterAndVerify's own retry
    // reassert uses — card 97558183: idle → true no-op, still-open → closes with only a small stray tail)
    // so the backspace burst that follows can never be swallowed as literal paste content from an earlier
    // write whose own closing END marker may have been the thing that dropped.
    // Deliberately NOT reset to 0 here (only a genuine confirmation resets it — see the field's doc): if
    // THIS write also gives up unconfirmed, the give-up branch must keep compounding on top of whatever was
    // already unresolved, not overwrite it — that compounding is exactly what specimen A/C's doubled/singled
    // residue measured.
    //
    // Card b9b8f8db (the composer-runaway fix): a REDELIVERY of an already-attempted message — `origin`
    // contains a member whose own PRIOR physical write already failed to confirm (`giveUpGen !== undefined`,
    // set only by `requeueGiveUpOrigin`'s `kept.push`) — must NOT repeat the backspace-then-repaste below.
    // `composerDirtyLen` is never reset except by a genuine confirmation (see the doc above), so in a
    // genuinely wedged session (confirmation never arrives) every redelivery cycle backspaced the FULL
    // accumulated total and repasted the ~identical body again, compounding without bound (measured: a
    // 45,934 B kickoff's own single-generation write grew to 184,967 B — 4× — across 4 cycles in ~2.5min).
    // Since this exact message already put its own content in front of the engine once, ASSUME the composer
    // still holds it (give or take the small possible-duplicate tag prefix `joinSubmittedText` adds at write
    // time, which is never literally re-typed either way) and retry ONLY the Enter — do not touch the
    // composer body at all.
    // ASSUMPTION, STATED (not inherited silently): the composer genuinely still holds what was last written
    // for this message — i.e. the earlier paste landed byte-for-byte and only the Enter/hook confirmation
    // never registered. If that's wrong (a genuinely mangled/partial earlier paste), this Enter submits
    // whatever content is ACTUALLY sitting there as a real turn, instead of self-correcting the way a full
    // backspace+repaste would. That is a real tradeoff, taken deliberately: it applies ONLY to a message
    // that has itself already been physically written once (never to a brand-new/different message, nor to
    // a fresh re-mint's own FIRST attempt — see `handleKickoffGiveUpExhausted`'s re-mint, which mints a NEW
    // QueuedMessage with no `giveUpGen` of its own yet, so it still takes the full clear+repaste below,
    // unchanged), and it is bounded by the SAME `GIVE_UP_REQUEUE_LIMIT`/chainDepth cycle count as before —
    // this does not remove the cap, it removes the wasted bytes inside each already-capped cycle.
    //
    // Card c148f118 (closing the ambiguity ae354916's comment below records): the defensive clear-prefix
    // below never decremented `composerDirtyLen`, and the additive give-up mark that can follow it fires
    // UNCONDITIONALLY — so "the clear worked, then the repaste alone failed to confirm" and "the clear
    // did nothing at all" landed on the EXACT SAME NUMBER, with no way to tell them apart. Fixed by
    // giving `composerDirtyLen` a single, HONEST job (the CONSERVATIVE upper bound — assume no attempted
    // clear, ever, has actually landed; unchanged below, byte-identical to before this card whenever no
    // clear is ever attempted) and adding a second field, `composerDirtyLenBelieved` (see its own doc on
    // the Live interface), for the OPTIMISTIC read (assume every attempted clear DID land). The two
    // together bound the truth: equal ⇒ no unresolved clear is in play, nothing to doubt;
    // `composerDirtyLenBelieved < composerDirtyLen` ⇒ a clear was attempted whose outcome is still
    // unverified, and the gap between them is exactly how many characters are in doubt. Neither field
    // alone could ever say that — two honest fields instead of one field doing two jobs, which is why it
    // could do neither.
    //
    // Card 2960c3bf (2026-08-05, worker `a9b67b0d`): a SECOND occurrence of exactly the residue
    // 3ce3fa39's comment above predicted ("first-hand confirmed: two specimens' abandoned text
    // survived a backspace-clear... only to resurface — once doubled") — this time via THIS deferred
    // clear (the branch below), not the immediate one 3ce3fa39 moved away from. A re-minted give-up
    // retry (44283 stranded + a fresh 44323-char repaste, the 40-char excess being the
    // `[loom:possible-duplicate root:…]` tag `framePossibleDuplicate` adds) landed at
    // `composerDirtyLen === 88606` (`= 44283 + 44323`, exact) after ITS OWN Enter also never
    // confirmed. ⚠️ THAT NUMBER IS NOT COMPOSER EVIDENCE — `composerDirtyLen` is pure write-side
    // bookkeeping (verified: every mutation site is either `+= lastPrompt.length`, the length of
    // what LOOM wrote, at 5673/6315/6363, or a full reset to 0 gated on `composerDirtyLenClearedByGen`
    // trusting a CONFIRMED hook — never a read-back of real terminal/composer content). `88606` is
    // therefore what this accounting produces whenever a clear-then-repaste generation's OWN Enter
    // also fails to confirm, REGARDLESS of whether the backspace burst actually cleared anything —
    // it says nothing about what the engine's real composer held. Two open candidates, not
    // established either way from static logs alone: (a) the un-bracketed `BACKSPACE.repeat(dirty)`
    // burst below gets misinterpreted as literal paste content once/if the engine processes it; (b)
    // the engine simply stopped consuming stdin after rendering the specimen's first large paste (its
    // raw per-session output log recorded ~0 bytes of further output for the rest of that session's
    // life — consistent with nothing sent afterward, backspaces included, ever being read at all).
    // A live experiment is needed to discriminate (a)/(b) above; this comment records the evidence, not
    // a fix for the STRAND — card 17c98df7's own repaint probe (merged a648239) since ran that
    // experiment and did NOT reproduce the strand in 9 attempts (a small-n null, not a clearance — see
    // that card). Card c148f118 fixed a DIFFERENT, narrower thing: `88606` above being unable to tell
    // "the clear worked, the repaste alone didn't confirm" from "the clear did nothing" is now closed by
    // `composerDirtyLenBelieved` (see its own doc) — for this exact specimen it would have read `44323`
    // (just the repaste, assuming the clear landed) alongside `composerDirtyLen`'s unchanged `88606`
    // (assuming it didn't) — an honest range instead of one number silently picking neither story. This
    // does NOT resolve which of (a)/(b) actually happened; it only stops the number from claiming to.
    const isGiveUpRedelivery = origin?.some((m) => m.giveUpGen !== undefined) ?? false;
    if (live.composerDirtyLen > 0 && live.composerLen === 0 && isGiveUpRedelivery) {
      // Stamp the same way the full-clear branch below does: a confirmed Enter for THIS generation proves
      // the turn was submitted, i.e. the composer is now genuinely empty — see composerDirtyLenClearedByGen's
      // doc. True regardless of whether we backspaced or not; the confirmation is what proves it either way.
      live.composerDirtyLenClearedByGen = gen;
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} redelivering an already-attempted message (composer possibly dirty, ${live.composerDirtyLen} chars) — retrying the Enter only, not re-pasting the body (card b9b8f8db)`);
      this.ptyWrite(sessionId, live, BRACKET_PASTE_START + BRACKET_PASTE_END, "reassert-paste");
      const reassertWrittenAt = Date.now();
      this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, 0, () => this.fireEnterAndVerify(sessionId, 1, gen));
    } else if (live.composerDirtyLen > 0 && live.composerLen === 0) {
      const dirty = live.composerDirtyLen;
      // Stamp WHICH generation is attempting this clear — the confirming-hook sites only reset
      // composerDirtyLen when they observe THIS SAME generation still current (see the field's doc); an
      // unrelated hook firing before this generation's own Enter confirms must never reset it.
      live.composerDirtyLenClearedByGen = gen;
      // Card c148f118: THIS is the optimistic assumption itself — the backspace burst about to be sent
      // (below) is sized to erase exactly `dirty` chars, so ASSUME it works and zero the believed
      // reading now, at write time, not deferred to any later confirm. `composerDirtyLen` (conservative)
      // is deliberately left untouched here — it only ever resets via a decisive confirm (the two gated
      // sites above) — so the two fields diverge starting HERE if this generation's own write later gives
      // up unconfirmed: `composerDirtyLenBelieved` will read as just this generation's own fresh write,
      // `composerDirtyLen` will read as that PLUS the `dirty` this clear was attempting. See the field's
      // own doc on the Live interface for how to read the gap between them.
      live.composerDirtyLenBelieved = 0;
      // Card b9b8f8db: THIS generation IS writing a fresh body (the repaste below) — gate composerDirtyLen's
      // additive mark side on this, see `composerBodyWrittenForGen`'s own doc.
      live.composerBodyWrittenForGen = gen;
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} composer possibly dirty from an earlier unconfirmed give-up (${dirty} chars) — clearing defensively before this write`);
      this.ptyWrite(sessionId, live, BRACKET_PASTE_START + BRACKET_PASTE_END, "reassert-paste");
      this.writeChunked(sessionId, BACKSPACE.repeat(dirty), writeNewTurn);
    } else {
      // Card b9b8f8db: same reasoning as the branch above — a plain (non-dirty-prefixed) paste also writes
      // a fresh body this generation.
      live.composerBodyWrittenForGen = gen;
      writeNewTurn();
    }
    this.setBusy(sessionId, true, reason); // M1: optimistic, SYNCHRONOUS — see the M1 INVARIANT note above. Keep last; keep sync.
  }

  /**
   * Write ONE Enter attempt, then wait `SUBMIT_VERIFY_TIMEOUT_MS` for confirmation (`enterConfirmed`,
   * set by deliverHook on `UserPromptSubmit`/`Stop`/`StopFailure`) before deciding what's next — the
   * verify-and-retry loop that closes card 9549e322 (a swallowed/dropped lone Enter strands the
   * composer with busy stuck true).
   *
   * `gen` is the `submitGeneration` this chain was scheduled under (captured once in `submit()`, threaded
   * through every recursive retry of the SAME submit). Every fire — the write AND the verify-timeout
   * callback — bails the instant `live.submitGeneration !== gen`: a NEWER submit() (or an out-of-band
   * busy-clear — healIfStuck / interruptForRedirect / stop, which all bump the generation too) means this
   * chain belongs to an ALREADY-SUPERSEDED turn, so its `enterConfirmed`/`busy` reads are meaningless for
   * whatever is live now — checking `enterConfirmed` alone is not enough (a fast turn can confirm+Stop
   * and a brand-new submit can reset `enterConfirmed` back to false WHILE this chain is still waiting,
   * which would otherwise read as "still unconfirmed" and retry-Enter into the new turn's window).
   *
   *  - Confirmed / stale generation / the session died by the time the wait elapses → stop, nothing more.
   *  - Not confirmed and attempts remain → log it (this IS the live validation the merge gate wants:
   *    it proves whether a real drop/swallow happened) and re-send `\r` for the next attempt.
   *  - Not confirmed and out of attempts → GIVE-UP SUPPRESSED (card 71de1f9c) if the engine produced any
   *    output after this final Enter write — that's strong evidence the Enter registered and a turn is
   *    actually running, just with a slow-to-confirm hook; do nothing and let the real Stop/UserPromptSubmit
   *    (however late) finalize normally. Otherwise (genuinely no output at all) → GIVE-UP RECOVERY: log an
   *    error, recover busy (setBusy(false)) so the session is never left busy=true with an unsent composer
   *    forever, AND clear the stranded injection
   *    (card ee082fbb) — but ONLY when `composerLen === 0`. `composerLen` tracks ONLY human raw-terminal
   *    keystrokes (never our own `pty.write`), so `===0` proves the composer holds NOTHING but this
   *    give-up'd injection — a human never got a chance to start a draft during the failed retries (if one
   *    did, `composerLen > 0` and we leave the box alone; `deferForHumanDraft`'s existing hold still
   *    protects it — see card e1829591, never destroy a user's uncommitted draft). This is exactly the
   *    HUMAN-DRAFT SAFETY half of the fix; the CLEAR-EFFICACY half (does a clear byte actually empty a
   *    real multi-line composer, or does it truncate/strand a partial remnant?) needed real-engine
   *    validation, not just hermetic bytes-written assertions:
   *
   *    REAL-CLAUDE FINDINGS (claude 2.1.207, card ee082fbb probe — test/_probe-composer-clear{,-2}.mjs):
   *      - The TUI COLLAPSES a multi-line/long bracketed paste into a single "[Pasted text #N +K lines]"
   *        placeholder token — the raw lines are NOT individually editable once pasted.
   *      - A single Esc does NOT clear it — it only ARMS a "Esc again to clear" confirm; a second Esc (or
   *        any other key right after) leaves the composer in an inconsistent, still-dirty state. REJECTED.
   *      - Ctrl-U (kill-line) cleared the COLLAPSED placeholder in one shot (it reads as one "line" to
   *        readline-style kill semantics) — but on a SHORT multi-line paste that stayed under the
   *        placeholder-collapse threshold (rendered as literal editable lines, not a placeholder), Ctrl-U
   *        only killed the CURRENT line and SILENTLY STRANDED the earlier line(s) — confirmed via the
   *        engine's own transcript, which recorded the stranded first line concatenated with the next
   *        turn. Exactly the "partial clear worse than concatenation" risk this card was deferred over.
   *        REJECTED as a general-purpose clear.
   *      - Exact-count Backspace (`\x7f` × the injected text's length) reliably emptied the composer in
   *        EVERY case tested: the collapsed placeholder (backspace #1 deletes the whole atomic token, the
   *        rest floor at 0 and no-op — safe even though the count overshoots the placeholder's own visual
   *        length; a VERSION-PINNED assumption about claude 2.1.207's composer/backspace handling — worth
   *        re-verifying against the probes if a future claude version changes that behavior), a short
   *        un-collapsed multi-line paste (backspace walks back through the embedded newlines exactly like
   *        nextComposerLen's own counting model), and a single-line paste. ADOPTED.
   *    The exact length to un-type is `live.lastPrompt` — already the literal text `submit()` pinned for
   *    THIS turn (line ~3007) — so no new state is needed; give-up walks it back char-by-char via the
   *    same `writeChunked` large-write path submit() itself uses (a giant Backspace burst is just as
   *    subject to ConPTY's write-size limits as a giant paste).
   *
   * VALIDATED against a real claude engine (v2.1.206, card 9549e322 review item ②): forcing
   * SUBMIT_VERIFY_TIMEOUT_MS well below a normal UserPromptSubmit round-trip (so the retry ALWAYS fires a
   * real second Enter into an already-genuinely-submitted, still-generating turn) still produced exactly
   * ONE UserPromptSubmit + ONE Stop for the one logical turn sent — the redundant bare `\r` landing on the
   * by-then-empty, mid-generation composer is INERT (no stray blank turn, no corruption). A retry firing
   * into a turn that actually already started is therefore harmless; the real risk this loop guards
   * against is a retry NOT firing when the Enter genuinely never registered.
   *
   * RETRY re-asserts the paste-close too (card 97558183): `submit()`'s own `BRACKET_PASTE_END` write is
   * JUST as fire-and-forget as the Enter it precedes, and the SAME ConPTY drop class can lose it. When it
   * does, Ink stays mid-paste and swallows every retried `\r` as paste CONTENT (never a submit) — worse,
   * each swallowed byte resets Ink's paste idle-timer, actively preventing self-heal, so the old code's
   * bare-Enter retry could NEVER recover from this and would burn all attempts before giving up. Every
   * retry (attempt > 1; the FIRST attempt follows immediately after submit()'s own END write, so
   * re-asserting there would just be redundant) re-sends a zero-length `START+END` pair — not a bare END
   * — as ONE write, before the `\r`:
   *   - Already closed (the common case — only the Enter dropped, not the END): Ink is idle, sees a fresh
   *     START immediately followed by END, and treats it as an empty paste — a true no-op. A bare END
   *     alone sent while idle is NOT verified safe (Ink may not recognize an out-of-context terminator the
   *     same way a fresh START+END pair is defined to behave either idle or mid-paste — see this file's
   *     own `CONTROL_CHAR_RE` note for the sibling risk of a stripped-ESC CSI turning into literal text).
   *   - Still genuinely open (the bug): the extra bytes fold in as a few stray literal paste-content
   *     characters, but END is found and the paste closes — recovering the turn (submitted with a small
   *     cosmetic tail) instead of losing it entirely after 4 failed attempts.
   * Real-`claude` confirmation of both branches (does an idle START+END truly no-op; does a still-open
   * paste truly close and submit with just a small stray tail) is the Lead's live-verification pass — the
   * fake pty this file's own test drives can't model Ink's paste state machine, only that the BYTES this
   * host writes are exactly what's intended.
   *
   * Card b64b3726 Half 1: on the FINAL attempt only (`attempt === SUBMIT_MAX_ATTEMPTS`), this re-assert is
   * itself a confirmed output source INSIDE the give-up branch's own anchor window (see
   * `REASSERT_SETTLE_POLL_MS`'s doc for the measured evidence) — a Code Reviewer finding on this method's
   * own suppression logic below. The fix is SEQUENCING, not detection: let the re-assert's response (if
   * any) land BEFORE writing this attempt's Enter and capturing `enterWrittenAt`, via `awaitReassertSettle`
   * (bounded, observed not guessed). Intermediate retries (attempt 2/3 here) never consult `lastOutputAt` —
   * only the give-up branch below does — so they skip straight to `fireEnterAndVerify` unchanged; waiting
   * there would tax every retry chain for zero discriminating benefit.
   */
  private sendEnterAndVerify(sessionId: string, attempt: number, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return;
    if (attempt > 1) {
      this.ptyWrite(sessionId, live, BRACKET_PASTE_START + BRACKET_PASTE_END, "reassert-paste");
      if (attempt === SUBMIT_MAX_ATTEMPTS) {
        const reassertWrittenAt = Date.now();
        this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, 0, () => this.fireEnterAndVerify(sessionId, attempt, gen));
        return;
      }
    }
    this.fireEnterAndVerify(sessionId, attempt, gen);
  }

  /**
   * Bounded, observed wait for the give-up attempt's own paste-reassert to settle before its Enter is
   * written — see `sendEnterAndVerify`'s doc and `REASSERT_SETTLE_POLL_MS`'s measured-distribution comment
   * for why this exists and how the bound was sized. Re-checks the SAME bail condition as every other link
   * in this chain (`!alive || enterConfirmed || submitGeneration !== gen`) on every poll — a superseded or
   * already-confirmed turn abandons here rather than proceeding to write a now-meaningless Enter.
   */
  private awaitReassertSettle(sessionId: string, gen: number, reassertWrittenAt: number, polls: number, onDone: () => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return;
    if (live.lastOutputAt > reassertWrittenAt || polls >= REASSERT_SETTLE_MAX_POLLS) { onDone(); return; }
    setTimeout(() => this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, polls + 1, onDone), REASSERT_SETTLE_POLL_MS);
  }

  /**
   * Card 441499ee: bounded, OBSERVED wait for `enterConfirmed` to flip true — see
   * `GIVE_UP_CONFIRM_SETTLE_POLL_MS`'s doc for why this is short and deliberately does not try to cover
   * the full hook-confirmation latency distribution. Called from the GIVE-UP branch of `fireEnterAndVerify`
   * the instant the OUTPUT discriminator (`lastOutputAt`) has already failed to suppress it — this is a
   * SEPARATE, independent check against a DIFFERENT signal (the hook-set `enterConfirmed`, not inferred
   * output), not a change to that discriminator's own logic.
   *
   * UNLIKE `awaitReassertSettle`, the caller needs to know WHY this settled — `confirmed:true` (a hook
   * arrived; treat exactly like GIVE-UP SUPPRESSED, do nothing else) vs `confirmed:false` (the bound
   * elapsed with no confirmation; proceed to GIVE-UP RECOVERY) lead to entirely different actions — so
   * `onSettled` takes that boolean. Mirrors `awaitReassertSettle`'s bail-silently-without-calling-back
   * shape for the dead/superseded case: if this generation is no longer live or has been superseded by a
   * newer submit(), there is nothing of THIS generation's left to confirm or recover, so it simply stops
   * (the newer submit's own give-up chain, if it ever needs one, runs this same check fresh under its own
   * generation).
   */
  private awaitGiveUpConfirmSettle(sessionId: string, gen: number, polls: number, onSettled: (confirmed: boolean) => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.submitGeneration !== gen) return; // stale/dead — this generation is moot, nothing to confirm or recover
    if (live.enterConfirmed) { onSettled(true); return; }
    if (polls >= GIVE_UP_CONFIRM_SETTLE_MAX_POLLS) { onSettled(false); return; }
    setTimeout(() => this.awaitGiveUpConfirmSettle(sessionId, gen, polls + 1, onSettled), GIVE_UP_CONFIRM_SETTLE_POLL_MS);
  }

  /** Write this attempt's Enter and arm its verify-timeout — the second half of `sendEnterAndVerify`,
   *  split out so the give-up attempt can route through `awaitReassertSettle` first. */
  private fireEnterAndVerify(sessionId: string, attempt: number, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return; // re-check: state may have changed during the settle wait
    this.ptyWrite(sessionId, live, ENTER, "enter");
    // Anchor for the give-up branch's liveness check below — captured for THIS attempt's own Enter write,
    // never an earlier one (each attempt gets its own closure). See the give-up branch's comment for why.
    const enterWrittenAt = Date.now();
    // Card 4a0af485: stamp the ORIGINAL (attempt 1 only) write time for THIS generation — a retry
    // (attempt>1) must never overwrite it, or a give-up's own reassert/retry writes would keep resetting
    // the clock and understate the true confirmation lag. Read by the CONFIRMED logging below and by
    // `requeueGiveUpOrigin` (to stamp an accurate `writtenAt` onto `ambiguousDispatches`).
    if (attempt === 1) live.currentGenFirstWrittenAt = enterWrittenAt;
    // Card 04de8bbf's investigation: this line previously carried no generation/message id, so no
    // analysis (or future live reconciliation fix on 4a0af485) could join a submit to its true confirming
    // hook — only an approximate time-order pairing, which breaks down across a give-up cascade (several
    // attempt-1 writes can precede the one real hook that eventually confirms a re-minted message).
    // `gen` is already in scope here (this function's own parameter) — log-only, no behavior change.
    // eslint-disable-next-line no-console
    console.log(`[submit] ${sessionId} Enter attempt ${attempt}/${SUBMIT_MAX_ATTEMPTS} written gen=${gen} — awaiting confirmation`);
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.enterConfirmed || l.submitGeneration !== gen) return; // confirmed / stale generation / dead — nothing more to do
      if (attempt < SUBMIT_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.log(`[submit] ${sessionId} Enter attempt ${attempt} NOT confirmed within ${SUBMIT_VERIFY_TIMEOUT_MS}ms — retrying`);
        this.sendEnterAndVerify(sessionId, attempt + 1, gen);
      } else {
        // Card 71de1f9c: most give-ups are FALSE NEGATIVES — the Enter genuinely registered and a turn is
        // running, only the confirming hook's round-trip is slow (observed under fleet load: 79% of a
        // measured sample of give-ups WERE followed by a UserPromptSubmit for the same session). Treating
        // every give-up as a real failure is actively harmful, not just imprecise: clearing busy here
        // reopens enqueueStdin's `!live.busy` immediate-submit path, so the NEXT message can land — and get
        // interleaved with — a turn that is actually still generating (the owner-reported "text sitting in
        // the input field, unsent" symptom). Distinguish the two cases with `lastOutputAt` (bumped on every
        // real pty.onData chunk, already used the same way by healIfStuck): if the engine produced ANY
        // output after THIS attempt's own Enter write, the Enter almost certainly reached and registered
        // with the engine — by attempt>1 (always true at give-up in production), the reassert above already
        // guaranteed the paste was closed going into this Enter, so a landed keystroke here can only be a
        // real submit, not paste-content-swallowing. Anchoring on the FINAL Enter write (not on submit()'s
        // own start) is required: the pasted body's own render bumps lastOutputAt within the very first
        // attempt, long before give-up, so anchoring any earlier makes the check vacuously true and useless.
        // Real-engine measurement (not a guess): a claude sitting genuinely idle at the composer emitted
        // ZERO pty output over an 85+ second observation window on this project's own live fleet, while a
        // concurrently-busy session's output stream grew continuously in the same window — confirming idle
        // claude does not emit periodic output (no spinner/repaint chatter) that could make this discriminator
        // misfire on a genuine drop. If this read is ever wrong regardless, healIfStuck's existing stale
        // backstop (busySince AND lastOutputAt both stale) still recovers a truly-wedged session — just not
        // as fast as this branch would have.
        //
        // REJECTED ALTERNATIVE — do not "simplify" this back into a bigger SUBMIT_VERIFY_TIMEOUT_MS. Give-
        // ups are CONTENTION-DRIVEN BURSTS, not uniformly-distributed slow hooks (measured: median gap
        // between consecutive give-ups is 12 log lines vs ~39 expected under a uniform distribution, 34% land
        // within 10 lines of each other, and local [submit]+[hook] log density around a give-up is 54.3 vs
        // 43.7 baseline — give-ups cluster where the daemon is already busy). A larger constant is therefore
        // LOAD-SENSITIVE: it just relocates the threshold to wherever fleet contention happens to peak next,
        // the same anti-pattern this project has hit and reverted repeatedly (cards 595aad10, fea23514,
        // 0fa5beef). Keying on `lastOutputAt` instead is LOAD-TOLERANT — it asks "did the engine actually do
        // something" rather than "did enough wall-clock time pass," so it stays correct regardless of how
        // bad the contention gets.
        if (l.lastOutputAt > enterWrittenAt) {
          // eslint-disable-next-line no-console
          console.log(`[submit] ${sessionId} GIVE-UP SUPPRESSED after ${attempt} Enter attempts — engine produced output after the final Enter write (turn likely already running; hook confirmation just late); leaving busy=true for the real Stop/UserPromptSubmit to finalize`);
          // Card 3ce3fa39: this discriminator is a heuristic, not proof — observed output after our Enter
          // write can belong to unrelated concurrent activity rather than THIS write's own turn actually
          // starting (first-hand confirmed: a specimen stayed suppressed here, a real Stop fired 64.5s later
          // for something else, and this exact text resurfaced intact 646s afterward, concatenated onto the
          // next genuine submit). Mark it possibly-dirty defensively — a correct suppression costs nothing
          // (the next submit's clear-prefix floors to a safe no-op against an already-empty composer); a
          // wrong one is now covered instead of silently corrupting a later, unrelated turn. Same
          // composerLen===0 human-draft gate as every other clear in this file (card e1829591). Stamp
          // `composerDirtyMarkedForGen` so healIfStuck's OWN later backstop (if this generation's busy
          // never resolves any other way) doesn't double-count the identical text — see that field's doc.
          // ALSO gated on `composerBodyWrittenForGen` (card b9b8f8db) — an Enter-only redelivery generation
          // never wrote a fresh body, so there is nothing new here to mark; see that field's own doc.
          if (l.composerLen === 0 && l.lastPrompt && l.composerDirtyMarkedForGen !== gen && l.composerBodyWrittenForGen === gen) {
            l.composerDirtyLen += l.lastPrompt.length;
            l.composerDirtyLenBelieved += l.lastPrompt.length; // card c148f118: same additive mark, mirrored onto the optimistic reading
            l.composerDirtyMarkedForGen = gen;
          }
          return;
        }
        // Card 441499ee (hardening — card 04de8bbf measured ~86% of give-ups reaching THIS point are
        // followed by a confirming hook, i.e. the OUTPUT discriminator above just missed a turn that
        // actually started): before committing to GIVE-UP RECOVERY — which requeues the text — give
        // `enterConfirmed` one short, bounded, OBSERVED last chance to flip true. This is a SEPARATE check
        // against a DIFFERENT signal than the discriminator above (the hook itself, not inferred output);
        // it does not change that discriminator's own logic. See `awaitGiveUpConfirmSettle`'s doc for why
        // this is short and does not try to cover the full hook-latency distribution — `purgeConfirmedGiveUpRequeue`
        // remains the defense-in-depth for a confirmation that arrives after this window closes.
        this.awaitGiveUpConfirmSettle(sessionId, gen, 0, (confirmed) => {
          if (confirmed) {
            // eslint-disable-next-line no-console
            console.log(`[submit] ${sessionId} GIVE-UP SUPPRESSED after ${attempt} Enter attempts — a confirming hook arrived during the post-give-up settle wait (turn actually started; the output discriminator missed it, but the hook proves it); leaving busy/composer untouched`);
            return;
          }
          const l2 = this.live.get(sessionId);
          if (!l2?.alive || l2.enterConfirmed || l2.submitGeneration !== gen) return; // re-check: state may have changed during the settle wait
          // eslint-disable-next-line no-console
          console.error(`[submit] ${sessionId} GIVE-UP RECOVERY after ${attempt} Enter attempts — no engine output observed since the final Enter write; turn never confirmed started; recovering busy so the session doesn't wedge`);
          // Card 3ce3fa39 (superseding card ee082fbb's immediate clear): do NOT attempt the clear HERE.
          // Give-up firing at all means the engine produced no output during the ENTIRE retry window — i.e.
          // it wasn't reading — which is exactly the condition under which a raw backspace burst is LEAST
          // likely to be safely interpreted (first-hand confirmed: two specimens' abandoned text survived a
          // backspace-clear attempted at THIS point fully intact, only to resurface — once doubled — glued
          // onto a much later, unrelated submit). Mark the amount possibly-stranded instead (ADDITIVE — see
          // `composerDirtyLen`'s doc: a second unresolved give-up on top of an already-dirty composer must
          // not lose track of the first) and let the NEXT submit() clear it right before writing fresh
          // content, when the engine is demonstrably about to read again. Same composerLen===0 human-draft
          // gate as before (card e1829591).
          //
          // No more `attempt > 1` gate: that used to be a cheap proxy for "the paste bracket is closed"
          // (only a retried attempt had sent its own re-assert first), skipping the clear entirely at
          // attempt===1 to avoid folding raw backspaces in as literal paste content. submit()'s own
          // defensive clear-prefix ALWAYS force-closes via a fresh START+END pair immediately before
          // backspacing, regardless of how this give-up happened — so that residual risk (card ee082fbb CR
          // item ②, guarded by pty-giveup-clear-single-attempt.mjs) is now covered structurally instead of
          // by this proxy, and skipping the mark here would just reintroduce the original stray-text bug for
          // the attempt===1 case.
          //
          // ALSO gated on `composerBodyWrittenForGen` (card b9b8f8db): a generation that took the Enter-only
          // redelivery path never wrote a fresh body, so this give-up has nothing new to mark — marking it
          // anyway would inflate composerDirtyLen for bytes that were never actually (re)typed this
          // generation, which is exactly the wasted-byte accounting this card's fix removes.
          if (l2.composerLen === 0 && l2.lastPrompt && l2.composerDirtyMarkedForGen !== gen && l2.composerBodyWrittenForGen === gen) {
            l2.composerDirtyLen += l2.lastPrompt.length;
            l2.composerDirtyLenBelieved += l2.lastPrompt.length; // card c148f118: same additive mark, mirrored onto the optimistic reading
            l2.composerDirtyMarkedForGen = gen;
          }
          this.setBusy(sessionId, false, "give-up-recovery");
          this.requeueGiveUpOrigin(sessionId, gen); // card 441499ee — see the method doc
        });
      }
    }, SUBMIT_VERIFY_TIMEOUT_MS);
  }

  /**
   * Card 3e76ecad — the manager-facing SUBMIT-ONLY affordance: press Enter on this worker's OWN composer
   * without writing any new text, the daemon-driven analogue of what a human does at the raw terminal
   * when a stranded turn just needs re-confirming (the parent card b9b8f8db's evidence: the owner
   * recovered a session that had sat "apparently dead" for ~29 minutes by pressing Enter — no new text,
   * just the confirming keystroke). Until this existed, a manager's only two documented options for a
   * stranded worker were `worker_message` (APPENDS — compounds an already-oversized buffer) or
   * `worker_stop` + respawn (DISCARDS whatever the worker had accumulated); this is the third option.
   *
   * GENUINELY NON-WRITING (DoD-2): writes ONLY a zero-length bracket-paste reassert pair
   * (`BRACKET_PASTE_START + BRACKET_PASTE_END` — closes any dangling open paste marker, no body bytes
   * in between — the SAME reassert `submit()`'s own isGiveUpRedelivery branch writes when it retries an
   * Enter without re-pasting) plus the Enter keystroke itself. Neither write adds a single character to
   * the composer's visible content, so its byte count is unchanged by this call — unlike `worker_message`,
   * which always writes `text`.
   *
   * NO-OP ON AN EMPTY COMPOSER (DoD-3): `live.enterConfirmed` true is checked FIRST and is SUFFICIENT ON
   * ITS OWN — `live.busy`/`live.composerDirtyLen` are never even consulted once it's true. This is
   * deliberate, not an approximation of a three-way AND: `enterConfirmed` flips true only when a
   * confirming hook (UserPromptSubmit/Stop/StopFailure) actually lands, which is proof the engine is alive
   * and reading — and `submit()` unconditionally resets it to false as the FIRST thing any new
   * Loom-originated write does (see `submit()`'s own `live.enterConfirmed = false`), so there is no window
   * in which genuinely fresh stranded content can exist while it still reads true: writing that content is
   * what would have reset it. `live.composerDirtyLen` CAN still read nonzero here (see below), but that is
   * never evidence of something currently sitting unconfirmed once `enterConfirmed` is true — see the note
   * on the SUPPRESSED give-up path just below for why. `busy`/`composerDirtyLen` are consulted ONLY in the
   * `enterConfirmed:false` case, to tell an outstanding retry/give-up worth flushing apart from a session
   * that has simply never submitted anything yet (both default to `false`/`0`, matching a fresh spawn).
   * Reports `{ok:false, reason:"composer-empty"}` when `enterConfirmed` is true, rather than firing a
   * stray bare Enter that could start an empty turn.
   *
   * ⚠️ WHY `composerDirtyLen` CAN LAG `enterConfirmed` (traced during review, card 3e76ecad): a GIVE-UP
   * SUPPRESSED mark (`fireEnterAndVerify`'s "engine produced output after the final Enter write" branch)
   * stamps `composerDirtyMarkedForGen` directly and returns WITHOUT calling `requeueGiveUpOrigin` — so
   * neither `live.giveUpConfirmQueue` nor `live.ambiguousDispatches` ever gets an entry for that mark, and
   * `clearComposerDirtyOnConfirm` (reached only via those two, from `purgeConfirmedGiveUpRequeue`) can
   * never fire for it. The ONLY thing that can still clear a SUPPRESSED-only mark is the inline
   * `composerDirtyLenClearedByGen === live.submitGeneration` gate on a LATER, fresh submit() — so
   * `composerDirtyLen` can sit nonzero indefinitely even after the suppressed turn's own later Stop hook
   * sets `enterConfirmed` true. This is real, PRE-EXISTING staleness in that field's own bookkeeping (not
   * introduced here) — but it is harmless to this guard specifically, because by the time that Stop hook
   * fires the turn has already genuinely completed; there is nothing left in the composer to flush either
   * way, so declining is still the correct call, just for a slightly different reason than a bare read of
   * `composerDirtyLen` alone would suggest.
   *
   * A REMEDY TO TRY, NOT A GUARANTEED RECOVERY (DoD-4): this reuses `awaitReassertSettle` +
   * `fireEnterAndVerify`'s own bounded verify-and-retry ladder (the exact mechanism `submit()` uses for a
   * give-up redelivery) under the worker's CURRENT `submitGeneration` — so a stranded Enter can still fail
   * to confirm here exactly as it did the first time, and this call reports that honestly
   * (`confirmed:false`) rather than claiming success. `composerDirtyLenClearedByGen` is stamped the same
   * way `submit()`'s own dirty-branch stamps it, so a genuine confirmation correctly clears
   * `composerDirtyLen` through the SAME gated path every other clear in this file uses — this call does
   * not invent a new clear mechanism.
   *
   * Does NOT generalize into "this always recovers a stranded worker" (DoD-5) — it is exactly the
   * press-Enter remedy, nothing more; a worker whose composer holds genuinely lost/corrupted state is
   * outside what pressing Enter can fix.
   */
  flushComposer(sessionId: string): Promise<{ ok: boolean; reason?: string; confirmed?: boolean }> {
    const live = this.live.get(sessionId);
    if (!live?.alive) return Promise.resolve({ ok: false, reason: "session-dead" });
    const stranded = !live.enterConfirmed && (live.busy || live.composerDirtyLen > 0);
    if (!stranded) return Promise.resolve({ ok: false, reason: "composer-empty" });
    const gen = live.submitGeneration;
    // Mirrors submit()'s own dirty-branch stamp — see that call site's comment: this generation is the
    // one attempting to resolve any outstanding dirty residue, so the confirming hook's existing
    // `composerDirtyLenClearedByGen === live.submitGeneration` gate clears it correctly on confirm.
    live.composerDirtyLenClearedByGen = gen;
    // eslint-disable-next-line no-console
    console.log(`[flush-composer] ${sessionId} submit-only flush attempted (card 3e76ecad) — busy=${live.busy} composerDirtyLen=${live.composerDirtyLen} gen=${gen}`);
    const reassertWrittenAt = Date.now();
    this.ptyWrite(sessionId, live, BRACKET_PASTE_START + BRACKET_PASTE_END, "reassert-paste");
    this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, 0, () => this.fireEnterAndVerify(sessionId, 1, gen));
    return new Promise((resolve) => {
      this.awaitFlushConfirmSettle(sessionId, 0, (confirmed) => resolve({ ok: true, confirmed }));
    });
  }

  /**
   * Bounded, observed wait for `enterConfirmed` to flip true after `flushComposer` — ALWAYS calls back
   * (unlike `awaitGiveUpConfirmSettle`/`awaitReassertSettle`, which bail SILENTLY on a dead session or a
   * superseded generation because their internal caller doesn't need to know). `flushComposer` returns a
   * Promise straight to its MCP caller and must resolve it on every path, dead-session and superseded-
   * generation included, or the tool call hangs forever.
   */
  private awaitFlushConfirmSettle(sessionId: string, polls: number, onSettled: (confirmed: boolean) => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) { onSettled(false); return; }
    if (live.enterConfirmed) { onSettled(true); return; }
    if (polls >= FLUSH_CONFIRM_MAX_POLLS) { onSettled(false); return; }
    setTimeout(() => this.awaitFlushConfirmSettle(sessionId, polls + 1, onSettled), FLUSH_CONFIRM_POLL_MS);
  }

  /**
   * Card 441499ee: the second half of GIVE-UP RECOVERY — called AFTER `setBusy(false)` has actually
   * landed (threaded through the backspace-clear's own completion when there is one, exactly like
   * `setBusy` itself, so a still-draining clear burst can't be raced by a promoted turn). Restores
   * `live.giveUpOrigin` (the exact message(s) this failed submit came from — see that field's doc) onto
   * the FRONT of `live.pending` — converting the silent loss into delayed-but-real delivery on the NEXT
   * natural drain trigger (a Stop hook for some other turn, the box-free transition, or the ~10s reconcile
   * tick, which already exists precisely to drain anything a session's own Stop hook can't reach — see
   * `reconcile()`). Deliberately does NOT force an immediate `drainPending` itself: give-up already has no
   * live turn to interleave with, so the ordinary drain triggers are sufficient, and forcing one here would
   * make EVERY give-up (even a lone, otherwise-idle session) immediately re-arm busy and retry a second
   * full attempt cycle in place — which is exactly the behavior the sibling give-up tests
   * (pty-giveup-clear.mjs, pty-giveup-clear-single-attempt.mjs, pty-giveup-false-negative.mjs) correctly
   * assert does NOT happen for their own (single-cycle) scenarios. `unshift` (not push) preserves FIFO
   * order relative to anything that queued WHILE this message was stuck retrying: that message was
   * logically first, so it goes back in front of newer arrivals — and because `live.busy` stayed true for
   * this session's entire failed-retry window, nothing else could have started running, so this can never
   * jump ahead of or interleave with an actual in-flight turn.
   *
   * BOUNDED by `GIVE_UP_REQUEUE_LIMIT`: a message already at its requeue budget is dropped for real here
   * (loudly logged) instead of requeued again — a message that keeps giving up and requeuing forever
   * would be worse than the original silent drop. `giveUpRequeues` is tracked per MESSAGE OBJECT/id, never
   * inferred from matching text, so two legitimately identical messages are bounded independently.
   *
   * SAFETY AGAINST A FALSE-NEGATIVE GIVE-UP (card 04de8bbf's neighbourhood — production measurement found
   * GIVE-UP RECOVERY firing while the turn actually HAD started, zero SUPPRESSED in that sample): the
   * discriminator deciding RECOVERY-vs-SUPPRESSED can itself be wrong, so a requeued entry stamps
   * `giveUpGen: gen` — the generation its failed submit ran under — precisely so `purgeConfirmedGiveUpRequeue`
   * can find and drop it the instant a confirming hook proves that generation's turn actually ran, instead
   * of letting it drain later as a silent duplicate of a message that already landed. Card 09e655d5: `gen`
   * is ALSO pushed onto `live.giveUpConfirmQueue` (only when something was actually kept/requeued — a
   * budget-exhausted drop has nothing left to purge later) — that queue, not `live.submitGeneration`, is
   * what `purgeConfirmedGiveUpRequeue` correlates a late hook against; see its doc for why.
   *
   * Card 73d5c34a: each kept entry is ALSO stamped `giveUpHeldUntil` (now + `GIVE_UP_HOLD_MS`) — this is
   * what makes `drainPending` treat it as ineligible until a confirming hook purges it OR the hold expires
   * (see `isGiveUpHeld`), instead of the entry sitting at the front of `pending` as ordinary drainable
   * content that a reconcile tick could resubmit before a late hook ever gets to purge it.
   *
   * Card ccb407eb: a message whose budget IS exhausted (`requeues > GIVE_UP_REQUEUE_LIMIT`) — for a message
   * that has `onGiveUpExhausted` wired — is never silently dropped here — this project's own "fail toward a
   * duplicate, never a loss" principle (88f11385) forbids it, and this terminal branch is exactly what used
   * to invert it (10 permanent drops across 6 sessions in one production log, incl. a `[loom:merge-done]`
   * settle nudge that strands a manager indefinitely). `m.onGiveUpExhausted?.()` hands the decision to
   * whoever wired it up (`enqueueDurableMessage` in sessions/service.ts) — this class stays DB-agnostic,
   * exactly as it already is for every other durability guarantee (see `onGiveUpExhausted`'s own doc on
   * {@link QueuedMessage}). CR follow-up (card ccb407eb): "no durable record is orphaned" is the precise
   * claim — NOT "nothing is ever dropped here". A message with no hook wired (every non-durable caller — an
   * idle/context/busy-stuck watchdog nudge — but ALSO, residually, a raw HUMAN composer turn: `enqueueStdin`'s
   * own callers never wire `onGiveUpExhausted` for that source, so a human turn that exhausts its budget
   * still hits a bare, silent drop, exactly like before this card) has nothing to hand off to. That residual
   * is a real gap this card does not close — only a durable message minted via `enqueueDurableMessage`
   * (worker_message/redirect/recycle-carry, plus the settle nudges this card converted) gets the "never
   * orphaned" guarantee; nothing here claims a raw human turn does too.
   */
  private requeueGiveUpOrigin(sessionId: string, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    const origin = live.giveUpOrigin;
    live.giveUpOrigin = null;
    if (!origin || origin.length === 0) return;
    // Code Review Major finding (card 4a0af485, Major 4): seed the signature from the text ACTUALLY
    // SUBMITTED, never each message's own individual `.text` — `drainPending` may have COALESCED several
    // origin messages into ONE physical write (`joinSubmittedText`, mirrored exactly here), and
    // `live.lastPrompt`/the engine's echo reflect that JOINED text, not any one member's own. Seeding from
    // the individual text meant NO stored signature could ever match a coalesced turn's real confirmation —
    // content matching silently never fired for the default `warning`-kind drain path, nor for ANY `agent`
    // message once the daemon-global `coalesceAgentMessages` setting is on. A single-element `origin` (the
    // common case — one message, one turn) is unaffected: joining one element with a separator is that
    // element itself, byte-identical to before this fix. Card 78e4b3f2: `joinSubmittedText` (not a bare
    // `.map(m => m.text)`) is now load-bearing here for a SECOND reason too — it's the same function that
    // decided whether the attempt that just failed carried the possible-duplicate marker, so this seeds the
    // signature from EXACTLY what was written, not from `.text`'s own possibly-pristine value.
    // Card 4af5aefa: `gen` is the ACTUAL (post-increment) generation number the failing write ran under —
    // `joinSubmittedText`'s own `currentGen` needs the value `live.submitGeneration` held at the moment
    // that write's text was ORIGINALLY assembled (pre-increment, i.e. `gen - 1`), or a message that got an
    // age annotation baked into what was actually sent would have its reconstructed signature disagree
    // with what the engine really echoes back — exactly the class of bug this function's OWN doc already
    // documents for the possible-duplicate tag.
    const submittedText = joinSubmittedText(origin, gen - 1);
    const submittedSig = textSignature(submittedText);
    const kept: QueuedMessage[] = [];
    for (const m of origin) {
      // Card 4a0af485: seed/refresh `ambiguousDispatches` for THIS message's logicalId regardless of which
      // branch below runs — the budget-exhausted branch (onGiveUpExhausted, ultimately PARK at
      // sessions/service.ts) is exactly the case whose late confirmation this map exists to still catch,
      // since nothing survives in `live.pending` for it past that point. `writtenAt` uses
      // `currentGenFirstWrittenAt` (this generation's own original Enter-write time, still valid here —
      // nothing has re-submitted between the give-up firing and this call) so `latencyMs` logging is exact.
      // EVERY member of a coalesced origin is seeded with the SAME joined signature (not its own) AND the
      // SAME `batchId: gen` (card bc0774c4) — see `purgeConfirmedGiveUpRequeue`'s "collect every match"
      // handling for why sharing the signature is the correct pairing, not a bug: one confirming hook
      // legitimately confirms the whole coalesced batch at once. `batchId` is the discriminator that lets
      // that purge tell "coalesced together" (one call to THIS method, one shared `gen`) apart from
      // "coincidentally identical" (two SEPARATE calls to this method — i.e. two genuinely distinct give-up
      // events — that happen to land on the same text): `gen` only ever increases and is captured once per
      // call, so it's a free, already-threaded batch identity — the SAME value already stamped onto each
      // kept `QueuedMessage.giveUpGen` below — no new counter needed.
      live.ambiguousDispatches.set(m.logicalId, { ...submittedSig, writtenAt: live.currentGenFirstWrittenAt ?? Date.now(), batchId: gen });
      this.capAmbiguousDispatches(live);
      const requeues = (m.giveUpRequeues ?? 0) + 1;
      if (requeues > GIVE_UP_REQUEUE_LIMIT) {
        // Card d4f60cc1: this line is now durably captured (daemon stdout is teed to a rotated file), so
        // it can no longer carry message CONTENT the way a console-only line safely could — log a
        // content-free signature (len+hash, same shape `textSignature` already gives prompt-echo) instead
        // of a text preview.
        const sig = textSignature(m.text);
        // eslint-disable-next-line no-console
        console.error(`[submit] ${sessionId} GIVE-UP RECOVERY: message ${m.id} (${sig.len} chars, hash=${sig.hash}) exhausted its requeue budget (${GIVE_UP_REQUEUE_LIMIT}) after repeated give-ups — handing off to onGiveUpExhausted (${m.onGiveUpExhausted ? "wired" : "none — non-durable entry, nothing further to preserve"}) instead of a bare drop`);
        // CR follow-up (card ccb407eb, finding [7]): a give-up-exhausted fault must never break GIVE-UP
        // RECOVERY itself, but swallowing it SILENTLY would also eat a deliberately-loud M1/M2 invariant
        // throw from deep inside handleGiveUpExhausted's re-mint path (enqueueStdin → submit). Log it.
        try { m.onGiveUpExhausted?.(); } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[submit] ${sessionId} onGiveUpExhausted threw for message ${m.id} — swallowed so GIVE-UP RECOVERY itself is never broken, but logged so it can't fail silently:`, err);
        }
        continue;
      }
      kept.push({ ...m, giveUpRequeues: requeues, giveUpGen: gen, giveUpHeldUntil: Date.now() + GIVE_UP_HOLD_MS });
    }
    if (kept.length > 0) {
      live.pending.unshift(...kept);
      live.giveUpConfirmQueue.push(gen);
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} GIVE-UP RECOVERY: re-queued ${kept.length} message(s) at the front of pending, HELD from drain for up to ${GIVE_UP_HOLD_MS}ms pending a confirming hook — see purgeConfirmedGiveUpRequeue/isGiveUpHeld`);
    }
  }

  /** Card 4a0af485: evict the OLDEST entry until back at `AMBIGUOUS_DISPATCH_CAP` — a count bound, never a
   *  time bound (see that constant's own doc for why). `Map` iterates insertion order, so `.next().value`
   *  is always the oldest key. */
  private capAmbiguousDispatches(live: Live): void {
    while (live.ambiguousDispatches.size > AMBIGUOUS_DISPATCH_CAP) {
      const oldest = live.ambiguousDispatches.keys().next().value;
      if (oldest === undefined) break;
      live.ambiguousDispatches.delete(oldest);
    }
  }

  /**
   * Card 4a0af485, Requirement A (manager directive: "defend at the resource, not the caller"): does
   * `text` exactly content-match a still-ambiguous (given-up, possibly PARKED) prior dispatch for this
   * session? Called by sessions/service.ts's `enqueueDurableMessage` BEFORE minting a fresh, self-rooted
   * `rootMsgId` — a manual resend (a manager reacting to a "could not be confirmed delivered" notice, with
   * no idea what msgId to cite) whose text matches gets AUTO-JOINED to the original logical chain instead
   * of starting a disconnected one, with no caller opt-in required. Returns the matching `logicalId`, or
   * null if there's no ambiguity for this session or nothing matches. Read-only; does not consume/delete
   * the entry (only an actual confirming hook, via `purgeConfirmedGiveUpRequeue`, resolves it) — a caller
   * may legitimately query this more than once before the ambiguity actually resolves.
   *
   * Card 78e4b3f2: a stored entry's signature is seeded from `joinSubmittedText` — EXACTLY what was
   * physically written for the failing attempt, which is now the possible-duplicate-TAGGED text once an
   * entry has itself already been redelivered once in-session (`giveUpGen` set). A human/agent typing a
   * manual resend after a `[loom:redelivery-parked]` notice has no way to know about that internal tag —
   * they resend the plain ORIGINAL content the notice's own (tag-stripped) head quoted back to them. So
   * `text` is tried BOTH as-is AND with the tag this SPECIFIC candidate `logicalId` would carry — the tag
   * embeds the logicalId itself, so it must be reconstructed per-entry, not once outside the loop.
   */
  hasAmbiguousMatch(sessionId: string, text: string): string | null {
    const live = this.live.get(sessionId);
    if (!live || live.ambiguousDispatches.size === 0) return null;
    const sig = textSignature(text);
    for (const [logicalId, entry] of live.ambiguousDispatches) {
      if (entry.len === sig.len && entry.hash === sig.hash) return logicalId;
      const markedSig = textSignature(framePossibleDuplicate(text, logicalId));
      if (entry.len === markedSig.len && entry.hash === markedSig.hash) return logicalId;
    }
    return null;
  }

  /**
   * Card 73d5c34a: is this requeued entry still within its post-give-up hold window (see
   * `requeueGiveUpOrigin`'s `giveUpHeldUntil` stamp)? `drainPending` treats a held entry as ineligible —
   * it must not be resubmitted while a late confirming hook could still arrive and prove the ORIGINAL
   * (already-delivered) turn actually ran, which is exactly the race `purgeConfirmedGiveUpRequeue` used to
   * lose against a reconcile tick. `undefined` (never requeued, i.e. almost every entry) is never held.
   */
  private isGiveUpHeld(entry: QueuedMessage): boolean {
    return entry.giveUpHeldUntil !== undefined && Date.now() < entry.giveUpHeldUntil;
  }

  /**
   * Card 2521bf51 (code review Major 1): is delivery currently held pending the engine's confirmation of
   * a genuine human Enter-submit? See `Live.humanSubmitHeldUntil`'s own doc for the race this guards and
   * why the bound is only a backstop. SHARED by BOTH delivery gates — `drainPending`'s queued-turn path
   * AND `enqueueStdin`'s immediate-submit path — on purpose: `c1d71ff2`'s own test header documents these
   * two as a deliberate PAIR ("Both drain paths ... DEFER while dirty"), and the first pass at this card
   * broke that symmetry by wiring the check into only one of them, leaving the exact race this card fixes
   * fully reachable for a message that ARRIVES during the unconfirmed gap rather than being already
   * queued. A single shared predicate is what keeps the two gates from drifting apart again.
   */
  private isHumanSubmitHeld(live: Live): boolean {
    if (live.humanSubmitHeldUntil === null) return false;
    if (Date.now() < live.humanSubmitHeldUntil) return true;
    live.humanSubmitHeldUntil = null; // bound expired — no confirming hook ever arrived; stop holding
    return false;
  }

  /**
   * Card 441499ee: safety net for a FALSE-NEGATIVE give-up — production measurement (the card's own
   * neighbourhood, card 04de8bbf) found GIVE-UP RECOVERY firing while the turn had actually started (zero
   * SUPPRESSED in that sample), meaning the discriminator that decides RECOVERY-vs-SUPPRESSED can itself
   * be wrong. If RECOVERY already requeued a duplicate copy of that turn's text (see
   * `requeueGiveUpOrigin`'s `giveUpGen` tag) and were left to drain later, it would silently re-submit a
   * message whose original ALREADY landed — converting a fixed silent-drop bug into a NEW silent-duplicate
   * bug. `UserPromptSubmit` and `Stop`/`StopFailure` are the two hooks that PROVE a turn actually ran
   * (this file's own long-standing convention — either is definitive even if the other was lost), so both
   * call this the instant they fire.
   *
   * Card 09e655d5 (fixing a gap in the 441499ee safety net): a hook carries NO generation of its own, so
   * WHICH generation it confirms has to be derived. The original approach compared a pending entry's
   * `giveUpGen` against the CURRENT `live.submitGeneration` — correct only while nothing has resubmitted
   * since the failed attempt gave up, which breaks the instant a SECOND generation has ALSO given up (and
   * so ALSO advanced `submitGeneration`) before the FIRST generation's late hook arrives: that hook would
   * misattribute to the CURRENT (second) generation and purge the WRONG requeued entry, leaving the
   * actually-redundant one to double-deliver.
   *
   * THE FIX: `live.giveUpConfirmQueue` (pushed in `requeueGiveUpOrigin`) tracks every generation that gave
   * up and is still awaiting a possible late confirmation, OLDEST first. A hook always correlates to the
   * QUEUE FRONT, never the live generation — the front is reliably the oldest still-ambiguous generation
   * because real turns run serially through the one pty stream, so confirming hooks resolve in the same
   * order their generations were submitted (a second generation's Enter can only actually reach the engine
   * after the first's turn — if it was a false negative — has finished running). `UserPromptSubmit` purges
   * the front's matching entry but does NOT advance the queue: it fires first for a real turn, and leaving
   * the front unchanged means a still-outstanding `Stop` for that SAME real turn is a safe no-op instead of
   * misattributing to whatever generation is next in the queue. Only `Stop`/`StopFailure` — the definitive,
   * one-per-real-turn end signal — advances past the front, purging first (covering the case where
   * `UserPromptSubmit` for it was itself lost, per this file's "either hook is definitive" convention).
   *
   * IMPROVED, NOT CLOSED (card 73d5c34a): a reconcile tick used to be able to beat a merely-late hook to
   * the punch and resubmit the requeued entry FIRST (bumping the generation before the confirmation
   * arrived), leaving this purge nothing to remove for that generation — the entry was already out being
   * resubmitted under its own new generation, so the turn it originally came from would double-deliver.
   * `requeueGiveUpOrigin`'s `giveUpHeldUntil` stamp plus `drainPending`'s `isGiveUpHeld` skip close THAT
   * specific race (a reconcile tick can no longer resubmit a still-held entry out from under this purge).
   * They do NOT make double-delivery structurally impossible — real bypasses remain, deliberately left
   * as residuals rather than "fixed": (1) a confirming hook arriving LATER than `GIVE_UP_HOLD_MS` still
   * double-delivers — the hold is a best-effort window, not a guarantee, and the `Stop`-only path (both
   * hooks lost) fires at TURN END, which a genuinely long-running turn (a manager mid-orchestration)
   * routinely exceeds; (2) `consumePending`/`inbox_pull` splices the WHOLE queue, held entries included,
   * treating them as delivered regardless of hold state — ASSESSED (card 9e27f4d2) and left as-is: unlike
   * a background drain/reconcile tick (which acts on a timer with no signal that the ambiguity has been
   * resolved), an `inbox_pull` caller has explicitly asked for its own inbox NOW — that is itself a
   * deliberate act by the very recipient the hold exists to protect, so treating the held entry as
   * delivered here is a reasonable, intentional choice, not an accidental bypass of the hold's purpose.
   * (3) FIXED (card 9e27f4d2): the pending snapshot used to carry a held entry's TEXT ONLY, dropping
   * `giveUpHeldUntil`, so a daemon-restart landing mid-hold-window replayed it on boot as a plain fresh
   * message with no hold at all — an unconditional immediate duplicate, strictly worse than residual (1).
   * The fix persists the deadline in `getPersistablePendingSnapshot`'s SEPARATE, additive `holds` half
   * — kept out of its `texts` return value deliberately; see that method's doc for the backward-compat
   * reason — and `resumeFleetOnBoot` restores it via `enqueueStdin`'s `giveUpHeldUntil`
   * param, so a restart during the hold degrades to the SAME delayed-duplicate SHAPE as residual (1) —
   * but NOT identically: residual (1) is a race the hold can still WIN (a confirming hook merely arrives
   * late but before some other purge/expiry); post-restart nothing can ever win it (no hook can reach a
   * dead process's generation, and `giveUpConfirmQueue` resets empty, so `purgeConfirmedGiveUpRequeue`
   * itself early-returns at its very first line) — so the restart case's duplicate is CERTAIN once the
   * hold expires, not merely probable. Same shape, higher (P=1 vs P<1) probability — an improvement over
   * the pre-fix immediate-unconditional case, not a promotion to residual (1)'s own odds. `giveUpGen` and
   * `giveUpConfirmQueue` are deliberately NOT restored TOGETHER — restoring `giveUpGen` ALONE is inert (the
   * only reader is this purge, gated on a non-empty `giveUpConfirmQueue`, which a fresh restart never has)
   * — but restoring THE PAIR would let a fresh post-restart generation collide with a resurrected `gen`
   * (`live.submitGeneration` restarts from its own initial value, so a small restored `gen` will often
   * equal it) and cause THIS purge to delete a genuinely-unconfirmed entry: the silent-loss failure this
   * whole file exists to avoid. The underlying discriminator decision (RECOVERY-vs-SUPPRESSED) this purge
   * is a safety net FOR is untouched and stays `04de8bbf`'s open question; this card only narrows a wrong
   * decision's consequence, it does not eliminate it. (4) CR follow-up (card ccb407eb finding [B1-3]): a
   * cross-turn-boundary RE-MINT (`sessions/service.ts` `handleGiveUpExhausted`, on a durable message whose
   * `GIVE_UP_REQUEUE_LIMIT` was exhausted) stamps `giveUpHeldUntil` but NEVER `giveUpGen` — `enqueueStdin`
   * has no public parameter for it, and this purge's own correlation is entirely internal to PtyHost. A
   * false-negative give-up AT THE POINT OF BUDGET EXHAUSTION therefore yields a CERTAIN duplicate once the
   * re-mint's hold expires or a natural drain trigger fires — not merely probable like (1), and not bounded
   * by timing at all: this purge can NEVER find and remove that re-mint, at any hook latency, because it
   * was never enrolled in `giveUpConfirmQueue` to begin with. Deliberately left this way, not a gap to
   * close: per "fail toward a duplicate, never a loss" (88f11385), a certain duplicate here is the correct,
   * accepted trade against the pre-card behaviour (a certain, silent, permanent DROP at that same point) —
   * the same reasoning residual (3) already accepted for the restart case, one level up the give-up chain.
   * This residual list enumerates DAEMON-RESTART-shaped bypasses of THIS purge specifically, not every place
   * `giveUpHeldUntil` could apply — (4) above is the one exception, named here because it's this SAME
   * purge's own blind spot, not a carry-path bypass. CLOSED (card
   * f25bf3bf): the give-up hold's OTHER carry paths besides a daemon restart — recycle/successor handoff
   * (`SessionService.carryPendingToSuccessor` and its three callers) and the companion capability re-pin
   * respawn (`SessionService.upgradeCompanionCapabilities`) — were assessed and decided, each on its own
   * merits, following on from this card. `carryPendingToSuccessor` DELIVERS deliberately (no hold carried)
   * — a recycle spawns its successor FRESH with no `--resume`, so there is no shared transcript for a
   * re-delivered duplicate to confuse, and the purge could never fire there regardless. The companion
   * re-pin respawn PRESERVES the hold instead — it reconnects the SAME engine session via `--resume`, the
   * same shape as this restart path. See each site's own doc comment for the full reasoning; don't read
   * (1)-(3) above as "every daemon-restart-shaped bypass is covered" independent of this paragraph.
   *
   * THE GUARD BELOW (card 73d5c34a, code review follow-up): the FIFO-front correlation above assumes the
   * NEXT hook to arrive, whatever it is, most likely confirms the OLDEST still-ambiguous generation — true
   * when every generation since `gen` has ALSO given up (this method's own established cross-generation
   * case, still handled exactly as before). It stops being true the instant a genuinely FRESH, never-
   * ambiguous generation is issued (e.g. an unrelated inbound message taking `enqueueStdin`'s idle
   * immediate-submit path while `gen`'s requeued entry sits held) and that fresh generation confirms
   * quickly and normally: THIS hook almost certainly proves the FRESH generation's own turn, not `gen`'s —
   * yet unconditional correlation would still attribute it to `gen` and DELETE `gen`'s still-genuinely-
   * unconfirmed entry, a SILENT LOSS worse than the duplicate this whole file exists to avoid ("fail
   * toward a duplicate, never a loss" — a lost message is invisible to both sides; a duplicate is at least
   * visible and was, in fact, how this very card's specimen was caught). So: only run the DESTRUCTIVE
   * delete loop when `live.submitGeneration` is EITHER still `gen` itself (nothing new has been issued —
   * the common, single-ambiguity case) OR is itself present in `giveUpConfirmQueue` (the current
   * generation is ALSO an ambiguous give-up, i.e. the established cross-generation case) — otherwise a
   * demonstrably fresh, non-ambiguous generation has taken over, and this hook is left for it: `gen`'s
   * entry survives, un-purged, to resolve via its own bounded hold (a duplicate at worst) instead of being
   * deleted on a misattributed guess. The `turnEnded` shift is left UNCONDITIONAL either way — it only
   * ever discards BOOKKEEPING (which generation is "next to maybe-confirm"), never a `pending` entry, so
   * there is no data-loss risk in still advancing past `gen` even when this hook wasn't really about it;
   * leaving it un-advanced instead would leak `gen` in `giveUpConfirmQueue` forever once its entry has
   * already drained under some later identity.
   *
   * CARD 4a0af485 — CONTENT-MATCH RESOLUTION (closes residual (4) above, for the STILL-QUEUED population
   * ONLY; read the scope note below before assuming more than that): everything above this paragraph is
   * the PRE-EXISTING FIFO-POSITION fallback, UNCHANGED — it still runs verbatim whenever content matching
   * can't apply (see below). NEW: when the caller supplies `reportedPrompt` (the confirming hook's own
   * `hook.prompt` — only ever passed at the `UserPromptSubmit` call site; `Stop`/`StopFailure` hooks carry
   * no such field, so that call site is untouched and always takes the fallback below, exactly per
   * Requirement C — "no worse than today's behaviour" when a prompt is absent), THIS method first checks
   * `reportedPrompt`'s `{len, hash}` signature against EVERY entry in `Live.ambiguousDispatches` (keyed by
   * `logicalId`, not `submitGeneration` — see that map's own doc) and resolves ALL that match AND share ONE
   * `batchId` (see the card bc0774c4 paragraph below), not just the first — a coalesced drain (see
   * `requeueGiveUpOrigin`'s own doc) seeds several member logicalIds with the IDENTICAL joined signature
   * AND the same `batchId`, and a single confirming hook legitimately confirms all of them at once.
   * A match resolves the CORRECT generation(s) DIRECTLY, by CONTENT, instead of guessing from queue
   * position — this is what closes residual (4): a cross-remint re-mint (or an auto-joined manual resend,
   * see `hasAmbiguousMatch`) is now enrolled by `logicalId` regardless of whether
   * `giveUpConfirmQueue`/`giveUpGen` ever applied to it, so a late confirmation can find and purge it too.
   * Every purged entry ALSO fires its own `onDeliver` (Code Review CRITICAL finding, card 4a0af485) — a
   * splice alone leaves an unresolved durable row behind for an entry that was purged before ever being
   * handed off (the auto-joined resend, or a still-held cross-remint re-mint), permanently wedging the
   * `worker_report done`-guard and inviting a boot/live-flip redrive to re-deliver the very duplicate this
   * purge exists to prevent; idempotent for an entry whose hand-off (and thus `onDeliver`) already happened
   * before it ever gave up. A MISS (no `reportedPrompt`, or none of the tracked signatures match — e.g. the
   * map is empty, or the engine's echo isn't byte-identical to what Loom wrote; see `textSignature`'s doc)
   * falls straight through to the untouched fallback below — a false-negative MISS here is by construction
   * never worse than the pre-card behaviour, only ever a no-op improvement missed.
   *
   * CARD bc0774c4 — BATCH-PROVENANCE DISCRIMINATION (closes the residual THIS card's own body originally
   * documented as accepted, in the paragraph that used to sit where this one now does — "genuinely-
   * distinct-but-same-text is indistinguishable from coalesced-together by signature alone"): a signature
   * match can span MORE than one `batchId` whenever two GENUINELY DISTINCT give-up events happen to share
   * byte-identical text — no hash collision needed, P=1 once two such entries coexist (see `textSignature`'s
   * own doc). An age-based tie-break (purge whichever matched `batchId` is numerically smallest, i.e. the
   * OLDEST give-up) was tried and REJECTED: it is refutable by a concrete trace, not merely "usually right".
   * Consider batch A (older) and batch B (younger), both genuinely ambiguous and held, sharing a signature.
   * If B's OWN held entry redrains on its normal hold-expiry path — an ordinary, unremarkable event this
   * class already handles (see `isGiveUpHeld`/`GIVE_UP_HOLD_MS`) — it resubmits under a BRAND-NEW
   * `submitGeneration`, and when THAT resubmission's own hook confirms normally, the confirming hook's
   * content still matches BOTH A's and B's stored signatures (B's stale `ambiguousDispatches` entry is not
   * itself cleared by a plain successful resubmission — only an explicit purge clears it). An age-based
   * tie-break would purge A here — a message that was NEVER actually confirmed — while leaving B's own
   * (truly resolved) entry to linger unpurged. That is loss through a narrower door than the one this card
   * was originally carded for, not a fix. So: when a content match spans MORE than one `batchId`, this
   * method purges NONE of them — every matched entry is left exactly as it was, still genuinely ambiguous,
   * to be resolved later once the competing batch has separately resolved (making a future same-content
   * hook a single-`batchId` match again) or via its own bounded give-up hold. It still returns `true` (see
   * the method body) rather than falling through to the FIFO-position fallback below: that fallback is
   * CONTENT-BLIND (it purges by queue position alone) and running it here could purge a `live.pending` entry
   * whose text doesn't even match `reportedPrompt` — strictly worse than resolving nothing. Per this
   * project's own "fail toward a duplicate, never a loss" principle (88f11385): this is the unconditional-
   * safe choice over a heuristic that is right most of the time — worst case, both batches eventually
   * redrain on their own bounded holds and one becomes a genuine duplicate delivery; never a silently
   * resolved-and-dropped row.
   *
   * ⚠️ SCOPE — WHAT THIS DOES NOT CLOSE (Requirement D; state this precisely, per this project's own
   * "a comment is a claim" rule — a claim of "duplicates prevented" here would be exactly the false-
   * safety-by-omission shape that rule warns about): this purge only ever removes an entry that is STILL
   * SITTING, UNDISPATCHED, in `live.pending`. Once TWO full paste+Enter writes are ALREADY physically
   * sitting, validly formed, in the pty FIFO — e.g. the give-up's own in-session retry already fired before
   * this resolution could run — Loom cannot un-write either of them (the same "nothing downstream can
   * preempt an earlier write" invariant that refuted this card's original composer-clear hypothesis), and
   * the engine will read BOTH as genuinely separate turns once it catches up. This is an ACCEPTED residual,
   * not a gap to rediscover: DoD#2 (a re-send cannot deliver a duplicate) is closed for the common,
   * still-queued case a RED test can assert on — never claimed closed for the already-dispatched case.
   * (Code Review correction: an earlier draft of this same paragraph claimed the still-queued case was
   * closed BEFORE the `onDeliver` fix above existed — it was not: a splice with no `onDeliver` left the
   * durable row unresolved, so a boot/live-flip redrive brought the "purged" duplicate right back. The
   * claim above is accurate only as of the `onDeliver` fix landing alongside it, not before.)
   * `Live.ambiguousDispatches` is ALSO cleaned up on every resolution path — the content-match purge above,
   * the FIFO-position fallback's own purge below, and a `giveUpGen`-tagged entry's successful re-drain
   * (`drainPending`) — never left to linger past its own resolution (Code Review Major finding): a stale
   * entry that outlives its resolution can wrongly `hasAmbiguousMatch`-join a LATER, entirely unrelated
   * same-content directive, and a subsequent confirming hook would then purge THAT unrelated directive
   * instead — a real, undelivered-message LOSS, not merely a residual duplicate. See each cleanup site's
   * own comment; this is why the map's own doc no longer claims eviction "almost never" happens under the
   * count cap — cleaned up promptly, it commonly WILL stay near-empty, but that is a consequence of the
   * cleanup discipline, not an independent claim about how rarely sessions give up.
   */
  /**
   * Card b932558c: a CONFIRMED give-up — this generation's turn genuinely started, proven either by
   * `purgeConfirmedGiveUpRequeue`'s content-match branch or its FIFO-position fallback — is decisive
   * proof THIS generation's own composer content was submitted, not stranded. The daemon already acts
   * on that proof (purging the requeued duplicate right where this is called from); `composerDirtyLen`
   * contradicting it until some LATER, unrelated submit()'s own defensive clear-prefix happens to
   * confirm is the bug this closes — previously the ONLY clear path (`composerDirtyLenClearedByGen`,
   * gated on a fresh submit()'s own confirmation) never fired for a give-up resolved this way, since no
   * new submit() is involved: the ORIGINAL generation's own late-arriving hook is what confirms it.
   *
   * GATED on `composerDirtyMarkedForGen === gen` — only touch what THIS generation actually marked,
   * same discipline as the sibling clear-prefix gate. WHY A FULL RESET (not a partial subtract) IS SAFE
   * when the gate matches — NOT because `gen` is the SOLE contributor (`composerDirtyLen` is ADDITIVE
   * across stacked give-ups — see that field's own doc — so a later gen's mark can sit on top of an
   * older one's; "sole contributor" would be false on its face): every submit() UNCONDITIONALLY runs
   * its own defensive clear-prefix for whatever `composerDirtyLen` already held BEFORE its own paste
   * (see submit()'s own doc) — so `gen`'s OWN submission already attempted to backspace away every
   * OLDER stacked contribution, in the SAME ordered pty write, immediately ahead of `gen`'s own text.
   * For the content-match branch specifically, confirming `gen` means the engine's reported prompt is
   * an EXACT match for `gen`'s OWN pasted text alone — that could only be true if the preceding
   * clear-prefix genuinely landed: a botched clear would have left stray older text glued onto `gen`'s
   * paste, making the reported prompt diverge from `gen`'s clean signature, and this content-match
   * would simply never have fired (see this file's own "stray text glued onto a later submit"
   * specimens, card 3ce3fa39). So `gen`'s own exact-match confirmation is transitive proof of the
   * WHOLE preceding write chain, not just `gen`'s own slice — a full reset is correct. The
   * FIFO-position fallback (content-blind) does NOT carry this same transitive proof — it resolves by
   * generation position alone, with no verification of what was actually echoed — but that is exactly
   * the SAME trust level the PRE-EXISTING `composerDirtyLenClearedByGen` gate already accepted (it too
   * is satisfied by a bare Stop hook with zero content check), not a new gap this fix introduces.
   *
   * If a LATER, still-unresolved give-up has since re-marked the field (`composerDirtyMarkedForGen`
   * now pointing elsewhere), this confirmation is for an OLDER generation whose own clear-prefix chain
   * a NEWER submission has since superseded — leave `composerDirtyLen` untouched; the newer
   * generation's own eventual confirmation (following the exact same reasoning above) is what resolves
   * the rest.
   */
  private clearComposerDirtyOnConfirm(sessionId: string, live: Live, gen: number): void {
    if (live.composerDirtyMarkedForGen === gen) {
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} composerDirtyLen cleared at CONFIRMED (gen=${gen}) — decisive proof this generation's turn actually started, not stranded`);
      live.composerDirtyLen = 0;
      live.composerDirtyLenBelieved = 0; // card c148f118: a decisive confirm collapses both readings to the same true zero
      live.composerDirtyMarkedForGen = null;
    }
  }

  private purgeConfirmedGiveUpRequeue(sessionId: string, live: Live, turnEnded: boolean, reportedPrompt?: string): boolean {
    if (typeof reportedPrompt === "string" && reportedPrompt.length > 0 && live.ambiguousDispatches.size > 0) {
      const sig = textSignature(reportedPrompt);
      // Code Reviewer follow-up (card 4a0af485, Major 4): a COALESCED drain seeds MULTIPLE member
      // logicalIds with the SAME joined signature (see `requeueGiveUpOrigin`'s own doc) — a single hook can
      // therefore legitimately confirm more than one logicalId at once. Collect every match instead of
      // stopping at the first, or the other coalesced members' duplicates would survive unpurged.
      const matchedLogicalIds: string[] = [];
      for (const [logicalId, entry] of live.ambiguousDispatches) {
        if (entry.len === sig.len && entry.hash === sig.hash) matchedLogicalIds.push(logicalId);
      }
      if (matchedLogicalIds.length > 0) {
        // Card bc0774c4 (see this method's own big doc block, "CARD bc0774c4 — BATCH-PROVENANCE
        // DISCRIMINATION", for the full reasoning and the rejected age-based tie-break): a content match can
        // span more than one give-up `batchId` whenever two GENUINELY DISTINCT give-up events happen to
        // share byte-identical text — resolve ONLY when every match belongs to ONE batch (the coalesced
        // case, including every single-member batch); a match spanning more than one batch is left
        // COMPLETELY untouched rather than guessed at.
        const batchIds = new Set(matchedLogicalIds.map((id) => live.ambiguousDispatches.get(id)!.batchId));
        if (batchIds.size > 1) {
          // eslint-disable-next-line no-console
          console.log(`[submit] ${sessionId} AMBIGUOUS content match: ${matchedLogicalIds.length} logicalId(s) span ${batchIds.size} distinct give-up batches sharing this signature — cannot attribute by content alone, leaving ALL untouched rather than guess (fails toward a duplicate, never a loss)`);
          return true; // still "handled" by content — do NOT fall through to the content-BLIND FIFO-position fallback, which could purge an entry whose text doesn't even match reportedPrompt
        }
        for (const logicalId of matchedLogicalIds) {
          const entry = live.ambiguousDispatches.get(logicalId)!;
          const latencyMs = Date.now() - entry.writtenAt;
          // eslint-disable-next-line no-console
          console.log(`[submit] ${sessionId} CONFIRMED logicalId=${logicalId} latencyMs=${latencyMs} (content-matched — resolving any still-queued duplicate copies)`);
          live.ambiguousDispatches.delete(logicalId); // Major 2: resolved — never lingers to wrongly auto-join a LATER, unrelated same-text directive
          // Card 417cea0a: hand this same CONFIRMED signal to whoever's listening (sessions/service.ts) —
          // see `onGiveUpConfirmed`'s own doc for why PtyHost can't decide here whether it's news.
          this.events.onGiveUpConfirmed?.(sessionId, logicalId, latencyMs);
        }
        // Card b932558c: this batch's generation is now DECISIVELY confirmed — see clearComposerDirtyOnConfirm's
        // own doc for why this is the actual fix (the field must not stay dirty until an unrelated later
        // submit() happens to clear it). `batchIds.size` is exactly 1 here: `matchedLogicalIds.length > 0`
        // (the `if` this sits inside) guarantees at least one, and the `batchIds.size > 1` branch above
        // already returned before this point for the only other case — never 0, never more than 1.
        this.clearComposerDirtyOnConfirm(sessionId, live, [...batchIds][0]!);
        const matchedSet = new Set(matchedLogicalIds);
        for (let i = live.pending.length - 1; i >= 0; i--) {
          if (matchedSet.has(live.pending[i]!.logicalId)) {
            const [dropped] = live.pending.splice(i, 1);
            // eslint-disable-next-line no-console
            console.warn(`[submit] ${sessionId} GIVE-UP RECOVERY was a false negative (content-matched) — a confirming hook proves logicalId=${dropped!.logicalId}'s turn actually started; purged a still-queued duplicate (${dropped!.text.length} chars) instead of letting it double-deliver`);
            // CODE REVIEW CRITICAL FINDING (card 4a0af485): a splice alone removes the FIFO entry but never
            // resolves its durable `session_message_queued` row — `onDeliver` is PtyHost's ONLY channel for
            // that (see `QueuedMessage`'s own doc; `flushPending`/`drainPending` both fire it on every path
            // that removes an entry without actually submitting it, precisely so the boot-recovery scan and
            // the `worker_report done`-guard never re-drive it — see `flushPending`'s doc). Without this, an
            // entry purged HERE (never yet handed off — the auto-joined resend, or a cross-remint re-mint
            // still sitting held) leaves its durable row unresolved FOREVER (the done-guard's own query has
            // no time bound), permanently wedging `worker_report(done)`, AND a later boot/live-flip redrive
            // re-enqueues the exact duplicate this purge exists to prevent. Idempotent for an entry whose
            // onDeliver ALREADY fired at its own original hand-off (gen 1's own giveUpGen-tagged requeue,
            // say) — `resolveQueuedMessage`'s `isQueuedMessageDelivered` guard makes a repeat call a no-op.
            dropped!.onDeliver?.("duplicate-of-confirmed-original");
          }
        }
        return true; // resolved by content — do NOT also run the FIFO-position fallback below for this hook, and tell the caller not to ALSO attribute this hook to the current generation (it just proved this hook is about a DIFFERENT, older one)
      }
    }
    // FALLBACK — UNCHANGED pre-card FIFO-position logic (Requirement C: identical to today whenever
    // content matching didn't apply above).
    if (live.giveUpConfirmQueue.length === 0) return false;
    const gen = live.giveUpConfirmQueue[0]!;
    const genIsCurrentOrAlsoAmbiguous = live.submitGeneration === gen || live.giveUpConfirmQueue.includes(live.submitGeneration);
    if (genIsCurrentOrAlsoAmbiguous) {
      for (let i = live.pending.length - 1; i >= 0; i--) {
        if (live.pending[i]!.giveUpGen === gen) {
          const [dropped] = live.pending.splice(i, 1);
          // eslint-disable-next-line no-console
          console.warn(`[submit] ${sessionId} GIVE-UP RECOVERY was a false negative — a confirming hook proves generation ${gen}'s turn actually started; purged the requeued duplicate (${dropped!.text.length} chars) instead of letting it double-deliver`);
          // Card 4a0af485 Major 2: this generation's ambiguity is now resolved by THIS path too (not just
          // the content-match branch above) — clear its tracked signature, or a stale entry outlives its
          // own resolution and can wrongly auto-join / cross-purge a LATER, unrelated same-text directive.
          // This entry's own `onDeliver` already fired at its original hand-off, before it ever gave up
          // (see the content-match branch's own comment on this) — no additional resolution needed here.
          live.ambiguousDispatches.delete(dropped!.logicalId);
        }
      }
      // Card b932558c: same fix as the content-match branch above — this generation is now decisively
      // confirmed by the FIFO-position fallback too, so it should not have to wait for an unrelated
      // later submit() to clear composerDirtyLen (gated on `composerDirtyMarkedForGen` still naming
      // this gen — see clearComposerDirtyOnConfirm's own doc for why a full reset is safe there).
      this.clearComposerDirtyOnConfirm(sessionId, live, gen);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} GIVE-UP RECOVERY: a confirming hook arrived while generation ${gen} is still ambiguous, but generation ${live.submitGeneration} (a fresh, non-ambiguous submit) is now current — leaving generation ${gen}'s requeued entry un-purged rather than risk deleting a genuinely-unconfirmed message; it will still resolve via its own bounded hold`);
    }
    // Stop/StopFailure definitively closes this generation's ambiguity window — advance past it so the
    // NEXT hook (if any) correlates against whatever generation gave up after this one, not this one again.
    // Unconditional even when the branch above declined to delete anything (see the method doc): this only
    // discards bookkeeping, never a pending entry.
    if (turnEnded) live.giveUpConfirmQueue.shift();
    return false; // this fallback path never definitively attributes to a SPECIFIC generation by content — see the method doc
  }

  /**
   * §19c-b resume: re-submit the turn the usage cap killed (lastPrompt) once the reset passes. Goes
   * out via submit() (re-arms busy); the held pending queue then drains normally on the next Stop.
   * Returns false if the session isn't live (already stopped/killed → caller does not resume).
   *
   * Card 7edd420b: a PARKED (rateLimited) session is alive-but-idle, not dying — so an UNRELATED stop can
   * overlap it: a plain pty.stop() (live.stopping) or a companion upgrade's holdDrain window
   * (live.drainHeld, see that method's doc) can both be mid-flight the instant this fires (the 60s
   * rate-limit-watcher tick, or a human clearing the park via REST). Pre-fix this method guarded on
   * `alive` only, so it would write the replayed turn straight into that dying/held pty — a write that
   * races the kill, is never recorded in `pending` (so `flushPending` can't recover it), and is simply
   * lost. `blocked` closes that: when either flag is set, route the replay through `enqueueStdin` instead
   * of a direct `submit()` — the SAME queuing primitive `drainPending`'s own turn-starting site already
   * falls back to when it can't submit safely. That HOLDS the prompt in `live.pending` rather than writing
   * it into the pty, and a caller that's actively draining `pending` before the pty actually exits
   * (upgradeCompanionCapabilities's holdDrain loop is exactly this) recovers and redelivers it onto the
   * fresh pty after the respawn — preserving the turn instead of merely declining to lose it noisily. A
   * plain stop() with no such capture (drainHeld never set) still clears `pending` itself before anything
   * can recover it (see stop()), so the prompt CAN still be lost on that narrower path — but only ever as
   * a quietly-dropped queue entry, never by corrupting a dying pty's write.
   *
   * Card 81f9c887 (defense-in-depth, mirrors `enqueueStdin`'s own idle-submit gate re-checking rather than
   * trusting its caller): also guard on `live.busy`. The invariant `rateLimited ⇒ !busy` (rateLimited is
   * only ever set inside the Stop/StopFailure handler AFTER setBusy(false)) means a genuinely parked
   * session is never busy — so hitting this on a BUSY session only happens when a caller invokes it against
   * a session that was never actually parked (e.g. the per-session `POST /rate-limit/clear` REST route has
   * no server-side busy/parked guard of its own, and `live.lastPrompt` is set by ANY submit(), not just a
   * rate-limit kill). That's a caller error, not a real resume — replaying `lastPrompt` there would
   * re-submit it as a SECOND turn on top of the one already in flight (the exact double-turn hazard the
   * M1/M2 busy-gate ordering exists to prevent). Skip the replay entirely rather than queuing it: unlike
   * the stopping/drainHeld case, there is no genuinely-held turn here to preserve — queuing would just
   * deliver the same stale duplicate a moment later instead of on top of the live one.
   */
  resumeAfterRateLimit(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live?.alive) return false;
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): log EVERY invocation,
    // including the branch that ends up doing nothing (lastPrompt null, or busy true) — that silent-skip
    // branch previously left NO trace at all, which is exactly the gap that made the a3814193 incident's
    // caller unconfirmable from the daemon log alone. `wasRateLimited` records whether this call's own
    // precondition (the session was actually parked) held BEFORE we unconditionally clear it below — a
    // call arriving with `wasRateLimited=false` is the exact "caller invoked this on a session that was
    // never actually parked" hazard this function's own doc comment already names.
    // eslint-disable-next-line no-console
    console.log(`[rate-limit-resume] ${sessionId} invoked wasRateLimited=${live.rateLimited} busy=${live.busy} lastPromptLen=${live.lastPrompt?.length ?? 0}`);
    // UNPARK: drop the suppress flag FIRST so the re-submitted turn (and the post-resume Stop drain of the
    // held queue) can proceed. submit() re-arms busy, so the reconcile drain stays no-op until that turn ends.
    live.rateLimited = false;
    // Replay the killed turn WITH its original route (lastPromptRoute) so a rate-limited companion inbound
    // still replies to the channel it came from after the reset (§19c-b + companion route routing). Also
    // replay its lastPromptOwnerText so Primitive A's attestation survives the kill-and-resume too, and its
    // lastPromptProactive so a rate-limited heartbeat/reminder/alert turn's replayed chat_reply is still
    // tagged as proactive.
    if (live.lastPrompt != null && !live.busy) {
      const blocked = live.stopping || live.drainHeld;
      if (blocked) {
        this.enqueueStdin(sessionId, live.lastPrompt, "system", undefined, live.lastPromptRoute ?? undefined, "agent", undefined, live.lastPromptOwnerText ?? undefined, live.lastPromptProactive, live.lastPromptSenderId);
      } else {
        this.submit(sessionId, live.lastPrompt, live.lastPromptRoute ?? undefined, live.lastPromptOwnerText ?? undefined, live.lastPromptProactive, live.lastPromptSenderId, "rate-limit-replay");
      }
    }
    return true;
  }

  /**
   * Persist + broadcast the turn-in-flight flag, and track it locally. Idempotent.
   *
   * `reason` (card 1f74080a instrumentation, DIAGNOSTIC ONLY — no control-flow change) tags WHICH of the
   * several call sites flipped busy, so a future "duplicate delivery" incident can reconstruct the exact
   * busy-window from `[busy]` log lines alone instead of requiring an engine-transcript dig (the ONLY
   * reason the a3814193 incident's mechanism took two people and a JSONL cross-reference to pin down).
   * Every call site below is updated to pass one; there is deliberately no default, so a future new call
   * site can't silently go unlabeled.
   */
  private setBusy(sessionId: string, busy: boolean, reason: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const prevBusySince = live.busySince;
    live.busy = busy;
    live.busySince = busy ? Date.now() : null; // track the rising edge for the stuck-busy heal
    // eslint-disable-next-line no-console
    console.log(`[busy] ${sessionId} -> ${busy ? "true" : "false"} (${reason})${!busy && prevBusySince != null ? ` afterMs=${Date.now() - prevBusySince}` : ""}`);
    this.events.onBusy(sessionId, busy);
    this.broadcastControl(live, { type: "busy", busy });
  }

  /** Read the current permission mode off the tail of a session's output ring (the repainted footer). */
  private readFooterMode(live: Live): LandedMode {
    const recent = Buffer.concat(live.ring.chunks).toString("utf8").slice(-8192);
    return detectPermissionMode(recent).mode;
  }

  /**
   * GENERAL permission-mode convergence primitive (card f05e4897, generalized off resume-only in card
   * b99d3d67) — used by BOTH a fresh spawn and a `--resume` to drive the footer to an ABSOLUTE `target`
   * mode. Both boot at the gate-free acceptEdits mode (`--resume` honours `--permission-mode` and does
   * NOT restore the persisted mode; probe-verified on 2.1.163), so both need the SAME climb off that boot
   * default. Rather than cycle a fixed COUNT (unreliable — a dropped/mistimed press half-lands mid-cycle
   * and stays there; that was the FRESH path's old blind `sendModeCycles`, and the resume/summary-gate
   * path's original blind approach before this), drive the footer to `target` ABSOLUTELY: read the mode,
   * and while it isn't the target press ONE Shift+Tab and then WAIT for the footer to actually CHANGE
   * before deciding again — so a laggy repaint can never trick us into over-pressing past the target. The
   * per-step decision is the pure `nextCycleAction`; this method only supplies the timing + the footer
   * reads (the real-claude probe validates the live sequencing).
   *
   * BOUNDED + GRACEFUL — it NEVER infinite-loops and NEVER wedges boot: every terminating branch (reached
   * the target / hit the press cap / footer unreadable / a press didn't move the footer / pty gone) calls
   * `onDone` exactly once (markReady), so queued injections are released only AFTER the mode settles.
   * Total time is sized to finish well under MODE_CYCLE_FALLBACK_MS (card c469d54e — re-armed from
   * SessionStart; see its own doc) so the mode-cycle fallback can't fire mid-cycle. A give-up branch can,
   * in a rare worst case, leave the session resting in an intermediate
   * mode (incl. `plan`) rather than the target — `logLandedMode`'s role-gated auto-heal is the backstop
   * that catches a Loom-driven role (no `ExitPlanMode` tool) left stranded there; this primitive itself is
   * intentionally unchanged behaviour for the resume caller (do not add path-specific corrections here).
   *
   * SERIALIZED per session (card 9c03f5a6) via `Live.modeCycleChain`: every caller — the boot
   * convergence above, `logLandedMode`'s plan auto-heal, and `setPermissionMode`'s manager-driven
   * override — funnels through this one entry point, which QUEUES onto that chain rather than running
   * immediately. Two `cycleToMode` runs sharing one session's pty/footer would otherwise interleave their
   * Shift+Tab presses and footer reads (each mistaking the OTHER's press for its own registered change),
   * converging to whichever cycle's target happens to win the race — this is exactly how a
   * `worker_set_mode` call issued right after spawn (a natural pattern: push a freshly-spawned worker
   * straight into its working mode) could land on the BOOT cycle's own default target ("auto") instead of
   * the one actually requested. Queueing guarantees each cycle starts from a footer state no other cycle
   * is concurrently mutating.
   */
  private cycleToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
    const live = this.live.get(sessionId);
    if (!live) { onDone(); return; }
    const runQueued = (): Promise<void> => new Promise((resolveChain) => {
      this.runCycleToMode(sessionId, target, () => {
        onDone();
        resolveChain();
      });
    });
    // Chain off whatever is currently in flight for this session (never let a prior link's rejection
    // break the chain — runQueued itself never rejects, but stay defensive for any future caller).
    live.modeCycleChain = live.modeCycleChain.then(runQueued, runQueued);
  }

  /** The actual press-and-verify cycle loop, run EXCLUSIVELY (see cycleToMode's queueing above) — never
   *  call this directly; go through `cycleToMode`. */
  private runCycleToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
    let presses = 0;
    let finished = false;
    const finish = (reason: string, mode: LandedMode): void => {
      if (finished) return;
      finished = true;
      // eslint-disable-next-line no-console
      console.log(`[resume-mode] ${sessionId} cycle→${target}: ${reason} after ${presses} press(es) (mode=${mode})`);
      onDone();
    };
    // Decide on a freshly-read, settled mode: at the target → stop; out of presses → stop (leave as-is);
    // else press one Shift+Tab and wait for the footer to change before the next decision.
    const decide = (cur: LandedMode): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", cur); return; }
      const action = nextCycleAction({ current: cur, target, presses, maxPresses: RESUME_MODE_MAX_PRESSES });
      if (action === "done") { finish("reached", cur); return; }
      if (action === "giveup") { finish("press-cap", cur); return; }
      presses++;
      this.ptyWrite(sessionId, live, SHIFT_TAB, "shift-tab");
      setTimeout(() => awaitChange(cur, 0), RESUME_MODE_READ_POLL_MS);
    };
    // After a press, poll until the footer reads a definite mode DIFFERENT from `prev` (the press
    // registered), then re-decide. If it never changes within the cap, stop gracefully (don't risk an
    // overshoot by pressing again on a stale read).
    const awaitChange = (prev: LandedMode, polls: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", prev); return; }
      const cur = this.readFooterMode(live);
      if (cur !== "unknown" && cur !== prev) { decide(cur); return; }
      if (polls < RESUME_MODE_CHANGE_MAX_POLLS) { setTimeout(() => awaitChange(prev, polls + 1), RESUME_MODE_READ_POLL_MS); return; }
      finish("footer-unchanged", cur);
    };
    // Initial: the footer may still be painting when SessionStart fires — poll until it's readable, then
    // make the first decision off the real boot mode (never press blindly on an "unknown" read).
    const awaitReadable = (polls: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", "unknown"); return; }
      const cur = this.readFooterMode(live);
      if (cur !== "unknown") { decide(cur); return; }
      if (polls < RESUME_MODE_CHANGE_MAX_POLLS) { setTimeout(() => awaitReadable(polls + 1), RESUME_MODE_READ_POLL_MS); return; }
      finish("footer-unreadable", "unknown");
    };
    setTimeout(() => awaitReadable(0), MODE_CYCLE_SETTLE_MS);
  }

  /**
   * Resolve the resume-summary gate (see `isResumeSummaryGate`/`resumeGateCursorOption`) by pressing
   * Down EXACTLY ONCE and then CONFIRMING the ❯ cursor actually landed on option 2 "Resume full session
   * as-is" before ever sending Enter — replacing the old blind fire-and-forget Down+(150ms later)Enter
   * pair that caused the 2026-07-10 incident (a delayed/reordered Down under restart load let Enter
   * confirm the still-default option 1 "Resume from summary", silently compacting three managers' full
   * context simultaneously).
   *
   * Code-review catch on the first draft of this fix: a version that RETRIED the Down (re-pressing once
   * the current press's poll window elapsed unconfirmed) reintroduced the exact class of bug it was
   * meant to kill — if Down #1 was merely SLOW to render (not dropped), a retried Down #2 could land
   * right after, overshooting the cursor 1→2→3 and selecting "Don't ask me again" (worse than the
   * original bug: that persists the gate-disable AND still compacts this turn). So this presses Down
   * ONCE and never again for the normal path — the poll BUDGET is generous (RESUME_GATE_MAX_POLLS) rather
   * than the press being retried, which makes a two-Down-in-flight race structurally impossible.
   *
   * Defensive-only (should be unreachable with a single Down ever written): if the cursor is ever read at
   * option 3 anyway, this corrects with exactly ONE Up press (never a second Down) and keeps polling —
   * see the "3" branch below. NO path may confirm/Enter while the cursor reads "3": that would durably
   * persist "don't ask me again" (an ONGOING config change) on top of still compacting this one time,
   * which is a strictly worse outcome than the belt-and-suspenders give-up (still sends Enter — the
   * pre-fix behavior — but only when the cursor is NOT known to be sitting on 3).
   *
   * This is the belt-and-suspenders fallback, not the primary defense — see the caller's doc comment:
   * writeSessionSettings' env override is meant to keep this gate from ever rendering for a Loom-spawned
   * session, so this loop should rarely if ever actually run in production.
   */
  private resolveResumeGate(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.resumeGateHandled) return;
    this.ptyWrite(sessionId, live, DOWN_ARROW, "resume-gate-down");
    this.awaitResumeGateConfirm(sessionId, 0, false);
  }

  /** Poll (read-only — no further Down keypress) for the resume-gate cursor to confirm option 2 after
   *  the one Down press; see resolveResumeGate for the full rationale. `upCorrected` tracks whether the
   *  one-time defensive Up-correction (for an unreachable-in-normal-operation option-3 read) has already
   *  fired, so it can only ever happen once. */
  private awaitResumeGateConfirm(sessionId: string, polls: number, upCorrected: boolean): void {
    setTimeout(() => {
      const live = this.live.get(sessionId);
      if (!live?.alive || live.resumeGateHandled) return;
      const cursor = resumeGateCursorOption(collapseBoot(live.resumeGateScan));
      if (cursor === "2") {
        live.resumeGateHandled = true;
        live.resumeGateScan = "";
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} resume-summary gate CONFIRMED on "Resume full session as-is" after ${polls} poll(s)${upCorrected ? " (following a defensive Up-correction)" : ""} — Enter`);
        this.ptyWrite(sessionId, live, ENTER, "resume-gate-enter");
        return;
      }
      if (cursor === "3" && !upCorrected) {
        // Should be unreachable — this loop writes exactly one Down and never a second keypress on this
        // path. Correct with exactly ONE Up (not a Down retry) and keep polling; never confirm/Enter here.
        // eslint-disable-next-line no-console
        console.error(`[pty] ${sessionId} resume-summary gate cursor unexpectedly on option 3 ("Don't ask me again") — correcting with a single Up (never confirming on 3)`);
        this.ptyWrite(sessionId, live, UP_ARROW, "resume-gate-up");
        this.awaitResumeGateConfirm(sessionId, 0, true);
        return;
      }
      if (polls < RESUME_GATE_MAX_POLLS) {
        this.awaitResumeGateConfirm(sessionId, polls + 1, upCorrected);
        return;
      }
      // Genuine give-up: the one Down (± the one defensive Up-correction) never confirmed option 2 within
      // a generous budget — a real dropped keystroke (rare; PRIMARY-prevented by the settings env
      // override). NEVER send Enter while still reading option 3 — that would durably persist "don't ask
      // me again" on top of still compacting this turn, strictly worse than leaving the gate on screen.
      // Every other read (1, or unreadable) falls back to the pre-fix behavior (send Enter anyway) rather
      // than stranding an otherwise-recoverable gate forever.
      if (cursor === "3") {
        live.resumeGateHandled = true;
        live.resumeGateScan = "";
        // eslint-disable-next-line no-console
        console.error(`[pty] ${sessionId} resume-summary gate still on option 3 after the give-up budget — NOT sending Enter (would durably persist "don't ask me again"); leaving the gate on screen`);
        return;
      }
      live.resumeGateHandled = true;
      live.resumeGateScan = "";
      // eslint-disable-next-line no-console
      console.error(`[pty] ${sessionId} resume-summary gate cursor NEVER confirmed on option 2 after ${polls} poll(s) — sending Enter anyway (best effort; may resume from a summary)`);
      this.ptyWrite(sessionId, live, ENTER, "resume-gate-enter-giveup");
    }, RESUME_GATE_POLL_MS);
  }

  /**
   * Mark a (re)spawned session READY: its TUI has booted and (on resume) the permission-mode cycles
   * have landed, so injected turns are safe to submit. Releases anything queued during boot — e.g. the
   * daemon-restart continuation nudge that boot-recovery enqueues right after resume(), before the
   * engine is up. Idempotent. See Live.ready: `busy` is "turn in flight", `ready` is "engine booted".
   */
  private markReady(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.ready) return;
    live.ready = true;
    // Card c469d54e: cancel whichever readiness-fallback timer is still pending (the original spawn-armed
    // one, or the SessionStart-rearmed one — see Live.readyFallbackTimer's own doc) now that readiness is
    // ACTUALLY achieved, so it can't fire a redundant (harmless, but wasteful) late no-op call later. The
    // `live.ready` guard above means this whole function body runs AT MOST once per session, so this clear
    // can never be skipped by an early return on any call that reaches this line — there is only one.
    if (live.readyFallbackTimer) { clearTimeout(live.readyFallbackTimer); live.readyFallbackTimer = null; }
    // Card 25813ecc (fixes a live regression 0050a17e/b4fa85a4 introduced): capture the kickoff from
    // `live.startupPrompt` — the IMMUTABLE field seeded once at spawn() — BEFORE `drainPending` runs
    // below. `live.lastPrompt` is NOT safe to read here: `drainPending` calls `submit()` for any queued
    // message (a resume's queue is normally non-empty — companion/project-memory recall, redriven
    // undelivered messages, all enqueued before ready), and `submit()` unconditionally overwrites
    // `live.lastPrompt` with whatever IT is currently submitting. Reading `lastPrompt` AFTER that drain —
    // as this code used to — captured the DRAINED message instead of the real kickoff on a resume, and
    // scheduleKickoffGuarantee then redelivered it a second time. `startupPrompt` never receives such a
    // write (only submit() touches lastPrompt; nothing ever touches startupPrompt past spawn()), so
    // reading it is correct by construction, not by statement order — no future reordering of the lines
    // below can reintroduce this bug.
    const kickoff = live.startupPrompt != null && !live.firstTurnStarted ? live.startupPrompt : null;
    this.drainPending(sessionId); // deliver the first queued injection now that the composer is live (synchronous; see its own doc — never races logLandedMode's read, which only starts polling MODE_LOG_POLL_MS from now)
    // Card 0050a17e (Code Review catch #2): logLandedMode's footer read + role-gated plan auto-heal (its
    // own Shift+Tab writes) must SETTLE before the kickoff DELIVERY (the actual pty write) ever happens —
    // both READ the same ring buffer / WRITE to the same pty, and now that delivery fires on the next tick
    // (not after the old ~10s grace, which used to keep the two windows apart incidentally), running them
    // concurrently would let the kickoff's paste pollute the footer read (→ mode:"unknown" → the heal
    // silently never fires for a role stranded in `plan` with ExitPlanMode disallowed) or interleave the
    // heal's own Shift+Tab writes with the kickoff's writeChunked/Enter-retry chain (the frame-splice class
    // of cards 3ce3fa39/78a16dc5). Gating the DELIVERY (not the capture above) on logLandedMode's own
    // completion callback makes that ordering STRUCTURAL rather than incidental — true for 3 of
    // `runCycleToMode`'s 4 terminal branches (`reached`/`press-cap` fire only once `awaitChange` has
    // CONFIRMED the footer moved, so the last Shift+Tab is provably consumed; `pty-gone` is moot, nothing
    // will be pasted). ⚠️ The `footer-unchanged` branch (card c22f6cb8) is the exception: it gives up after
    // `RESUME_MODE_CHANGE_MAX_POLLS` polls with the just-written Shift+Tab still UNCONFIRMED, then still
    // calls `onDone` — so on that branch the ordering is best-effort, not structural: a queued Shift+Tab
    // can in principle still land mid-paste if the engine is stalled precisely across that give-up.
    this.logLandedMode(sessionId, () => { if (kickoff != null) this.scheduleKickoffGuarantee(sessionId, kickoff); });
  }

  /**
   * KICKOFF DELIVERY (card 0050a17e — formerly a "guarantee" racing the vendor CLI's own auto-submit of a
   * positional prompt; that race no longer exists, since no role's boot ever carries a positional prompt
   * any more — see buildSpawnArgs' own doc). This is now the PRIMARY delivery path for a fresh session's
   * first turn, not a fallback: `submit()` is the same reliable path every later turn (and the §19c-b
   * rate-limit replay) already uses, so routing turn 1 through it too removes a whole class of CLI-side
   * auto-type/auto-submit timing risk instead of racing it.
   *
   * Called exactly once per session from markReady (which itself only proceeds once, guarded by
   * `live.ready`) — `markReady` captures `kickoff` itself, synchronously, from the IMMUTABLE
   * `live.startupPrompt` field (see that field's own doc and card 25813ecc), and passes it in here as a
   * plain parameter — this function never reads `live.lastPrompt` itself, and `startupPrompt` is written
   * exactly once (at spawn()) and never again, so there is no "some other submit() has since overwritten
   * it" window to worry about here AT ALL — correct by construction, not by capture timing. Deliberately
   * still deferred by one further tick (`setTimeout(…, 0)`) past ITS OWN call site — by the time
   * markReady's caller (logLandedMode's `onSettled`) invokes this, real asynchronous work has already
   * happened (the mode-read poll, possibly a heal), so the extra tick here is defense-in-depth, not
   * load-bearing the way capturing `kickoff` from an immutable field is.
   *
   * Fires for EVERY startup-prompt spawn, not just a fresh worker_spawn: `live.startupPrompt` is seeded
   * from `opts.startupPrompt` at spawn (see spawn()), and recycleWorker/recycleManager/the platform-lead
   * recycle ALL pass a real handoff prompt through that SAME path (a fresh startup-prompt spawn,
   * deliberately not `--resume`, so the recycled session doesn't drag the old context forward) — so a
   * recycled session's handoff is delivered the same way. A run session's startup prompt
   * (composeRunStartupPrompt) rides the same path and is covered the same way.
   *
   * A no-op ONLY for resume and fork: neither ever passes `opts.startupPrompt` (a resume's continuation
   * is injected via enqueueStdin post-boot, not a startup turn — and boot-reconcile's resume path is
   * covered by the SAME resume mechanics, not this one), so `startupPrompt` stays null there and
   * markReady's own capture never calls this at all in that case — genuinely byte-identical now, since
   * `startupPrompt`, unlike `lastPrompt`, is never written by a resume's own pre-ready drain.
   */
  private scheduleKickoffGuarantee(sessionId: string, kickoff: string): void {
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.firstTurnStarted) return; // something else already started a turn on this SAME tick (see this function's own doc) — no-op
      // Card 78a16dc5 (mirrors resumeAfterRateLimit's card-81f9c887 fix): `firstTurnStarted` is set ONLY
      // by the UserPromptSubmit hook, which CAN be lost (see the Stop/StopFailure handler's own comment) —
      // so this can fire while a turn genuinely already ran and its Stop's own drainPending() just started
      // writing a QUEUED message. A direct submit() here would race THAT in-flight writeChunked chain —
      // its own staggered pty.write()s would interleave with this one's, splicing two different messages
      // together mid-word (the observed corruption).
      //
      // `busy` alone is NOT the right signal for "a write is genuinely in flight": it is ALSO true from
      // spawn()'s own OPTIMISTIC set (the common, intended case this delivery exists for — a fresh spawn
      // whose kickoff hasn't attempted to submit yet) with NO submit() ever having run — deferring on bare
      // `busy` would wrongly hold the kickoff in `pending` FOREVER in exactly that case, since nothing will
      // ever fire a Stop to drain it (worker-kickoff-guarantee.mjs's H1a/H1e/H1f pinned this regression).
      // The precise signal is `submitGeneration > 0 && !enterConfirmed`: `submitGeneration` only advances
      // inside submit() itself (never by the spawn-time optimistic setBusy), so `0` means "no submit() has
      // EVER run for this pty" (direct-write is unconditionally safe — nothing to race); `enterConfirmed`
      // is reset false at the TOP of every submit() and only flips true once that turn's Enter is verified
      // (UserPromptSubmit/Stop/StopFailure) — so `>0 && !confirmed` means "the most recent submit's
      // writeChunked chain may still be stepping, or is at least not yet verified done" — the actual
      // interleave hazard. `stopping`/`drainHeld`/`rateLimited` are separate, orthogonal reasons a direct
      // write is unsafe (a dying/held/parked pty) that submit() itself does not check.
      //
      // Either way, route through the SAME serialized primitive every other write uses when a direct write
      // isn't safe RIGHT NOW: enqueueStdin still GUARANTEES delivery (held FIFO, drained atomically at the
      // next safe boundary — never dropped), it just never races an in-flight write. kind:"agent" — this is
      // substantive directed content (the kickoff itself), not a bracket-tagged Loom nudge, so it drains
      // alone (not coalesced) and is exempt from the [loom:*] shape guard below (scoped to "warning" only).
      // Tolerated rare duplicate (CR-noted): if `rateLimited` is what makes this branch unsafe, resumeAfterRateLimit
      // will INDEPENDENTLY replay `lastPrompt` once unparked — and lastPrompt is USUALLY still this exact
      // kickoff (nothing else has submitted yet). That means the kickoff can be delivered TWICE (the
      // enqueued copy below, plus resumeAfterRateLimit's own replay) rather than lost — strictly better
      // than pre-fix (which could interleave/corrupt it), and rare enough (needs a lost UserPromptSubmit
      // hook AND a rate-limit park on the SAME never-confirmed turn) not to special-case further here.
      const submitOutstanding = l.submitGeneration > 0 && !l.enterConfirmed;
      if (submitOutstanding || l.stopping || l.drainHeld || l.rateLimited) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} ready with no turn started, but unsafe to write directly (submitOutstanding=${submitOutstanding} stopping=${l.stopping} drainHeld=${l.drainHeld} rateLimited=${l.rateLimited}) — queuing the kickoff for atomic delivery instead of racing an in-flight write`);
        this.enqueueStdin(sessionId, kickoff, "system", undefined, undefined, "agent");
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} ready with no turn started — submitting the kickoff`);
      // Code Review Major finding (card 0050a17e): this is a DIRECT submit() (mirrors resumeAfterRateLimit's
      // "rate-limit-replay", the OTHER direct caller `Live.giveUpOrigin`'s doc names) — historically its
      // `origin` was left undefined, since a lost give-up here was reachable only after the vendor CLI's
      // OWN auto-submit had already failed once. Now that this direct submit() is the PRIMARY delivery path
      // for EVERY spawn, an unconfirmed give-up (Enter never confirms within SUBMIT_MAX_ATTEMPTS — a real,
      // measured risk: pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` records
      // a 232-second confirmation lag) would otherwise DISCARD the kickoff with nothing to restore — give-up
      // is likeliest exactly for the large pastes this card exists to enable. A synthetic single-element
      // origin routes this write through the SAME requeueGiveUpOrigin recovery every enqueueStdin-originated
      // turn already gets: on a give-up, the kickoff is re-queued at the front of `pending` (held pending a
      // late confirming hook — see requeueGiveUpOrigin's own doc), not lost. `source:"system"`/`kind:"agent"`
      // mirror the enqueueStdin call in the branch just above (the "unsafe to write directly" sibling path),
      // which ALREADY gets a correct origin for free via drainPending's own `drained` array.
      //
      // Card a8f8a8f2: `onGiveUpExhausted` (card ccb407eb's hook — see `QueuedMessage.onGiveUpExhausted`'s
      // own doc) was left UNWIRED here — `GIVE_UP_REQUEUE_LIMIT` is 1, so a SECOND unconfirmed give-up on
      // this same kickoff took the residual bare-drop path `requeueGiveUpOrigin` documents (console.error
      // only), losing the entire task dispatch with nothing durable or visible surfacing it except the
      // generic idle-watchdog eventually noticing the idle, never-started session — slow and indirect,
      // not a signal at the exact seam that failed. Wired to `events.onKickoffGiveUpExhausted` (DB-agnostic,
      // same layering PtyHost already uses for `onGiveUpConfirmed`) so the higher layer can decide what to
      // do — card 7772176d: that is now a bounded re-mint before park+notify, not park+notify immediately;
      // see `SessionService.handleKickoffGiveUpExhausted`'s own doc for the current shape.
      // Card 00bd3b4a: `kickoffMsgId`/`kickoffLogicalId` captured into locals (not inlined twice) so the
      // give-up hook reports the EXACT SAME ids the QueuedMessage itself carries — this is what lets the
      // implementer record a durable "parked" event keyed to the same `rootMsgId` a later content-matched
      // `onGiveUpConfirmed` will report, closing the retraction gap `onKickoffGiveUpExhausted`'s own doc
      // describes.
      const kickoffMsgId = randomUUID();
      const kickoffLogicalId = randomUUID();
      this.submit(sessionId, kickoff, undefined, undefined, undefined, undefined, "kickoff-guarantee",
        [{
          id: kickoffMsgId, text: kickoff, source: "system", kind: "agent", logicalId: kickoffLogicalId,
          onGiveUpExhausted: () => this.events.onKickoffGiveUpExhausted?.(sessionId, kickoffMsgId, kickoffLogicalId, kickoff),
        }]);
      // Deferred one tick past this function's OWN call site (see this function's own doc) — defense in
      // depth, not load-bearing. Card 0050a17e.
    }, 0);
  }

  /**
   * OBSERVABILITY + defense-in-depth landed-mode auto-heal (card f05e4897 / b99d3d67 / 1658fc22 /
   * 9c03f5a6) — record, to the daemon log, what permission mode a (re)spawned session actually LANDED in
   * once it settled (mode-cycles/gate handling done + markReady), and — the auto-heal — if a Loom-DRIVEN
   * role with `ExitPlanMode` disallowed (any role `disallowedToolsForRole` disallows it for — worker,
   * setup, auditor, workspace-auditor, run, assistant) is found resting SOMEWHERE OTHER than its intended
   * boot target, drive it back onto that target via the SAME feedback-verified `cycleToMode` primitive the
   * main convergence path uses, not a single blind press.
   *
   * WIDENED (card 9c03f5a6) from a plan-only trigger to the explicit {@link HEALABLE_MODES} set
   * (plan|acceptEdits|default|bypassPermissions — every definite reading short of `auto`, `"unknown"`
   * excluded by construction): `plan` was always the one landed mode such a role can NEVER self-exit
   * itself (its `ExitPlanMode` tool is structurally removed at spawn, and Claude Code's own permission
   * engine additionally gates ANY non-read-only MCP tool call — incl. the role's own report-up channel —
   * behind an unanswerable "ask" while in plan), but the SAME give-up-mid-cycle worst case that could
   * strand a session in plan can just as easily strand it ONE STEP SHORT of the working target — e.g.
   * resting in `acceptEdits` (the boot cycle's very first press never registers, so `runCycleToMode` gives
   * up at the RAW gate-free boot mode) — which is the OTHER stall the owner named: an unattended role
   * sitting in a mode that hasn't earned an allowlist entry for the command it needs stalls on that
   * permission prompt exactly the same way. The heal's destination is the session's ACTUAL configured
   * target (`healTarget` below — the SAME `resumeModeTarget ?? modeAfterCyclesFromAcceptEdits(...)`
   * expression the main SessionStart convergence path computes), not a hardcoded `auto` — every
   * platform-default (`startupModeCycles:2`) session still converges there, but a project that deliberately
   * sets `startupModeCycles:0` (stay at the gate-free acceptEdits boot mode) is honoured on BOTH fresh
   * spawn and resume instead of resume alone getting force-cycled past its own target. `noCyclingConfigured`
   * below excludes a null-or-acceptEdits target rather than fighting that deliberate choice.
   *
   * A single blind corrective press would have the same drop risk as the failure it's healing (card
   * 1658fc22): if IT also drops under load, the session stays stranded with no further retry. Routing
   * through cycleToMode instead reads the footer and retries (bounded) until it reaches the target or the
   * pty dies, exactly like the main path — so a dropped press just costs one more poll, not a permanent
   * strand. This is a BACKSTOP, independent of cycleToMode's own convergence logic invoked from the main
   * SessionStart path (which stays unchanged for that caller — see cycleToMode's doc comment): it fires
   * off the mode ACTUALLY read from the footer, regardless of why the session ended up there. A
   * manager/platform session is structurally excluded (`disallowedToolsForRole` never puts `ExitPlanMode`
   * in their list — they may separately carry the task-tracking disallow, which this check ignores), so
   * this never fights a manager's legitimate, human-approved entry into plan mode (or any other mode).
   *
   * Best-effort + bounded: polls the ring (the existing rolling output buffer) a few times to let the
   * footer repaint into its final state, logs as soon as a mode is read (or gives up at the cap, logging
   * mode=unknown — no correction is attempted without a definite read), and corrects at most once per
   * session (modeLogged guard, claimed up front, so a repeat markReady never re-triggers the heal even
   * mid-cycle). Shells are excluded. `cycleToMode` is itself bounded (see its doc comment), so the whole
   * heal — this poll-for-a-read plus the cycle — stays comfortably under MODE_CYCLE_FALLBACK_MS (card
   * c469d54e; a heal's OWN cycleToMode call re-uses whatever fallback timer is already armed at that point
   * — it does not re-arm one itself).
   *
   * `onSettled` (card 0050a17e, Code Review catch): fires EXACTLY ONCE, on every terminal path (an early
   * return, the poll giving up at MODE_LOG_MAX_ATTEMPTS, a definite read with no heal needed, or a fired
   * heal's own `cycleToMode` completion) — never on the "keep polling" continuation. `markReady` gates
   * kickoff delivery on this callback so the kickoff's own pty write can never land WHILE this read (or
   * the heal it can trigger) is still in flight — both touch the same ring/pty, and interleaving them
   * either pollutes the footer read (→ a stranded-in-plan role's auto-heal silently never fires) or
   * splices the heal's Shift+Tab writes into the kickoff's own writeChunked/Enter-retry chain (the
   * frame-splice class of cards 3ce3fa39/78a16dc5). Every early-return path below still calls `onSettled`
   * — there is nothing left to gate on once this function has decided there's no read/heal to run.
   */
  private logLandedMode(sessionId: string, onSettled: () => void): void {
    const live = this.live.get(sessionId);
    if (!live || live.kind !== "claude" || live.modeLogged) { onSettled(); return; }
    live.modeLogged = true; // claim it once, up front — a repeat markReady won't re-schedule this
    const isResume = live.isResume;
    const role = live.role;
    // The heal's destination is the session's ACTUAL configured target, not a hardcoded "auto" — the
    // SAME expression the main SessionStart convergence path uses (see the `target` computed there), so
    // a project that deliberately configures NO cycling (startupModeCycles:0) converges to `acceptEdits`
    // on BOTH fresh spawn and resume instead of resume alone getting force-cycled past it to `auto`. A
    // resume always carries a definite `resumeModeTarget` (SessionService.resume derives it from the SAME
    // `startupModeCycles`, so `cycles:0` → `acceptEdits`, never `null`) — the fresh path is the one that
    // can genuinely have no target (`startupModeCycles:0` and no `resumeModeTarget`).
    const healTarget = live.resumeModeTarget ?? (live.startupModeCycles > 0 ? modeAfterCyclesFromAcceptEdits(live.startupModeCycles) : null);
    const noCyclingConfigured = healTarget == null || healTarget === "acceptEdits";
    let attempts = 0;
    const tryRead = (): void => {
      const l = this.live.get(sessionId);
      if (!l) { onSettled(); return; }
      attempts++;
      const recent = Buffer.concat(l.ring.chunks).toString("utf8").slice(-8192);
      const { mode, matchedToken } = detectPermissionMode(recent);
      // Keep polling only while we still can't read a footer at all (still booting). A definite read —
      // incl. the unlabeled "default" — is final. Stop at the cap or once the pty is gone.
      if (mode === "unknown" && attempts < MODE_LOG_MAX_ATTEMPTS && l.alive) {
        setTimeout(tryRead, MODE_LOG_POLL_MS);
        return;
      }
      const snippet = collapseFooter(recent).slice(-160); // short, ANSI-free evidence for the log
      // eslint-disable-next-line no-console
      console.log(`[resume-mode] ${sessionId} kind=${isResume ? "resume" : "fresh"} mode=${mode} matched=${matchedToken ?? "-"} footer=${JSON.stringify(snippet)}`);
      if (!noCyclingConfigured && healTarget != null && mode !== healTarget && HEALABLE_MODES.has(mode) && l.alive && disallowedToolsForRole(role).includes("ExitPlanMode")) {
        // eslint-disable-next-line no-console
        console.log(`[resume-mode] ${sessionId} auto-heal: role=${role ?? "-"} landed in ${mode} (ExitPlanMode disallowed) — cycling to ${healTarget}`);
        this.cycleToMode(sessionId, healTarget, onSettled);
        return;
      }
      // Card 2151f1db (visibility, NOT auto-correct): a role that is NOT excluded from ExitPlanMode —
      // manager, platform, a plain session — has no backstop above, by design (it may deliberately choose
      // plan, and it CAN self-exit). But the boot mode-cycle's own footer-read confirmation can fail under
      // host contention for this role exactly as it can for a healable one (see cycleToMode's doc: a
      // give-up branch can leave ANY role short of its target) — and unlike a deliberate choice, that
      // failure is currently silent: the session just discovers it later, indistinguishably from having
      // chosen the mode itself. `mode !== healTarget` (not just HEALABLE_MODES membership) is the real
      // mismatch test here, since — unlike a worker/setup/auditor role, whose target is always pinned to
      // "auto" regardless of project config — a manager/platform target could in principle itself be a
      // HEALABLE_MODES member (e.g. a project configured to land there deliberately), and that must not
      // false-positive as a mismatch. One-shot: `live.modeLogged` above already guards this whole function
      // to fire once per (re)spawn, so this never repeats mid-session.
      if (!noCyclingConfigured && healTarget != null && mode !== healTarget && HEALABLE_MODES.has(mode) && l.alive && !disallowedToolsForRole(role).includes("ExitPlanMode")) {
        // eslint-disable-next-line no-console
        console.log(`[resume-mode] ${sessionId} mode-mismatch-notice: role=${role ?? "-"} landed in ${mode}, configured target is ${healTarget} — notifying (no auto-correct for this role)`);
        this.enqueueStdin(
          sessionId,
          `[loom:mode-unconfirmed] Your permission mode settled at "${mode}" rather than the configured "${healTarget}" after boot — the mode-cycle's confirmation may have been dropped under host load, not necessarily a choice you made. If you're unexpectedly blocked from writes/tools, press Shift+Tab (or call ExitPlanMode) to cycle to your working mode.`,
          "system", undefined, undefined, "warning",
        );
      }
      onSettled();
    };
    setTimeout(tryRead, MODE_LOG_POLL_MS);
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    const live = this.live.get(sessionId);
    if (!live) return () => {};
    // Replay ring so a LATE attach sees a coherent screen, then stream live.
    const sb = Buffer.concat(live.ring.chunks);
    if (sb.length) sub.onData(sb);
    if (live.engineSessionId) sub.onControl({ type: "sessionId", id: live.engineSessionId });
    // Tell the new viewer the pinned grid so it sizes its xterm to match (info only — never resizes the pty).
    sub.onControl({ type: "geometry", cols: live.geometry.cols, rows: live.geometry.rows });
    if (!live.alive) sub.onControl({ type: "exit", code: null });
    live.subscribers.add(sub);
    return () => { live.subscribers.delete(sub); };
  }

  writeStdin(sessionId: string, data: string): void {
    const live = this.live.get(sessionId);
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): this is the ONE write path
    // with NO busy gate at all (by design — a real human must always be able to type) and the ONLY caller
    // is the gateway's raw websocket `{type:"stdin"}` relay (an attached client), so anything landing here
    // is either a genuine keystroke or something upstream mistakenly relaying non-human bytes through the
    // human channel. Threshold-gated (>20 chars) so this doesn't become a per-keystroke firehose — a lone
    // key is a handful of bytes; a pasted paragraph (the shape a stray report replay would take) is not.
    if (live && data.length > 20) {
      // eslint-disable-next-line no-console
      console.log(`[stdin-write] ${sessionId} busy=${live.busy} len=${data.length} head=${JSON.stringify(data.slice(0, 60))}`);
    }
    // Write the human's bytes to the pty FIRST — they must stay AHEAD of any held programmatic turn in
    // the pty's FIFO input stream. A box-freeing key (e.g. Enter) is a tiny chunk written synchronously
    // here, so a subsequent write is strictly behind that Enter in BYTE ORDER. Card 2521bf51: byte order
    // is NOT state-transition order — it says nothing about whether claude has actually PROCESSED the
    // Enter and cleared its own composer by the time a later write lands. See the drain gate below.
    this.writeChunked(sessionId, data);
    if (live) {
      // Track the human's UNCOMMITTED raw-terminal draft (composer-dirty) so a programmatic turn never
      // lands on half-typed text. We NEVER touch the human's bytes — we only HOLD delivery while dirty.
      const wasDirty = live.composerLen > 0;
      live.composerLen = nextComposerLen(live.composerLen, data);
      // Card 0f9268cc: the text-carrying twin of the composerLen update above — see Live.lastRawSubmit's
      // doc. A genuine Enter-submit freezes the composed text into lastRawSubmit for the paste-tripwire;
      // any OTHER free (Ctrl-C/kill-line/Esc/backspace-to-empty) just resets the accumulator, same as
      // composerLen, with no tripwire baseline captured (nothing will be recorded to the transcript).
      const draft = nextRawDraftState(live.rawDraftText, data);
      live.rawDraftText = draft.text;
      if (draft.submitted !== null) {
        live.lastRawSubmit = draft.submitted;
        // Card b4b9b707: same capture, SEPARATE field/lifecycle — see Live.pendingRawOwnerSubmit's doc.
        live.pendingRawOwnerSubmit = draft.submitted;
        live.pendingRawOwnerSubmitAt = Date.now();
      }
      // Card 2521bf51 (a human Enter never arms busy, so the drain races the turn it just started): a
      // box-free transition is EITHER a genuine SUBMIT (`draft.submitted !== null` — an Enter with a
      // non-empty draft) or a CLEAR (Ctrl-C/kill-line/Esc/backspace-to-empty — `draft.submitted === null`).
      // ARM ON `draft.submitted !== null` ALONE (code review Major 2) — NOT `wasDirty && composerLen===0`.
      // `draft.submitted` already requires a non-empty draft (`nextRawDraftState`'s own `text.length > 0`
      // gate), so it can never false-arm; the arming condition and the discriminator are now the SAME
      // fact. Gating on `wasDirty` too was the bug: a SINGLE chunk like `"abc\r"` accumulates its own
      // draft and frees the box within the SAME writeStdin call, so `wasDirty` (computed from
      // `composerLen` BEFORE this call) reads false even though this is a genuine submit — the whole
      // block used to be skipped, arming nothing, leaving that chunk shape fully unprotected.
      // A SUBMIT starts a REAL engine turn that Loom has NOT yet been told about — nothing arms `live.busy`
      // on this path (that only happens once claude's own `UserPromptSubmit` hook actually fires,
      // asynchronously, after it has genuinely processed the Enter). Draining here (directly, or via the
      // ~10s reconcile tick — see `humanSubmitHeldUntil`'s own doc for why the reconcile tick alone isn't
      // safe either) would write Loom's queued turn into a composer claude may still be transitioning out
      // of — the exact race this card fixes. So arm the bounded hold instead of draining; it self-clears
      // the instant a confirming hook arrives (deliverHook's UserPromptSubmit/Stop cases), letting the
      // ordinary Stop-path drain (the M2 window) deliver once the human's own turn genuinely completes —
      // DELAYED, never lost, even in the backstop-bound case where a hook is lost outright.
      if (draft.submitted !== null) {
        live.humanSubmitHeldUntil = Date.now() + HUMAN_SUBMIT_CONFIRM_HOLD_MS;
        // Card 3ff89cbc: snapshot whether an unrelated turn is ALREADY in flight right now — see
        // `humanSubmitHeldArmedDuringTurn`'s own doc for why this discriminates the pre-existing turn's
        // own Stop from the human's own turn's eventual confirmation.
        live.humanSubmitHeldArmedDuringTurn = live.busy;
      } else if (wasDirty && live.composerLen === 0) {
        // A CLEAR drains PROMPTLY, unaffected: there is no engine-side turn in flight for Loom to race,
        // so it's safe to skip the reconcile tick and deliver right away — byte-identical to the old
        // behavior for this arm. Still gated on `wasDirty` here (unlike the submit arm above) because
        // this only makes sense as a reaction to an actual dirty→clean TRANSITION — nothing to prompt-
        // drain for if the composer was never dirty to begin with.
        this.drainPending(sessionId);
      }
    }
  }

  /**
   * Write `text` to the pty in paced chunks. One big `pty.write` is truncated by Windows ConPTY's
   * input buffer (long worker reports / pastes arrived cut off), so split large writes and let the
   * console host drain between them. Keystroke-sized writes go in a single chunk; `done` fires
   * after the last chunk (submit() uses it to send Enter only once the whole turn has landed).
   */
  private writeChunked(sessionId: string, text: string, done?: () => void): void {
    const live = this.live.get(sessionId);
    // Card 9ed20572: `done` must fire on EVERY exit path, including this not-alive one — a caller
    // (healIfStuck's give-up clear) threads `setBusy(false)` through it, and a skipped `done` here
    // would leave `busy` stuck forever if the session was already dead when the burst was scheduled.
    // Card bb3d9005 (S1): also treat `killed` as an exit path — `alive` alone stays true through the
    // kill()→'exit' window (see Live.killed's own doc), and this is writeStdin's single choke point
    // (a real human's raw keystrokes, deliberately ungated on busy/stopping), so it's directly reachable
    // in that window.
    if (!live?.alive || live.killed) { done?.(); return; }
    if (text.length === 0) { done?.(); return; }
    let i = 0;
    const step = (): void => {
      const l = this.live.get(sessionId);
      // Same guarantee as above: the session died (or was killed) mid-burst — still fire `done` once.
      if (!l?.alive || l.killed) { done?.(); return; }
      const end = surrogateSafeChunkEnd(text, i, PTY_WRITE_CHUNK_UNITS);
      this.ptyWrite(sessionId, l, text.slice(i, end), "chunk");
      i = end;
      if (i >= text.length) { done?.(); return; }
      setTimeout(step, PTY_WRITE_CHUNK_DELAY_MS);
    };
    step();
  }

  repaint(sessionId: string): void {
    const live = this.live.get(sessionId);
    // Card bb3d9005 (S1): `alive` alone stays true through the kill()→'exit' window — see Live.killed's
    // doc. A viewer repaint landing in that window used to write to a destroyed socket and crash the
    // whole daemon; `!live.killed` closes it.
    if (live?.alive && !live.killed) this.ptyWrite(sessionId, live, "\x0c", "repaint-ctrl-l"); // Ctrl-L
  }

  stop(sessionId: string, mode: StopMode): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    // A Stop intent must NOT be defeated by a queued inbound turn re-arming busy. Mark the session
    // STOPPING (drainPending/enqueueStdin then refuse to submit a new turn) and CLEAR the held queue,
    // so a queued composer turn ("sends when turn ends") can't be drained by the very Stop hook the
    // interrupt fires — which used to re-arm busy and make stop take ~3 escalating clicks. Synchronous
    // field writes only (no await) → the M2 lower-busy→drain window in deliverHook is untouched.
    live.stopping = true;
    live.pending.length = 0;
    // Bump the generation so a still-pending sendEnterAndVerify chain from whatever turn was in flight
    // recognizes it's stale and bails — the `alive` guard alone isn't enough during the graceful window
    // (the pty stays alive through escalateGracefulStop), and a stray retry-Enter or give-up→setBusy(false)
    // during a deliberate stop serves no purpose. See Live.submitGeneration.
    live.submitGeneration++;
    if (mode === "hard") {
      // Card bb3d9005 (S1): set BEFORE kill() — see Live.killed's own doc. `alive` won't flip to false
      // until the async 'exit' event; `killed` closes the write-after-destroy race in that window.
      live.killed = true;
      live.pty.kill(); // TerminateProcess on Windows; node-pty's conpty kill path walks _getConsoleProcessList() to kill the tree (not a Job Object — node-pty@1.1.0 has none)
      return;
    }
    // graceful: double Ctrl-C exits an IDLE claude (resumable, clean) — and for an idle session this is
    // the whole story (it exits here; the escalation below is a no-op). A BUSY/mid-turn session instead
    // has its turn INTERRUPTED by the two Ctrl-Cs and stays alive at an idle prompt (no Stop hook fires,
    // so busy stays stale) — escalateGracefulStop is what then drives it deterministically to exit.
    this.ptyWrite(sessionId, live, "\x03", "stop-ctrl-c");
    // Card bb3d9005 (S1): also check `killed` here — this delayed resend runs concurrently with
    // escalateGracefulStop's own timers below, and ordinary setTimeout jitter can let it fire AFTER
    // stage 3's kill() has already flipped `killed` true while `alive` is still true (measured: caught by
    // this card's own regression test under real timer scheduling, not just reasoned about).
    setTimeout(() => { if (live.alive && !live.killed) this.ptyWrite(sessionId, live, "\x03", "stop-ctrl-c"); }, GRACEFUL_STOP_GAP_MS);
    this.escalateGracefulStop(sessionId, live);
  }

  /**
   * Deterministic graceful-stop escalation (see GRACEFUL_STOP_* for the why). Drives a BUSY/mid-turn
   * session — whose turn the initial double Ctrl-C only INTERRUPTED, leaving the pty alive — the rest of
   * the way to `exited`, so a graceful stop ALWAYS terminates and never leaves a "stopped" session live.
   *   • Stage 2 (RETRY): still alive → the turn has unwound to an idle prompt; re-send the exit sequence.
   *   • Stage 3 (KILL): STILL alive at the hard bound → a wedged turn that ignores Ctrl-C; hard-kill the
   *     pty (node-pty's conpty kill path, orphan-free — not a Job Object, node-pty@1.1.0 has none). This
   *     is the backstop that makes "graceful" deterministic.
   * Every timer captures the SAME `live` and guards on `live.alive` (write-gating timers ALSO check
   * `live.killed` — see Live.killed's own doc; card bb3d9005 S1 — since stage 3's kill() can fire while
   * an earlier stage's own delayed resend is still pending, and ordinary setTimeout jitter offers no
   * ordering guarantee between them), so once the pty exits (or its Live is REPLACED by a resume's fresh
   * spawn — the old object keeps alive=false forever) each timer is an inert no-op. It therefore can
   * NEVER kill a resumed session, and an IDLE stop (exited on stage 1) runs neither stage — its behaviour
   * is unchanged. The pty.kill goes through the same orphan-free path as a hard stop.
   */
  private escalateGracefulStop(sessionId: string, live: Live): void {
    // Stage 2: the interrupt didn't exit the process → re-send the exit sequence from the idle prompt.
    setTimeout(() => {
      if (!live.alive) return; // idle session already exited on the first sequence — nothing to escalate
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} graceful stop: still live after interrupt — re-sending exit sequence`);
      this.ptyWrite(sessionId, live, "\x03", "stop-escalate-ctrl-c");
      // Card bb3d9005 (S1): `killed` too — see the doc above this method.
      setTimeout(() => { if (live.alive && !live.killed) this.ptyWrite(sessionId, live, "\x03", "stop-escalate-ctrl-c"); }, GRACEFUL_STOP_GAP_MS);
    }, GRACEFUL_STOP_RETRY_MS);
    // Stage 3: a turn that ignores Ctrl-C entirely must still die — bounded hard-kill escalation.
    setTimeout(() => {
      if (!live.alive) return;
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} graceful stop: still live after ${GRACEFUL_STOP_KILL_MS}ms — escalating to hard kill`);
      // Card bb3d9005 (S1): same ordering as the hard-stop branch above — set BEFORE kill().
      live.killed = true;
      live.pty.kill();
    }, GRACEFUL_STOP_KILL_MS);
  }

  /**
   * REDIRECT interrupt (worker_redirect, the "land it NOW" steer): END a BUSY worker's current turn so a
   * freshly-enqueued redirect drains as the very next turn. Writes a SINGLE Esc — "stop generating, return
   * to the prompt" — GENTLER than stop()'s Ctrl-C×2 (which EXITS the process). Like the Ctrl-C interrupt,
   * an Esc-cancel fires NO Stop hook, so `busy` would go STALE (the same gap healIfStuck/escalateGracefulStop
   * cover); after a BOUNDED settle we SYNCHRONOUSLY setBusy(false) + drainPending in the SAME tick — exactly
   * like deliverHook's Stop branch (respecting the M2 window: NO await between the two) — so the redirect
   * that redirectWorker enqueued before calling us is delivered (coalesced) as the next turn.
   *
   * NO-OP unless there's a live, in-flight turn to interrupt: a dead/unknown session, a session already
   * `stopping` (a real stop must win — never fight it / re-arm busy past it), or an idle (busy=false) one
   * (nothing to cancel — redirectWorker submits the redirect as a normal turn for the idle case and only
   * calls us when the redirect was HELD, i.e. the worker was busy).
   *
   * The settle callback SNAPSHOTS busySince at interrupt time and bails if it changed — guarding the narrow
   * race where the worker's real turn ends NATURALLY (a real Stop drains the redirect and the worker starts
   * acting on it, re-arming busy with a NEW busySince) within the settle window: we must NOT then clobber
   * that live turn's busy. If it ended and stayed idle, our setBusy(false) is a harmless idempotent repeat.
   */
  interruptForRedirect(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.stopping || !live.ready || !live.busy) {
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} redirect: Esc NOT sent (nothing in flight to interrupt — alive=${!!live?.alive} stopping=${live?.stopping} ready=${live?.ready} busy=${live?.busy})`);
      return; // nothing in flight to interrupt
    }
    const busySinceAtInterrupt = live.busySince; // snapshot: a NEW turn (re-armed busy) updates this
    // We are deliberately abandoning this turn's Enter — bump the generation so a still-pending
    // sendEnterAndVerify chain for it recognizes it's stale and bails (never retry-Enters or
    // give-up→setBusy(false)'s into the cancelled prompt or whatever the redirect submits next). See
    // Live.submitGeneration.
    live.submitGeneration++;
    this.ptyWrite(sessionId, live, ESC_KEY, "redirect-esc"); // single Esc: cancel the in-flight generation, return to the idle prompt
    // eslint-disable-next-line no-console
    console.log(`[pty] ${sessionId} redirect: Esc sent — settling for ${REDIRECT_SETTLE_MS}ms`);
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.stopping || !l.ready) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle bailed (died / a real stop won / never readied)`);
        return; // died / a real stop won / never readied → drop the self-clear
      }
      if (!l.busy) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle no-op (a real Stop already cleared busy and drained)`);
        return; // a real Stop already cleared it (and drained) — nothing to heal
      }
      if (l.busySince !== busySinceAtInterrupt) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle bailed (a NEW turn started since the Esc — not clobbering it)`);
        return; // a NEW turn started since the Esc — do NOT clobber its busy
      }
      // No Stop hook fired on the Esc-cancel → clear the stale busy OURSELVES and drain the redirect in the
      // SAME tick (the M2 window: strictly no await between setBusy(false) and drainPending), mirroring the
      // Stop branch. finalizingTurn arms the same tripwire so a future async leak here is caught loudly.
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} redirect: settled — clearing stale busy and draining the redirect now`);
      this.finalizingTurn = true;
      try {
        this.setBusy(sessionId, false, "interrupt-for-redirect-settle");
        this.drainPending(sessionId);
      } finally {
        this.finalizingTurn = false;
      }
    }, REDIRECT_SETTLE_MS);
  }

  /**
   * Manager-driven ABSOLUTE mode override (worker_set_mode, card 610abe29) — the manual belt-and-suspenders
   * complement to `cycleToMode`'s automatic spawn/resume convergence and `logLandedMode`'s plan auto-heal:
   * lets a manager recover a worker stuck in (or deliberately push it into) a permission mode directly,
   * since a worker can never change its own mode itself (Shift+Tab is a human TUI keystroke; ExitPlanMode/
   * EnterPlanMode are disallowed for a worker). Reuses `cycleToMode` VERBATIM — same press-and-wait-for-
   * change feedback loop, same bounds — so a manual override behaves identically to the automatic paths;
   * this does not hand-roll its own keystroke cycling. `cycleToMode` itself now QUEUES onto the session's
   * `modeCycleChain` (card 9c03f5a6), so this override can never race the boot convergence / plan
   * auto-heal — it waits its turn and then cycles from an uncontested footer read. On top of that, this
   * wraps a bounded OUTER retry (`cycleToModeWithRetries`): a single cycleToMode pass can still miss the
   * exact target on a genuinely dropped keystroke, and the DoD is to keep retrying rather than accept a
   * neighbor mode on the first miss. Resolves with the FEEDBACK-VERIFIED landed mode read fresh off the
   * footer once cycling settles (which may still differ from `target` if every bounded attempt gave up —
   * the caller sees the truth, not an assumed success), or "unknown" if the session isn't live.
   */
  setPermissionMode(sessionId: string, target: LandedMode): Promise<LandedMode> {
    return this.cycleToModeWithRetries(sessionId, target, MODE_OVERRIDE_MAX_ATTEMPTS)
      .then((landed) => this.escapePlanIfStuck(sessionId, target, landed));
  }

  /**
   * Last-resort safety net (card 9c03f5a6 DoD) — a WORKING-mode request (acceptEdits|auto) must never be
   * reported as having left the worker resting in `plan`: a worker has no `ExitPlanMode` tool to self-exit
   * plan mode, so landing there is a silent STALL (can't edit) that wastes the worker's slot until a human
   * notices. If every bounded attempt in `cycleToModeWithRetries` still could not confirm the EXACT target
   * and the worker is resting in plan, make one more bounded push to `auto` (a single Shift+Tab away from
   * plan in the cycle order) — ANY safe working mode beats reporting "still in plan". A genuine
   * set-to-`plan` request, or a target that was already reached, passes through untouched.
   */
  private escapePlanIfStuck(sessionId: string, target: LandedMode, landed: LandedMode): Promise<LandedMode> {
    if (target === "plan" || landed !== "plan") return Promise.resolve(landed);
    return this.cycleToModeWithRetries(sessionId, "auto", MODE_OVERRIDE_MAX_ATTEMPTS);
  }

  /**
   * `setPermissionMode`'s bounded outer retry loop (card 9c03f5a6). Each attempt runs a full
   * `cycleToMode` pass (itself queued against any concurrent cycle) and re-reads the footer; a miss
   * re-attempts from that FRESH read (never reuses a stale one) until `attemptsLeft` is exhausted, so a
   * one-off dropped keystroke self-corrects instead of surfacing a non-target neighbor on the first try.
   * Stops immediately on an exact match or an "unknown" (dead session — retrying can't help). Bounded, so
   * a genuinely wedged footer still reports the honest landed mode rather than looping forever.
   */
  private cycleToModeWithRetries(sessionId: string, target: LandedMode, attemptsLeft: number): Promise<LandedMode> {
    return new Promise((resolve) => {
      if (!this.live.get(sessionId)?.alive) { resolve("unknown"); return; }
      this.cycleToMode(sessionId, target, () => {
        const live = this.live.get(sessionId);
        const landed: LandedMode = live?.alive ? this.readFooterMode(live) : "unknown";
        if (landed === target || landed === "unknown" || attemptsLeft <= 1) { resolve(landed); return; }
        resolve(this.cycleToModeWithRetries(sessionId, target, attemptsLeft - 1));
      });
    });
  }

  isAlive(sessionId: string): boolean {
    return this.live.get(sessionId)?.alive ?? false;
  }

  /** Whether a session's turn is CURRENTLY in flight — the same in-memory `live.busy` flag `setBusy`
   *  writes on every rising/falling edge (mirrored to the DB via `onBusy`, but read here directly with no
   *  DB round-trip). Card d88163b7: lets a caller that's about to force-interrupt a session (e.g. a
   *  companion capability upgrade) give an active turn a bounded chance to finish naturally first, instead
   *  of always cutting it off mid-generation. Returns false for a dead/unknown session — nothing is "in
   *  flight" there. */
  isBusy(sessionId: string): boolean {
    return this.live.get(sessionId)?.busy ?? false;
  }

  /**
   * Card d88163b7 (CR fix): suppress this session's drain surface — BOTH `drainPending`'s Stop-hook
   * auto-drain and `enqueueStdin`'s idle-submit path — until `releaseDrain` lifts it. For a caller that's
   * deciding WHETHER to interrupt a live session (e.g. a companion capability upgrade waiting out a busy
   * turn): without this, the turn ending (or a new message arriving) DURING that decision window can start
   * a fresh turn the caller's own subsequent `pty.stop()` then kills — invisible to `flushPending`, since
   * neither path ever leaves the message sitting in `pending` for it to recover. Holding the drain forces
   * anything that would start a turn to stay queued instead, exactly where `flushPending` CAN see it.
   *
   * DELIBERATELY a distinct flag from `stopping` (see `Live.drainHeld`) — `stopping` also means "this
   * session is being torn down" (`onExit` reads it to classify the death as intended), which is not yet
   * true here; the caller may still decide NOT to stop. A no-op for a dead/unknown session.
   *
   * The caller MUST pair this with `releaseDrain` — including on an abort/throw path — or this session's
   * drain stays suppressed forever (a worse wedge than the bug this exists to fix). Use try/finally.
   *
   * NOT RE-ENTRANT — `drainHeld` is a bool, not a counter, so an inner `releaseDrain` lifts an OUTER hold
   * wholesale. Safe today only because the sole caller (`CompanionController.upgrade`) serializes on a
   * single global reconcile chain, so two holds on the same session can never overlap. A future caller
   * that could nest holds would need a counter instead — don't add one speculatively; there is no such
   * caller today.
   */
  holdDrain(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) live.drainHeld = true;
  }

  /** Lift a `holdDrain` suppression. A no-op for a dead/unknown session (nothing to release) — safe to
   *  call unconditionally, including from a `finally` after the session died mid-hold. Does NOT itself
   *  re-trigger a drain: the caller that held it is expected to `flushPending`/decide next, exactly as
   *  `upgradeCompanionCapabilities` does immediately after releasing. */
  releaseDrain(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) live.drainHeld = false;
  }

  /** Epoch ms when this session's CURRENTLY LIVE pty process started, or null if it has no live process
   *  (never spawned, or exited). A resume/fork/recycle/companion-upgrade returns a fresh value (each goes
   *  through createPty). Read by the companion capability panel to decide whether a grant change is still
   *  pending a respawn to take effect (grant created AFTER this ⇒ not yet applied to the running process). */
  liveStartedAt(sessionId: string): number | null {
    const live = this.live.get(sessionId);
    return live && live.alive ? live.startedAt : null;
  }

  /** The OS pid of this session's own pty process, or undefined if it isn't live. Lets a caller that's
   *  about to reap OTHER processes rooted in this session's cwd (e.g. a pre-gate worktree sweep) exclude
   *  the session's own still-live process from that sweep — see {@link reapProcessesRootedInWorktree}'s
   *  `excludePids`. */
  getPid(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.pid;
  }

  /** Epoch ms of this session's last pty OUTPUT chunk (`Live.lastOutputAt`), or undefined if it isn't
   *  live. Distinct from the DB-persisted `lastActivity` (which only moves at turn boundaries — hook
   *  events): this advances on EVERY engine-output chunk, so it keeps moving THROUGH a single long turn
   *  and only goes stale once the engine truly stops producing — already fed to the busy-stale self-heal
   *  (see `healIfStuck`'s use of `lastOutputAt`); this getter just surfaces the same signal to a reader
   *  (worker_list/worker_status) so a manager can tell "busy + progressing" from "possibly wedged" without
   *  spending a worker_transcript pull. */
  getLastOutputAt(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.lastOutputAt;
  }

  /** Cumulative count of characters possibly still stranded in this session's composer from an earlier
   *  unconfirmed give-up/heal-if-stuck clear (`Live.composerDirtyLen` — see that field's own doc, card
   *  3ce3fa39), or undefined if the session isn't live. SET synchronously the moment a give-up/heal fires
   *  (no dependency on any later write); CLEARED via either of TWO independent, gated paths: a SUBSEQUENT
   *  submit()'s own defensive clear-prefix going on to CONFIRM (`composerDirtyLenClearedByGen` gates that
   *  reset), or — card b932558c — `purgeConfirmedGiveUpRequeue` itself proving THIS generation's turn
   *  actually started (content-match or its FIFO-position fallback; see `clearComposerDirtyOnConfirm`),
   *  with no new submit() required. So in the specific case this getter exists to catch (text written,
   *  never submitted, and NEITHER path above ever resolves it), the value stays non-zero and readable
   *  indefinitely rather than requiring a later write to become observable. Card dcd8659c: surfaced to
   *  worker_list/worker_status/my_context as a PULL read — this never touches
   *  `submit()`/`enqueueStdin`/`drainPending`/the pty; it only reads the same in-memory field those write.
   *
   *  ⚠️ Card c148f118 — READ THIS BEFORE trusting a non-zero value alone: this value is the CONSERVATIVE
   *  reading only — it NEVER assumes a defensive clear-prefix actually landed, so it stays inflated by
   *  whatever a still-unresolved clear attempt was trying to erase even if that clear genuinely worked.
   *  It therefore can NOT by itself distinguish "a clear was attempted and failed" from "a clear was
   *  attempted and worked, only the fresh write after it hasn't confirmed yet" — those two very different
   *  situations read as the exact same number here. `getComposerDirtyLenBelieved` is the OPTIMISTIC
   *  counterpart (assumes every attempted clear worked) — read the two together: equal means nothing to
   *  doubt, a gap means a clear is unresolved and the gap size is how much is in doubt. */
  getComposerDirtyLen(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.composerDirtyLen;
  }

  /** Card c148f118: the OPTIMISTIC counterpart to `getComposerDirtyLen` above (`Live.composerDirtyLenBelieved`
   *  — see that field's own doc for the full mechanics). Same undefined-vs-0 discipline: `undefined` means
   *  the session isn't live in this process, `0` is a genuine measured zero. Read ALONGSIDE
   *  `getComposerDirtyLen`, never instead of it: equal values mean no defensive-clear attempt is currently
   *  unresolved (nothing to doubt); a LOWER value here than `getComposerDirtyLen` means a clear WAS
   *  attempted and its outcome is still unverified — the gap is exactly how many characters are in doubt,
   *  bounding the truth between "the clear worked" (this getter) and "the clear did nothing"
   *  (`getComposerDirtyLen`) instead of the single, ambiguity-collapsing number either field gave alone
   *  before this card. Surfaced on worker_list/worker_status/my_context (mcp/orchestration.ts) alongside
   *  `getComposerDirtyLen` — that's the reader this getter exists for; see those tools' own descriptions
   *  for the same reading guide in their terms. */
  getComposerDirtyLenBelieved(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.composerDirtyLenBelieved;
  }

  /** Card a33a72f7: milliseconds elapsed since the CURRENT generation's first Enter write
   *  (`Live.currentGenFirstWrittenAt`), for as long as that write remains unconfirmed
   *  (`!Live.enterConfirmed`) — a PURELY ADDITIVE read of two fields `fireEnterAndVerify`/the
   *  `UserPromptSubmit` hook already maintain for `latencyMs` logging; nothing here writes, times out, or
   *  changes when Loom gives up. Exists to close the blind window named on this card: `composerDirtyLen`
   *  (above) only ever becomes non-zero once a give-up/heal-if-stuck actually FIRES — `FIRST_TURN_STALE_MS`
   *  (30s) or `GIVE_UP_HOLD_MS` (20s) plus retry time after the write — so a manager glancing at a worker in
   *  THAT window sees a `0` indistinguishable from a genuinely clean composer. This getter has no such
   *  floor: it reads non-null the INSTANT a write is outstanding and keeps counting every ms after.
   *
   *  Returns `undefined` if the session isn't live in this process (mirrors `getComposerDirtyLen`'s own
   *  undefined-vs-0 discipline). Returns `null` if nothing is currently outstanding — either no submit()
   *  has ever run, or the current generation already confirmed (`enterConfirmed === true`); these two are
   *  NOT distinguished from each other, deliberately: no manager decision turns on telling them apart, and
   *  conflating them costs nothing extra bad, unlike the ambiguity documented below.
   *
   *  ⚠️ WHAT THIS DOES NOT DISTINGUISH — read alongside `composerDirtyLen`, not instead of it:
   *  a non-null reading means ONLY "the current generation's Enter has been written and no confirming hook
   *  has landed for it yet." It stays non-null identically whether Loom is still WITHIN its own give-up
   *  budget (still retrying, or in `awaitGiveUpConfirmSettle`'s short window) OR has ALREADY given up for
   *  this exact generation (`fireEnterAndVerify`'s GIVE-UP RECOVERY/SUPPRESSED branches touch neither
   *  `enterConfirmed` nor `currentGenFirstWrittenAt` — only `composerDirtyLen`) — give-up firing does not
   *  make this field go null. So a large `unconfirmedDeliveryMs` alone never proves "still trying" vs.
   *  "already gave up, outcome still unknown" for THIS generation — cross-check `composerDirtyLen`: zero
   *  there while this reads non-null is the ONE case unambiguously new information ("in flight, this
   *  session has never given up at all yet"); non-zero there is ambiguous (may be THIS generation's own
   *  give-up, or stale residue from an earlier, already-superseded generation still awaiting its own
   *  confirm-driven clear — see `composerDirtyLen`'s doc). Together the two are still strictly MORE
   *  informative than either alone, which is the entire point of adding this rather than reworking that. */
  getPendingConfirmMs(sessionId: string): number | null | undefined {
    const live = this.live.get(sessionId);
    if (!live) return undefined;
    if (live.enterConfirmed || live.currentGenFirstWrittenAt === null) return null;
    return Date.now() - live.currentGenFirstWrittenAt;
  }

  /** Card 68459420: the most recent occurrence of this session's `[loom:prompt-mismatch]` notice being
   *  identified as a REPLAY of a prior generation (`Live.lastMismatchReplay` — see that field's own doc),
   *  or `null` if none has fired since this session went live, or `undefined` if the session isn't live
   *  in this process. This is the SENDER-directed arm of the notice: the recipient session can never
   *  verify a loss it never saw, so this getter exists to be read by the party who CAN — worker_list/
   *  worker_status, at the point its manager already looks — rather than relying solely on a longer
   *  session-facing notice. Never cleared once set (see the field's own doc for why); a subsequent
   *  occurrence overwrites rather than accumulates, so this always reflects the LATEST replay only. */
  getLastMismatchReplay(sessionId: string): Live["lastMismatchReplay"] | undefined {
    return this.live.get(sessionId)?.lastMismatchReplay;
  }

  /** Card f5f6515a DoD-4: the FUSED counterpart to `getLastMismatchReplay` above — see `Live.lastMismatchFusion`'s
   *  own doc for what it fires on (ANY confirmed composer-accumulation, no span cap — see that doc for why an
   *  earlier `spanGens.length <= 2` bound was removed) and why it's a separate field rather than widening the
   *  single-entry one. ⚠️ Its CONTRACT is DUPLICATION, not loss — see the field's own doc before reusing this
   *  language elsewhere; do not describe it as "re-send if this postdates your last message" (that is
   *  `lastMismatchReplay`'s contract, not this one). Same PULL-surface mechanics otherwise: `null` = none fired
   *  yet since this session went live, `undefined` = session not live in this process, never cleared once set,
   *  overwritten (not accumulated) by a later occurrence. */
  getLastMismatchFusion(sessionId: string): Live["lastMismatchFusion"] | undefined {
    return this.live.get(sessionId)?.lastMismatchFusion;
  }

  /** Card 59757189 DoD-1/3: the UNMATCHABLE counterpart to `getLastMismatchReplay`/`getLastMismatchFusion`
   *  above — see `Live.lastMismatchUnmatched`'s own doc for what it fires on (a mismatch that matched NONE
   *  of the recognized/confirmed shapes) and why it captures `intended` directly rather than relying on
   *  `recentWrittenTurns` (a bounded ring that rotates). Same PULL-surface mechanics otherwise: `null` =
   *  no unmatchable mismatch has fired yet since this session went live, `undefined` = session not live in
   *  this process, never cleared once set, overwritten (not accumulated) by a later occurrence. This is a
   *  DELIBERATE pull-only surface — nothing in this codebase currently pushes its content anywhere (a
   *  parent/manager delivery path is a separate, still-undecided question — see card 59757189's own
   *  DoD-2 note); reading it never has side effects. */
  getLastMismatchUnmatched(sessionId: string): Live["lastMismatchUnmatched"] | undefined {
    return this.live.get(sessionId)?.lastMismatchUnmatched;
  }

  /** Card c0323f8a — the durable PULL surface for `Live.lastMismatchNoticeSuppressed`: how many times, and
   *  under what signature, the EXACT-REPEAT SUPPRESSION guard (see the `UserPromptSubmit` case) has held
   *  back a byte-identical `[loom:prompt-mismatch]` resend instead of delivering it as a fresh turn. `null`
   *  = no suppression has fired yet this session, `undefined` = session not live in this process. Same
   *  PULL-surface mechanics as `getLastMismatchReplay`/`getLastMismatchFusion`: never cleared once set,
   *  overwritten (not accumulated as a struct — only its own `count` field accumulates, and only across
   *  repeats of the SAME signature) by a later occurrence. */
  getLastMismatchNoticeSuppressed(sessionId: string): Live["lastMismatchNoticeSuppressed"] | undefined {
    return this.live.get(sessionId)?.lastMismatchNoticeSuppressed;
  }

  /** Whether this session's first real turn has been CONFIRMED (`Live.firstTurnStarted` — flips true on
   *  the first `UserPromptSubmit` hook, see that field's own doc). Card 00bd3b4a: the discriminator
   *  `handleKickoffGiveUpExhausted` (sessions/service.ts) reads before treating an exhausted kickoff
   *  give-up as a genuine "nothing began at all" drop — Loom's own delivery-confirmation budget exhausting
   *  proves only that ITS confirmation is stale, never that the engine never received the write (see pinned
   *  memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`); a session already past its
   *  first confirmed turn is proof-by-construction that the kickoff was NOT dropped, whatever Loom's own
   *  give-up signal reads. `false` (never `undefined`) for a session that isn't live — not-live also means
   *  not-started, the correct read for that case too. */
  hasFirstTurnStarted(sessionId: string): boolean {
    return this.live.get(sessionId)?.firstTurnStarted ?? false;
  }

  private appendRing(live: Live, buf: Buffer): void {
    live.ring.chunks.push(buf);
    live.ring.bytes += buf.length;
    while (live.ring.bytes > RING_CAP_BYTES && live.ring.chunks.length > 1) {
      live.ring.bytes -= live.ring.chunks.shift()!.length;
    }
  }

  private broadcastControl(live: Live, e: TerminalControl): void {
    for (const s of live.subscribers) { try { s.onControl(e); } catch { /* ignore */ } }
  }
}

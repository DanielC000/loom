# 31f997e7 — capability-bound skill delivery is hygiene, not a security boundary

Card `31f997e7` adds a generic mechanism to `skills/inject.ts`: a bundled skill can be declared bound to
a capability slug (`CAPABILITY_BOUND_SKILLS`, a static map keyed by skill name), and is withheld from the
deliver-all default unless (a) the session's `cwd` is worktree-isolated (`isWorktreeCwd`) AND (b) the
session's resolved capabilities (`resolveProfileCapabilities`) include that slug. An explicit profile
`skills` subset still bypasses BOTH checks entirely, by design — see `509176c8`'s own record for why an
explicit subset is already a deliberate, human-attributable grant that isn't narrowed by any
ambient-default filter.

## CORRECTED (Code Review round 1, reviewer fa43d8a6): the shared-cwd residual was PERMANENT, not concurrent

The original version of this card gated purely on the capability grant, with no cwd check, and this
record originally described the resulting shared-cwd visibility as a benign, accepted residual. The
reviewer reproduced a permanent-orphan sequence that made that framing wrong:

1. Granted manager A injects `bound` into a shared cwd (`project.repoPath`) and claims it in the shared
   manifest.
2. A dies. Ungranted session B spawns at the same cwd; `injectSkills`'s `isSessionLive`-driven prune
   (card `9d73e537`) correctly drops A's now-dead manifest key. `bound` now sits on disk UNCLAIMED by
   anyone (`{"B":[]}`), and the "repo's own" skip (`exists && !myPrev.includes(name) &&
   !otherClaimed.has(name)`) reads it exactly like a pre-existing project-local skill nobody manages —
   because nothing in the manifest claims it anymore.
3. A resumes, still granted. Its own `myPrev` is empty (it's a fresh manifest entry for this generation)
   and `otherClaimed` doesn't have `bound` either — so the SAME "repo's own" skip fires for A too, and
   the stale copy is never re-claimed, never re-copied, never pruned, by ANY future session at that cwd,
   granted or not. The orphan is permanent.

This is reachable the moment `CAPABILITY_BOUND_SKILLS` is non-empty — before this card, deliver-all meant
every shared-cwd session claimed every skill every time, so no skill could ever go unclaimed this way.

## THE ROUND-1 FIX: worktree isolation, not grant alone

`passesCapabilityGate` (`inject.ts`) now additionally requires `isWorktreeCwd(cwd)` — cwd must be nested
under `WORKTREES_DIR`. Per that function's own doc: every worker (tasked or taskless) spawns/resumes/
forks/recycles with `cwd: worktreePath`, always under `WORKTREES_DIR`; every other role shares
`project.repoPath` as cwd, except "run" (a disposable snapshot, moot — a run session's `capabilities` is
hardcoded `[]`). A bound skill is now delivered only into a cwd no OTHER LIVE session can ever share, so
the permanent-orphan sequence above cannot start: step 1 never happens for a shared-cwd role, whatever
its grant.

Pinned in `skills-capability-bound.mjs`: a granted shared-cwd session does not receive a bound skill; a
granted worker in its own worktree does; the reviewer's (a)-(c) sequence is reproduced directly and shown
to never place the skill on disk at any step.

## CORRECTED AGAIN (Code Review round 2, reviewer 3e7c525e): isolation alone still orphans via WORKTREE REUSE

Round 1's framing — "exactly one session can ever own the copy" — was itself wrong. A worktree is not
single-use: `createWorktree` (`git/worktrees.ts`) reuses a RETAINED worktree (after `worker_stop` or a
rejected merge) when the SAME task is re-dispatched, possibly to a DIFFERENT agent with different grants.
`git reset --hard` never removes untracked `.claude/skills`. The reviewer reproduced this with real
`dist` (repro script referenced in the card discussion):

1. Granted worker A injects `bound` on worktree W.
2. A is stopped (W retained). The task is re-dispatched to ungranted worker B on the SAME worktree path
   W. B's own `injectSkills` call prunes A's now-dead manifest key (card `9d73e537`'s mechanism) — `bound`
   sits on disk unclaimed, the manifest reads `{"B":[]}`, and the "repo's own" skip treats it exactly like
   an unmanaged pre-existing dir from here on.
3. B resumes, still ungranted: never pruned, never re-claimed. The orphan is permanent, same shape as
   round 1's finding, just via REUSE of one cwd across sessions instead of concurrent sharing of one.

Fork and recycle were already fine: both reuse a worktree but carry their OWN resolved capabilities
forward (`sessions/service.ts`'s `capabilities: old.capabilities ?? []`), so they never hit this.

## THE ROUND-2 FIX: clean up a dead session's claims in an isolated cwd

When `injectSkills` prunes a dead session's manifest key (the `isSessionLive` mechanism, card `9d73e537`)
AND `cwd` is an isolated worktree, it now also removes that dead session's manifest-claimed dirs that no
LIVE session still claims. Scope, deliberately:

- Applies to ALL skills in that dead session's claim, not just capability-bound ones — a dead session's
  manifest entry is the only record of what IT placed there, bound or not.
- Never touches a dir NOT recorded in the dead session's own manifest entry — a user/repo dir is never in
  any session's manifest (see the "repo's own" skip), so it is never even a CANDIDATE for this cleanup.
  (Round 3, below, adds a SECOND, independent protection for a dir that WAS genuinely claimed.)
- Never applied to a shared cwd — that is card `f4e93dbf`'s harder, data-loss-sensitive scope. (A fork
  shares an isolated cwd with its still-live source, so "isolated" never meant "at most one live session
  — ever"; the SAME `otherClaimed` check that already protects a shared cwd's concurrent sessions
  protects a second live session at an isolated cwd too.)
- Reuses the SAME symlink-escape guard (the function's own early refusal) and the SAME direct-child-only
  `rmSync` discipline the existing stale-prune loop already applies — no new unguarded delete path.

Pinned in `skills-capability-bound.mjs`: the reviewer's exact A→stop→B(different grants, same worktree
path)→B-resume sequence now never places `bound` on disk after step 2; a SUBSEQUENT granted re-dispatch
to the same worktree still receives it, freshly copied; a user/repo dir in the same worktree survives the
whole sequence untouched; and the cleanup is shown firing for an ordinary, never-bound skill too (not
gated on `capabilityBindings` at all).

## CORRECTED AGAIN (Code Review round 3, reviewer 085065b7): "recorded as claimed" ≠ "still safe to delete"

The round-2 fix targeted the right bug, but being claimed is a fact about WHEN Loom placed a dir, not
about what's there NOW. The reviewer's probes (real `dist`, probe script referenced in the card
discussion) showed real destruction:

- (b) A worker hand-edits an injected `SKILL.md` and adds `notes.md` (both uncommitted). A dies; B
  arrives with a subset disjoint from the edited skill. The round-2 code deleted the WHOLE dir — edits
  included — because it was still recorded as A's claim and nothing else claimed it.
- (a2) A worker `git add -f`s an edit to an injected dir (or a merge/rebase brings in a tracked
  same-named skill). The SAME cleanup either deletes it or reverts the tracked content, with no git call
  anywhere in this sync path to notice.

The owner's standing rule is never to destroy a user's unfinished work; this cleanup path (new in round
2) was a genuine instance of exactly that, not a theoretical one.

## THE ROUND-3 FIX: a content fingerprint gates the delete, not the claim alone

1. `fingerprintSkillDir` records a sha256-based content fingerprint (over every file's path + bytes,
   sorted, recursively — never following a symlink/junction child) for every skill a session places,
   computed AFTER any Obsidian-fragment append — i.e. the FINAL bytes Loom actually left on disk.
2. Fingerprints live in a SEPARATE sidecar file, `.loom-skills-fingerprints.json` (`FINGERPRINTS_FILE`,
   `readFingerprintsFile`), never merged into the existing manifest's own on-disk shape — several other
   test files parse that file directly, and this keeps every one of them byte-for-byte unaffected. The
   sidecar needs no legacy-format handling at all (nothing pre-dates it): absent (an old worktree, or one
   this version hasn't written to yet) or corrupt both simply read as "no fingerprint for anything."
3. The round-2 cleanup now deletes a dead session's claimed dir ONLY when `fingerprintSkillDir(target)`
   at delete time matches ANY ONE of the fingerprints recorded by a dead claimant of that name (CR round
   4 — a `Map<string,string>` would have made the outcome depend on manifest key iteration order
   whenever two dead sids claimed the same name with different recorded fingerprints; a `Map<string,
   Set<string>>` of candidate fingerprints is order-independent, equally safe). Any REGULAR-FILE content
   change — a hand edit, an added file — fails that match and SKIPS the delete, logging it: an orphan is
   preferable to data loss. A claim with NO recorded fingerprint (a legacy pre-round-3 claim, or a
   fingerprint computation that itself failed at placement time) SKIPS too — "cannot verify" fails toward
   keeping, never toward deleting.
4. Scope, deliberately NARROW to the round-2 cleanup path only: the two PRE-EXISTING paths
   (copy-over-`myPrev`'s own re-copy, and the `myPrev` stale-prune loop below it) are UNCHANGED by this
   card. The same class of risk exists there too, for a SAME-SESSION resume overwriting its own earlier
   hand edit — a separate, already-filed card, not fixed here.
5. Named residual, honestly, NARROWED (CR round 4 nit — the original wording overclaimed "any
   divergence"): `fingerprintSkillDir` hashes only regular FILE bytes, recursively — it is BLIND to a
   symlink/junction CHILD added inside the dir (never followed, by design) and to an added EMPTY
   subdirectory, neither of which changes any file's content. A dir modified ONLY that way still matches
   its recorded fingerprint and is still deleted; the symlink's own target is never touched either way
   (`fs.rmSync` on a symlink removes the link itself, never follows it). Separately, a TRACKED dir whose
   content happens to be byte-identical to what Loom wrote can also still be deleted — the fingerprint
   matches, so nothing here distinguishes "Loom's own, untouched" from "tracked, but nobody has edited it
   since Loom placed it." Both show up as an unexpected (but git-recoverable, for the tracked case)
   deletion. There is no git call anywhere in this sync path (by design — this is filesystem bookkeeping,
   not a VCS integration), so neither case is, or can be, checked for before deleting.
6. CR round 4 MINOR: the dead-session scan now iterates the UNION of `claims`' and the fingerprints
   sidecar's own sids, not just `claims`' — a sid present only in the sidecar (its manifest key already
   gone some other way) is pruned from there too, instead of leaking in that file forever.

Pinned in `skills-capability-bound.mjs`: the reviewer's probe (b) (hand edit + extra file) survives
untouched; an untouched claim is still cleaned (round 2's own cases stay green); a legacy no-fingerprint
claim is kept; both orders of two dead sids claiming the same name with different fingerprints still
clean correctly (round 4's determinism fix).

## CARD `6db94dfe`: the SAME-SESSION-resume class (point 4 of "What remains") is now closed

Round 3 deliberately left the two PRE-EXISTING paths untouched (see the "Do not" list below): the
`want`-loop re-copy for a name already in `myPrev` (`copySkillAtomic`, unconditional whenever the "repo's
own" skip didn't fire), and the `myPrev`-vs-`want` stale-prune loop (`fs.rmSync`, unconditional). Both ran
with zero content check — a worker that hand-edited, added a file to, or had a merge/rebase replace, its
OWN injected skill lost that work on its own session's very next resume, exactly the same class of damage
round 3 had just closed for a DEAD session's claim.

**The fix (`inject.ts`), as it stands after the correction below (the ORIGINAL version of this paragraph
compared only against the calling session's own fingerprint — see "CORRECTED" below for why that was
wrong):** `fingerprintSkillDir`'s match logic was extracted into one shared helper,
`matchesRecordedFingerprint(currentFp, recorded, storeFallback?)`, now used by all four fingerprint-gated
write/delete decisions in this file (the two existing dead-claim sites, behaviour-preserving, plus the two
new same-session sites). Before the `want`-loop re-copy or the stale-prune `rmSync` touches a name already
in `myPrev`, the on-disk fingerprint is compared against `recordedFingerprintsForName(manifest,
fingerprints, name)` — the UNION of every CURRENT claimant's (mine, plus any live co-claimant sharing this
cwd) own last-recorded fingerprint for that name, read at the top of the call before this call's own write
overwrites anything. A mismatch against EVERY one of those skips the write/delete and logs, exactly like
the dead-claim cleanup; the name then drops out of `placed`/`fingerprints[sessionId]` for this call and is
never claimed (or touched) again, the same self-healing "becomes an ordinary unmanaged dir" outcome the
"repo's own" skip already gives an unclaimed dir.

**Refinement over the dead-claim policy (owner-reviewed): a legacy claim (no recorded fingerprint from any
current claimant) is not unconditionally kept.** Unconditionally skipping would permanently un-manage
every claim made before this fingerprint mechanism existed — which, for the SAME-session path (unlike the
dead-claim path), is the *common* case on this card's own first live deploy, not a rare transitional edge.
Instead: no recorded fingerprint anywhere ⇒ the write/delete proceeds ONLY if the on-disk content is
already byte-identical to what placement would ACTUALLY produce right now (`wouldPlaceFingerprint` — see
"CORRECTED" below for why this is NOT simply the raw store dir; nothing would be lost by proceeding); any
divergence still fails toward keeping. The two existing dead-claim call sites never pass `storeFallback`
and keep their exact pre-6db94dfe behavior (any unrecorded claim is kept, no store comparison at all) —
that policy is unchanged for THEM, deliberately; see the helper's own doc for why the two paths differ.

**Named residual carried forward, NOT fixed here:** the same git-tracked-but-byte-identical gap named in
round 3 (point 5 there) now ALSO applies to these two new sites — there is no git call anywhere in this
sync path, by design, so a dir that's become git-tracked (force-added, or replaced by a merge/rebase) but
happens to be byte-identical to what Loom last placed is still overwritten/pruned. Folded into "What
remains" below rather than re-stated as a new point.

**Deliberately out of scope, carded separately:** the `otherClaimed` re-copy — the WANT-loop branch that
fires when a name is in `otherClaimed` (another live session's claim) but NOT in `myPrev` (I've never
placed it myself) — still re-copies unconditionally with no fingerprint check of its own; that path is
untouched by 6db94dfe. **CLOSED by card `3b2a8707` — see the "CARD `3b2a8707`" section further down.**
⛔ **RETRACTED, see the correction below:** this paragraph originally also claimed
6db94dfe's own fix "gates purely on the calling session's OWN fingerprint... the conservative default,
consistent with every fail-toward-keeping check in this file." That was WRONG — it was never conservative;
comparing against only my own recorded value, in a shared cwd, FAILED TOWARD RELINQUISHING a still-needed
claim the moment a co-claimant legitimately refreshed the content, which a later prune could then act on.
See the correction section immediately below for the real mechanism and the fix.

Pinned in `skills-inject-same-session-fingerprint.mjs`: a hand-edited SKILL.md and an added file both
survive a same-session re-copy; a hand-edited name dropped from a narrowed subset survives the prune; an
UNTOUCHED resume still refreshes/prunes normally (no regression); a legacy no-fingerprint claim is
refreshed/pruned when byte-identical to what placement would actually produce, kept when it diverges —
see the correction below for the fuller, corrected coverage list.

## CORRECTED (Code Review on card `6db94dfe`, reviewer `cb4d6528`): the live-co-claimant case regressed data, and the legacy fallback compared the wrong bytes

**Finding 1 — MAJOR, blocking: a shared cwd with two LIVE co-claimants reproduced real data loss.**
Sequence (reviewer's `coclaim2.mjs` repro): A and B both claim `skill-a` in a shared cwd. The store
reseeds (`skill-a` v1 → v2). A resumes first and legitimately refreshes its own copy to v2, recording v2 as
ITS OWN fingerprint. B then resumes: the original fix compared the on-disk content (now v2, from A's
refresh) against ONLY `fingerprints["B"]["skill-a"]` — B's OWN last-recorded value, still v1 — a mismatch,
so B logged "hand-modified" and silently dropped its own claim on `skill-a`, even though nothing was ever
hand-edited; the only thing that happened was a LEGITIMATE refresh by a co-claimant. A then narrows its own
subset away from `skill-a`; its prune loop checks `otherClaimed`, which no longer lists B (B just
relinquished), so A deletes `skill-a` out from under B, which still wants and claims it in its own next
`want`. This is a regression THIS CARD introduced, not a pre-existing gap.

**The fix:** `recordedFingerprintsForName(manifest, fingerprints, name)` builds the full set of
fingerprints every CURRENT claimant of `name` (mine included, read from `manifest` — which already
excludes anyone `isSessionLive` pruned as dead earlier in the same call) actually recorded placing there,
and `matchesRecordedFingerprint` is called with THAT set instead of a singleton of just my own value — at
BOTH the re-copy site and the prune site. This mirrors the dead-claim cleanup's own any-of-set match
(`deadFingerprints`) for the identical reason: a shared cwd's on-disk content is whatever ANY live
co-claimant most recently and legitimately wrote, so "does this match what I, personally, last placed" was
always the wrong question in a shared cwd — the right question is "does this match what SOME live Loom
session placed."

**Finding 2 — the prune site's own legacy branch had no test:** a legacy claim (no recorded fingerprint
anywhere) that is byte-identical to the current store copy, and gets dropped from `want` on resume, must
still be PRUNED — the reviewer's mutant D (disabling that branch) survived the full suite because no test
exercised it. Added as its own case in `skills-inject-same-session-fingerprint.mjs`.

**Finding 3 — the legacy fallback compared against the wrong bytes.** `storeFallback` originally
fingerprinted the RAW, untransformed store directory. Real placement never delivers raw store bytes: it
runs `needsPermissionStrip`/`stripPermissionWideningFile` (strips a permission-widening construct from an
agent-written or unstamped skill) and, for a fragment-target skill with `obsidian.autoStart` on, appends
the Obsidian preflight fragment. A legacy, no-fingerprint claim of such a skill could be EXACTLY what real
placement would produce and still read as "diverged" against the raw store, permanently un-managing a
skill that was never actually touched by hand.

**The fix:** `wouldPlaceFingerprint(name, obsidianEnabled)` builds the SAME bytes real placement would, off
to the side under the OS temp dir (never the session's own cwd, never the real store): copy the store dir,
run the SAME `needsPermissionStrip`/`stripPermissionWideningFile` call, run the SAME obsidian-fragment
append when applicable, fingerprint the result, then unconditionally clean up. Returns null (fails toward
keeping, like every other branch here) when the store copy is missing or the strip would genuinely fail —
the same "undeliverable" outcome real placement treats as never fingerprinted at all. Lazy: only invoked
from `matchesRecordedFingerprint`'s `storeFallback` thunk, on the "nobody has a recorded fingerprint for
this name" branch — never on the ordinary hot path where a real recorded fingerprint already exists.

**Named residual — NOT closed, and genuinely cannot be from inside this mechanism:** a legacy copy that
was placed from an OLDER store version (one predating a later reseed) still matches NEITHER any current
claimant's recorded fingerprint (there isn't one — that's what "legacy" means) NOR what placement would
produce from TODAY's store (the store has since moved on) — it fails both halves of the gate and is kept,
permanently. There is no third comparison available: the only two Loom-authored states this mechanism can
ever reconstruct are "what a live claimant actually recorded" and "what today's store would produce right
now" — a byte-exact record of what some PAST store version produced was never captured and cannot be
recovered after the fact. **In a shared repo cwd this is not a per-session inconvenience — it freezes that
skill for every later session sharing the cwd, forever**, until a human manually intervenes (deletes the
stale dir, or edits/re-adopts it): every session's own placement attempt hits the identical two-way
mismatch and relinquishes the same way, so no session ever re-claims it, and the dir settles into the same
permanently-unmanaged state an ordinary user/repo skill occupies — except this one is stale Loom output,
not anything a human actually wrote.

**QUALIFIED (card `3b2a8707`, item 5), then CORRECTED (round 3 of the same card — see "What remains" point
5 below for the full correction): "no session ever re-claims it… forever" is true only once EVERY claimant
has relinquished — but a live claimant's `manifest` entry is NOT an independent anchor that survives
regardless of future checks.** `manifest[sessionId] = placed` is rewritten in full on every one of that
session's own calls, so its OWN next resume reruns the identical fingerprint gate against the same on-disk
content and can relinquish its own claim the exact same way a fresh co-claimant would — "currently claimed"
offers no protection by itself. See the "CARD `3b2a8707`" section below for the SEPARATE defect this
correction is downstream of: before that card, a
fresh session's `otherClaimed`-not-`myPrev` re-copy had no fingerprint gate at all, so it would blindly
overwrite (and re-claim) a name even while hand-edited content sat under a still-live claimant — the
opposite failure mode from the one this paragraph describes.

Pinned in `skills-inject-same-session-fingerprint.mjs`: the reviewer's two-live-co-claimant repro (a
store reseed between resumes never causes a false "hand-modified" relinquish, and a co-claimant's own
subset-narrowing prune never destroys a skill the OTHER co-claimant still claims); the missing legacy
prune-and-byte-identical case; a legacy claim that matches the TRANSFORMED (obsidian-fragment-appended)
bytes refreshes/claims correctly even though it diverges from the raw store; the same claim does NOT
false-match when `obsidianEnabled` is off (so the fragment legitimately wouldn't be there) — proving the
fallback reflects THIS session's own real settings, not a blind "does it look like it came from the store"
guess.

## CARD `3b2a8707`: the `otherClaimed`-not-`myPrev` re-copy (point 4's own named exception) is now closed

Card `6db94dfe`'s own "Deliberately out of scope" paragraph (above) named exactly one adjacent path it
left untouched: the WANT-loop branch that fires when a name is in `otherClaimed` (another live session's
claim) but NOT in `myPrev` (the calling session has never placed it itself) — a FRESH session claiming a
name for the first time, where some OTHER live session already claims it in this shared cwd. That branch
re-copied unconditionally, with no fingerprint check of its own: a live claimant's hand-edited (or
otherwise diverged) copy was overwritten the moment a second session wanted the same name.

**The fix (`inject.ts`):** the SAME gate 6db94dfe already built for the `myPrev` case now also covers this
one — `exists && (myPrev.includes(name) || otherClaimed.has(name))`, using `recordedFingerprintsForName`/
`matchesRecordedFingerprint`/`wouldPlaceFingerprint` completely unchanged. No new comparison logic was
needed: `recordedFingerprintsForName` already answers "does this match what SOME live Loom session
placed," not "does this match what I personally placed," which is exactly the right question for a
first-time claimant too.

**Claimed, but WRONG — the cross-variant co-claim question (see the correction immediately below):** this
section originally claimed two live sessions legitimately producing different bytes for the same name
(e.g. one has `obsidian.autoStart` on, the other off) could never freeze each other out, because
"whichever variant is currently on disk always matches SOME claimant's own entry." A Code Review on THIS
card found that claim false the moment the LAST session to write the dir has since died — see the
correction and fix below.

**Item 4 (nitpick, also fixed on this card):** `stripPermissionWideningFile`'s failure-path log used to
name the real `skillMd` path unconditionally — when reached from `wouldPlaceFingerprint`'s off-to-the-side
probe (a `loom-skill-wouldplace-*` temp dir), that read as a real, actionable delivery failure rather than
a scratch comparison. `stripPermissionWideningFile`/`applyPlacementTransforms` (the item-3 extraction,
below) now take an `isProbe` flag that only changes the log wording, never behavior.

**Item 3 (extraction, also this card):** the copy→strip→fragment-append sequence was duplicated between
the real placement loop and `wouldPlaceFingerprint`'s probe. `applyPlacementTransforms(name, dir, fragment,
isProbe?)` now holds that sequence once; both callers keep their own copy step (`copySkillAtomic`'s
atomic/retried real delivery vs. `wouldPlaceFingerprint`'s plain scratch `cpSync`) and their own decision
about whether/how to even obtain a `fragment` to pass in — the extraction is behaviour-preserving.

## CORRECTED (Code Review round 2 on card `3b2a8707`): the widened gate reopened a FALSE FREEZE the pre-card unconditional re-copy never had

The round-1 fix above gates on `recordedFingerprintsForName` — every CURRENT (live) claimant's own
per-session recorded fingerprint. That set is built from `manifest`/`fingerprints`, which the dead-session
prune (above, in `injectSkills`'s own top section) has ALREADY deleted entries from by the time this gate
runs. So the moment the LAST session to actually write the dir dies before anyone else refreshes it, the
only per-session record of those exact (genuinely untouched) bytes is gone — and the gate now reads
untouched Loom content as unverifiable, indistinguishable from a real hand edit.

**Repro (two independent shapes, both real):**
1. **`otherClaimed` branch:** A places v1 → the store moves to v2 → C (a fresh co-claimant) first-claims
   and refreshes to v2 → C dies → B (another fresh co-claimant) first-claims: on-disk is v2, but the only
   recorded fingerprint left is A's stale v1 → mismatch → B refuses, never claims. A's own next resume
   also mismatches the same way and relinquishes (`continue` before `placed.push`) — the dir ends up
   claimed by NOBODY and, from the very next call onward, reads exactly like an ordinary unmanaged repo
   dir (the "repo's own" skip fires for everyone, forever).
2. **`myPrev` branch, the pre-existing variant case:** A (obsidian on) places its fragment-appended
   variant → B (a fresh co-claimant, obsidian off) first-claims and overwrites with its OWN fragment-free
   variant, recording B's own fingerprint → B dies → A's OWN resume: on-disk is B's variant, but the only
   recorded fingerprint left is A's OWN stale (fragment-appended) one → mismatch → A relinquishes its own
   claim (`A=[]`).

**Critically, on main BEFORE this card, shape 1 healed itself:** the `otherClaimed` branch's unconditional
pre-card re-copy meant B would overwrite (a no-op, since content was already v2) and, in doing so,
UNCONDITIONALLY record its own fresh fingerprint for whatever was already there — bootstrapping a new,
live per-session record for content nobody currently had one for. Gating that re-copy (round 1 of this
card) removed the unconditional write that used to do this healing, without replacing what it implicitly
provided.

## THE ROUND-2 FIX (card `3b2a8707`): a daemon-local registry, plus an unconditional last-resort fallback

`recordedFingerprintsForName` now unions in `loomPlacedFingerprintsByCwd` — the daemon-side registry
(`inject.ts`, keyed by `(cwd, name)`, never by session id) that already tracks the latest bytes THIS
DAEMON PROCESS itself most recently placed for a name in a cwd, for the cwd-skill permission scan's own
trust decision (card `015fdb23`). That registry is NEVER cleared on a session's death — only on an LRU
eviction or a daemon restart — so as long as the daemon process that did the actual writing is still the
one running, the registry still vouches for content a dead session's own manifest/fingerprints entries no
longer can. This single change, applied inside the ONE shared helper both the `myPrev` and `otherClaimed`
branches already called, closes BOTH repro shapes above at once — no per-branch special-casing needed.

Separately, `matchesRecordedFingerprint`'s `storeFallback` (the `wouldPlaceFingerprint` thunk) used to run
ONLY when `recorded` was entirely empty. It now runs whenever nothing in `recorded` already matched —
whether `recorded` was empty, or non-empty but every entry was stale. "A recorded set exists but is stale"
and "no recorded set exists at all" are the same "nothing here vouches for this content" case from this
function's own point of view, and an overwrite that turns out byte-identical to what's already there loses
nothing either way.

**Residual at this round (CLOSED by round 3 below, for any name a live session still claims at the moment
a dead session's claim is discovered and pruned):** the registry is in-process daemon memory. After a
DAEMON RESTART it is empty, so the fix above degrades to the `wouldPlaceFingerprint` fallback alone, and a
name can still freeze — reproduced directly by test cases (19)/(20) below. See "THE ROUND-3 FIX" below for
the persisted `lastPlaced` carry-forward that closes it, and "What remains" point 5 for the one residual
that survives even after round 3.

Pinned in `skills-inject-same-session-fingerprint.mjs`: cases (12)/(13) (a fresh claimant's first-time
`otherClaimed` re-copy respects a live claimant's hand edit, and still succeeds normally when untouched),
(14) (a cross-variant co-claim where neither co-claimant has died — see the correction above for the
case where one does), (15) (the exact mutant-killing recipe for `wouldPlaceFingerprint`'s own strip step —
a real agent/unstamped hazard skill's REAL probe-generated stripped bytes, planted as a legacy claim, must
still match), (16) (`wouldPlaceFingerprint`'s undeliverable `return null` branch, via card `712148f1`'s own
flow-mapping-form hazard), (17) (repro shape 1 above: the `otherClaimed` branch, last writer dies, a fresh
co-claimant AND the original claimant's own resume both still succeed), and (18) (repro shape 2 above: the
`myPrev` branch, same shape, same fix).

## THE ROUND-3 FIX (card `3b2a8707`, same card, later round): the carry-forward now survives a daemon restart

Round 2's daemon-local registry (`loomPlacedFingerprintsByCwd`) survives a dead session's own manifest
prune, but only for the lifetime of the daemon PROCESS that did the writing — it is plain in-memory state,
never written to disk. A daemon restart between a session's death and the next resume/claim empties it, and
the fix degrades back to `wouldPlaceFingerprint` alone — which cannot rescue a case where the store has
moved on a SECOND time since the dead session's own write (test case (20) below), reopening the exact
freeze round 2 had just closed, now gated on daemon uptime instead of session liveness.

**The fix:** `injectSkills`'s existing dead-session prune (the loop that deletes `manifest[sid]`/
`fingerprints[sid]` for any sid `isSessionLive` reports dead, collecting what it claimed into
`deadClaimed`/`deadFingerprints` before deleting) now also calls `carryDeadFingerprintsForward` immediately
after that prune, in the SAME call that discovers the death — i.e. whenever the daemon first notices the
session is gone, which may be long after the session actually died. For every name `deadFingerprints`
collected, if that name is STILL claimed by some live session right now (`myPrev` ∪ `otherClaimed`,
computed post-prune — `stillLiveClaimed`), the dead claimant's fingerprint(s) for it are written into a
new reserved top-level key in the `FINGERPRINTS_FILE` sidecar, `__lastPlaced` (`LAST_PLACED_KEY`): `name ->
string[]` of every fingerprint a dead session's prune has carried forward for it. `recordedFingerprintsForName`
unions this set in alongside the manifest/fingerprints and in-process-registry sets, so a dead session's
last-known-good content is available to the fingerprint gate across a restart, not just within one daemon
process's lifetime.

**Semantics, as of Code Review round 4 (corrected — see the "CORRECTED (Code Review round 4...)" section
below for why the original REPLACE semantics were wrong):** each call MERGES this pass's own fps into
whatever `lastPlaced[name]` already held — this pass's own fps go first, then whatever survives from the
existing entry — then truncates at `LAST_PLACED_MAX_FPS_PER_NAME` (8) per name. **"First" is
PRUNE-DISCOVERY order for THIS call, never placement-age (Code Review round 5 correction — see "Item 2"
in that round's own section below):** it is `Set` insertion order over whichever dead sids this pass's
scan happens to visit first, so a long-lived session's own fingerprint, however old, can rank ahead of
fresher content already in `existing`; a fp re-discovered this pass that was already in `existing` moves
to the front too. Truncation evicts whatever ranks last in THIS pass's own order, which is not always the
genuinely oldest entry — and if a single pass alone discovers `>= LAST_PLACED_MAX_FPS_PER_NAME` distinct
fingerprints for one name, `existing` is evicted in full. Either shape only ever moves a GENUINE
Loom-placed fingerprint out of the set, so the failure mode is always toward FREEZE, never toward an
unsafe overwrite. A name this call's prune didn't touch is left exactly as it was. Never written
for a name NO live session claims at the moment of the carry — that is deliberately left to card
`f4e93dbf`'s own pending-reclaim mechanism (a shared cwd) or resolved immediately, in that same call, by
the isolated-cwd dead-claim deletion path above (which already has `deadFingerprints` to hand and never
needs cross-call persistence at all); this one is not meant to duplicate or interfere with either.

**This adds no new trust tier.** A live sid's own `fingerprints[sid][name]` was already read straight from
this same `FINGERPRINTS_FILE` sidecar before this fix (and before this card's round 3 ever existed) —
`lastPlaced` persists the identical, already-trusted kind of value (a fingerprint a real Loom placement
actually recorded) past the owning sid's own death, nothing more. The sidecar's existing fail-toward-empty
posture (absent or corrupt reads as "nothing recorded") covers `lastPlaced` too — `sanitizeLastPlacedMap`/
`sanitizeLastPlacedRecord` apply the same untrusted-input bounds as every other field this file parses from
disk (`isSafeManifestEntry` for the name, `sanitizeFingerprint` for each value, truncated at the cap rather
than rejected outright). An older daemon build (one that predates `LAST_PLACED_KEY`) reading a sidecar that
already carries it does not choke: its own `readFingerprintsFile` has no special case for the key, so it
reads `__lastPlaced`'s value as if it were an ordinary session's fingerprint map; every entry under it is an
array, `sanitizeFingerprint` returns `null` for anything that isn't a string, so the "session" it reads is
simply empty, is then treated as a dead/unknown sid on the very next prune pass, and quietly drops out of
the file on the next write — no crash, no corruption, just a silent (and harmless, since that older build
never looks for `__lastPlaced` anyway) loss of the carried-forward data.

**Why test case (19) does not isolate this fix, and why (19b) does.** (19) reproduces the reviewer's
originally-described repro (last writer dies, daemon restarts, a fresh co-claimant resumes with no further
store change) — but reverting ONLY this round-3 fix still leaves (19) green: round 2's `wouldPlaceFingerprint`
fallback ALSO independently matches it (disk is still exactly what placement would produce right now, since
the store never moved again after the dead session's write), so (19) cannot tell the two fixes apart. (19b)
isolates round 2's OWN fallback instead — removing round 3 from the picture entirely (no dead session at
all) and constructing a `recorded` set that is non-empty but stale, which only round 2's "always try the
store fallback once nothing in `recorded` matches, whether `recorded` is empty or non-empty-but-stale" rule
(not round 3's `lastPlaced`) rescues. (20) is the case that genuinely needs round 3: the store moves a
SECOND time (v2→v3) after the dead session's death AND after a daemon restart, so `wouldPlaceFingerprint`
now computes v3 against a disk still at v2 and cannot rescue it — only the persisted `lastPlaced` entry
(which still holds the dead session's own recorded v2 fingerprint, surviving the restart even though the
in-memory registry didn't) matches.

Pinned in `skills-inject-same-session-fingerprint.mjs`: (19) (restart, no further store move — real
coverage of the described repro, but not a clean isolation of this fix alone, see above), (19b) (a true
isolation of round 2's own fallback: no dead session, a stale-but-non-empty `recorded` set), (20) (the case
round 3 actually closes: restart plus a second store move after the death, for a fresh co-claimant, the
original claimant's own resume, AND a third fresh co-claimant — none freeze).

## CORRECTED (full regression sweep, not an external reviewer round): round 3's `lastPlaced[name]` access crashed on a store skill named "constructor"

Found running `skills-capability-bound.mjs` as part of this card's own standing DoD, not by a Code
Reviewer — reported here anyway since it is a real defect in round 3's own new code, not a pre-existing
one. `recordedFingerprintsForName`'s `lastPlaced` is a plain `Record<string, string[]>` — the exact same
shape test case (8) in that file already exists to prove is a prototype-shadowing hazard for
`passesCapabilityGate`'s `capabilityBindings` lookup: when `lastPlaced` has no OWN property for `name`,
bracket access (`lastPlaced[name]`) falls through the prototype chain to `Object.prototype`'s own inherited
member of that name (e.g. a store skill literally named `"constructor"` reads back the `Object`
constructor FUNCTION, not `undefined`) — and unlike `passesCapabilityGate`, this read was never guarded by
`Object.hasOwn`. Because the access was iterated directly (`for (const fp of lastPlaced[name] ?? [])`
— the `??` guard is no help, since a function is not nullish), this one THROWS (`TypeError: function is
not iterable`) rather than merely polluting a Set with a stray function value the way an equivalent
`fingerprints[sid]?.[name]` lookup a few lines above it would (that one's own `if (fp)` truthy check at
least prevented a crash, though it could still silently add a non-string value — fixed in the same pass,
below, for consistency, not because it crashed).

Reproduced directly: case (8)'s own fixture plants a real store skill directory named `"constructor"` and
never removes it, so every LATER case in the same file that reaches the `want` loop's fingerprint-gated
re-copy branch for an unbound skill (case 11's own "(c) A resumes" step) hits this function with
`name === "constructor"` and throws — case (8) itself never reaches this exact branch, so it passed, and
the throw only surfaced three cases later.

**The fix (`inject.ts`):** both the `fingerprints[sid]?.[name]` lookup and the `lastPlaced[name]` lookup in
`recordedFingerprintsForName` now gate on `Object.hasOwn` first, mirroring `passesCapabilityGate`'s own
established pattern — an absent own property reads as genuinely absent (`undefined`), never as whatever
`Object.prototype` happens to have under that name. Both were fixed together, in the same pass, for
consistency within this one function — the `fingerprints[sid]?.[name]` side never crashed on its own (its
`if (fp)` truthy check stopped a stray function value from reaching an iteration), so it was a latent,
benign pollution risk rather than the reproduced crash, but it shares the identical root cause and the
identical fix. Scoped to this one function only when first fixed; a Code Review round 4 full sweep of
every other `[name]`-keyed plain-object access in this file found exactly ONE more site sharing the
same hazard — the dead-session prune loop's own `fingerprints[sid]?.[n]` read, one call earlier in the
same pipeline — fixed in the "CORRECTED (Code Review round 4...)" section below; with that fix, the
sweep is COMPLETE, not merely scoped to this function anymore.

**Blast radius, precisely:** `injectSkills`'s one call site (`pty/host.ts`) already wraps the whole call in
a non-fatal `try/catch` — so this never crashed the daemon, only silently disabled skill injection entirely
(logged, non-fatal) for every session touching a cwd where a skill named `"constructor"` (or any other
`Object.prototype` member: `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
`propertyIsEnumerable`, `toLocaleString`) was in `want` and reached this gate — a real, user-triggerable
regression (anyone who can write a user-store skill by that name) even though not a crash.

Pinned in `skills-capability-bound.mjs`'s own existing case (8) (unchanged assertion, now also exercising
the previously-crashing later cases in the same run without throwing) — no new case added, since the
existing fixture already plants the exact trigger and the full suite run is itself the regression proof
(RED under the pre-fix code at this card's own round 3, GREEN after).

## CORRECTED (Code Review round 4 on card `3b2a8707`): REPLACE semantics let a SECOND prune pass re-open the freeze round 3 had just closed

Round 3's own `carryDeadFingerprintsForward` (above) REPLACED `lastPlaced[name]` wholesale on every call
that touched it. That is safe for a single dead-session discovery, but breaks the moment a SECOND,
LATER call discovers a DIFFERENT dead session claiming the SAME name — exactly the shape a long-lived
shared cwd produces over time, one session dying at a time.

**Reviewer's repro:** A and L place v1 → store moves to v2 → C claims and refreshes to v2 (recording fp2)
→ C dies; a session E that does NOT want this name nonetheless triggers the dead-session prune as a side
effect of its own call, carrying C's fp2 forward: `lastPlaced[name] = [fp2]` → daemon RESTART (empties the
in-process registry) → store moves AGAIN to v3 → A also dies; a LATER call (another non-wanting session F)
discovers A's death and runs the SAME carry-forward — under the original REPLACE semantics this
overwrites `lastPlaced[name]` to `[fp1]` (A's own fingerprint), discarding the already-persisted `fp2`
even though `fp2` is still the ONLY record of the content genuinely sitting on disk right now (v2, from
C's write). From here, L's own resume AND a fresh co-claimant's first claim both fail the fingerprint
gate — current disk (fp2) matches neither the now-REPLACED `recorded` set (`{fp1}` plus whatever a live
claimant's own manifest entry independently offers) nor `wouldPlaceFingerprint`'s own fresh computation
(which is now v3, not v2) — and the dir freezes at v2, permanently, the exact outcome round 3 existed to
prevent. A control run of the identical timeline WITHOUT A's second death (only C's prune ever runs)
refreshes to v3 normally, isolating the SECOND prune pass itself — not the restart, not the second store
move alone — as the trigger.

**THE FIX:** `carryDeadFingerprintsForward` now MERGES this pass's own fingerprints into whatever
`lastPlaced[name]` already held (this pass's own fps first, then whatever survives from the existing
entry, deduped), then truncates to `LAST_PLACED_MAX_FPS_PER_NAME`. **"First" is PRUNE-DISCOVERY order,
not placement-age — corrected further in Code Review round 5's own section below; don't read "evicts the
oldest" as literal recency.** This is safe to accumulate regardless of ordering: every single entry, old
or new, is a sha256 this file itself computed at a REAL Loom placement — there is no way merging more of
them in (or evicting one in the wrong order) can ever cause a hand edit to start matching; eviction only
ever removes a genuine Loom-placed candidate, so the failure mode is always toward FREEZE, never toward an
unsafe overwrite. The same read also picked up its own instance of the prototype-shadowing hazard (reading
the EXISTING `lastPlaced[name]` before merging) and is guarded with `Object.hasOwn` from the start.

**Item 3 (same round): the dead-session prune loop's OWN `fingerprints[sid]?.[n]` read had the identical
prototype-shadowing hazard `recordedFingerprintsForName` was already fixed for (the "full regression
sweep" section above) — just one call earlier in the same pipeline.** When a dead session's manifest claims
a name (e.g. `"constructor"`) but its OWN fingerprint entry for that name is missing (the legacy /
failed-to-fingerprint shape this file already documents and tests as "keep, don't delete" elsewhere), the
bare bracket read `fingerprints[sid]?.[n]` falls through to `Object.prototype`'s own inherited member —
for `n === "constructor"` specifically, the `Object` constructor FUNCTION, which is truthy. That function
value was then added to `deadFingerprints`, carried forward by `carryDeadFingerprintsForward`, and
persisted into `lastPlaced[name]` — a function has no sensible JSON form, so `JSON.stringify` renders it
as `null` inside the array: the reviewer's own probe output, `"__lastPlaced":{"constructor":[null]}`,
reproduced byte-for-byte. Fixed with the same `Object.hasOwn` guard as every other name-keyed lookup in
this file. Pinned in `skills-capability-bound.mjs` case (21): a dead claim named `"constructor"` with its
own fingerprint entry deliberately stripped (simulating the legacy/failed-fingerprint shape) never lets a
non-string value reach `__lastPlaced`, proven by reading the sidecar's raw JSON directly after the prune.

**Full sweep re-confirmed (narrowed to READ-side, Code Review round 5 correction):** the reviewer's own
sweep covering every other `[name]`-keyed plain-object lookup in this file found none shares this
crash/pollution shape. The complete READ-side set is FIVE sites, not three — the three fixed by this card
(`recordedFingerprintsForName`'s two lookups, and this prune loop's one) PLUS two that were already
correctly guarded before this card ever touched them: `passesCapabilityGate`'s own `capabilityBindings`
lookup (round 1 of this same card) and `carryDeadFingerprintsForward`'s own `ownExisting` read of
`lastPlaced[name]` (written guarded from the moment it was added, this round). This claim is READ-side
only — see "Item 3" in Code Review round 5's own section below for the separate, NOT-fixed-here WRITE-side
hazard a literal `"__proto__"`-named skill creates.

**Item 2 — the record's own overclaims, corrected (see "What remains" point 5 below for where the
corrected claims now live):**
- *"This is the ONLY residual left standing after round 3"* was FALSE the moment the REPLACE bug above
  existed — it is TRUE AGAIN now that round 4 has closed it, but see the next two points for what round
  4's OWN fix adds back as a replacement residual.
- *"Bounded per-call, not cumulative across a cwd's whole lifetime"* was also false, independent of the
  REPLACE/MERGE question: nothing in this mechanism EVER removes an entry from `lastPlaced[name]` once
  written (short of a fresh dead-session prune for that exact name touching it again) — retention is
  bounded in COUNT (the cap), never in TIME. An entry can survive for as long as the name stays in
  `stillLiveClaimed` across any number of later calls, long after the dead session that produced it is
  forgotten everywhere else (its own manifest/fingerprints entries are long gone).
- **The edge this opens, named precisely:** because `lastPlaced[name]` can now hold SEVERAL historical
  fingerprints at once (not just the latest), a fingerprint from an OLDER Loom placement can still vouch
  for disk content LONG after that placement is gone from everywhere else — so if disk is later reset,
  by some means OUTSIDE this mechanism (a deliberate revert, or tracked content checked out), back to
  EXACTLY those old bytes, the stale retained fingerprint still matches and the gate treats the dir as
  "safe to overwrite," proceeding to re-copy over it. This needs an exact byte-for-byte match against a
  genuine PAST Loom placement — not an arbitrary hand edit, which still fails every comparison — so the
  risk is low, but it is real and it is new: before round 4's MERGE fix, a REPLACE'd `lastPlaced[name]`
  could only ever vouch for the SINGLE most recently discovered dead claim, not an arbitrary one from
  further back.
- **Considered and NOT done: dropping `lastPlaced[name]` once no live session claims the name.** The
  dead-claim path (round 2/3's own isolated-cwd delete, and card `f4e93dbf`'s shared-cwd pending-reclaim)
  already owns the "nobody live claims this anymore" case and never reads `lastPlaced` at all — so
  dropping it there would not, by itself, be reachable through either of those paths and could not
  reopen the freeze through them. The reason it is NOT done here anyway: `carryDeadFingerprintsForward`
  only ever learns a name has dropped OUT of `stillLiveClaimed` on the NEXT call that happens to discover
  a death for that exact name — there is no independent sweep that revisits every existing `lastPlaced`
  key on every call to check whether its name is still live-claimed, and adding one is a real behavior
  change with its own correctness surface (does it ever need to fire when NO death is being discovered at
  all? does an added sweep interact safely with a name that drops out of live claims and is then reclaimed
  moments later via `f4e93dbf`'s own path, which never touches `lastPlaced`?) that this round did not have
  reason to open. Documenting the time-unbounded retention above, rather than building that sweep, is the
  deliberate choice for this round — a correct future addition of such a sweep remains open, not
  foreclosed, but is not required to close round 4's own named findings.

Pinned in `skills-inject-same-session-fingerprint.mjs` cases (21a)/(21b)/(21c): (21a) the ORIGINAL
co-claimant's (L's) own resume succeeds after a second dead-session prune pass; (21b) the SAME scenario
tested independently via a FRESH co-claimant's first claim (never relying on L having already fixed the
state); (21c) the control — the identical restart + second-store-move shape, but with only ONE prune pass
ever (A never dies), refreshing normally, isolating the second prune pass itself as the trigger. All three
reproduce RED under the pre-round-4 REPLACE code and GREEN after.

## CORRECTED (Code Review round 5 on card `3b2a8707`): wording/record corrections only — no behavior change

Round 4 shipped correct code (three mutants reconfirmed RED by the reviewer) but described its own
ordering guarantee imprecisely in several places. This round is comments and this record only.

**Item 1 — `LAST_PLACED_MAX_FPS_PER_NAME`'s own doc comment (`inject.ts`) still said "never a cross-pass
accumulator… a pass always REPLACES… never hit in practice"** — exactly the claim round 4 made false.
Rewritten to describe the cap as what it now is: the bound on `lastPlaced[name]`'s MERGED retention
ACROSS passes, and the thing that creates the eviction edge named in Item 2 below.

**Item 2 — "newest first / evicts the oldest" is true only in PRUNE-DISCOVERY order, not placement age.**
This pass's own `fps` (a `Set`) is built in whatever order THIS call's dead-sid scan happens to visit —
sidecar key iteration order, not a timestamp — so "this pass's fps first" really means "whichever dead
claim THIS call happened to discover first," which can easily be a long-lived session's OWN, genuinely
OLD fingerprint: that session simply died (and was discovered dead) in this call, so its fp ranks ahead of
fresher content a PRIOR call already carried into `existing`. A fp this pass re-discovers that was already
somewhere in `existing` also moves to the front (deduped out of the tail, kept only in the `fps`-first
segment) — so re-discovery, not recency, decides rank. Truncation at the cap therefore evicts whatever
ranks LAST in THIS pass's own order, which is not guaranteed to be the actual oldest placement; and if a
SINGLE pass alone discovers `>= LAST_PLACED_MAX_FPS_PER_NAME` distinct fingerprints for one name (e.g.
that many sessions dying in the same call, each with a different recorded fp for it), `existing` is
evicted in full regardless of how long any of its entries had survived. **Named precisely, this always
fails toward FREEZE, never toward an unsafe overwrite** — every candidate ever evicted is itself a real
sha256 a genuine Loom placement produced, so losing one can only ever make the gate MORE conservative
(refuse a write it would otherwise have allowed), never less. Rewritten at the doc comment and both
inline comments on `carryDeadFingerprintsForward` (`inject.ts`), in this record's own "Semantics" / "THE
FIX" paragraphs above, and in the "Do not" bullet below — all now say "most recently discovered," never
"newest," and name the `>= LAST_PLACED_MAX_FPS_PER_NAME`-in-one-pass case explicitly.

**Item 3 — the "complete set of three sites" claim was too narrow in TWO ways.** First, it counted only
the sites this card itself had to FIX, omitting the two that were already correctly guarded before this
card touched them: `passesCapabilityGate`'s own `capabilityBindings` lookup (round 1 of this card) and
`carryDeadFingerprintsForward`'s own `ownExisting` read of `lastPlaced[name]` (added already-guarded this
round). The complete READ-side set is FIVE, not three. Second, the claim never distinguished READ from
WRITE — and a WRITE-side hazard this file still carries, genuinely NOT fixed by any of these five guards,
is real: `lastPlaced[name] = …` (and every other bare `obj[name] = …` write keyed by an untrusted skill
`name` in this file) is an ordinary bracket ASSIGNMENT, and for the one literal name `"__proto__"`,
bracket assignment on a plain object does not create an own property at all — it invokes the special
`[[Prototype]]` setter, reassigning the TARGET OBJECT's own prototype to whatever is assigned (silently
ignored only when the assigned value isn't an object or `null`; here it's always an array, which IS an
object, so the setter fires for real). A store or user skill literally named `__proto__` would therefore
corrupt `lastPlaced`'s own prototype chain the next time a dead claim for it is carried forward — a
different, stranger failure shape than the read-side hazard, and NOT merely a freeze at the write site
itself (though every DOWNSTREAM read of the corrupted object still only ever fails toward freeze, never
toward an unsafe overwrite, for the same genuine-sha256-only reason Item 2 gives). **Not fixed on this
round — tracked as a follow-up finding, not yet filed to a card id this record can cite.** The sweep claim
above is now explicitly scoped to READ-side only; do not read it as also covering writes.

**Item 4 — nit, mentioned only, not fixed.** The dead-session prune loop's OUTER `manifest[sid] ?? []`
read (`inject.ts`, the loop over `allSids`) shares the identical bracket-access shape, keyed by `sid`
rather than a skill `name` — reachable only if the `FINGERPRINTS_FILE` sidecar is FORGED to carry a
literal top-level key `"constructor"` as if it were a real session id (a real session id is server-minted
and never arbitrary), since `allSids` is built straight from `Object.keys(manifest)` ∪
`Object.keys(fingerprints)` with no other validation. Read-only, and caught the same way every other
hazard in this file is: `injectSkills`'s one call site (`pty/host.ts`) wraps the whole call in a
non-fatal `try/catch`, so a forged sidecar degrades to "this session boots without its injected skills,"
never a daemon crash. Mentioned at its own call site and here; not fixed, since it needs a forged file to
reach at all and the existing containment already bounds the blast radius to the one call.

No test changes this round — nothing here changes observable behavior, only the words describing it.

## CARD `f4272888`: the multi-source gate is RETIRED for ONE persisted per-(cwd,name) fact

Lesson-277 SHRINK follow-up, recommended by `3b2a8707`'s own round-4 Code Review. Everything in the
"CARD `3b2a8707`" and "CARD `6db94dfe`" sections above described the overwrite/delete gate as a UNION of
four approximations of one underlying fact ("disk == the bytes Loom last wrote here"): live per-session
recorded fingerprints (`fingerprints[sid][name]`), the in-process `loomPlacedFingerprintsByCwd` registry,
the persisted `__lastPlaced` carry-forward (merged, capped at 8, prune-discovery order), and the
`wouldPlaceFingerprint` store fallback. Each of three review rounds found a NEW hole where one
approximation lost the fact under a lifecycle event (session death, daemon restart, a second prune). All
four holes failed toward FREEZE, never data loss — but the surface kept sprouting holes, which is exactly
what this card set out to stop by deleting the surface rather than patching it again.

### THE NEW INVARIANT

`__lastPlaced` (on disk, in the same `FINGERPRINTS_FILE` sidecar, same reserved key) now holds exactly ONE
fingerprint per name — written as a single-element array, REPLACED (never merged) at the end of EVERY
successful real placement, by ANY session sharing the cwd. **CORRECTED (round 6 Code Review): the
invariant this actually gives is "every entry is SOME fingerprint Loom itself actually wrote there," not
"ALWAYS exactly what Loom's most recent write left on disk"** — a null fingerprint computed at placement
time (~:1207), a transform failure, or a sidecar write failure can each leave a stale entry that no
longer matches the latest real write. It is never a session- or process-scoped snapshot that can go stale
when a session dies or a daemon restarts, which is the property that matters for the holes below. The gate
collapses to: `disk == lastPlaced.get(name) || disk == wouldPlaceFingerprint(name)`.

This closes every one of the holes above STRUCTURALLY, not by patching each one:
- **Session death** never mattered to a value that was never keyed by session.
- **Daemon restart** never mattered to a value that was always disk-persisted, not held only in the
  in-process registry.
- **A second dead-session prune for the same name** (the round-4 REPLACE-vs-MERGE bug) cannot recur,
  because prune passes no longer WRITE to `lastPlaced` at all — only a real placement does.
- **Cross-variant co-claimants** (one obsidian-on, one obsidian-off) "handle naturally," per this card's
  own proposal: whichever session last wrote is exactly what `lastPlaced` now holds, so there is nothing
  to reconcile across claimants.

### WHAT WAS DELETED

`carryDeadFingerprintsForward` (whole function), the per-call `deadFingerprints: Map<string,Set<string>>`
collection in the dead-session-prune loop, the ENTIRE per-session fingerprint map
(`FingerprintMap`/`bySession`, i.e. `fingerprints[sid][name]`), and `recordedFingerprintsForName`'s
manifest/fingerprints/registry-union logic (now a bare `lastPlaced.get(name)` at each of the four call
sites: the `want`-loop re-copy skip, the `myPrev` stale-prune skip, the isolated-cwd dead-claim delete, and
the shared-cwd `pendingWorking` seeding). `LAST_PLACED_MAX_FPS_PER_NAME`'s cap/truncation/eviction-order
reasoning (round 4/5's own "most recently discovered, not newest" correction) is moot: a real write is now
a straight replace of a 1-element array, never an accumulator with an eviction order to reason about.

**Kept unchanged, deliberately:** `loomPlacedFingerprintsByCwd`/`recordLoomPlacedFingerprint` — per this
card's own instructions, kept ONLY for 015fdb23's trust-boundary job (the permission scan's
`claimedFingerprints`, which must never trust sidecar content since it's forgeable/committable). This is
now a CLEAN separation that didn't exist before: before this card the registry was ALSO unioned into the
overwrite gate; now the gate never reads it at all, and the registry's only remaining consumer is the
scan. `PENDING_RECLAIM_KEY`/`PendingReclaimMap`/card `f4e93dbf`'s whole shared-cwd mechanism is unchanged
in behaviour and on-disk shape — the only touch is that `PendingReclaimRecord.deadFingerprints` is now
populated from `lastPlaced.get(name)` at discovery time instead of from the deleted per-session
collection; same shape, same consumer code, different (now simpler) data source.

### THE ONE-SHOT MIGRATION FOLD (owner-approved design decision, closing the upgrade-boundary residual)

Deleting the per-session fingerprint map outright would have opened a narrow, self-healing transitional
false freeze: immediately after upgrading the daemon binary, a name whose on-disk content predates the
store's most recent reseed, placed by a session that never died (so no dead-session prune ever ran for it,
so no `__lastPlaced` entry exists for it yet), would mismatch BOTH `lastPlaced` (empty) and
`wouldPlaceFingerprint` (now computing the newer store version) on the very first post-upgrade call for
that (cwd,name) — a false "hand-modified" skip on content nobody ever touched by hand.

**The fix:** `readFingerprintsFile` now folds, on READ only, every top-level sidecar key that is neither
`PENDING_RECLAIM_KEY` nor `LAST_PLACED_KEY` — i.e. a pre-card per-session fingerprint record — into
`lastPlaced` (unioned, deduped, capped at `LAST_PLACED_MAX_FPS_PER_NAME`, same bound as a real
`__lastPlaced` entry). `serializeFingerprintsFile` NEVER writes a legacy section back, so the sidecar
self-migrates to the new shape the first time any session in that cwd calls `injectSkills` again. Every
folded value is a real fingerprint a past Loom placement actually recorded — folding more of them in only
ever widens what the gate recognizes as "still Loom's own," never admits a hand edit, for the identical
reason the old `carryDeadFingerprintsForward` merge already relied on. The legacy top-level key itself
(the old session id) is used ONLY as a loop discriminant, never stored as an object/Map key anywhere —
closing the hazard named below without needing to validate or sanitize it at all.

Pinned in `skills-inject-same-session-fingerprint.mjs` case (22): an old-format sidecar with a live
session's per-session fp and no `__lastPlaced` entry, store reseeded, resumes without a false freeze; a
parallel setup proves a GENUINE hand edit over the identical legacy shape still survives (the fold never
admits a real divergence). Mutant-verified: disabling the fold loop alone turns exactly case (22)'s two
checks RED, nothing else — confirming the case isolates the fold and nothing else.

### CORRECTION, found during this card's own implementation: the `"__proto__"`-named-skill premise was unreachable as stated

The card's own text (and the decision record's round-5 Item 3 it was based on) described
`lastPlaced[name] = …` as reachable with `name === "__proto__"` for "a store or user skill literally named
`__proto__`." Verified NOT reachable via the normal pipeline: `NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`
(store.ts) requires a leading `[a-z0-9]` character, excluding every underscore-leading name — so
`"__proto__"` can never pass `isValidSkillName`/`isSafeManifestEntry`, and therefore can never appear in
`storeNames`, `want`, or a validated manifest entry, every one of which funnels through that same
validator before a name ever reaches a bracket-assignment write site. (`"constructor"`/`"toString"`/etc.
— all-letter names — ARE reachable, and that is exactly what rounds 1/4/5 of card `3b2a8707` correctly
fixed, on the READ side.)

**The GENUINELY reachable hazard, not previously flagged:** `readFingerprintsFile`'s (pre-card) top-level
session-id loop did `bySession[sid] = inner`, with `sid` taken straight from `Object.entries(raw)` on
parsed JSON and checked ONLY against the two reserved-key sentinels — never run through any name
validator. A forged/corrupted sidecar file with a literal top-level key `"__proto__"` WOULD have reached
that bracket assignment. This whole `bySession` concept is deleted by this card's redesign, so the site
disappears as a side effect of the broader simplification, not as a targeted fix.

**The fix, generalized:** every skill-name- or sid-keyed structure this card touches (`Manifest`,
`LastPlacedMap`, `PendingReclaimMap`) is now a `Map`, built via `Object.entries(raw)` (own-enumerable-only,
safe) and `Map.set` (no special treatment of any key, including `"__proto__"`), never a plain object built
via bracket assignment keyed by untrusted content. Serialization goes back to a plain object ONLY via
`Object.fromEntries` (spec'd to use `CreateDataProperty`, the same safe operation `JSON.parse` itself
uses — never a bracket-assignment loop), so a `"__proto__"`-keyed entry becomes a genuine own property
instead of reassigning the target's own prototype.

**Named limitation of the test coverage, honestly reported:** the required `"__proto__"`-named-skill test
case (`skills-inject-same-session-fingerprint.mjs` case 23) proves `readFingerprintsFile` neither throws
nor pollutes `Object.prototype` on a forged sidecar carrying `"__proto__"` as both a top-level key and a
nested `__lastPlaced` name, and that a subsequent ordinary placement in the same cwd still succeeds
normally. Mutant-tested: an ISOLATED, otherwise-unused bracket-assignment onto a local accumulator (`obj[key]
= value` for the untrusted top-level key, wired nowhere else) was confirmed to have NO observable effect on
either assertion — which is the correct, expected outcome for a corrupted-but-discarded value, not a gap in
the test. The real protection is structural: this file's implementation never stores the untrusted
top-level key anywhere at all (confirmed by reading the code, not by a mutant) — a meaningful mutant would
require first wiring that dead accumulator into the live data flow, which is a larger, more invasive change
than a clean single-line mutation allows, and was not attempted.

### ROUND 6 Code Review: the migration fold was ORDER-DEPENDENT (MAJOR, fixed)

The one-shot migration fold above (`readFingerprintsFile`) originally did `lastPlaced.set(name, fps)` —
a plain REPLACE — when its loop over `Object.entries(raw)` reached the `__lastPlaced` key, discarding
whatever the legacy-fold branch had already unioned in for that name from an EARLIER key in the same
iteration. `Object.entries` iterates in insertion order, and the pre-card `serializeFingerprintsFile`
always wrote `{...bySession, __pendingReclaim, __lastPlaced}` — `__lastPlaced` LAST — so every real
pre-card sidecar hits this defeat path by construction, not merely as an edge case.

**Repro (reviewer 301538b8):** sidecar `{A:{"skill-a":v2}, __lastPlaced:{"skill-a":[v1]}}`, disk `== v2`,
store reseeded to `v3`. Session A resumes: the legacy-fold branch sets `lastPlaced.get("skill-a") = [v2]`
first, then the `__lastPlaced` branch REPLACES it with `[v1]`. Disk (`v2`) now matches neither `[v1]` nor
`wouldPlaceFingerprint` (`v3`) ⇒ false "hand-modified" freeze on content nobody touched by hand. A control
with `__lastPlaced` listed FIRST in the raw JSON (so the legacy branch runs last and does the discarding
in the other direction) does not reproduce it — confirming the defect is specifically about which branch
writes LAST, not about the fold existing at all.

**Fix:** the `__lastPlaced` branch now UNIONS into whatever `lastPlaced.get(name)` already holds (dedup
+ cap at `LAST_PLACED_MAX_FPS_PER_NAME`, same bound every other write path in this file already uses)
instead of replacing it — see `readFingerprintsFile`'s own inline `@decision f4272888` comment. The fold
is now order-independent: regardless of which key the loop reaches first, the result is the union of
every fingerprint either branch would have contributed alone. This does not reintroduce the round-4
MERGE-accumulator surface this card otherwise deleted — the union only ever happens ONCE, inside this one
read of a single sidecar file, never across separate calls or passes.

Pinned in `skills-inject-same-session-fingerprint.mjs` case (24): a sidecar in the OLD serializer's real
key order (`__lastPlaced` last) carrying BOTH a legacy per-session fp and a `__lastPlaced` entry for the
same name, store reseeded — resumes refreshed, not frozen; a parallel hand-edited-copy case over the
identical shape still survives (the union still never admits a genuine divergence). Mutant-verified:
restoring the bare `.set()` replace turns exactly case (24)'s refresh assertion RED, nothing else.

### "Do not" bullets ABOVE this section now superseded (kept for history, not re-opened as findings)

- Card `3b2a8707` round 3's own bullet ("do not persist a `lastPlaced` entry for a name no live session
  claims... cap it at `LAST_PLACED_MAX_FPS_PER_NAME`") and round 4's correction of it (MERGE not REPLACE,
  prune-discovery order) both describe a mechanism (`carryDeadFingerprintsForward`) that THIS card deletes
  outright. Do not re-apply either rule to new code in this file — there is no more carry-forward step to
  gate, merge, or cap; a real placement always replaces `lastPlaced.get(name)` with exactly one element.
- "What remains" point 5's own "unbounded-time retention" and "an old retained fingerprint can vouch for
  disk later reset to those exact bytes" edges (round 4's own Item 2) were both properties of the MERGE
  accumulator specifically. They do not apply to a bare replace-on-write — see "What remains" below for
  this point's own f4272888 update.

## CARD `4c2a0bfd`: the sidecar RMW is now safe against the same-tmp-name cross-process collision — the plain lost update stays an accepted residual

Investigated off `3b2a8707`'s own Code Review round 3 (pre-existing, not introduced by that card). Within ONE daemon, `injectSkills` is fully synchronous (no `async`/`await` anywhere in its call path), so two calls can never interleave — this card's risk is CROSS-PROCESS only (two daemons sharing one cwd, e.g. two `LOOM_HOME`s pointed at the same repo, or a dev and a stable daemon side by side). Both the manifest and the `__lastPlaced` fingerprints sidecar used a FIXED `${path}.tmp` staging name with no retry; two such writers could clobber each other's tmp file mid-write — whichever rename loses the race throws `ENOENT` against an already-consumed tmp and logs a spurious "failed to write" even though a valid write DID land.

**Cost, confirmed structurally before deciding the fix: never data loss.** Every destructive path in this file (`matchesRecordedFingerprint`-gated delete/prune/re-copy-skip) requires a POSITIVE match against a recorded `lastPlaced` fingerprint before acting — a lost/stale read of that fact can only ever read as "no match" (fail toward KEEPING), never a false match, so a lost update can at most cause under-deletion (an orphan, a freeze), never over-deletion of real content.

**The fix:** both sidecar writes now go through `pty/claude-config.ts`'s existing `writeJsonAtomic` (built for the identical cross-process-JSON-RMW problem against `.claude.json`) instead of a hand-rolled tmp+rename — a unique `pid+randomUUID` tmp name per call closes the same-tmp-name collision, plus gets `writeJsonAtomic`'s own bounded retry on a transient Windows rename failure (EPERM/EACCES/EBUSY) for free, which the old hand-rolled code never had. Deliberately did NOT move/refactor `writeJsonAtomic` itself — it is a shared, load-bearing `pty/` file. Because its tmp name is unique EVERY call (never reused, unlike the old fixed name, which self-healed the moment any later write reused and overwrote it), a crash-stranded one no longer self-heals — `MANIFEST_TMP_GLOB`/`FINGERPRINTS_TMP_GLOB` (two new, unconditional, GLOBBED git-exclude entries, added via `inject.ts`'s own `hideFromGit` call — the pid/uuid differ every call, so only a glob, never an exact name, can cover it) close the "permanent untracked noise in the user's worktree" risk a unique name would otherwise introduce.

### Accepted residual: the plain, unlocked cross-process lost update — NOT closed, by design

A unique tmp name removes the COLLISION hazard above; it does not, and cannot, remove the inherent unlocked lost-update of any unsynchronized concurrent read-modify-write — whichever process's full read-modify-write cycle finishes LAST wins outright, silently discarding the other's conflicting change. Per the cost analysis above this is never data loss. Two concrete shapes, both pinned in `skills-inject-sidecar-rmw-race.mjs`:

- **A dead-session prune gets undone.** Self-healing: the very next `injectSkills` call by anyone sharing the cwd re-runs `isSessionLive` for every manifest key and re-attempts the same prune.
- **A live session's OWN claim write is overwritten by a concurrent process's stale snapshot** (the "stuck-but-correct own skill" case). The session's own skill dir is genuinely present and correct on disk; only the bookkeeping `manifest.set` for it is lost. On that session's NEXT call, `myPrev` comes back empty, so the re-copy gate (`exists && !myPrev.includes(name) && !otherClaimed.has(name) && !reclaimableNow.has(name)`) treats its own correct, Loom-placed copy as if it were "the repo's own" skill — permanently skipping it from every future refresh/prune decision for that session, until the dir is removed out-of-band. The skill keeps working exactly as placed; it simply stops participating in bookkeeping. A lost `__lastPlaced` write degrades, at worst, to the PRE-EXISTING, already-accepted "legacy claim" freeze at "What remains" point 5 below — not a new failure shape.

**Escalation path, named but deliberately not taken here:** `pty/claude-config.ts` also has a full cross-process advisory lock (`withTrustLock`, PID-liveness-based stale-lock breaking) that COULD serialize the whole manifest+fingerprints RMW region if this residual is ever judged worth closing. Not ported — porting a general cross-process lock onto this synchronous hot spawn path is not proportionate to a cost ceiling of "freeze," one this same file already tolerates elsewhere (see "What remains" point 5 below).

### Test methodology (`skills-inject-sidecar-rmw-race.mjs`)

Since `injectSkills` is fully synchronous, a real cross-process race can't be reproduced hermetically by just calling it twice — there is no gap for a second call to land in. The test instead hooks `pty/claude-config.ts`'s own `__setRenameSyncForTest` seam: the first manifest rename of a "sess-A" call synchronously runs a COMPLETE second ("sess-B") `injectSkills` call to completion before sess-A's own rename proceeds, simulating sess-B's whole read-modify-write cycle landing in the gap between sess-A's read and sess-A's write.

Negative-control (`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/skills/inject.ts --test packages/daemon/test/skills-inject-sidecar-rmw-race.mjs`, default `--ref HEAD`): pre-fix `inject.ts` never calls `writeJsonAtomic`/`__setRenameSyncForTest` at all (raw `fs.writeFileSync`/`fs.renameSync`), so the hook never fires and the hook-fired/nested-ran assertions go RED — a behavioral assertion that the real write path reaches the shared helper, not a bare "does the function exist" check (lesson 298, since `__setRenameSyncForTest` exists unchanged either way).

Mutant (hand-verified, not automated in the test file, since the target lives in a shared `pty/` file this card does not permanently touch): temporarily reverting ONLY `writeJsonAtomic`'s own `const tmp = ...` line (`pty/claude-config.ts`) back to the pre-this-card fixed `${filePath}.tmp` form (API-keeping — same signature, same callers) turns the "no spurious failure log" assertion RED, and inverts which session's claim survives (sess-A's write now throws instead of sess-B's being overwritten) — both explained by the same reintroduced collision. Reverted immediately; confirmed byte-identical via `git diff` before rebuilding green again.

## What remains (accurate as of card `3b2a8707`, UPDATED for card `f4272888` where noted)

1. An EXPLICIT `skills` subset naming a bound skill still bypasses both the grant check and the isolation
   check (unchanged since round 1 — `509176c8`'s existing "an explicit subset is a deliberate,
   human-attributable grant" posture). If a human sets such a subset on a SHARED-cwd role's profile, the
   round-1 permanent-orphan shape can still occur there — the round-2/3/4 cleanup is isolated-cwd-only by
   design and never runs for a shared cwd regardless of subset use.
2. Card `f4e93dbf`'s own scope: the GENERAL dead-session-orphan problem for a SHARED cwd, for every skill
   (not just a capability-bound one). Tracked separately; this card's fixes deliberately do not reach
   into it.
3. A symlink/junction child or empty subdirectory added to a claimed dir doesn't change its fingerprint,
   so such a dir is still deleted/overwritten; and a TRACKED dir whose content happens to be byte-identical
   to what Loom wrote can also still be deleted/overwritten — true of the original round-3 dead-claim
   cleanup AND, since card `6db94dfe`, of the same-session re-copy/prune paths too. Both accepted rather
   than fixed — closing either would mean adding real content-type/git awareness to a sync path that
   deliberately has neither.
4. ~~The SAME-SESSION-resume class the round-3 fix deliberately did NOT touch~~ — CLOSED by card
   `6db94dfe` (see above). ~~The `otherClaimed` re-copy (a DIFFERENT session's claim, shared cwd) is the
   one adjacent path 6db94dfe deliberately left untouched~~ — ALSO CLOSED, by card `3b2a8707` (see the
   "CARD `3b2a8707`" section above, including its own round-2 correction). The ORIGINAL defect named here
   (unconditional overwrite, no fingerprint check at all) is closed. ~~What is NOT closed: after a daemon
   restart, this same gate degrades to the `wouldPlaceFingerprint` fallback alone~~ — ALSO CLOSED, by
   `3b2a8707`'s own round 3 (see "THE ROUND-3 FIX" section above): the persisted `lastPlaced` carry-forward
   survives the restart for any name a live session still claims at the moment the dead claim is pruned.
   What remains after round 3 is folded entirely into point 5 below — do not re-open this point as a
   separate finding.
5. A legacy claim (no recorded fingerprint from any current claimant, the registry, or `lastPlaced`)
   placed from an OLDER store version — one that has since been reseeded/updated — matches neither any
   claimant's recorded fingerprint nor what today's store would actually produce, and so is kept,
   permanently: there is no third, byte-exact record of a past store version to compare against. In a
   SHARED repo cwd this freezes that skill, for every later session there, until a human intervenes — see
   card `6db94dfe`'s own correction section above for why this cannot be closed from inside the mechanism
   itself. **This core residual SURVIVES card `f4272888` too** — a single persisted fact is no more able
   to reconstruct a byte-exact record of a long-gone store version than the multi-source union was.

   **UPDATED (card `f4272888`), CORRECTED (round 6 Code Review): the round-4 MERGE-specific "unbounded-time
   retention" edge is CLOSED for a REAL PLACEMENT's own write — a real write always REPLACES
   `lastPlaced.get(name)` with exactly one fresh element, so nothing a real write ever produces survives
   past the NEXT real write for that name. It is NOT closed for the one-shot migration fold, which is
   written back: `readFingerprintsFile` now folds a legacy per-session record into `lastPlaced` as a UNION
   with whatever is already there (never a last-write-wins replace — see the fix below), and that merged,
   possibly-multi-element array IS persisted under `__lastPlaced` the next time anything in the cwd writes
   the sidecar, same as a real placement's single-element array is. A multi-element folded entry then
   survives with no time bound of its own until the NEXT real placement for that name replaces it — bounded
   only in COUNT (capped at `LAST_PLACED_MAX_FPS_PER_NAME`), never in time, exactly as narrow as the
   round-4 MERGE accumulator's own retention was. "An old retained fingerprint vouching for disk later
   reset back to those exact bytes by something outside this mechanism" is likewise not newly impossible
   for a folded multi-element entry — the same narrowing as the retention edge, not a separate closure.

   **CORRECTED (round 3): the earlier "while ANY live session still claims the name, that claim alone
   keeps it alive" qualifier was FALSE, and is retracted.** A live session's `manifest` entry is rewritten
   in full (`manifest[sessionId] = placed`) on every one of ITS OWN calls — it is not a standing exemption.
   That session's own NEXT resume reruns the identical fingerprint gate against the same on-disk content
   and can relinquish its own claim the exact same way a fresh co-claimant would. The honest framing: a
   name only truly freezes once it reaches a state where NO session's — live, dead, or future —
   recorded or reconstructable fingerprint matches current disk; it does not require every claimant to
   have already died first, and a presently-"claimed" name offers no protection against it on its own.

   **A name whose only claimant died while NO live session claimed it at the moment of discovery is
   deliberately out of scope for this entire fingerprint-gate mechanism (`lastPlaced` +
   `wouldPlaceFingerprint`), and this is a separate point from the legacy-claim residual above, not a
   widening of it.** (Card `f4272888`: `carryDeadFingerprintsForward` — the function this paragraph
   originally described — no longer exists; `lastPlaced` is updated ONLY by a real placement, never by a
   prune, so there is no "carry" step left to scope here at all.) A fully-unclaimed name is either
   resolved immediately, in the SAME call that discovers the death, by the isolated-cwd dead-claim
   deletion path above (which reads `lastPlaced.get(name)` directly and never depends on a restart at
   all), or, for a shared cwd, is card `f4e93dbf`'s own pending-reclaim concern — a separate,
   already-reviewed mechanism this one deliberately does not duplicate or interfere with.

There is no longer an isolated-cwd residual for a capability-bound skill from the claim-pruning mechanism
itself: the round-2/3 cleanup applies regardless of whether the current session uses a subset or the
deliver-all default, because it keys on the dead session's own manifest record, not on `want` — and it
now additionally requires the content fingerprint to match before it ever deletes anything.

## Do not

- Do not gate a capability-bound skill on the grant alone — isolation (`isWorktreeCwd`) is required too
  (round 1).
- Do not assume isolation alone is sufficient — a dead session's claim in an isolated, worktree-REUSED
  cwd must also be actively cleaned up, or the SAME permanent-orphan shape returns via reuse (round 2).
- Do not assume "recorded as claimed" is sufficient to delete — a claim is a fact about placement time,
  not about current content. Require a matching content fingerprint, and fail toward KEEPING (not
  deleting) whenever it's absent or doesn't match (round 3).
- Do not extend the round-2/3 cleanup to a shared cwd — that is card `f4e93dbf`'s harder, data-loss-sensitive
  scope, and a shared cwd's "whose dir is this" question is genuinely ambiguous in a way an isolated
  worktree's isn't.
- Do not let the cleanup remove anything not recorded in the DEAD session's own manifest entry, or whose
  current content fingerprint matches none of the global `lastPlaced` fact recorded for that name (card
  `f4272888`, round 6 — see the superseded list below for the retired per-claim framing this replaces).
- Do not collapse two dead claimants' fingerprints for the same name into one last-writer-wins value —
  that makes the outcome depend on manifest key iteration order (round 4). Keep the SET. (Card `f4272888`:
  this specific per-call collection no longer exists — the dead-claim delete/reclaim paths now read the
  one persisted `lastPlaced.get(name)` array directly, which is already order-independent by construction
  since it is never built from a per-call iteration at all. The underlying PRINCIPLE — never let an
  order-dependent collapse decide a delete — still holds; it just has nothing left to apply to here.)
- (Round 3's own scope limit, now CLOSED by card `6db94dfe`.) Round 3 itself did not touch the two
  PRE-EXISTING paths (copy-over-`myPrev`, the `myPrev` stale-prune loop) — the same hand-edit-destruction
  class existed there too, for a same-session resume. Card `6db94dfe` fixed both; see "CARD `6db94dfe`"
  above. Do not re-open this as a finding — it is closed, not merely tracked.
- (Card `6db94dfe`'s own scope limit, now CLOSED by card `3b2a8707`.) `6db94dfe` deliberately left the
  `otherClaimed`-not-`myPrev` re-copy (a FRESH session's first-time claim, where a DIFFERENT live session
  already claims the name) with no fingerprint gate at all. Card `3b2a8707` closed it by widening the
  SAME gate; its own round-2 Code Review found that widening alone reopened a false freeze for a
  cross-variant co-claim whose LAST writer has since died (NOT closed merely by the round-1 widening —
  see the "CORRECTED (Code Review round 2...)" section above) — the round-2 fix (the daemon-side registry
  + the unconditional last-resort fallback) closed it within one daemon process's lifetime; round 3 (see
  "THE ROUND-3 FIX" section above) then closed the post-daemon-restart case too, for any name a live
  session still claims at the moment the dead claim is pruned, via the persisted `lastPlaced` sidecar key.
  Do not re-open the ORIGINAL (unconditional-overwrite) defect, or the post-restart freeze for a
  still-claimed name, as findings — both are closed. The one residual that survives both rounds is the
  pre-existing legacy-claim shape (no fingerprint ever recorded by anyone, from a store version that has
  since moved on), named precisely at "What remains" point 5 — do not cite "a cross-variant co-claim can
  never get stuck" without that one qualification.
- Do not treat a bound skill's presence on disk as proof a session without the grant can act on it. The
  capability's own MCP mount shares the SAME grant source (`resolveProfileCapabilities`) but additionally
  requires a valid catalog row (a missing or first-party-squatting slug is dropped there) — this skill
  gate keys on the raw slug alone. **The capability grant gating the MCP mount is the real gate.** A
  bound skill must never be the only thing standing between an agent and a capability.
- (Card `3b2a8707` round 3 — ⛔ SUPERSEDED by card `f4272888`, kept for history only.) Do not persist a
  `lastPlaced` entry for a name no live session claims at the moment of the carry — that is card
  `f4e93dbf`'s own pending-reclaim concern. Do not let it grow unbounded — cap it at
  `LAST_PLACED_MAX_FPS_PER_NAME` per name. **This bullet describes `carryDeadFingerprintsForward`, which
  no longer exists** — there is no more "carry" step to gate this way; `lastPlaced` is written only by a
  real placement. Do not re-derive this rule for new code in this file.
- (Card `3b2a8707` round 4 — CORRECTS round 3's own bullet above; ⛔ ALSO SUPERSEDED by card `f4272888`,
  kept for history only.) The MERGE-vs-REPLACE question this bullet used to settle (merge this pass's own
  fingerprints into whatever is already there, prune-discovery order, truncate to the cap) is moot: card
  `f4272888` deletes the whole accumulator. **The CURRENT rule is simply: a real placement REPLACES
  `lastPlaced.get(name)` with a fresh single-element array, full stop** — see the "CARD `f4272888`"
  section above. Do not re-introduce a merge/cap/eviction-order mechanism here without first reading why
  this card removed it (the surface it created was exactly what kept sprouting new holes).
- (Card `f4272888`.) Do not read any fingerprint map/sidecar structure in this file as a plain object with
  bracket-assignment keyed by untrusted content (a skill name, OR a legacy sidecar's top-level session-id
  key) — use a `Map` (`.set`/`.get`) for the in-memory shape, and `Object.fromEntries`/`Object.entries`
  (never a bracket-assignment loop) at the JSON (de)serialization boundary. This is what closes the
  GENUINELY reachable `"__proto__"`-as-a-forged-top-level-sidecar-key hazard found while implementing this
  card — see the "CORRECTION" sub-section above for why the originally-cited hazard (a skill literally
  named `"__proto__"`) was never reachable, and what the real one was instead.
- Do not widen the fix search to "stop sharing cwd" as a follow-on to this card — that's a much larger
  change to manager/platform/setup/auditor/plain session architecture, out of scope here.
- Do not fix card `9d73e537`'s or card `f4e93dbf`'s general dead-session-orphan problem for a SHARED cwd,
  or the round-3-named tracked-but-byte-identical residual, on this card — both are separate, broader
  findings tracked on their own cards. (The same-session-resume residual this bullet used to also name
  here is CLOSED — card `6db94dfe`, see above — not merely tracked elsewhere.)
- Do not bracket-access a `[name: string]: string | string[]`-shaped plain object (`lastPlaced`,
  `fingerprints[sid]`, `capabilityBindings`) with an untrusted, store/attacker-controllable `name` —
  `Object.hasOwn(obj, name)` first, always. A skill literally named `"constructor"` (or any other
  `Object.prototype` member) otherwise reads back the inherited member instead of `undefined`; three
  separate sites in this file have now hit this (`passesCapabilityGate`, fixed from round 1;
  `recordedFingerprintsForName`'s two lookups, fixed in the full-regression-sweep section above;
  the dead-session prune loop's own lookup, fixed in round 4 — see "Item 3" above) — read every one of
  them as the worked examples for the next one, rather than re-deriving the guard from scratch.
- (⛔ SUPERSEDED by card `f4272888` round 6, kept for history only.) The isolated-cwd dead-claim delete used
  to require the dir's content fingerprint to match one of the DEAD CLAIM's own per-session recorded
  fingerprints specifically — a per-claimant concept. That per-session fingerprint map is deleted by this
  card; the delete now keys on the single global `lastPlaced.get(stale)` fact for the name instead
  (`inject.ts` ~:1069, `matchesRecordedFingerprint`), which is still a Loom-recorded fingerprint for that
  name (just no longer scoped to which session placed it) — the fail-toward-keeping posture this bullet
  protects is unchanged and still safe. Do not re-derive a per-claim fingerprint scope for new code here.

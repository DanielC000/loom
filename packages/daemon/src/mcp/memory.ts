import type { ProjectMemoryEntry } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { annotateRequestLinks } from "../sessions/project-memory-request-links.js";
import { annotateBacklinks } from "../sessions/project-memory-backlinks.js";
import { annotateNote } from "../sessions/project-memory-annotations.js";
import { computeFloorTierStatus, computeRestTierStatus, NEVER_DROP_TAG } from "../sessions/project-memory-recall.js";

// Project-scoped SHARED memory tool business logic (card 2fd9abf9). EVERY function takes the projectId
// resolved SERVER-SIDE from the session id — the agent never passes a projectId, mirroring tasks.ts.
// ANY worker may write (owner decision #1: it's notes, not code/secrets) — these tools are registered
// unconditionally in server.ts, not gated behind a role or capability.

/** A short, stable slug — mirrors the companion memory-store's name-slug model. Letters/digits/-/_ only,
 *  1-64 chars, so a key is always safe to use as an identity (upsert target) without further escaping. */
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Bounds hardening: a note is meant to be a short, curated fact — not a dumping ground. Caps `text` at a
 *  few KB so an accidental memory_write-in-a-loop (or a large paste) can't bloat every future kickoff or
 *  grow the DB unbounded; rejected with a clear error rather than silently truncated (silent truncation
 *  would corrupt the note's meaning). `title` gets a small cap too — it lands verbatim in the injected
 *  digest's section header.
 *
 *  Card 835a8d67 — this is a BYTES cap, and it feeds the READ side: `estimateTokens` (project-memory-
 *  recall.ts) is ~4 bytes/token, so one maxed-out note costs ≈1000 estimated tokens of `memory.budgetTokens`
 *  (config.ts) — itself a TOKENS budget defaulting to 4000. `4000` appears at both sites, in two DIFFERENT
 *  units, ~4× apart in what they mean: FOUR notes maxed against THIS cap alone exhaust the ENTIRE default
 *  read budget, before anything else (any other pinned note, any related-tier match) gets a byte. See
 *  config.ts's `memory.budgetTokens` doc comment for the arithmetic from the other direction. */
const MAX_TEXT_BYTES = 4000;
const MAX_TITLE_CHARS = 200;

/**
 * Card 046c721e, off the `5469ec08` investigation — the FLOOR TIER (pinned && `never-drop`, see
 * `isNeverDrop`/`computeFloorTierStatus` in project-memory-recall.ts) is not "one more note among many":
 * every such note rides on EVERY future kickoff, unconditionally, so its byte cost is fixed overhead paid
 * by every session on the project, not just a cost to the note's own author. The investigation measured
 * the floor consuming ~91% of an 8000-tok digest budget with all 7 floor notes sized right up against
 * MAX_TEXT_BYTES — this dedicated, LOWER cap for that tier (≈500 est-tok vs the general ≈1000) roughly
 * halves that cost, enforced as a REJECTING write-time precondition, never an advisory: the pre-existing
 * `neverDropStatus` signal below (computeNeverDropStatus) is computed strictly AFTER the write already
 * succeeded, so it could inform but never prevent this exact problem — and the project's own
 * `shipping-a-detector-is-not-someone-reading-it` memory note found blocking preconditions 2-for-2 acted
 * on against advisories 0-for-many. The cap applies only when the note's EFFECTIVE post-write state is
 * genuinely `pinned && never-drop` (see the `isFloorTierNote` computation below) — a `never-drop` tag on
 * an unpinned note is INERT in the packer, confirmed by reading project-memory-recall.ts directly rather
 * than trusting the tool description, so this cap must stay silent for that case or it would fire on a
 * note the packer never actually puts in the floor tier.
 */
const MAX_NEVER_DROP_TEXT_BYTES = 2000;

export interface MemoryWriteInput {
  key: string;
  /**
   * Card 145e8d72 — REQUIRED to create a brand-new key (a note with no body is not a note), but OPTIONAL
   * to update an EXISTING one: omitting it on an update is a METADATA-ONLY patch — the stored body is left
   * byte-identical (re-read straight from the row, never retyped by the caller, so there is nothing to
   * diff against a resend gone wrong). Joins the same omit-preserves convention as `title`/`pinned`/`tags`
   * below; it does not get its own rule.
   */
  text?: string;
  title?: string;
  pinned?: boolean;
  tags?: string[];
  /**
   * Card e6d270b3 — an OPTIONAL, EXPLICIT link to one or more Request ids (`question_ask` rows). Deliberately
   * explicit, never sniffed out of `text` via regex/UUID-matching — this project already shipped and fixed a
   * prefix-`taskId` ambiguity bug of exactly that class (`3a3f587`) that silently hid real owner answers.
   * Every read of this note (kickoff injection, `memory_read`, `memory_list`) re-resolves each linked id's
   * LIVE state against the requests store, so a note written in asking voice about a PENDING request
   * self-corrects the moment the owner answers it — see project-memory-request-links.ts.
   */
  requestIds?: string[];
  /** The `version` the caller last read for this key (memory_read/memory_list/a prior memory_write
   *  response) — required to UPDATE an existing key; irrelevant for a brand-new one. Deliberately an
   *  integer version counter, NOT a timestamp — see {@link writeProjectMemory}. */
  baseVersion?: number;
}

export interface MemoryWriteConflict {
  error: string;
  conflict: true;
  /** The note as it stands right now — reconcile/merge into this and retry with its `version` as the
   *  new `baseVersion`. */
  current: ProjectMemoryEntry;
}

export interface MemoryWriteTooLong {
  error: string;
  /** How many bytes over the applicable cap the submitted text is — trim without needing a re-fetch.
   *  Card 046c721e: the applicable cap is MAX_TEXT_BYTES in general, or the lower MAX_NEVER_DROP_TEXT_BYTES
   *  when the note is (effectively, post-write) `pinned && never-drop` — this shape is shared by both. */
  bytesOver: number;
  /** The EXISTING note (if this key already has one) to trim against — omitted for a brand-new key. */
  current?: ProjectMemoryEntry;
}

/**
 * Card 835a8d67 — an informational signal returned ALONGSIDE a successful write, never a rejection: the
 * write above has ALREADY succeeded by the time this is computed, exactly as it did before this card.
 * Present only when the note's (post-write) `tags` include {@link NEVER_DROP_TAG}; absent otherwise (an
 * ordinary write is byte-identical to before this card).
 *
 * Two, mutually exclusive shapes:
 * - `inert: true` — the tag is set on an UNPINNED note. The floor tier the packer builds is
 *   `pinned && never-drop` (see `computeFloorTierStatus`/`isNeverDrop` in project-memory-recall.ts), so an
 *   unpinned tagged note is never in it — the tag does nothing for this note until it's also pinned.
 * - the floor-tier numbers — this note IS pinned+never-drop, so it's actually IN the tier being measured.
 *   `floorTokens`/`budgetTokens`/`overBudget` come from `computeFloorTierStatus`, the SAME helper
 *   `composeProjectMemoryDigest`'s own in-digest ALARM line uses internally (via `floorSectionTokens`) —
 *   one function, so the number reported here and what the packer actually drops on the next kickoff
 *   cannot disagree.
 */
export interface NeverDropSignal {
  message: string;
  inert?: true;
  floorCount?: number;
  floorTokens?: number;
  budgetTokens?: number;
  overBudget?: boolean;
  roughFitCount?: number;
}

/**
 * Card 3b2aa339 (DoD-2 option b) — an informational signal returned alongside a successful write for an
 * ORDINARY pinned note (`pinned:true`, no `NEVER_DROP_TAG`) — the sub-tier `NeverDropSignal` never covers,
 * and the one measured to actually starve (mean ~1.6% per-note delivery at this project's real corpus/
 * budget; most REST notes never delivered across 30 rounds — see {@link computeRestTierStatus}'s own doc
 * comment for the full measurement). The cost of adding to this tier was previously invisible at the exact
 * moment of the pin; this surfaces it there instead, purely advisory — it can never turn a write that
 * would otherwise succeed into a rejection, mirroring {@link NeverDropSignal}'s own posture.
 */
export interface RestTierSignal {
  message: string;
  restCount: number;
  floorTokens: number;
  restCapEstimate: number;
  roughFitCount: number;
  roughCycleKickoffs: number | null;
}

/**
 * UPSERT by `key` (owner decision #2: always-update in place) — a second write to the same key updates
 * the note rather than piling a contradictory duplicate. Enforces the per-project bounded-store cap
 * (`memory.maxNotes`, resolveConfig) on every write; pinned notes are exempt (see
 * `evictProjectMemoryOverCap` in db.ts).
 *
 * Card a5f98bb4 (Lore audit F3): updating an EXISTING key requires `baseVersion` to match the row's
 * current `version` (a monotonic counter, NOT the `updatedAt` timestamp — a coarse/colliding clock could
 * let two distinct writes share a timestamp and defeat a timestamp-based check) — a racing/stale write is
 * REJECTED with the current note attached (`conflict`) instead of silently clobbering it. A brand-new key
 * needs no base. See {@link Db.upsertProjectMemoryChecked} for the full rationale.
 *
 * Card 835a8d67: a successful write whose (post-write) `tags` include `NEVER_DROP_TAG` also carries a
 * `neverDropStatus` on the returned entry — see {@link NeverDropSignal}. Purely informational: it can
 * never turn a write that would otherwise succeed into a rejection.
 *
 * Card 249004c3: an update is a true PATCH, not a hard overwrite — `title`/`pinned`/`tags` the caller
 * OMITS from `input` are left unchanged on the stored row (only `text` + the version bump apply); passing
 * one explicitly (incl. `pinned:false`/`tags:[]`) still writes it verbatim. See
 * {@link Db.upsertProjectMemory} for the COALESCE mechanics that implement this.
 *
 * Card 145e8d72: `text` now joins that same patch model on an UPDATE — omitting it re-reads the existing
 * row's own stored body and resends THAT (never a caller-retyped copy), so the persisted text is
 * byte-identical and every cap/floor-tier check below still runs against the note's real effective size.
 * `text` stays REQUIRED to create a brand-new key (nothing to fall back to) — see the `!existing` check.
 */
export function writeProjectMemory(
  db: Db,
  projectId: string,
  input: MemoryWriteInput,
):
  | (ProjectMemoryEntry & { neverDropStatus?: NeverDropSignal; restTierStatus?: RestTierSignal })
  | { error: string }
  | MemoryWriteConflict
  | MemoryWriteTooLong {
  const key = input.key?.trim();
  if (!key) return { error: "key is required" };
  if (!KEY_RE.test(key)) return { error: "key must be a short slug: letters, digits, '-', '_' only, 1-64 chars" };
  const existing = db.getProjectMemoryByKey(projectId, key);
  // Card 145e8d72: `text` is REQUIRED to create a brand-new key (nothing to fall back to), but OPTIONAL to
  // update an EXISTING one — omitting it there is a metadata-only patch that resends the row's OWN stored
  // body (never a caller-retyped copy), so `textBytes` below always reflects the note's real effective
  // size whether or not this call actually supplied new text.
  let text: string;
  if (input.text !== undefined) {
    const trimmed = input.text.trim();
    if (!trimmed) return { error: "text is required" };
    text = trimmed;
  } else {
    if (!existing) return { error: "text is required (only omittable when updating an existing key)" };
    text = existing.text;
  }
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes > MAX_TEXT_BYTES) {
    return {
      error: `text is too long (${textBytes} bytes, max ${MAX_TEXT_BYTES}) — memory notes are short, curated facts, not a dumping ground; trim ${textBytes - MAX_TEXT_BYTES} bytes and retry`,
      bytesOver: textBytes - MAX_TEXT_BYTES,
      current: existing,
    };
  }
  // Card 046c721e — computed from the EFFECTIVE post-write state, not the raw `input` fields: this is a
  // PATCH (mirrors upsertProjectMemory's own COALESCE semantics exactly), so an omitted `pinned`/`tags`
  // means "keep whatever this key already has", not "false"/"[]". Getting this wrong either direction is a
  // real bug: reading raw `input.pinned` would let an update that only OMITS `pinned` slip an over-cap
  // floor note through (false negative), while defaulting a missing `existing` note to floor-tier status
  // would wrongly reject an ordinary brand-new pinned note before `tags` even names `never-drop`.
  const effectivePinned = input.pinned !== undefined ? input.pinned : (existing?.pinned ?? false);
  const effectiveTags = input.tags !== undefined ? input.tags : (existing?.tags ?? []);
  const isFloorTierNote = effectivePinned && effectiveTags.includes(NEVER_DROP_TAG);
  // DoD-3: an EXISTING floor note already over this cap (today's 7 notes, all ~1000 est-tok) is REJECTED
  // on its very next update, never grandfathered — `textBytes` above always reflects the note's EFFECTIVE
  // body (the caller's new `text`, or — since card 145e8d72 — the existing row's own stored body when
  // `text` is omitted), so any future touch of that key (even a metadata-only one only changing
  // `title`/`tags`) is still forced through this same check. Deliberate: grandfathering would make the cap
  // unenforceable exactly where the problem the investigation measured already lives, and a cap that only
  // bites brand-new notes never converges the existing floor tier down. §SCOPE forbids touching those 7
  // notes to demonstrate this — it takes effect the first time anyone else edits one.
  if (isFloorTierNote && textBytes > MAX_NEVER_DROP_TEXT_BYTES) {
    // Manager review (post-046c721e): "trim N bytes and retry" is the RIGHT remedy for a throwaway note,
    // but today's real floor notes are dense operational/safety prose — for those, "trim" reads as
    // "delete ~half the note to make a one-word correction," and compressing safety prose risks silently
    // dropping a load-bearing clause. Name two NON-DESTRUCTIVE escapes alongside trim so the rejection
    // never becomes de-facto pressure to damage a note just to satisfy it (a refusal you can't satisfy
    // without damage is worse than a notice you ignore).
    return {
      error: `text is too long for a "${NEVER_DROP_TAG}" floor-tier note (${textBytes} bytes, max ${MAX_NEVER_DROP_TEXT_BYTES} — ` +
        `lower than the general ${MAX_TEXT_BYTES}-byte cap because a pinned "${NEVER_DROP_TAG}" note rides on EVERY future ` +
        `kickoff); trim ${textBytes - MAX_NEVER_DROP_TEXT_BYTES} bytes and retry, or — prefer this for dense safety/operational ` +
        `prose — SPLIT the overflow into a separate key (unpinned, or pinned without "${NEVER_DROP_TAG}") and cross-link the two ` +
        `with a [[wikilink]]-style reference so no clause is lost, or drop the "${NEVER_DROP_TAG}" tag (keeping pinned:true) to ` +
        `exit this cap entirely — at the cost of the note becoming evictable like any other pinned note`,
      bytesOver: textBytes - MAX_NEVER_DROP_TEXT_BYTES,
      current: existing,
    };
  }
  const title = input.title?.trim() || undefined;
  if (title && title.length > MAX_TITLE_CHARS) {
    return { error: `title is too long (${title.length} chars, max ${MAX_TITLE_CHARS})` };
  }
  // Trim/drop blanks only — no format validation (no regex-sniffing a "real" request id; an id that
  // resolves to nothing just annotates fail-visibly at read time, see project-memory-request-links.ts).
  const requestIds = input.requestIds === undefined
    ? undefined
    : input.requestIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const memoryConfig = resolveConfig(db.getProject(projectId)?.config).memory;
  const result = db.upsertProjectMemoryChecked(
    projectId,
    { key, title, text, pinned: input.pinned, tags: input.tags, requestIds },
    memoryConfig.maxNotes,
    input.baseVersion,
  );
  if (!result.ok) {
    return {
      error: "this note changed since you last read it (or you never read it) — re-read it (memory_read) " +
        "and retry with the current version as baseVersion, merging your change into the current text",
      conflict: true,
      current: result.current,
    };
  }
  const neverDropStatus = computeNeverDropStatus(db, projectId, result.entry, memoryConfig.budgetTokens);
  const restTierStatus = computeRestTierSignal(db, projectId, result.entry, memoryConfig.budgetTokens);
  return {
    ...result.entry,
    ...(neverDropStatus ? { neverDropStatus } : {}),
    ...(restTierStatus ? { restTierStatus } : {}),
  };
}

/** Card 835a8d67 DoD-1/2/3 — computed AFTER the write above already succeeded (never blocks/rejects it).
 *  `undefined` when the note's tags don't include {@link NEVER_DROP_TAG} at all — an ordinary write's
 *  response is unaffected (no `neverDropStatus` key) — otherwise one of the two shapes documented on
 *  {@link NeverDropSignal}. */
function computeNeverDropStatus(
  db: Db,
  projectId: string,
  entry: ProjectMemoryEntry,
  budgetTokens: number,
): NeverDropSignal | undefined {
  if (!entry.tags.includes(NEVER_DROP_TAG)) return undefined;
  if (!entry.pinned) {
    return {
      inert: true,
      message: `"${NEVER_DROP_TAG}" is set but this note is UNPINNED — the floor tier only packs ` +
        `pinned notes tagged "${NEVER_DROP_TAG}" (pinned && never-drop, not the tag alone), so the tag ` +
        `does nothing for this note until it's also pinned (pinned:true).`,
    };
  }
  const pinnedNow = db.listPinnedProjectMemory(projectId);
  // Card e4e180ad: uses the SAME combined annotate as the real kickoff digest (project-memory-recall.ts's
  // retrieveProjectMemoryForKickoff) — backlinks ride in the floor tier's rendered size exactly like
  // linked-request annotations already did, so this status can never under-report against what the
  // packer's own in-digest ALARM line actually computes (see composeProjectMemoryDigest's DoD-6 cross-check).
  const annotate = (m: ProjectMemoryEntry) => annotateNote(db, projectId, m);
  const status = computeFloorTierStatus(pinnedNow, budgetTokens, annotate);
  return {
    floorCount: status.floorCount,
    floorTokens: status.floorTokens,
    budgetTokens: status.budgetTokens,
    overBudget: status.overBudget,
    roughFitCount: status.roughFitCount,
    message: status.overBudget
      ? `floor tier (pinned + "${NEVER_DROP_TAG}") is now ≈${status.floorTokens} tok against a ` +
        `${status.budgetTokens} tok budget — "${NEVER_DROP_TAG}" can no longer GUARANTEE delivery for ` +
        `every note in this tier; roughly ${status.roughFitCount} of ${status.floorCount} such notes fit.`
      : `floor tier (pinned + "${NEVER_DROP_TAG}") is ≈${status.floorTokens} tok of a ` +
        `${status.budgetTokens} tok budget (${status.floorCount} note(s)) — fits.`,
  };
}

/** Card 3b2aa339 (DoD-2 option b) — computed AFTER the write above already succeeded (never blocks it),
 *  same posture as {@link computeNeverDropStatus}. `undefined` when the note's (post-write) EFFECTIVE
 *  state isn't an ORDINARY pin — unpinned, or pinned-and-`NEVER_DROP_TAG`-tagged (that sub-tier already
 *  gets {@link computeNeverDropStatus}'s own signal; this one is deliberately its REST-tier sibling, not a
 *  duplicate for the same note). Reuses {@link computeRestTierStatus} — one function computes the numbers,
 *  this one only phrases them, so the estimate here can never silently diverge from the doc-commented
 *  measurement that motivated it. */
function computeRestTierSignal(
  db: Db,
  projectId: string,
  entry: ProjectMemoryEntry,
  budgetTokens: number,
): RestTierSignal | undefined {
  if (!entry.pinned || entry.tags.includes(NEVER_DROP_TAG)) return undefined;
  const pinnedNow = db.listPinnedProjectMemory(projectId);
  const annotate = (m: ProjectMemoryEntry) => annotateNote(db, projectId, m);
  const status = computeRestTierStatus(pinnedNow, budgetTokens, annotate);
  const cycle = status.roughCycleKickoffs;
  return {
    restCount: status.restCount,
    floorTokens: status.floorTokens,
    restCapEstimate: status.restCapEstimate,
    roughFitCount: status.roughFitCount,
    roughCycleKickoffs: cycle,
    message: cycle == null
      ? `this project's ordinary-pinned ("REST") tier now has ${status.restCount} note(s), and none of them ` +
        `are expected to fit this budget at all (a rotating LRU tier with roughly 0 slots) — "pinned" does NOT ` +
        `mean delivered here; consider "never-drop" only if this note must always ride, or leave it unpinned ` +
        `so it can compete on relevance via FTS instead.`
      : `this project's ordinary-pinned ("REST") tier now has ${status.restCount} note(s) competing for ` +
        `roughly ${status.roughFitCount} slot(s) per kickoff under a fair rotation — expect this note ` +
        `(and every other REST note) to be delivered on the order of once every ~${cycle} kickoffs, not every ` +
        `kickoff; "pinned" guarantees full-text inclusion only for the separate "never-drop" floor tier.`,
  };
}

/** Explicit curation (layer 1 of the two-layer cleanup mechanism — layer 2 is the bounded-store eviction
 *  in `writeProjectMemory`). Idempotent on a missing key: `deleted:false`, never an error. */
export function forgetProjectMemory(db: Db, projectId: string, key: string): { ok: true; deleted: boolean } {
  return { ok: true, deleted: db.deleteProjectMemory(projectId, key.trim()) };
}

/** A note plus its linked Requests' LIVE state, resolved fresh at read time (card e6d270b3) — see
 *  project-memory-request-links.ts. `text` itself is never mutated; annotations ride as their own field
 *  so the raw stored note is always distinguishable from the live-resolved commentary about it.
 *  `everDelivered` (card 738568b6) — DoD-4: `retrievalCount` is already on `ProjectMemoryEntry`, but it's
 *  a raw number an author has to know to interpret; this exposes the actual FACT it encodes (`retrievalCount
 *  > 0`, matching `ProjectMemoryEntry`'s own doc comment: bumped only on actual kickoff-digest inclusion,
 *  never on an explicit `memory_read`/`memory_list`) so an author can see at a glance that their note has
 *  never once reached a reader — no judgement about the note's quality, just the fact.
 *
 *  `backlinks` (card e4e180ad) — every OTHER note in this project whose text `[[wikilink]]`s to THIS
 *  note's key, resolved fresh at read time exactly like `requestAnnotations` (see
 *  sessions/project-memory-backlinks.ts): the fix for the one-way-link gap where a capped canonical note
 *  has no room to add the forward link its own overflow companion already carries back to it. Kept as
 *  its OWN field, deliberately never merged into `requestAnnotations` — the two are unrelated kinds of
 *  link. ALWAYS an array (never omitted), so an empty `backlinks: []` is a MEASURED zero — "this note has
 *  no inbound links" — structurally distinguishable from the field being absent altogether. */
export type ProjectMemoryEntryWithLinks = ProjectMemoryEntry & { requestAnnotations: string[]; everDelivered: boolean; backlinks: string[] };

function withLinks(db: Db, projectId: string, entry: ProjectMemoryEntry): ProjectMemoryEntryWithLinks {
  return {
    ...entry,
    requestAnnotations: annotateRequestLinks(db, projectId, entry.requestIds),
    everDelivered: entry.retrievalCount > 0,
    backlinks: annotateBacklinks(db, projectId, entry.key),
  };
}

/**
 * Full listing (small corpus by design — dozens to low-hundreds of short notes, per the card's design
 * doc) — pinned first, then most-recently-updated. Use `memory_forget`/re-`memory_write` to curate.
 * Each row is annotated with its linked Requests' LIVE state (card e6d270b3): `memory_list` returns full
 * note BODIES (unlike a metadata-only listing), so the same stale-decided-voice text this card exists to
 * fix would otherwise stand unchallenged here too — annotating only kickoff-injection + `memory_read`
 * would leave this access path telling a different story.
 */
export function listProjectMemoryEntries(db: Db, projectId: string): ProjectMemoryEntryWithLinks[] {
  return db.listProjectMemory(projectId).map((e) => withLinks(db, projectId, e));
}

/** Read ONE note in full by key, annotated with its linked Requests' LIVE state (card e6d270b3). */
export function readProjectMemory(db: Db, projectId: string, key: string): ProjectMemoryEntryWithLinks | { error: string } {
  const found = db.getProjectMemoryByKey(projectId, key.trim());
  if (!found) return { error: `no memory note with key "${key}" on this project` };
  return withLinks(db, projectId, found);
}

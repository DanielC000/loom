import type { ProjectMemoryEntry } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { annotateRequestLinks } from "../sessions/project-memory-request-links.js";

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
 *  digest's section header. */
const MAX_TEXT_BYTES = 4000;
const MAX_TITLE_CHARS = 200;

export interface MemoryWriteInput {
  key: string;
  text: string;
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
  /** How many bytes over MAX_TEXT_BYTES the submitted text is — trim without needing a re-fetch. */
  bytesOver: number;
  /** The EXISTING note (if this key already has one) to trim against — omitted for a brand-new key. */
  current?: ProjectMemoryEntry;
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
 * Card 249004c3: an update is a true PATCH, not a hard overwrite — `title`/`pinned`/`tags` the caller
 * OMITS from `input` are left unchanged on the stored row (only `text` + the version bump apply); passing
 * one explicitly (incl. `pinned:false`/`tags:[]`) still writes it verbatim. See
 * {@link Db.upsertProjectMemory} for the COALESCE mechanics that implement this.
 */
export function writeProjectMemory(
  db: Db,
  projectId: string,
  input: MemoryWriteInput,
): ProjectMemoryEntry | { error: string } | MemoryWriteConflict | MemoryWriteTooLong {
  const key = input.key?.trim();
  if (!key) return { error: "key is required" };
  if (!KEY_RE.test(key)) return { error: "key must be a short slug: letters, digits, '-', '_' only, 1-64 chars" };
  const text = input.text?.trim();
  if (!text) return { error: "text is required" };
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes > MAX_TEXT_BYTES) {
    return {
      error: `text is too long (${textBytes} bytes, max ${MAX_TEXT_BYTES}) — memory notes are short, curated facts, not a dumping ground; trim ${textBytes - MAX_TEXT_BYTES} bytes and retry`,
      bytesOver: textBytes - MAX_TEXT_BYTES,
      current: db.getProjectMemoryByKey(projectId, key),
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
  const maxNotes = resolveConfig(db.getProject(projectId)?.config).memory.maxNotes;
  const result = db.upsertProjectMemoryChecked(
    projectId,
    { key, title, text, pinned: input.pinned, tags: input.tags, requestIds },
    maxNotes,
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
  return result.entry;
}

/** Explicit curation (layer 1 of the two-layer cleanup mechanism — layer 2 is the bounded-store eviction
 *  in `writeProjectMemory`). Idempotent on a missing key: `deleted:false`, never an error. */
export function forgetProjectMemory(db: Db, projectId: string, key: string): { ok: true; deleted: boolean } {
  return { ok: true, deleted: db.deleteProjectMemory(projectId, key.trim()) };
}

/** A note plus its linked Requests' LIVE state, resolved fresh at read time (card e6d270b3) — see
 *  project-memory-request-links.ts. `text` itself is never mutated; annotations ride as their own field
 *  so the raw stored note is always distinguishable from the live-resolved commentary about it. */
export type ProjectMemoryEntryWithLinks = ProjectMemoryEntry & { requestAnnotations: string[] };

function withLinks(db: Db, projectId: string, entry: ProjectMemoryEntry): ProjectMemoryEntryWithLinks {
  return { ...entry, requestAnnotations: annotateRequestLinks(db, projectId, entry.requestIds) };
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

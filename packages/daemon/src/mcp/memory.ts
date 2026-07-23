import type { ProjectMemoryEntry } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";

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
  const maxNotes = resolveConfig(db.getProject(projectId)?.config).memory.maxNotes;
  const result = db.upsertProjectMemoryChecked(
    projectId,
    { key, title, text, pinned: input.pinned, tags: input.tags },
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

/** Full listing (small corpus by design — dozens to low-hundreds of short notes, per the card's design
 *  doc) — pinned first, then most-recently-updated. Use `memory_forget`/re-`memory_write` to curate. */
export function listProjectMemoryEntries(db: Db, projectId: string): ProjectMemoryEntry[] {
  return db.listProjectMemory(projectId);
}

/** Read ONE note in full by key. */
export function readProjectMemory(db: Db, projectId: string, key: string): ProjectMemoryEntry | { error: string } {
  const found = db.getProjectMemoryByKey(projectId, key.trim());
  return found ?? { error: `no memory note with key "${key}" on this project` };
}

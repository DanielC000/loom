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
}

/**
 * UPSERT by `key` (owner decision #2: always-update, hard-overwrite v1) — a second write to the same key
 * overwrites the note in place, so a changed fact updates rather than piling a contradictory duplicate.
 * Enforces the per-project bounded-store cap (`memory.maxNotes`, resolveConfig) on every write; pinned
 * notes are exempt (see `evictProjectMemoryOverCap` in db.ts).
 */
export function writeProjectMemory(db: Db, projectId: string, input: MemoryWriteInput): ProjectMemoryEntry | { error: string } {
  const key = input.key?.trim();
  if (!key) return { error: "key is required" };
  if (!KEY_RE.test(key)) return { error: "key must be a short slug: letters, digits, '-', '_' only, 1-64 chars" };
  const text = input.text?.trim();
  if (!text) return { error: "text is required" };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    return { error: `text is too long (${Buffer.byteLength(text, "utf8")} bytes, max ${MAX_TEXT_BYTES}) — memory notes are short, curated facts, not a dumping ground` };
  }
  const title = input.title?.trim() || undefined;
  if (title && title.length > MAX_TITLE_CHARS) {
    return { error: `title is too long (${title.length} chars, max ${MAX_TITLE_CHARS})` };
  }
  const maxNotes = resolveConfig(db.getProject(projectId)?.config).memory.maxNotes;
  return db.upsertProjectMemory(
    projectId,
    { key, title, text, pinned: input.pinned, tags: input.tags },
    maxNotes,
  );
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

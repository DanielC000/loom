import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Project, QuestionAttachmentKind } from "@loom/shared";
import { WORKTREES_DIR, LOOM_HOME, projectWorkDir, questionAttachmentDir } from "../paths.js";
import { canonicalizeForContainment, isProperlyUnder } from "../projects/vault-path.js";
import { comparisonKey } from "../projects/repos.js";
import type { StoredQuestionAttachment } from "../db.js";

/**
 * `question_ask`'s `attachments` resolution/copy pipeline (card 432765ab, epic 7d1d66ab phase 1). Shared
 * by BOTH `question_ask` registrations (`mcp/orchestration.ts`'s manager surface, `mcp/platform.ts`'s
 * Lead surface) — the same "one shared implementation, never duplicated per surface" discipline every
 * other `question_ask` concern in `questionTool.ts` already follows (lesson 198).
 *
 * @decision 432765ab — deliberately does NOT consult `Project.denyGlobs`: it is a repo-relative,
 * merge-review DIFFSTAT warning mechanism, not a file-access denylist, and the default `mockups/**`
 * entry would block exactly the mockup files this feature exists to attach.
 */

const PROJECT_REPO_ROOT_LABEL = "the project repo root";
const PROJECT_WORKTREES_LABEL = "the project's worker worktrees";
const PROJECT_WORK_DIR_LABEL = "the project's work dir";
const PROJECT_VAULT_ROOT_LABEL = "the project vault root";

export interface AttachmentRoot {
  label: string;
  path: string;
}

/** The allowed roots an attachment's absolute path must resolve inside — the project repo root, its
 *  worker worktrees, its work dir, its vault root (when bound), and every entry in its multi-repo
 *  `repos` registry. `repoPath`/`vaultPath` are pushed only when non-empty: an empty string canonicalizes
 *  to the daemon's own cwd, never a legitimate root. */
export type AttachmentProjectShape = Pick<Project, "id" | "repoPath" | "vaultPath" | "repos">;

export function attachmentAllowedRoots(project: AttachmentProjectShape): AttachmentRoot[] {
  const roots: AttachmentRoot[] = [];
  if (project.repoPath) roots.push({ label: PROJECT_REPO_ROOT_LABEL, path: project.repoPath });
  roots.push(
    { label: PROJECT_WORKTREES_LABEL, path: path.join(WORKTREES_DIR, project.id) },
    { label: PROJECT_WORK_DIR_LABEL, path: projectWorkDir(project.id) },
  );
  if (project.vaultPath) roots.push({ label: PROJECT_VAULT_ROOT_LABEL, path: project.vaultPath });
  for (const entry of project.repos ?? []) {
    if (entry.path) roots.push({ label: `the project repo '${entry.key}'`, path: entry.path });
  }
  return roots;
}

function describeAllowedRoots(roots: AttachmentRoot[]): string {
  return roots.map((r) => `${r.label} (${r.path})`).join("; ");
}

/** `canonicalizeForContainment` with the same raw-string-or-realpath-fallback posture
 *  `SETTINGS_DIR_REAL` (`pty/claude-settings.ts`) already uses for a module-load-time constant: never
 *  throws, degrades to the lexically-resolved form on a canonicalization failure instead of crashing. */
function canonicalizeOrFallback(raw: string): string {
  const r = canonicalizeForContainment(raw);
  return r.ok ? r.value : path.resolve(raw);
}

/**
 * `LOOM_HOME`'s own canonical comparison key, computed ONCE at module load. `ATTACHMENTS_DIR` (and
 * everything else LOOM_HOME-rooted) is a child of `LOOM_HOME`, so this one check structurally covers all
 * of them, including the attachment store itself.
 * @decision 432765ab — this refusal is MISTAKE/INJECTION HARDENING, the same class as root containment
 * — NOT a privilege boundary: a hard-linked LOOM_HOME file still passes it (closed separately, at the
 * file-identity checks below), and an asker with Bash can read LOOM_HOME by other means regardless.
 */
const LOOM_HOME_CANON_KEY = comparisonKey(canonicalizeOrFallback(LOOM_HOME));

export type AttachmentPathResolution =
  | { ok: true; absPath: string; dev: number; ino: number }
  | { ok: false; error: string };

/** POSIX-only (0 on win32, where it's genuinely absent — mirrors `vault/writer.ts`'s
 *  `O_NOFOLLOW_IF_POSIX`): opening a FIFO for read WITHOUT this blocks until a writer attaches, wedging
 *  the libuv threadpool after a handful of concurrent calls. With it, the open returns immediately and
 *  the `fstat` on that SAME fd tells us what was actually opened before anything tries to read it. */
const O_NONBLOCK_IF_POSIX = typeof (fs.constants as { O_NONBLOCK?: number }).O_NONBLOCK === "number"
  ? (fs.constants as { O_NONBLOCK: number }).O_NONBLOCK
  : 0;

/** POSIX-only (0 on win32): refuses outright (ELOOP) if the final path component is a symlink at open
 *  time, rather than silently following it — defense in depth on top of `canonicalizeForContainment`'s
 *  own resolution, for the window between that resolution and this open. Mirrors `vault/writer.ts`'s own
 *  use of the same flag. */
const O_NOFOLLOW_IF_POSIX = typeof (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number"
  ? (fs.constants as { O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

const ATTACHMENT_OPEN_FLAGS = fs.constants.O_RDONLY | O_NONBLOCK_IF_POSIX | O_NOFOLLOW_IF_POSIX;

/** Is `stat` (a real `fs.Stats`, or a test double shaped like one) an acceptable attachment target? A
 *  pure predicate — no I/O — so it can be unit-tested with a fake stat on any platform, independent of
 *  whether a real FIFO/socket/device file can even be created there (e.g. win32, where `mkfifo` doesn't
 *  exist). Deliberately does NOT check `nlink` — a hard-linked file is rejected by its own, separately
 *  named check at each call site, so a caller that wants to permit multi-linked files in some future
 *  context isn't forced to fork this predicate to do it. */
export function isAcceptableAttachmentStat(stat: { isFile(): boolean }): boolean {
  return stat.isFile();
}

/**
 * Open the CANONICAL path (never the raw string) and confirm it is a real, regular, SINGLY-linked file —
 * entirely via `fs.promises`, never throwing (every failure, including an unexpected `stat()` error,
 * degrades to a clean `{ok:false}` refusal rather than an uncaught rejection). Refuses a directory, a
 * FIFO/socket/device/block file (`isAcceptableAttachmentStat`, not merely `!isDirectory()` — opening a
 * FIFO without `O_NONBLOCK` blocks forever), and a HARD-LINKED file (`nlink > 1`).
 * Returns the file's `dev`+`ino` on success so a caller can re-verify the SAME identity at copy time —
 * see `copyAttachmentWithCap`'s own doc for why that re-check exists.
 */
async function openAndCheckRegularFile(canonicalPath: string, rawPathForError: string): Promise<AttachmentPathResolution> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(canonicalPath, ATTACHMENT_OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: false, error: `attachment not found on disk: ${rawPathForError}` };
    if (code === "EISDIR") return { ok: false, error: `attachment path is a directory, not a file: ${rawPathForError}` };
    if (code === "ELOOP") return { ok: false, error: `attachment path is (or became) a symlink: ${rawPathForError}` };
    return { ok: false, error: `could not open attachment: ${(err as Error).message}` };
  }
  try {
    const st = await handle.stat();
    if (st.isDirectory()) return { ok: false, error: `attachment path is a directory, not a file: ${rawPathForError}` };
    if (!isAcceptableAttachmentStat(st)) {
      return { ok: false, error: `attachment path is not a regular file: ${rawPathForError}` };
    }
    if (st.nlink > 1) {
      return { ok: false, error: `attachment path is a hard-linked file, which cannot be attached: ${rawPathForError}` };
    }
    return { ok: true, absPath: canonicalPath, dev: st.dev, ino: st.ino };
  } catch (err) {
    return { ok: false, error: `could not inspect attachment: ${(err as Error).message}` };
  } finally {
    await handle.close();
  }
}

/** One allowed root's RAW (lexical) and CANONICAL comparison keys, computed once per `resolveAttachmentPath`
 *  call and reused by both the lexical pre-filter and the precise containment check below — never
 *  recomputed per check. `canonKey` is null when the root itself can't be canonicalized (e.g. an
 *  unresolvable UNC `vaultPath`) — that root simply can't match either check, not this caller's error. */
interface RootKeys {
  root: AttachmentRoot;
  rawKey: string;
  canonKey: string | null;
}

function computeRootKeys(roots: AttachmentRoot[]): RootKeys[] {
  return roots.map((root) => {
    const rawKey = comparisonKey(path.resolve(root.path));
    const canon = canonicalizeForContainment(root.path);
    return { root, rawKey, canonKey: canon.ok ? comparisonKey(canon.value) : null };
  });
}

/** Does `targetKey` lexically match (equal to, or properly under) a root's raw or canonical key? Pure
 *  string comparison — no fs call. */
function lexicallyMatchesRoot(targetKey: string, keys: RootKeys): boolean {
  if (targetKey === keys.rawKey || isProperlyUnder(targetKey, keys.rawKey)) return true;
  return keys.canonKey !== null && (targetKey === keys.canonKey || isProperlyUnder(targetKey, keys.canonKey));
}

/**
 * Resolve ONE `attachments[i].path` to an absolute, PROVABLY-contained, existing REGULAR, SINGLY-linked
 * file — or refuse.
 *
 * @decision 432765ab — fixed order, never reorder: absolute → lexical root plausibility (no fs call) →
 * canonicalize/refuse unsafe forms → precise containment → LOOM_HOME refusal → only then touch the
 * filesystem, on the canonical path. Reordering reopens a synchronous-realpath-on-any-path hole.
 */
export async function resolveAttachmentPath(
  project: AttachmentProjectShape,
  rawPath: string,
): Promise<AttachmentPathResolution> {
  const roots = attachmentAllowedRoots(project);
  if (!path.isAbsolute(rawPath)) {
    return {
      ok: false,
      error: `path must be absolute: "${rawPath}" — allowed roots: ${describeAllowedRoots(roots)}`,
    };
  }

  // Roots are the daemon's OWN trusted, bounded-count paths — canonicalizing them is expected and cheap,
  // unlike canonicalizing an attacker-influenced target. Computed once, reused by both checks below.
  const rootKeys = computeRootKeys(roots);

  const lexicalTargetKey = comparisonKey(path.resolve(rawPath));
  const plausible = rootKeys.some((keys) => lexicallyMatchesRoot(lexicalTargetKey, keys));
  if (!plausible) {
    return {
      ok: false,
      error: `attachment path is outside every allowed root: ${rawPath} — allowed roots are ${describeAllowedRoots(roots)}`,
    };
  }

  const targetCanon = canonicalizeForContainment(rawPath);
  if (!targetCanon.ok) return { ok: false, error: targetCanon.error };
  const targetKey = comparisonKey(targetCanon.value);

  if (targetKey === LOOM_HOME_CANON_KEY || isProperlyUnder(targetKey, LOOM_HOME_CANON_KEY)) {
    return {
      ok: false,
      error: `attachment path resolves under LOOM_HOME, which is never an allowed attachment source regardless of how this project's paths are bound: ${rawPath}`,
    };
  }

  let matchedRoot = false;
  for (const keys of rootKeys) {
    if (keys.canonKey === null) continue;
    if (targetKey === keys.canonKey) {
      return { ok: false, error: `attachment path is a root itself, not a file inside one: ${rawPath}` };
    }
    if (isProperlyUnder(targetKey, keys.canonKey)) {
      matchedRoot = true;
      break;
    }
  }
  if (!matchedRoot) {
    return {
      ok: false,
      error: `attachment path is outside every allowed root: ${rawPath} — allowed roots are ${describeAllowedRoots(roots)}`,
    };
  }

  return openAndCheckRegularFile(targetCanon.value, rawPath);
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const HTML_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm"]);

/** Derived SERVER-SIDE from the copied file's own extension — never from the asker's say-so. */
export function deriveAttachmentKind(absPath: string): QuestionAttachmentKind {
  const ext = path.extname(absPath).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

/** Generous bound on how much of the file's head we read to find PNG/JPEG dimensions — real header/SOF
 *  markers sit well within this for any ordinary image; never a reason to read the whole file. */
const DIMENSION_PROBE_BYTES = 65536;

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Scans JPEG markers for the first SOF (start-of-frame) segment, which carries height/width — the ONLY
 *  markers that do. Skips every other marker by its own declared segment length. */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1] as number;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null; // malformed segment length — bail rather than loop forever
    offset += 2 + segLen;
  }
  return null;
}

/** Cheap, header-only image dimensions — never a full decode, never a new dependency. Returns null for a
 *  non-image kind, an unrecognized format, or a header that couldn't be parsed — NEVER a reason to refuse
 *  the attachment itself. Reads a path already confirmed (by the caller) to be a regular file. */
export function cheapImageDimensions(absPath: string, kind: QuestionAttachmentKind): { width: number; height: number } | null {
  if (kind !== "image") return null;
  let buf: Buffer;
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const full = Buffer.alloc(DIMENSION_PROBE_BYTES);
      const bytesRead = fs.readSync(fd, full, 0, DIMENSION_PROBE_BYTES, 0);
      buf = full.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return readPngDimensions(buf) ?? readJpegDimensions(buf);
}

export type CopyWithCapResult = { ok: true; bytes: number } | { ok: false; error: "too-large" | string };

const COPY_CHUNK_BYTES = 256 * 1024;

export interface ExpectedAttachmentIdentity {
  dev: number;
  ino: number;
}

/**
 * Copy `srcPath` → `destPath`, refusing once the BYTES ACTUALLY TRANSFERRED exceed `capBytes` (never a
 * pre-copy `fs.stat` size check). `destPath`'s parent dir must already exist.
 *
 * @decision 432765ab — RE-OPENS and re-validates (`O_NONBLOCK`+`O_NOFOLLOW`, `isAcceptableAttachmentStat`,
 * `nlink===1`, the SAME `dev`/`ino` resolve-time captured) rather than trusting the earlier resolve-time
 * check — closes the resolve-then-copy swap window; any mismatch refuses before a byte is read.
 *
 * `onChunk` is a TEST-ONLY hook (never set by production code) called after each chunk is written — lets
 * a test deterministically grow the source file mid-copy without any real concurrency or sleep.
 */
export async function copyAttachmentWithCap(
  srcPath: string,
  destPath: string,
  capBytes: number,
  expectedIdentity: ExpectedAttachmentIdentity,
  onChunk?: () => void | Promise<void>,
): Promise<CopyWithCapResult> {
  let srcFile: fsp.FileHandle;
  try {
    srcFile = await fsp.open(srcPath, ATTACHMENT_OPEN_FLAGS);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    const st = await srcFile.stat();
    if (!isAcceptableAttachmentStat(st) || st.nlink !== 1 || st.dev !== expectedIdentity.dev || st.ino !== expectedIdentity.ino) {
      return { ok: false, error: "file changed after validation" };
    }
    let destFile: fsp.FileHandle;
    try {
      destFile = await fsp.open(destPath, "wx");
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      let total = 0;
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await srcFile.read(buf, 0, COPY_CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > capBytes) return { ok: false, error: "too-large" };
        await destFile.write(buf, 0, bytesRead);
        if (onChunk) await onChunk();
      }
      return { ok: true, bytes: total };
    } finally {
      await destFile.close();
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await srcFile.close();
  }
}

/** Strip path separators, every win32-illegal filename character (`:<>"|?*` — closes an alternate-data-
 *  stream write via a crafted `label`-derived basename like `in.txt:ads`), and control characters, then
 *  drop any leading dots (never a hidden/dotfile in the store). Falls back to a fixed name rather than an
 *  empty string. */
export function sanitizeBasename(name: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes from a filename
  const cleaned = name.replace(/[\\/:<>"|?*\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return cleaned || "attachment";
}

export interface AttachmentInput {
  path: string;
  label?: string;
}

export type PrepareAttachmentsResult =
  | { ok: true; attachments: StoredQuestionAttachment[] }
  | { ok: false; error: string };

/** TEST-ONLY hooks (never set by production code) for `prepareQuestionAttachments` — let a test drive a
 *  race deterministically instead of with real concurrency/sleep. `beforeCopy` fires immediately before
 *  copying attachment `index`, after EVERY attachment has already been resolved — the exact window where
 *  a later attachment's file could be swapped while an earlier one is still copying. */
export interface PrepareAttachmentsTestHooks {
  beforeCopy?: (index: number, absPath: string) => void | Promise<void>;
}

/**
 * Resolve, cap-check, and copy EVERY `question_ask` attachment for one request — the shared orchestrator
 * both `question_ask` registrations call, AFTER `buildQuestionAsk` and BEFORE `db.insertQuestion`.
 *
 * Ordering (card 432765ab §3/§4, the atomicity contract): resolve EVERY path first (reject the WHOLE
 * call on the first bad one, nothing copied, nothing inserted), then — only once every path resolves —
 * create the store dir and copy them all in; any single copy failure removes the WHOLE store dir before
 * returning an error. The caller still wraps its own `db.insertQuestion` in try/catch to remove this same
 * dir if THAT throws — this function only closes the copy-phase half of that contract.
 */
export async function prepareQuestionAttachments(
  project: AttachmentProjectShape,
  questionId: string,
  inputs: AttachmentInput[] | undefined,
  caps: { maxBytes: number; maxCount: number },
  testHooks?: PrepareAttachmentsTestHooks,
): Promise<PrepareAttachmentsResult> {
  if (!inputs || inputs.length === 0) return { ok: true, attachments: [] };
  if (inputs.length > caps.maxCount) {
    return { ok: false, error: `attachments: ${inputs.length} attachment(s) exceeds the per-request cap of ${caps.maxCount}` };
  }
  const resolved: { absPath: string; label: string; dev: number; ino: number }[] = [];
  for (const [i, input] of inputs.entries()) {
    const r = await resolveAttachmentPath(project, input.path);
    if (!r.ok) return { ok: false, error: `attachments[${i}]: ${r.error}` };
    resolved.push({ absPath: r.absPath, label: input.label?.trim() || path.basename(r.absPath), dev: r.dev, ino: r.ino });
  }
  const storeDir = questionAttachmentDir(questionId);
  try {
    fs.mkdirSync(storeDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create the attachment store dir: ${(err as Error).message}` };
  }
  const stored: StoredQuestionAttachment[] = [];
  try {
    for (const [i, { absPath, label, dev, ino }] of resolved.entries()) {
      if (testHooks?.beforeCopy) await testHooks.beforeCopy(i, absPath);
      const kind = deriveAttachmentKind(absPath);
      const storedFilename = `${i}-${sanitizeBasename(path.basename(absPath))}`;
      const destPath = path.join(storeDir, storedFilename);
      const copyResult = await copyAttachmentWithCap(absPath, destPath, caps.maxBytes, { dev, ino });
      if (!copyResult.ok) {
        const reason = copyResult.error === "too-large"
          ? `exceeds the ${caps.maxBytes}-byte per-attachment cap`
          : copyResult.error;
        throw new Error(`attachments[${i}] ("${label}"): ${reason}`);
      }
      stored.push({
        id: String(i),
        label,
        kind,
        sizeBytes: copyResult.bytes,
        imageDimensions: cheapImageDimensions(destPath, kind),
        storedFilename,
        originalPath: absPath,
        openedAt: null,
      });
    }
  } catch (err) {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup — the orphan dir, if it survives, is the (separate, not-yet-built) GC card's concern */ }
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, attachments: stored };
}

// --- Serving-route helpers (card 8f050b79, child 2) ---------------------------------------------------

/** The question id shape `question_ask` actually mints (`randomUUID()`, questionTool.ts) — a v4 UUID. */
export const QUESTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The per-attachment id shape `prepareQuestionAttachments` actually mints above (`id: String(i)`) — a
 *  bare non-negative integer string, bounded so a pathological digit run can't be used to probe anything. */
export const ATTACHMENT_ID_RE = /^[0-9]{1,10}$/;

/** Content-Type for the two kinds this route renders INLINE (never trusted from the asker — this is the
 *  SAME extension derivation `deriveAttachmentKind` already committed to at copy time, just mapped to a
 *  servable type). Everything else (`kind:"other"`, which already includes `.svg` — see the module doc
 *  below) is served `application/octet-stream` regardless of its real extension: it downloads either
 *  way (`Content-Disposition: attachment`), so a precise type buys nothing and a wrong one costs nothing. */
const INLINE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};

export function attachmentServeContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return INLINE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export type ResolveStoredAttachmentResult = { ok: true; absPath: string } | { ok: false };

/**
 * Resolve ONE already-stored attachment's absolute file path from its DB record's `storedFilename` —
 * defence in depth (card 8f050b79, manager condition 1): `storedFilename` is entirely daemon-written
 * (`sanitizeBasename` at copy time, never client input), so this can never actually escape in practice,
 * but the route still canonicalizes and re-checks containment under THIS question's own store dir before
 * any fs touch — the same "never trust a path without re-proving containment, however it was produced"
 * posture `resolveAttachmentPath` (above) applies on the write side. Pure path-math; does not touch the
 * filesystem beyond canonicalization (no existence/regular-file check — the caller does that separately,
 * since a missing file is a 404, not a resolution failure).
 */
export function resolveStoredAttachmentFile(questionId: string, storedFilename: string): ResolveStoredAttachmentResult {
  const dir = questionAttachmentDir(questionId);
  const rawTarget = path.join(dir, storedFilename);
  const canonDir = canonicalizeForContainment(dir);
  const canonTarget = canonicalizeForContainment(rawTarget);
  if (!canonDir.ok || !canonTarget.ok) return { ok: false };
  const dirKey = comparisonKey(canonDir.value);
  const targetKey = comparisonKey(canonTarget.value);
  if (!isProperlyUnder(targetKey, dirKey)) return { ok: false };
  return { ok: true, absPath: canonTarget.value };
}

/** RFC 5987 `attr-char` — everything else in a `filename*=UTF-8''…` value must be percent-encoded. */
const RFC5987_ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

function encodeRfc5987Value(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += RFC5987_ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Build a `Content-Disposition: attachment` header value from an attachment's human-authored `label` —
 * card 8f050b79, manager condition 3. Two hardening steps, in order:
 *  1. Strip CR/LF and every other control character FIRST, unconditionally — this is what stops a label
 *     like `evil"\r\nX-Injected: yes` from smuggling a second header line; everything below operates on
 *     the already-cleaned string, so neither encoding step can reintroduce the byte this removes.
 *  2. Emit BOTH forms, same as every modern server: a legacy ASCII `filename="…"` fallback (non-ASCII
 *     collapsed to `_`, `"`/`\` backslash-escaped per the quoted-string grammar) for a client that only
 *     reads the old parameter, and the RFC 5987 `filename*=UTF-8''…` extended form for everyone else,
 *     which is what actually preserves non-ASCII labels (e.g. a mockup titled in Japanese) losslessly.
 */
export function attachmentContentDisposition(label: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes (incl. CR/LF) from a header value
  const cleaned = label.replace(/[\x00-\x1f\x7f]/g, "").trim() || "attachment";
  const asciiRaw = cleaned.replace(/[^\x20-\x7e]/g, "_");
  const asciiEscaped = asciiRaw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `attachment; filename="${asciiEscaped}"; filename*=UTF-8''${encodeRfc5987Value(cleaned)}`;
}

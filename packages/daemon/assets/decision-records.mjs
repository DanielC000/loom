#!/usr/bin/env node
// Loom decision-record injector — PostToolUse hook on `Read` (card 661b7d46).
//
// Loom's source anchors durable decision/rationale prose with a short marker:
//   // @decision <8hex card id> — <the prohibition or consequence>   (<=3 lines, comment-syntax agnostic)
// and stores the COMPLETE record out of band, keyed by that same id, in one of three stores (see
// CLAUDE.md's decision-records convention, card 90b19799): `docs/adr/<id>*.md` (immutable),
// `docs/decisions/<id>*.md` (mutable), or an existing `docs/investigations/<id>-*/findings.md`.
//
// A `Read` call only ever sees whatever byte range it actually asked for — a ranged read can slice
// straight through a long comment block and deliver a fragment that carries the OPPOSITE instruction of
// the whole (measured: 42.1% of block/window intersections truncated — see card 661b7d46's own evidence).
// Anchors fix this structurally: the anchor itself is short enough to always survive a read window
// intact, and THIS hook appends the FULL, out-of-band record whenever an anchor's line falls inside the
// range the `Read` tool actually returned (or immediately ABOVE it, in the same undivided block — see
// `expandStartToBlock` below) — so the agent always sees the complete record, never a slice of it.
//
// Invoked by Claude Code as: node decision-records.mjs <dedupeDir>
// Reads the PostToolUse payload on stdin: {tool_name, tool_input:{file_path,offset,limit}, session_id,
// cwd}. A non-`Read` tool, a file outside the session's own repo, a repo with none of the three record
// stores, an unreadable file, or a read range with no anchored id in it are all fast, silent no-ops —
// byte-identical to a session with no injection at all (DoD-2). Always exits 0: a bug in this script
// must never block or alter the underlying `Read` result.
//
// On a hit, writes a JSON object to stdout carrying the record via BOTH `systemMessage` and PostToolUse
// `hookSpecificOutput.additionalContext` (whichever the running Claude honors) — the same non-blocking
// advisory shape `vault-lint.mjs` already uses. This hook never blocks or denies a `Read`.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Deliberately comment-syntax-agnostic: matches the literal token regardless of what precedes it (`//`,
// `#`, `--`, `/*`, ...), so the SAME anchor format works in .ts/.mjs/.py/.sql/.md source alike. Global
// (`g`) so a line carrying more than one anchor yields every id, not just the first (card review N4).
const ANCHOR_RE = /@decision\s+([0-9a-f]{8})\b/gi;
// Flat `<id>*.md` stores, checked in this order. `docs/investigations/` is handled separately below —
// its existing convention nests each report under its own `<id>-<slug>/` directory (see any
// docs/investigations/*/findings.md), not a flat file.
const FLAT_STORES = ["adr", "decisions"];
const PER_RECORD_MAX_BYTES = 4000; // a single oversized record is truncated WITH an explicit signal, never silently.
const TOTAL_MAX_BYTES = 12000; // once the total for this call would exceed this, further WHOLE records are dropped (never partially).
const BLOCK_EXPAND_MAX = 40; // bounds the blank-line-delimited "enclosing block" upward lookback below.
const DEFAULT_READ_LIMIT = 2000; // the real Read tool's own default line cap when offset/limit are omitted.

/** Walk up from `startDir` looking for a `.git` entry (dir or file — worktrees use a file). */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Whether `repoRoot` has adopted ANY of the three record stores at all. Card-review S1: the cheapest
 * possible early-out — a project that hasn't started using @decision anchors yet (true of most projects,
 * and even of docs/adr and docs/decisions in THIS repo today) never pays the cost of reading the target
 * file below. Three fs.existsSync calls, never a directory listing.
 */
function anyStoreExists(repoRoot) {
  return fs.existsSync(path.join(repoRoot, "docs", "adr"))
    || fs.existsSync(path.join(repoRoot, "docs", "decisions"))
    || fs.existsSync(path.join(repoRoot, "docs", "investigations"));
}

/**
 * Read only lines [0, maxLineIndex] of `filePath` (0-indexed, inclusive), stopping the underlying stream
 * as soon as that many lines have been consumed rather than reading the whole file into memory first
 * (card-review S1: the prior `readFileSync` + `split` scaled with FILE size, not with the read window —
 * the inverse of the `Read` tool's own cost model, worst on exactly the comment-heaviest files this card
 * targets). If the file is shorter than `maxLineIndex`, resolves with however many lines it actually has.
 */
function readLinesUpTo(filePath, maxLineIndex) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      if (err) reject(err); else resolve(lines);
    };
    stream.on("error", finish);
    rl.on("line", (line) => {
      lines.push(line);
      if (lines.length > maxLineIndex + 1) finish();
    });
    rl.on("close", finish);
  });
}

/**
 * The start of the blank-line-delimited block containing `start` (0-indexed), expanded UPWARD ONLY,
 * bounded by BLOCK_EXPAND_MAX lines. This is a heuristic stand-in for "the enclosing symbol" (card
 * 661b7d46's own wording) — not a real AST symbol boundary — chosen because it's cheap, dependency-free,
 * and mirrors a heuristic already used elsewhere in this repo (docs/investigations/
 * e3faa8ac-fixed-wait-polarity) for the same "which block is this line part of" question. It catches the
 * common case of an anchor comment sitting immediately above a function/section whose body starts
 * mid-window, without scanning the file.
 *
 * ⛔ Deliberately NOT symmetric (card-review B1): expanding DOWNWARD past the literally-requested range
 * would find an anchor for a LATER section the agent's `Read` call never actually returned, inject it
 * under a header claiming it governs "this range" (false), and mark it delivered — so when the agent
 * later reads the section that anchor actually documents, the hook would wrongly stay silent. An anchor
 * comment precedes the code it documents, never follows it, so only upward expansion is justified.
 */
function expandStartToBlock(lines, start) {
  let s = start;
  for (let n = 0; s > 0 && lines[s - 1].trim() !== "" && n < BLOCK_EXPAND_MAX; n++) s--;
  return s;
}

/** True iff `nameLower` is `id` followed by a real boundary (`-`, `.`, or nothing) — never a bare prefix
 * match, which would let id `deadbeef` match an unrelated `deadbeefcafe-other.md` (card-review N3). */
function idBoundaryMatch(nameLower, id) {
  if (!nameLower.startsWith(id)) return false;
  const rest = nameLower.slice(id.length);
  return rest === "" || rest.startsWith("-") || rest.startsWith(".");
}

/** Resolve an anchored `id` to its full record text + source path, across the three stores. Null if none.
 * Deterministic: candidates are sorted before picking the first (card-review N3 — `readdirSync` order is
 * not guaranteed). */
function resolveRecord(repoRoot, id) {
  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const hit = entries
      .filter((n) => n.toLowerCase().endsWith(".md") && idBoundaryMatch(n.toLowerCase(), id))
      .sort()[0];
    if (hit) {
      const full = path.join(dir, hit);
      try { return { recordPath: full, text: fs.readFileSync(full, "utf8") }; } catch { /* fall through to next store */ }
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let entries;
  try { entries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { entries = []; }
  const hitDir = entries
    .filter((e) => e.isDirectory() && idBoundaryMatch(e.name.toLowerCase(), id))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (hitDir) {
    const full = path.join(invDir, hitDir.name, "findings.md");
    try { return { recordPath: full, text: fs.readFileSync(full, "utf8") }; } catch { /* no findings.md at that dir — no record */ }
  }
  return null;
}

function loadDelivered(dedupeFile) {
  try { return new Set(JSON.parse(fs.readFileSync(dedupeFile, "utf8"))); } catch { return new Set(); }
}
function saveDelivered(dedupeFile, ids) {
  try {
    fs.mkdirSync(path.dirname(dedupeFile), { recursive: true });
    fs.writeFileSync(dedupeFile, JSON.stringify([...ids]));
  } catch { /* best-effort — a lost dedupe write only costs a re-injection later, never a correctness bug */ }
}

function relPath(repoRoot, p) {
  return path.relative(repoRoot, p).replace(/\\/g, "/");
}

/** True iff byte `b` is a UTF-8 CONTINUATION byte (`10xxxxxx`) — i.e. the middle/tail of a multi-byte
 * codepoint, never a valid place to cut a UTF-8 buffer. */
function isContinuationByte(b) { return (b & 0xc0) === 0x80; }

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, keeping the HEAD and the TAIL (never just the head:
 * card-review N2 — this repo's own convention puts caveats/bounds LAST in a comment, so a head-only cut
 * keeps the claim and drops its qualifier, reproducing this very card's thesis inside the injector
 * itself), snapping both cut points to a real codepoint boundary so a multi-byte character (this repo's
 * house typography — em dashes, arrows, warning glyphs — is 2-3 bytes each) is never split mid-sequence
 * (card-review B2: the prior `body.slice(0, maxBytes)` sliced UTF-16 CODE UNITS, so e.g. 4000 chars of
 * 3-byte em dashes produced 12000 BYTES — 3x the stated cap, silently blowing the shared per-call budget
 * and causing an otherwise-fitting record to be dropped whole instead of truncated).
 */
function truncateRecord(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const marker = "\n\n… [elided — see full record] …\n\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const remaining = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.min(buf.length, Math.ceil(remaining * 0.6));
  const tailBudget = Math.max(0, remaining - headBudget);
  let headEnd = headBudget;
  while (headEnd > 0 && isContinuationByte(buf[headEnd])) headEnd--; // never end mid-codepoint
  let tailStart = Math.max(headEnd, buf.length - tailBudget);
  while (tailStart < buf.length && isContinuationByte(buf[tailStart])) tailStart++; // never start mid-codepoint
  const head = buf.slice(0, headEnd).toString("utf8");
  const tail = tailStart < buf.length ? buf.slice(tailStart).toString("utf8") : "";
  return { text: `${head}${marker}${tail}`, truncated: true };
}

/**
 * Write `obj` as JSON to stdout and resolve only once the write has actually flushed — never before
 * (card-review N6). On some platforms (macOS: stdout to a pipe is non-blocking) a `process.exit()` issued
 * immediately after `write()` can race the OS-level flush and silently drop the record; awaiting the
 * write's own callback (with a bounded, unref'd fallback so a wedged stream still exits) closes that
 * race. `main()`'s no-output paths never call this and exit immediately — nothing to flush.
 */
function emit(obj) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    process.stdout.write(JSON.stringify(obj), finish);
    setTimeout(finish, 2000).unref();
  });
}

async function main() {
  const dedupeDir = process.argv[2];
  if (!dedupeDir) return;

  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  if (payload.tool_name !== "Read") return;
  let filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string") return;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (!path.isAbsolute(filePath)) filePath = path.resolve(cwd, filePath);

  // Card-review S4: never resolve records against a repo other than the session's own. Without this, a
  // Read of a file that happens to live in a DIFFERENT repo on the same host (a reference checkout, a
  // sibling worktree) would inject THAT tree's decision records into this session — an unscoped read of
  // arbitrary host directories. `sessionRoot` is derived from the session's own cwd, never from the file
  // path being read, so it can't be steered by the file argument itself.
  const sessionRoot = findRepoRoot(cwd);
  if (!sessionRoot) return;
  const fileRoot = findRepoRoot(path.dirname(filePath));
  if (!fileRoot || path.resolve(fileRoot) !== path.resolve(sessionRoot)) return;
  const repoRoot = sessionRoot;

  // Card-review S1: bail before ever touching the target file when this repo has adopted NONE of the
  // three record stores — the common case for a project that hasn't started using @decision anchors yet.
  if (!anyStoreExists(repoRoot)) return;

  // The Read tool's own default (no offset/limit given) is "from line 1, up to 2000 lines" — NOT the
  // whole file. Matching that default matters: assuming "whole file" here would inject a record anchored
  // past line 2000 of a large file the agent's actual Read call never returned, associating the injected
  // context with code the agent never saw.
  const offset = Number.isInteger(payload.tool_input?.offset) ? payload.tool_input.offset : 1;
  const limit = Number.isInteger(payload.tool_input?.limit) ? payload.tool_input.limit : DEFAULT_READ_LIMIT;
  const startIdx = Math.max(0, offset - 1); // Read's `offset` is 1-indexed
  const provisionalEndIdx = startIdx + limit - 1;
  if (startIdx > provisionalEndIdx) return;

  // Card-review S1: stream only up to the window we might need — block expansion is upward-only (see
  // expandStartToBlock, B1), so nothing past provisionalEndIdx is ever needed — instead of reading and
  // splitting the WHOLE file. Bounds this hook's cost to the read window (plus whatever precedes it up to
  // that point in the file), never to total file size.
  let lines;
  try { lines = await readLinesUpTo(filePath, provisionalEndIdx); } catch { return; }
  if (lines.length === 0) return;
  const endIdx = Math.min(lines.length - 1, provisionalEndIdx);
  if (startIdx > endIdx) return;

  const blockStart = expandStartToBlock(lines, startIdx);

  const foundIds = new Set();
  for (let i = blockStart; i <= endIdx; i++) {
    for (const m of lines[i].matchAll(ANCHOR_RE)) foundIds.add(m[1].toLowerCase());
  }
  if (foundIds.size === 0) return; // no anchor in the actually-read range (or its block) → byte-identical to today (DoD-2)

  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "unknown";
  const dedupeFile = path.join(dedupeDir, `${sessionId}.json`);
  const delivered = loadDelivered(dedupeFile);

  const candidates = [];
  for (const id of foundIds) {
    if (delivered.has(id)) continue; // per-session dedupe (DoD-3)
    const record = resolveRecord(repoRoot, id);
    if (record) candidates.push({ id, ...record });
  }
  if (candidates.length === 0) return; // every anchor already delivered this session, or its store entry is missing (DoD-5)

  let budget = TOTAL_MAX_BYTES;
  const sections = [];
  const omitted = [];
  const newlyDelivered = [];
  for (const { id, recordPath, text } of candidates) {
    const { text: body, truncated } = truncateRecord(text, PER_RECORD_MAX_BYTES);
    const rel = relPath(repoRoot, recordPath);
    const rendered = `### decision ${id} (${rel})\n\n${body}`
      + (truncated ? `\n\n[TRUNCATED at ${PER_RECORD_MAX_BYTES} bytes — head+tail kept, middle elided — full record: ${rel}]` : "");
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    // Past budget: drop the WHOLE record rather than truncate it further — a record already at its own
    // per-record cap is truncated-with-signal above; a record that merely lost the race for shared
    // budget is omitted whole, named explicitly, never half-included a second time. Deliberately NOT
    // marked delivered here — a later call with a different (smaller) candidate set may still have room.
    if (renderedBytes > budget) { omitted.push({ id, recordPath }); continue; }
    sections.push(rendered);
    budget -= renderedBytes;
    newlyDelivered.push(id);
  }

  if (sections.length === 0) {
    // Every candidate was too large to fit even alone — now unreachable in ordinary operation since a
    // single truncated record's rendered size is always well under TOTAL_MAX_BYTES (see truncateRecord),
    // kept as a defensive branch. Say so explicitly (never silent: DoD-4's whole point is that a
    // silently-dropped record is exactly the failure mode this card exists to prevent) — AND mark these
    // delivered (card-review N1: an un-marked, permanently-too-large candidate would otherwise re-emit
    // this identical note on every future read of the same region, forever, in this session).
    const note = `${omitted.length} decision record(s) governing this range were too large to inject (byte budget ${TOTAL_MAX_BYTES}) — read directly: `
      + omitted.map((o) => relPath(repoRoot, o.recordPath)).join(", ");
    for (const { id } of omitted) delivered.add(id);
    saveDelivered(dedupeFile, delivered);
    await emit({ systemMessage: note, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
    return;
  }

  for (const id of newlyDelivered) delivered.add(id);
  saveDelivered(dedupeFile, delivered);

  const omittedNote = omitted.length
    ? `\n\n(${omitted.length} further record(s) omitted for byte budget — read directly: ${omitted.map((o) => relPath(repoRoot, o.recordPath)).join(", ")})`
    : "";
  const msg = `Complete decision record(s) governing this range (injected in full — never a positional fragment):\n\n${sections.join("\n\n---\n\n")}${omittedNote}`;

  await emit({
    systemMessage: msg,
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg },
  });
}

main().catch(() => {}).finally(() => process.exit(0));

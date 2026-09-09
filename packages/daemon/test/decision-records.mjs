// decision-records.mjs PostToolUse hook test (card 661b7d46). Fully deterministic — no daemon, no
// claude. Invokes the shipped decision-records.mjs asset directly with synthetic PostToolUse `Read`
// payloads on stdin against a fixture "repo" (a temp dir with its own `.git` marker + docs/adr,
// docs/decisions, docs/investigations), and asserts:
//   DoD-1: a read whose range (or enclosing block) intersects a `// @decision <id>` anchor returns that
//          record's COMPLETE text, resolved live from the fixture repo at call time.
//   DoD-2: a read with no anchored id in range is byte-identical to no hook at all (empty stdout).
//   DoD-3: per-session dedupe — a repeat read of the same anchored region injects nothing the second
//          time in the SAME session, but still injects in a DIFFERENT session.
//   DoD-4: a byte cap is enforced two ways — a single oversized record is truncated WITH an explicit
//          signal (never silently), and when several records compete for one call's shared budget,
//          excess ones are dropped WHOLE and named, never partially included a second time.
//   DoD-5: negative control — an anchor whose id resolves to NO record in any store stays silent, but
//          the SAME store/mechanism is proven capable of firing first (a known-present id, above).
// Plus code-review regressions (2026-09-09):
//   B1: block expansion is upward-only — a read strictly BEFORE an anchor (dense file, no blank lines)
//       must never reach it via downward expansion, and must never falsely mark it delivered.
//   B2: truncation is byte-accurate on MULTI-BYTE content (this repo's own em-dash-heavy prose) — never
//       a UTF-16-code-unit slice that silently triples the real byte count.
//   S4: never resolve records against a repo OTHER than the session's own cwd.
//   N2: truncation keeps HEAD and TAIL, not just the head (a trailing caveat must survive).
//   N3: id resolution requires a real boundary after the id (no bare-prefix false match) and is
//       deterministic.
//   N4: a single line carrying two anchors yields both ids.
//
// RUN with an isolated LOOM_HOME (writeSessionSettings just needs the settings dir; no daemon needed):
//   pnpm build (repo root) then `node test/decision-records.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DECISION_RECORDS_SCRIPT, SETTINGS_DIR, ensureDirs } from "../dist/paths.js";
import { writeSessionSettings } from "../dist/pty/claude-settings.js";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- fixture repo: a temp dir with its own `.git` marker + the three record stores ---
const REPO = path.join(os.tmpdir(), `loom-decrec-repo-${Date.now()}-${process.pid}`);
const DEDUPE_DIR = path.join(os.tmpdir(), `loom-decrec-dedupe-${Date.now()}-${process.pid}`);
const FOREIGN_REPO = path.join(os.tmpdir(), `loom-decrec-foreign-${Date.now()}-${process.pid}`); // S4: a DIFFERENT repo on the same host
const NO_STORE_REPO = path.join(os.tmpdir(), `loom-decrec-nostore-${Date.now()}-${process.pid}`); // S1: a repo with no record store at all
fs.mkdirSync(path.join(REPO, ".git"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "decisions"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-a-real-investigation"), { recursive: true });

fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-adr-store.md"), "# ADR aaaaaaaa\n\nAn immutable decision record, resolved from docs/adr.\n");
fs.writeFileSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-a-real-investigation", "findings.md"), "# bbbbbbbb — findings\n\nAn investigation report, resolved from the nested docs/investigations convention.\n");
fs.writeFileSync(path.join(REPO, "docs", "decisions", "dddddddd-decisions-store.md"), "# Decision dddddddd\n\nA mutable decision record, resolved from docs/decisions.\n");
// deadbeef: deliberately oversized (> the script's 4000-byte per-record cap).
fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadbeef-oversized.md"), "# deadbeef\n\n" + "x".repeat(5000) + "\n");
// four ~3500-byte records that individually fit the per-record cap but together exceed the shared
// per-call budget (3 * ~3550 fits under 12000; a 4th does not) — for the drop-whole-record case.
for (const id of ["e0000001", "e0000002", "e0000003", "e0000004"]) {
  fs.writeFileSync(path.join(REPO, "docs", "decisions", `${id}-budget.md`), `# ${id}\n\n` + "y".repeat(3480) + "\n");
}

// --- fixture source file: several blank-line-delimited blocks. Built with a line-tracking helper (never
// hand-counted line numbers) so every anchor's real 1-indexed line is known exactly, however the blocks
// around it are shaped. ---
const srcLines = [];
const lineOf = {}; // id -> 1-indexed line number of its anchor comment
const push = (text) => { srcLines.push(text); return srcLines.length; }; // returns the new line's 1-indexed number
const blank = () => srcLines.push("");
const filler = (n, label) => { for (let i = 0; i < n; i++) push(`// filler ${label}${i}`); };

// Block A: anchor aaaaaaaa NOT on the first line of the block — a read of a LATER line in the same
// block must still expand upward and find it (DoD-1's "enclosing block" scope control).
filler(3, "A-pre");
lineOf.aaaaaaaa = push("// @decision aaaaaaaa — always X, never Y");
filler(8, "A-post");
blank();

// Block B: anchor bbbbbbbb alone (resolves via the nested docs/investigations convention).
filler(2, "B");
lineOf.bbbbbbbb = push("// @decision bbbbbbbb — see the investigation");
filler(2, "B-post");
blank();

// Block C: anchor cccccccc alone, in ITS OWN block — isolated by blank lines on both sides so a read of
// just this line (or this block) can never also pick up bbbbbbbb from block B. Deliberately has NO
// record in any store (DoD-5).
lineOf.cccccccc = push("// @decision cccccccc — this id resolves to no record anywhere");
blank();

// Block D: no anchor at all (DoD-2), and separated by blank lines from block C's anchor on one side and
// block E's anchors on the other — proves the "enclosing block" expansion doesn't bleed across either.
filler(10, "D-no-anchor");
blank();

// Block E: four anchors sharing ONE block — the shared-byte-budget case (DoD-4b).
for (const id of ["e0000001", "e0000002", "e0000003", "e0000004"]) {
  lineOf[id] = push(`// @decision ${id} — budget-competing record`);
}
blank();

const SRC = path.join(REPO, "src.ts");
fs.writeFileSync(SRC, srcLines.join("\n") + "\n");
// A single range that spans BOTH block B (bbbbbbbb) and block C (cccccccc) in one read — proves the
// resolver fires correctly on one id while correctly staying silent on the other in the SAME call.
const bAndCRange = [lineOf.bbbbbbbb, lineOf.cccccccc - lineOf.bbbbbbbb + 1];
// A range entirely inside block D (no anchor, and bounded by blank lines from block C on one side).
const blockDLine = lineOf.cccccccc + 3; // a couple of lines into block D's filler
// A range spanning all four block-E anchors in one call.
const blockEStart = lineOf.e0000001;
const blockESpan = lineOf.e0000004 - lineOf.e0000001 + 1;

function runHookRaw(filePath, cwd, sessionId, offset, limit, tool = "Read") {
  const toolInput = { file_path: filePath };
  if (offset !== undefined) toolInput.offset = offset;
  if (limit !== undefined) toolInput.limit = limit;
  const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, session_id: sessionId, cwd };
  const r = spawnSync(process.execPath, [DECISION_RECORDS_SCRIPT, DEDUPE_DIR], { input: JSON.stringify(payload), encoding: "utf8" });
  const out = (r.stdout || "").trim();
  return out ? JSON.parse(out) : null;
}
function runHookOnFile(filePath, sessionId, offset, limit, tool = "Read") {
  return runHookRaw(filePath, REPO, sessionId, offset, limit, tool);
}
function runHook(sessionId, offset, limit, tool = "Read") {
  return runHookOnFile(SRC, sessionId, offset, limit, tool);
}

try {
  // --- DoD-1: a range that does NOT include the anchor line itself, but shares its blank-line-delimited
  // block, still gets the complete record (the "enclosing block" scope control, card 661b7d46). ---
  const a1 = runHook("s1", lineOf.aaaaaaaa + 2, 3); // a few lines AFTER the anchor, still in block A
  check("DoD-1: read inside block A (not the anchor line itself) injects the complete aaaaaaaa record",
    !!a1 && /An immutable decision record, resolved from docs\/adr\./.test(a1.systemMessage));
  check("DoD-1: the injected record is the FULL file text, not a fragment",
    !!a1 && a1.systemMessage.includes("# ADR aaaaaaaa"));

  // --- DoD-1 (investigations convention) + DoD-5 positive control: bbbbbbbb resolves (nested dir), and
  // this SAME call also carries an anchor (cccccccc) that has NO record anywhere — proving the
  // resolution mechanism fires correctly for one id while correctly staying silent for the other in the
  // very same hook invocation (not just an isolated always-empty result). ---
  const a2 = runHook("s2", bAndCRange[0], bAndCRange[1]); // spans both bbbbbbbb (block B) and cccccccc (block C)
  check("DoD-1: nested docs/investigations/<id>-*/findings.md convention resolves",
    !!a2 && /An investigation report, resolved from the nested docs\/investigations convention\./.test(a2.systemMessage));
  check("DoD-5: an anchored id with no record anywhere is silently skipped (never a broken partial), "
    + "in the SAME call that correctly resolved a sibling id — proves the miss is a real absence, not a broken check",
    !!a2 && !a2.systemMessage.includes("cccccccc"));

  // --- DoD-2: a read entirely inside block C (no anchor in range or its own block) is a byte-identical
  // no-op — AND, since the read is separated by a blank line from block B's own anchors, this also
  // proves the "enclosing block" expansion does not bleed across a blank-line boundary. ---
  const a3 = runHook("s3", blockDLine, 3);
  check("DoD-2: a read with no anchored record in range (or its own block) is silent (no stdout at all)", a3 === null);

  // --- DoD-5, restated per the polarity discipline: re-run the EXACT same negative id in isolation —
  // block C is bounded by blank lines on both sides, so this reads NOTHING but the cccccccc anchor and
  // its own block — this is the "control run where the target is known present first" pairing (a2 above
  // already showed the mechanism firing on a real id, bbbbbbbb, in the same call). ---
  const a3b = runHook("s3b", lineOf.cccccccc, 1); // exactly (and only) the cccccccc anchor's own isolated block
  check("DoD-5: an anchor whose id has no record anywhere, read alone, produces zero output", a3b === null);

  // --- non-Read tool is ignored outright. ---
  const a4 = runHook("s4", lineOf.aaaaaaaa + 2, 3, "Write");
  check("a non-Read tool_name is ignored (no injection even over an anchored range)", a4 === null);

  // --- a Read call with NO offset/limit must default to the REAL Read tool's own default (line 1, up
  // to 2000 lines) — never "the whole file". Otherwise a large file's anchor past line 2000 would get
  // injected as if the agent's actual (truncated) Read call had returned it, which it never did. ---
  const bigLines = [];
  bigLines[9] = "// @decision facade00 — within the default 2000-line window";
  // Placed well past even the block-expansion heuristic's own bound (2000 + BLOCK_EXPAND_MAX=40) — this
  // file has no blank lines at all, so a weaker placement would be caught by block expansion instead of
  // genuinely testing the default-limit boundary.
  bigLines[2100] = "// @decision 0fff2000 — past the default 2000-line window";
  for (let i = 0; i < 2200; i++) if (bigLines[i] === undefined) bigLines[i] = `// filler BIG${i}`;
  const BIG_SRC = path.join(REPO, "big.ts");
  fs.writeFileSync(BIG_SRC, bigLines.join("\n") + "\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "facade00-in-window.md"), "# facade00\n\nWithin the default window.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "0fff2000-out-of-window.md"), "# 0fff2000\n\nPast the default window.\n");
  const bigPayload = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: BIG_SRC }, session_id: "s-default-window", cwd: REPO };
  const bigResult = spawnSync(process.execPath, [DECISION_RECORDS_SCRIPT, DEDUPE_DIR], { input: JSON.stringify(bigPayload), encoding: "utf8" });
  const a4b = (bigResult.stdout || "").trim() ? JSON.parse(bigResult.stdout) : null;
  check("default (no offset/limit) read: an anchor WITHIN the default 2000-line window is injected",
    !!a4b && a4b.systemMessage.includes("Within the default window."));
  check("default (no offset/limit) read: an anchor PAST the default 2000-line window is NOT injected "
    + "(the real Read tool never returned it, so injecting it would misattribute context the agent never saw)",
    !!a4b && !a4b.systemMessage.includes("0fff2000"));

  // --- DoD-3: per-session dedupe. ---
  const dedupeSession = "s-dedupe";
  const first = runHook(dedupeSession, lineOf.aaaaaaaa + 2, 3);
  check("DoD-3 setup: first read in a fresh session injects the record", !!first);
  const second = runHook(dedupeSession, lineOf.aaaaaaaa + 2, 3);
  check("DoD-3: an IDENTICAL repeat read in the SAME session injects nothing the second time", second === null);
  const otherSession = runHook("s-dedupe-different", lineOf.aaaaaaaa + 2, 3);
  check("DoD-3: the SAME region in a DIFFERENT session still injects (dedupe is per-session, not global)", !!otherSession);

  // --- DoD-4a: a single oversized record is truncated WITH an explicit signal, never silently. ---
  fs.appendFileSync(SRC, "\n// @decision deadbeef — oversized record\n");
  const deadbeefLine = fs.readFileSync(SRC, "utf8").split(/\r?\n/).findIndex((l) => l.includes("deadbeef")) + 1;
  const a5 = runHook("s-trunc", deadbeefLine, 1);
  check("DoD-4a: an oversized record is injected truncated, with an explicit TRUNCATED marker naming the byte cap",
    !!a5 && a5.systemMessage.includes("[TRUNCATED at 4000 bytes"));
  check("DoD-4a: the truncated body itself is capped near the stated limit, not the full 5000+ bytes",
    !!a5 && a5.systemMessage.length < 4600);

  // --- DoD-4b: several records competing for one call's shared budget — the ones that fit are injected
  // COMPLETE (never partially truncated to fit more in), and the rest are dropped WHOLE and named. ---
  const a6 = runHook("s-budget", blockEStart, blockESpan); // all four e000000N anchors in one range
  check("DoD-4b: at least one budget-competing record is injected in full (not truncated)",
    !!a6 && /# e0000001/.test(a6.systemMessage) && !a6.systemMessage.includes("[TRUNCATED"));
  check("DoD-4b: at least one record is explicitly named as omitted for shared budget, not silently dropped",
    !!a6 && /omitted for byte budget/.test(a6.systemMessage) && /e000000\d-budget\.md/.test(a6.systemMessage));

  // --- B1 regression: block expansion is upward-only. A DENSE file (no blank lines anywhere) with an
  // anchor at line 30 — a read strictly BEFORE it must NOT reach it via downward expansion, and must NOT
  // falsely mark it delivered, so a LATER read that actually contains the anchor still gets it. Before
  // the fix: the early read's 40-line downward expansion reached the anchor, injected it under a header
  // claiming it governed a range it didn't, and marked it delivered — so the later, genuinely-governed
  // read got wrongly silenced. ---
  const denseLines = [];
  for (let i = 0; i < 25; i++) denseLines.push(`// dense filler ${i}`);
  denseLines[29] = "// @decision cafebabe — governs the block starting near line 30";
  for (let i = 25; i < 70; i++) if (denseLines[i] === undefined) denseLines[i] = `// dense filler ${i}`;
  const DENSE_SRC = path.join(REPO, "dense.ts");
  fs.writeFileSync(DENSE_SRC, denseLines.join("\n") + "\n"); // NO blank lines anywhere in this file
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "cafebabe-dense.md"), "# cafebabe\n\nGoverns the block starting near line 30.\n");
  const b1Session = "s-b1";
  const b1Early = runHookOnFile(DENSE_SRC, b1Session, 1, 10); // lines 1-10, well before line 30, no blank lines to stop expansion
  check("B1: a read strictly BEFORE an anchor (dense file, no blank lines) does NOT reach it via downward expansion", b1Early === null);
  const b1Later = runHookOnFile(DENSE_SRC, b1Session, 25, 15); // lines 25-39, actually contains line 30
  check("B1: the SAME session's later read that actually contains the anchor still gets it "
    + "(not falsely marked delivered by the earlier, too-early read)",
    !!b1Later && b1Later.systemMessage.includes("Governs the block starting near line 30."));

  // --- B2 regression: byte-accurate truncation on MULTI-BYTE content. The prior slice(0, 4000) cut
  // UTF-16 CODE UNITS, so 4000 chars of 3-byte em dashes produced 12000 BYTES — 3x the stated per-record
  // cap — which then blew the shared TOTAL_MAX_BYTES budget and caused the whole record to be DROPPED
  // instead of truncated. This repo's own house typography (em dashes, arrows) is exactly this shape. ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "b2b2b2b2-multibyte.md"), "# b2b2b2b2\n\n" + "—".repeat(4500) + "\n");
  const B2_SRC = path.join(REPO, "b2.ts");
  fs.writeFileSync(B2_SRC, "// @decision b2b2b2b2 — multi-byte record\n");
  const b2Result = runHookOnFile(B2_SRC, "s-b2", 1, 1);
  check("B2: a multi-byte-heavy oversized record is INJECTED, truncated (not dropped whole for exceeding the shared budget)",
    !!b2Result && /# b2b2b2b2/.test(b2Result.systemMessage) && !/too large to inject/.test(b2Result.systemMessage));
  check("B2: it carries the explicit TRUNCATED marker (never a silent cut)",
    !!b2Result && b2Result.systemMessage.includes("[TRUNCATED at 4000 bytes"));
  check("B2: the WHOLE emitted message (not just this one record) stays within the shared 12000-byte budget "
    + "— proof the per-record truncation is measured in real bytes, not UTF-16 code units",
    !!b2Result && Buffer.byteLength(b2Result.systemMessage, "utf8") <= 12000);

  // --- N2 regression: truncation must keep HEAD AND TAIL. This repo's own convention puts a caveat/bound
  // at the END of a comment — a head-only cut keeps the claim and silently drops its qualifier. ---
  const n2Body = "HEAD-CLAIM-MARKER\n" + "z".repeat(6000) + "\nTAIL-CAVEAT-MARKER";
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "22222220-headtail.md"), `# 22222220\n\n${n2Body}\n`);
  const N2_SRC = path.join(REPO, "n2.ts");
  fs.writeFileSync(N2_SRC, "// @decision 22222220 — head+tail check\n");
  const n2Result = runHookOnFile(N2_SRC, "s-n2", 1, 1);
  check("N2: a truncated record keeps its HEAD", !!n2Result && n2Result.systemMessage.includes("HEAD-CLAIM-MARKER"));
  check("N2: a truncated record ALSO keeps its TAIL (a trailing caveat must survive truncation, not just the opening claim)",
    !!n2Result && n2Result.systemMessage.includes("TAIL-CAVEAT-MARKER"));

  // --- N3 regression: a bare prefix match would let id `deadbeef` match an unrelated
  // `deadbeefcafe-other.md`. Require a real boundary (`-`/`.`) after the id. deadbeef's OWN record
  // (docs/decisions/deadbeef-oversized.md) already exists from the DoD-4a fixture above. ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadbeefcafe-other.md"), "# unrelated\n\nA DIFFERENT record that merely SHARES a prefix with deadbeef.\n");
  const N3_SRC = path.join(REPO, "n3.ts");
  fs.writeFileSync(N3_SRC, "// @decision deadbeef — boundary check\n");
  const n3Result = runHookOnFile(N3_SRC, "s-n3", 1, 1);
  check("N3: a prefix-sharing but unrelated store file is NEVER matched",
    !!n3Result && !n3Result.systemMessage.includes("A DIFFERENT record that merely SHARES a prefix"));
  check("N3: the id's OWN correctly-bounded record still resolves",
    !!n3Result && n3Result.systemMessage.includes("[TRUNCATED at 4000 bytes")); // deadbeef's own record is the oversized one

  // --- N4 regression: a single line carrying TWO anchors must yield BOTH ids, not just the first (the
  // prior regex had no `g` flag). ---
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "11111111-multi.md"), "# 11111111\n\nFirst of two anchors on one line.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "22222222-multi.md"), "# 22222222\n\nSecond of two anchors on one line.\n");
  const MULTI_SRC = path.join(REPO, "multi.ts");
  fs.writeFileSync(MULTI_SRC, "// @decision 11111111 — first  // @decision 22222222 — second\n");
  const multiResult = runHookOnFile(MULTI_SRC, "s-n4", 1, 1);
  check("N4: a single line carrying TWO anchors injects BOTH records (not just the first)",
    !!multiResult && multiResult.systemMessage.includes("First of two anchors on one line.")
      && multiResult.systemMessage.includes("Second of two anchors on one line."));

  // --- S4 regression: never resolve records against a repo OTHER than the session's own cwd — a Read of
  // a file that happens to live in a DIFFERENT repo on the same host must not inject THAT tree's records. ---
  fs.mkdirSync(path.join(FOREIGN_REPO, ".git"), { recursive: true });
  fs.mkdirSync(path.join(FOREIGN_REPO, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(FOREIGN_REPO, "docs", "decisions", "f0f0f0f0-foreign.md"), "# f0f0f0f0\n\nForeign repo record.\n");
  const FOREIGN_SRC = path.join(FOREIGN_REPO, "foreign.ts");
  fs.writeFileSync(FOREIGN_SRC, "// @decision f0f0f0f0 — foreign repo anchor\n");
  const s4Foreign = runHookRaw(FOREIGN_SRC, REPO, "s-foreign", 1, 1); // cwd = THIS session's own repo; file lives in a DIFFERENT one
  check("S4: a Read of a file in a DIFFERENT repo than the session's own cwd is never resolved (no injection)", s4Foreign === null);
  const s4ForeignOwnCwd = runHookRaw(FOREIGN_SRC, FOREIGN_REPO, "s-foreign-2", 1, 1); // cwd = that SAME foreign repo
  check("S4 sanity: the same file DOES resolve when the session's own cwd is that repo "
    + "(proves the silence above is the cross-repo guard firing, not a broken resolver)",
    !!s4ForeignOwnCwd && s4ForeignOwnCwd.systemMessage.includes("Foreign repo record."));

  // --- S1: the early-bail when a repo has adopted NONE of the three record stores at all — a repo with
  // no docs/adr, docs/decisions, or docs/investigations must stay silent even over a syntactically
  // well-formed anchor (proves the store-existence check, not just "no anchor found"). ---
  fs.mkdirSync(NO_STORE_REPO, { recursive: true });
  fs.mkdirSync(path.join(NO_STORE_REPO, ".git"), { recursive: true });
  const NO_STORE_SRC = path.join(NO_STORE_REPO, "src.ts");
  fs.writeFileSync(NO_STORE_SRC, "// @decision aaaaaaaa — this repo has no record store at all\n");
  const s1NoStore = runHookRaw(NO_STORE_SRC, NO_STORE_REPO, "s-nostore", 1, 1);
  check("S1: a repo with NONE of the three record stores stays silent even over a well-formed anchor",
    s1NoStore === null);

  // --- writeSessionSettings wiring: the Read PostToolUse hook is ALWAYS present, vaultPath or not. ---
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };
  const settings = JSON.parse(fs.readFileSync(writeSessionSettings("decrec-wiring", perm, "test-hook-token"), "utf8"));
  const readGroup = (settings.hooks.PostToolUse || []).find((g) => g.matcher === "Read");
  check("writeSessionSettings: PostToolUse always carries a Read group (no vaultPath needed)", !!readGroup);
  check("writeSessionSettings: the Read group's command points at decision-records.mjs",
    !!readGroup && readGroup.hooks[0].command.includes("decision-records.mjs"));
} finally {
  for (const d of [REPO, DEDUPE_DIR, FOREIGN_REPO, NO_STORE_REPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(SETTINGS_DIR, "decrec-wiring.json"), { force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decision-records.mjs injects complete, out-of-band decision records (resolved live "
    + "from docs/adr, docs/decisions, and the nested docs/investigations convention) whenever an anchor's "
    + "line falls within a Read's actual range or its enclosing blank-line block; stays byte-identical to "
    + "no hook at all when nothing is anchored in range; dedupes per session; and enforces its byte cap "
    + "via explicit truncation (single oversized record) or explicit whole-record omission (shared-budget "
    + "contention) — never a silent partial."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

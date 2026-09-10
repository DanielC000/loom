import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// decisions_for (card dbad4b59): the @decision-anchor index MCP tool, backed by a trivial index built by
// grepping the CALLING PROJECT'S OWN repo at call time — never a persisted snapshot. Exercises all four
// query shapes (path / 8-hex id reverse lookup / symbol / omitted-enumerate-all) against a REAL, hermetic
// fixture repo carrying real anchors and real docs/adr, docs/decisions, docs/investigations records —
// mirrors decision-records.mjs's own three-store resolution, and both DoD-4 orphan directions (an
// anchored id with no record, and a record nothing anchors). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like tasks-get-taskid-alias.mjs: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the
// REAL TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty).
//
// Plus card 969b0e1c (2026-09-10, code-review finding B1) — the `@decision sha:<id>` namespace sigil this
// file's own SOURCE (mcp/decisions.ts) carried an independent THIRD `ANCHOR_RE` copy that the sigil
// landing missed: `decisions_for` was silently BLIND to a real sha:-sigil'd anchor (anchorCount:0 for a
// file that genuinely has one) and affirmatively WRONG about a real sha-keyed record (orphan:true for a
// record that genuinely has live anchors) — the exact two failure modes this tranche now covers against a
// REAL git repo (a genuine `git init` + seed commit, not just a `.git` marker, so `git rev-parse --verify`
// has something real to check): a `sha:`-sigil'd anchor citing a REAL, verified commit resolves (in path
// mode, id-reverse-lookup mode via a NEW `sha:<id>` query form, and enumerate-all mode); the SAME hex
// under the sigil is REFUSED when it does not verify as a real commit, even when an identical record file
// exists (refuse-rather-than-fall-through, never silently falling through to the namespace-blind file
// lookup); and every mode's items now carry `ns`.
//
// Run: 1) build (turbo builds shared first), 2) node test/decisions-for-tool.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-dft-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Fixture repo: a throwaway directory with a real anchor+record convention, entirely disjoint from
// this repo's own docs/adr etc. (so this test can never accidentally observe or corrupt real records). ---
const repoRoot = path.join(tmpHome, "fixture-repo");
const mk = (rel) => fs.mkdirSync(path.join(repoRoot, rel), { recursive: true });
const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(repoRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(repoRoot, rel), content); };

mk("docs/adr");
mk("docs/decisions");
mk("docs/investigations/cccccccc-some-investigation");
mk("src");

// Card 969b0e1c: a REAL git repo (not just a `.git` marker) so `verifyCommitSha`'s `git rev-parse
// --verify` has a genuine commit to check against — one seed commit is enough.
execFileSync("git", ["init", "-q"], { cwd: repoRoot });
write("SEED.md", "seed\n");
commitAll(repoRoot, "seed", "-c user.email=dft-fixture@loom -c user.name=dft-fixture");
const REAL_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim().slice(0, 8);

// aaaaaaaa: a real ADR record, anchored once in src/foo.ts.
write("docs/adr/aaaaaaaa-example-decision.md", "# aaaaaaaa — Example decision title\n\n## Status\n\naccepted\n");
// bbbbbbbb: a real decisions/ record with NO inbound anchor anywhere (orphan-record signal).
write("docs/decisions/bbbbbbbb-local-decision.md", "# bbbbbbbb — Local decision title\n\nBody.\n");
// cccccccc: an investigations/ record (register #3), anchored in src/bar.ts.
write("docs/investigations/cccccccc-some-investigation/findings.md", "# cccccccc — Investigation title\n\nFindings body.\n");
// REAL_SHA: a genuine verified-commit record (card 969b0e1c), anchored via the sha: sigil in src/foo.ts.
write(`docs/decisions/${REAL_SHA}-sha-decision.md`, `# ${REAL_SHA} — Verified-commit decision title\n\nBody.\n`);
// deadc0de: backs BOTH the bare (resolves, unverified) and sigil'd (refused — not a real commit) query/
// anchor forms from the SAME fixture id, mirroring the other two test files' namespace control pair.
write("docs/decisions/deadc0de-namespace-test.md", "# deadc0de — Namespace test title\n\nBody.\n");

// src/foo.ts: FOUR anchors — aaaaaaaa (resolves), dddddddd (a dangling anchor: no record anywhere),
// sha:REAL_SHA (a genuine verified-commit anchor, must resolve), sha:deadc0de (refused — not a real
// commit, even though docs/decisions/deadc0de-namespace-test.md exists).
write(
  "src/foo.ts",
  "// @decision aaaaaaaa — do not do X, see the record\n" +
  "export function doThing() {}\n" +
  "\n" +
  "// @decision dddddddd — this id has no record on purpose\n" +
  "export const ORPHAN_MARKER = 1;\n" +
  "\n" +
  `// @decision sha:${REAL_SHA} — a genuine verified-commit record\n` +
  "export const SHA_MARKER = 1;\n" +
  "\n" +
  "// @decision sha:deadc0de — sigil'd form IS SHA-verified; deadc0de is not a real commit here\n" +
  "export const REFUSED_SHA_MARKER = 1;\n",
);
// src/bar.ts: cccccccc anchored right above a const declaration used for the symbol-mode test, plus a
// BARE deadc0de anchor (the positive control: resolves as a CARD id, never SHA-verified — proves a
// card-id anchor still resolves exactly as it did before this card).
write(
  "src/bar.ts",
  "// @decision cccccccc — see the investigation findings\n" +
  "export const BAR_SYMBOL = 42;\n" +
  "\n" +
  "// @decision deadc0de — bare form is a CARD id, never SHA-verified\n" +
  "export const BARE_DEADC0DE_MARKER = 1;\n",
);

// --- Card 2b2d9a47: two big-file fixtures exercising the MAX_FILE_BYTES cap directly. Sized RELATIVE to
// the REAL cap read out of the source (never a pinned literal) so this stays correct if the cap changes
// again — mirrors the card's own "match on file+anchor text, not a pinned line number" instruction, applied
// to a byte threshold instead of a line number. ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const decisionsSrcPath = path.join(__dirname, "..", "src", "mcp", "decisions.ts");
// Card 36afbbdd: comment-stripped before matching — the regex below is UNANCHORED (no `^`/`m`), so a
// comment mentioning a HISTORICAL value (e.g. "this used to be const MAX_FILE_BYTES = 100_000; before the
// cap was raised") would otherwise be matched first if it precedes the real declaration, silently sizing
// every fixture in this file against the WRONG cap — a comment-only diff that never fails loudly (the
// sanity check at (0) only asserts "a positive number", which a stale historical value still is).
const decisionsSrc = stripComments(fs.readFileSync(decisionsSrcPath, "utf8"));
const capMatch = /const MAX_FILE_BYTES = ([^;]+);/.exec(decisionsSrc);
if (!capMatch) throw new Error("could not find `const MAX_FILE_BYTES = ...;` in decisions.ts — fixture sizing depends on it");
// eslint-disable-next-line no-new-func -- trusted own-source literal, not external input
const MAX_FILE_BYTES = new Function(`"use strict"; return (${capMatch[1]});`)();
check("(0) sanity: MAX_FILE_BYTES parsed from source is a sane positive number", Number.isFinite(MAX_FILE_BYTES) && MAX_FILE_BYTES > 0);

// (0-control, card 36afbbdd) NEGATIVE: a comment mentioning a stale historical cap value no longer wins
// the match. POSITIVE: the identical text as a REAL declaration still parses correctly.
{
  const decoyThenReal = "// this used to be const MAX_FILE_BYTES = 100_000; before the cap was raised\nconst MAX_FILE_BYTES = 512 * 1024;\n";
  const strippedMatch = /const MAX_FILE_BYTES = ([^;]+);/.exec(stripComments(decoyThenReal));
  check("(0-control) NEGATIVE: the decoy comment's stale value is gone — the REAL declaration is matched",
    !!strippedMatch && strippedMatch[1].trim() === "512 * 1024");
  const realOnly = "const MAX_FILE_BYTES = 512 * 1024;\n";
  const realMatch = /const MAX_FILE_BYTES = ([^;]+);/.exec(stripComments(realOnly));
  check("(0-control) POSITIVE: the same text as REAL code still matches after stripping",
    !!realMatch && realMatch[1].trim() === "512 * 1024");
}

const OLD_CAP_BYTES = 512 * 1024; // the pre-card-2b2d9a47 cap this bug shipped with — a historical fact, not a moving target
const OVER_OLD_CAP_UNDER_CURRENT_CAP = OLD_CAP_BYTES + 64 * 1024; // ~576KB: over the OLD cap, comfortably under the current one
// Deliberately a `check()`, not a throw: run this SAME file against pre-fix (reverted) decisions.ts — where
// MAX_FILE_BYTES is still 512KB — and this sizing assumption itself goes red (576KB is no longer "under
// the current cap"), which is itself part of the DoD-2 RED signal rather than a crash that would hide the
// real per-assertion failures below (e.g. (8i)) that this fixture exists to drive.
check("(0d) sanity: OVER_OLD_CAP_UNDER_CURRENT_CAP sits under the CURRENT cap (fails here on pre-fix code, by design)",
  OVER_OLD_CAP_UNDER_CURRENT_CAP < MAX_FILE_BYTES);
const OVER_CURRENT_CAP = MAX_FILE_BYTES + 1024 * 1024; // always skipped, whatever the current cap is

/** Pad `header` with filler comment lines until it reaches `targetBytes` (never truncates below `header`).
 * All-ASCII content only (header + filler), so `.length` IS the UTF-8 byte count — computed ONCE up front
 * and tracked incrementally rather than re-measured via `Buffer.byteLength` on the whole (growing) string
 * every iteration, which is accidentally-quadratic: a real first draft of this helper took 58s to pad a
 * single 5MB fixture for exactly that reason. Built via array-push + one final `join`, never repeated `+=`
 * on a single string, so V8 never has to re-flatten a growing rope on each append either. */
function padTo(targetBytes, header) {
  if (/[^\x00-\x7f]/.test(header)) throw new Error("padTo: header must be pure ASCII — byte-count math below assumes .length === UTF-8 byte length");
  const filler = "// padding line to inflate this fixture past a byte-cap threshold for testing\n";
  const parts = [header];
  let len = header.length;
  while (len < targetBytes) { parts.push(filler); len += filler.length; }
  return parts.join("");
}

// eeeeeeee: anchored in a file BIGGER than the pre-fix 512KB cap, SMALLER than the current cap — the
// RED/GREEN case (DoD-2): this must resolve (orphan:false) on FIXED code and FAIL (orphan:true) on the
// pre-fix 512KB-cap code, proving the check can actually go red.
write(
  "src/big-under-current-cap.ts",
  padTo(OVER_OLD_CAP_UNDER_CURRENT_CAP, "// @decision eeeeeeee - anchored in a file over the OLD cap, under the CURRENT one\nexport const BIG_MARKER = 1;\n"),
);
write("docs/decisions/eeeeeeee-big-file-decision.md", "# eeeeeeee — Big file decision title\n\nBody.\n");

// ffffffff: anchored in a file BIGGER than the CURRENT cap too — proves the disclosure half (DoD-1):
// when a file genuinely cannot be scanned, the tool must say so (skippedFiles) rather than silently
// asserting orphan:true with no way for a caller to tell "not found" from "did not look".
write(
  "src/genuinely-over-current-cap.ts",
  padTo(OVER_CURRENT_CAP, "// @decision ffffffff - anchored in a file over the CURRENT cap too\nexport const HUGE_MARKER = 1;\n"),
);
write("docs/decisions/ffffffff-huge-file-decision.md", "# ffffffff — Huge file decision title\n\nBody.\n");
check("(0b) sanity: the big-under-cap fixture is actually over the OLD cap and under the CURRENT cap",
  fs.statSync(path.join(repoRoot, "src/big-under-current-cap.ts")).size > OLD_CAP_BYTES
  && fs.statSync(path.join(repoRoot, "src/big-under-current-cap.ts")).size < MAX_FILE_BYTES);
check("(0c) sanity: the genuinely-over-cap fixture is actually over the CURRENT cap",
  fs.statSync(path.join(repoRoot, "src/genuinely-over-current-cap.ts")).size > MAX_FILE_BYTES);

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pDecisions", name: "Decisions Fixture", repoPath: repoRoot, vaultPath: repoRoot, config: {}, createdAt: now, archivedAt: null, reserved: false });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pDecisions", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "decisions-for-tool-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // (1) PATH mode: src/foo.ts carries a resolvable card anchor, a dangling (orphan) card anchor, a
  // resolvable sha anchor (card 969b0e1c — the B1 repro: a real verified-commit anchor), and a refused
  // sha anchor (deadc0de is not a real commit, even though its record file exists).
  const byPath = await call("decisions_for", { query: "src/foo.ts" });
  check("(1a) path mode reports mode:\"path\" and the right file", byPath.mode === "path" && byPath.path === "src/foo.ts");
  check("(1b) path mode finds all FOUR anchor sites", byPath.anchorCount === 4);
  const aaaa = byPath.decisions.find((d) => d.id === "aaaaaaaa");
  check("(1c) the resolvable card anchor resolves to its record path+title, ns:\"card\", orphan:false",
    !!aaaa && aaaa.ns === "card" && !aaaa.orphan && aaaa.record?.path === "docs/adr/aaaaaaaa-example-decision.md" && aaaa.record?.title === "Example decision title");
  const dddd = byPath.decisions.find((d) => d.id === "dddddddd");
  check("(1d) the dangling card anchor (no record) is reported, not silently skipped — orphan:true, record:null (DoD-4)",
    !!dddd && dddd.orphan === true && dddd.record === null);
  const shaReal = byPath.decisions.find((d) => d.ns === "sha" && d.id === REAL_SHA);
  check("(1f) card 969b0e1c B1 repro FIXED: a sha:-sigil'd anchor citing a REAL, verified commit is NOT "
    + "silently blind — it resolves, ns:\"sha\", orphan:false",
    !!shaReal && !shaReal.orphan && shaReal.record?.path === `docs/decisions/${REAL_SHA}-sha-decision.md`);
  const shaRefused = byPath.decisions.find((d) => d.ns === "sha" && d.id === "deadc0de");
  check("(1g) the sha:deadc0de anchor is REFUSED (not a real commit), even though its record file exists "
    + "— orphan:true, record:null (refuse-rather-than-fall-through, never the affirmatively-wrong B1 bug)",
    !!shaRefused && shaRefused.orphan === true && shaRefused.record === null);
  check("(1e) path mode's own orphanAnchorCount matches BOTH orphans (dddddddd + the refused sha:deadc0de)",
    byPath.orphanAnchorCount === 2);

  // (2) A path escape is refused, not silently resolved outside the repo root.
  const escape = await call("decisions_for", { query: "../../outside.ts" });
  check("(2) a path escaping the repo root is refused with {error}", typeof escape.error === "string");

  // (3) ID reverse-lookup mode — "what does this record govern": aaaaaaaa IS cited, orphan:false.
  const idHit = await call("decisions_for", { query: "aaaaaaaa" });
  check("(3a) id mode reports mode:\"record\" with the resolved record", idHit.mode === "record" && idHit.record?.title === "Example decision title");
  check("(3b) id mode's anchoredIn names the real citing site", idHit.anchoredIn.length === 1 && idHit.anchoredIn[0].file === "src/foo.ts" && idHit.anchoredIn[0].line === 1);
  check("(3c) a cited, resolvable id is NOT orphan", idHit.orphan === false);

  // (4) ID reverse-lookup, orphan-RECORD direction: bbbbbbbb has a real record but NO inbound anchor.
  const idOrphanRecord = await call("decisions_for", { query: "bbbbbbbb" });
  check("(4a) bbbbbbbb's record resolves", idOrphanRecord.record?.title === "Local decision title");
  check("(4b) but nothing anchors it — anchoredIn:[] and orphan:true (DoD-4, the OTHER orphan direction)",
    idOrphanRecord.anchoredIn.length === 0 && idOrphanRecord.orphan === true);

  // (5) ID reverse-lookup, orphan-ANCHOR direction: dddddddd is cited but has no record.
  const idOrphanAnchor = await call("decisions_for", { query: "dddddddd" });
  check("(5) dddddddd is anchored but has no record — record:null, orphan:true even though anchoredIn is non-empty",
    idOrphanAnchor.record === null && idOrphanAnchor.anchoredIn.length === 1 && idOrphanAnchor.orphan === true);

  // (5s) ID reverse-lookup, the NEW sha: query form (card 969b0e1c): "sha:<id>" -> ns:"sha", the SAME
  // reverse lookup applied to the commit-sha namespace instead of the card namespace.
  const idShaHit = await call("decisions_for", { query: `sha:${REAL_SHA}` });
  check("(5sa) \"sha:<id>\" is recognized as an id query (mode:\"record\", ns:\"sha\") — never falling "
    + "through to symbol mode (the B1 direction's own open question, resolved: YES, it is accepted)",
    idShaHit.mode === "record" && idShaHit.ns === "sha" && idShaHit.id === REAL_SHA);
  check("(5sb) the real verified-commit record resolves via the sha: query, cited at its real site",
    idShaHit.record?.path === `docs/decisions/${REAL_SHA}-sha-decision.md`
    && idShaHit.anchoredIn.length === 1 && idShaHit.anchoredIn[0].file === "src/foo.ts" && idShaHit.orphan === false);

  // (5sc) The bare-vs-sigil namespace control pair, via the reverse-lookup mode this time (path mode
  // already covered the same pair as source anchors, above): the bare "deadc0de" query resolves as a CARD
  // id (never SHA-verified); "sha:deadc0de" is REFUSED (deadc0de is not a real commit), even though the
  // identical record file backs both queries.
  const idDeadc0deBare = await call("decisions_for", { query: "deadc0de" });
  check("(5sc) bare \"deadc0de\" query resolves as ns:\"card\", unverified",
    idDeadc0deBare.mode === "record" && idDeadc0deBare.ns === "card"
    && idDeadc0deBare.record?.path === "docs/decisions/deadc0de-namespace-test.md" && idDeadc0deBare.orphan === false);
  const idDeadc0deSha = await call("decisions_for", { query: "sha:deadc0de" });
  check("(5sd) \"sha:deadc0de\" query is REFUSED — record:null even though the identical record file "
    + "resolved for the bare form above, and anchoredIn still names the refused anchor's own site "
    + "(orphan:true covers this: a real anchor site with no resolvable record)",
    idDeadc0deSha.mode === "record" && idDeadc0deSha.ns === "sha"
    && idDeadc0deSha.record === null && idDeadc0deSha.anchoredIn.length === 1 && idDeadc0deSha.orphan === true);

  // (6) SYMBOL mode: resolve BAR_SYMBOL -> src/bar.ts -> its anchored decision (cccccccc, register #3:
  // docs/investigations/.../findings.md — the "either register" text some card carried was wrong; this
  // mirrors the REAL three-store resolver, not that description).
  const bySymbol = await call("decisions_for", { query: "BAR_SYMBOL" });
  check("(6a) symbol mode resolves to the defining file", bySymbol.mode === "symbol" && bySymbol.resolvedFiles.includes("src/bar.ts") && !bySymbol.ambiguous);
  const barResult = bySymbol.results.find((r) => r.path === "src/bar.ts");
  check("(6b) the resolved file's own decisions include the investigations-register record",
    !!barResult && barResult.decisions.some((d) => d.id === "cccccccc" && d.record?.path === "docs/investigations/cccccccc-some-investigation/findings.md"));

  // (7) SYMBOL mode, no definition found anywhere — reported as an explicit error, not an empty crash.
  const noSymbol = await call("decisions_for", { query: "ThisSymbolDoesNotExistAnywhere" });
  check("(7) an unresolvable symbol reports {mode:\"symbol\", error, resolvedFiles:[]}", noSymbol.mode === "symbol" && typeof noSymbol.error === "string" && noSymbol.resolvedFiles.length === 0);

  // (8) NO query — full-repo enumeration reporting BOTH orphan directions at once (DoD-4). 7 unique
  // "ns:id" anchor keys (card:aaaaaaaa, card:dddddddd, card:cccccccc, card:deadc0de, card:eeeeeeee,
  // sha:REAL_SHA, sha:deadc0de — card:ffffffff's OWN anchor lives in the genuinely-over-cap fixture and is
  // never indexed, so it does NOT add an 8th key here), 7 records (the original 5 plus eeeeeeee/ffffffff).
  const all = await call("decisions_for", {});
  check("(8a) enumerate-all reports mode:\"index\" with the right totals", all.mode === "index" && all.recordCount === 7 && all.uniqueAnchorIds === 7);
  check("(8b) orphanAnchors names card:dddddddd (an anchored card id with no record)",
    all.orphanAnchors.items.some((o) => o.ns === "card" && o.id === "dddddddd"));
  check("(8c) orphanRecords names bbbbbbbb (a record with no inbound anchor in EITHER namespace), advisory:true",
    all.orphanRecords.items.some((o) => o.id === "bbbbbbbb") && all.orphanRecords.advisory === true);
  check("(8d) aaaaaaaa/cccccccc — properly anchored+recorded — are NOT reported as orphans in either direction",
    !all.orphanAnchors.items.some((o) => o.id === "aaaaaaaa" || o.id === "cccccccc")
    && !all.orphanRecords.items.some((o) => o.id === "aaaaaaaa" || o.id === "cccccccc"));

  // (8e) card 969b0e1c B1 repro FIXED, in enumerate-all mode this time: the reviewer's own repro was
  // `decisions_for("<real sha record id>")` returning `orphan:true` for a record with real live anchors.
  // Here: the sha:REAL_SHA anchor must NOT appear in orphanAnchors (it resolves, verified), and the
  // REAL_SHA record must NOT appear in orphanRecords (something legitimately anchors it).
  check("(8e) sha:REAL_SHA is NOT an orphan anchor (the B1 bug would have shown it here)",
    !all.orphanAnchors.items.some((o) => o.ns === "sha" && o.id === REAL_SHA));
  check("(8f) the REAL_SHA record is NOT an orphan record (it IS anchored, just via the sha namespace)",
    !all.orphanRecords.items.some((o) => o.id === REAL_SHA));

  // (8g) sha:deadc0de IS an orphan anchor (refused — not a real commit), even though the bare card:deadc0de
  // anchor resolving the SAME record means the deadc0de RECORD itself is correctly NOT an orphan record.
  check("(8g) sha:deadc0de IS an orphan anchor (refuse-rather-than-fall-through) in the full index too",
    all.orphanAnchors.items.some((o) => o.ns === "sha" && o.id === "deadc0de"));
  check("(8h) the deadc0de record is NOT an orphan record — the BARE card:deadc0de anchor still anchors it",
    !all.orphanRecords.items.some((o) => o.id === "deadc0de"));

  // (8i) card 2b2d9a47 DoD-2 RED/GREEN: eeeeeeee's anchor lives in a file over the PRE-FIX 512KB cap but
  // under the CURRENT one — this must resolve (orphan:false) on fixed code, and this exact assertion is
  // what the negative-control run (below, post-report) shows failing against pre-fix code.
  const idBig = await call("decisions_for", { query: "eeeeeeee" });
  check("(8i) eeeeeeee (anchored in a big-but-under-cap file) resolves, orphan:false",
    idBig.mode === "record" && idBig.record?.title === "Big file decision title"
    && idBig.anchoredIn.length === 1 && idBig.anchoredIn[0].file === "src/big-under-current-cap.ts" && idBig.orphan === false);

  // (8j) card 2b2d9a47 DoD-1 disclosure: ffffffff's anchor lives in a file over the CURRENT cap too, so it
  // genuinely cannot be found — orphan:true is unavoidable here, but the response must say WHY: a
  // non-empty skippedFiles naming the file it could not scan, so orphan:true is interpretable rather than
  // a silent false assertion.
  const idHuge = await call("decisions_for", { query: "ffffffff" });
  check("(8j) ffffffff (anchored ONLY in a genuinely over-cap file) reports orphan:true WITH skippedFiles naming that file",
    idHuge.mode === "record" && idHuge.orphan === true
    && Array.isArray(idHuge.skippedFiles) && idHuge.skippedFiles.includes("src/genuinely-over-current-cap.ts"));

  // (8k) path mode on the genuinely-over-cap file itself: skippedForSize:true, anchorCount:0 — the file-
  // level signal that "0 anchors" here means "did not look", not "has none" (mirrors the id-mode case).
  const pathHuge = await call("decisions_for", { query: "src/genuinely-over-current-cap.ts" });
  check("(8k) querying the genuinely-over-cap file by path reports skippedForSize:true, anchorCount:0",
    pathHuge.mode === "path" && pathHuge.skippedForSize === true && pathHuge.anchorCount === 0 && pathHuge.decisions.length === 0);

  // (8l) path mode on the big-but-under-cap file: skippedForSize:false, its one real anchor IS found.
  const pathBig = await call("decisions_for", { query: "src/big-under-current-cap.ts" });
  check("(8l) querying the big-but-under-cap file by path reports skippedForSize:false and finds its anchor",
    pathBig.mode === "path" && pathBig.skippedForSize === false && pathBig.anchorCount === 1
    && pathBig.decisions[0]?.id === "eeeeeeee" && pathBig.decisions[0]?.orphan === false);

  // (8m) enumerate-all mode carries the same disclosure: skippedFiles names the genuinely-over-cap file,
  // and — the accepted residual (DoD-1's own text: the cap always leaves SOME size that can be skipped) —
  // ffffffff's record IS still (wrongly) reported as an orphan RECORD, because its only anchor lives in a
  // file this scan could not read; that is exactly why skippedFiles must ride alongside orphanRecords.
  check("(8m) enumerate-all's skippedFiles names the genuinely-over-cap file",
    Array.isArray(all.skippedFiles) && all.skippedFiles.includes("src/genuinely-over-current-cap.ts"));
  check("(8n) eeeeeeee is correctly NOT an orphan record (it resolves under the current cap)",
    !all.orphanRecords.items.some((o) => o.id === "eeeeeeee"));
  check("(8o) ffffffff IS (still) reported as an orphan record — the documented residual the skippedFiles disclosure exists to explain",
    all.orphanRecords.items.some((o) => o.id === "ffffffff"));

  // (9) A project with no repoPath at all gets a clean {error}, never a throw.
  db.insertProject({ id: "pNoRepo", name: "No Repo", repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
  const noRepoServer = new TaskMcpRouter(db, wakes).buildServer("pNoRepo", "S2");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await noRepoServer.connect(serverT2);
  const client2 = new Client({ name: "decisions-for-tool-test-2", version: "0" });
  await client2.connect(clientT2);
  const noRepoResult = JSON.parse((await client2.callTool({ name: "decisions_for", arguments: {} })).content[0].text);
  check("(9) a project with no repoPath returns a clean {error}, not a throw", typeof noRepoResult.error === "string");
  await client2.close();

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decisions_for resolves path/id/symbol/enumerate-all queries against a real fixture repo, across all three record stores, reporting BOTH orphan directions (DoD-4) instead of silently skipping either, and (card 2b2d9a47) never asserting orphan:true from an unscanned over-cap file without disclosing skippedFiles."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7c74acd8 — the kickoff project-memory digest selects by TASK relevance, not size.
//   (B) a non-floor note over DIGEST_NOTE_TRUNCATE_OVER_CHARS renders as its lead + a `memory_read <key>` pointer;
//       the never-drop FLOOR and a note the kickoff cites by key render unchanged.
//   (C) the related-tier query is built from the task title + the kickoff's TASK section, stopwords dropped
//       BEFORE the 32-token cap, with the whole kickoff as the fallback; the query's SOURCE is logged (no content).
// Run: build, then node test/project-memory-relevance-selection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `pm-rel-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const R = await import("../dist/sessions/project-memory-recall.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");
const { leadOrWhole, composeProjectMemoryDigest, buildRecallQuery, extractTaskSection, retrieveProjectMemoryForKickoff, NEVER_DROP_TAG } = R;

const now = new Date().toISOString();
const entry = (key, text, over = {}) => ({
  id: `id-${key}`, projectId: "p", key, title: `Title of ${key}`, text, pinned: !!over.pinned, tags: over.tags ?? [],
  createdAt: now, updatedAt: now, lastRetrievedAt: null, retrievalCount: 0, version: 1, requestIds: null, triggerGlob: null, expiresAt: null,
});
const LATE = "LATE-SENTINEL-DO-NOT-RENDER";
// A long note shaped like the real store's: a short provenance paragraph, then sections, a sentinel at the very end.
const longText = [
  "**Est. 2026-01-01. Provenance line.**",
  "## THE RULE\nThe lead rule sentence that must survive truncation.",
  ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"filler ".repeat(25)}`),
  LATE,
].join("\n\n");

try {
  // ===================== (B) leadOrWhole =====================
  {
    check("(B sanity) the fixture note is genuinely over the threshold", longText.length > R.DIGEST_NOTE_TRUNCATE_OVER_CHARS);
    const lead = leadOrWhole(longText, "some-key");
    check("(B) a long note keeps its provenance paragraph AND its first rule (lead is whole paragraphs to the target)",
      lead.includes("Provenance line") && lead.includes("The lead rule sentence that must survive truncation"));
    check("(B) a long note's tail is NOT rendered", !lead.includes(LATE));
    check("(B) the pointer names the key and the omitted size", /`memory_read` some-key for the full note/.test(lead) && /\[… \d+ more chars omitted/.test(lead));
    check("(B) the lead is far shorter than the note (bounded by MAX + pointer)",
      lead.length < R.DIGEST_NOTE_LEAD_MAX_CHARS + 200 && lead.length < longText.length / 3);
    const atThreshold = "x".repeat(R.DIGEST_NOTE_TRUNCATE_OVER_CHARS);
    check("(B negative control) a note exactly at the threshold is returned whole, with no pointer", leadOrWhole(atThreshold, "k") === atThreshold);
    const fenced = "intro\n\n```js\n" + "code line\n".repeat(200) + "```\n\nafter";
    const fl = leadOrWhole(fenced, "k");
    check("(B) a cut never leaves a code fence open", ((fl.split("\n[…")[0]).match(/```/g) ?? []).length % 2 === 0);
  }

  // ===================== (B) composeProjectMemoryDigest tiers =====================
  {
    const floor = entry("floor-note", longText, { pinned: true, tags: [NEVER_DROP_TAG] });
    const rest = entry("rest-note", longText, { pinned: true });
    const related = entry("related-note", longText);
    const cited = entry("cited-note", longText);
    const { digest } = composeProjectMemoryDigest([floor, rest], [related, cited], 100000, () => [], "see memory key cited-note for details");
    const sect = (k) => { const s = digest.indexOf(`(${k})`); const e = digest.indexOf("\n### ", s + 1); return digest.slice(s, e < 0 ? undefined : e); };
    check("(B) the never-drop FLOOR note renders compact (no tail, a memory_read pointer)", !sect("floor-note").includes(LATE) && sect("floor-note").includes("memory_read` floor-note"));
    check("(B) the compact floor note is far shorter than its body", sect("floor-note").length < longText.length / 3);
    check("(B) an ordinary pinned (REST) note is lead-truncated with a pointer", !sect("rest-note").includes(LATE) && sect("rest-note").includes("memory_read` rest-note"));
    check("(B) a RELATED note is lead-truncated with a pointer", !sect("related-note").includes(LATE) && sect("related-note").includes("memory_read` related-note"));
    check("(B) a RELATED note the kickoff cites by key renders in full", sect("cited-note").includes(LATE));
    const full = composeProjectMemoryDigest([floor, rest], [related], 100000, () => [], "", { truncateLongNotes: false }).digest;
    check("(B) truncateLongNotes:false restores full rendering (the pre-card sizing) and the default is measurably smaller",
      full.includes(LATE) && full.length > digest.length);
  }

  // ===================== (C) extractTaskSection / buildRecallQuery =====================
  {
    const kick = "preamble words\nTASK: card abc12345 (\"feat(memory): select digest\") docs wordiness work\nmore task detail here\n\nSTANDING KICKOFF CONSTRAINTS (verbatim): no push gate guards lane";
    const sec = extractTaskSection(kick);
    check("(C) the TASK section is extracted", sec !== null && sec.includes("wordiness") && sec.includes("more task detail"));
    check("(C) the TASK section stops before the standing-constraints block", !sec.includes("guards") && !sec.includes("STANDING"));
    check("(C negative control) no TASK line ⇒ null", extractTaskSection("just some prose with gate and guards") === null);

    const q = buildRecallQuery(kick, "Select digest by relevance");
    check("(C) source is title+task-section when both exist", q.source === "title+task-section");
    check("(C) boilerplate words after the standing marker are NOT in the query", !/\b(guards|gate|push|lane)\b/.test(q.query));
    check("(C) task words are in the query", /wordiness/.test(q.query) && /relevance/.test(q.query));
    check("(C) the title's words come first", q.query.startsWith("select digest relevance"));
    const noTitle = buildRecallQuery(kick);
    check("(C) source is task-section when only the section exists", noTitle.source === "task-section");
    const fb = buildRecallQuery("plain kickoff about gate guards");
    check("(C fail-safe) no TASK section and no title ⇒ the whole kickoff, source=kickoff", fb.source === "kickoff" && /gate/.test(fb.query));
    check("(C) title but no TASK section ⇒ title+kickoff", buildRecallQuery("plain kickoff about gate", "A title").source === "title+kickoff");
    const sw = buildRecallQuery("the and for not but are this that with from");
    check("(C) an all-stopword kickoff yields an empty query (no related tier)", sw.query === "");
    const many = buildRecallQuery(Array.from({ length: 80 }, (_, i) => `word${i}x`).join(" "));
    check("(C) the query is capped at RECALL_QUERY_MAX_TOKENS distinct tokens", many.query.split(" ").length === R.RECALL_QUERY_MAX_TOKENS);
    // 40 DISTINCT stopwords (dedupe would collapse repeats) ahead of one content word: with filtering AFTER the
    // 32-cap the content word would be pushed out; the cap must be spent on content words only.
    const stops = "the and for not but are was were with that this these those from into onto than then them they their there here have has had its our out all any can could should would will shall may might must does did you your".split(" ");
    const spent = buildRecallQuery(`${stops.join(" ")} distinctive`);
    check("(C sanity) the fixture really has >32 distinct stopwords", new Set(stops).size > 32);
    check("(C) stopwords do not spend the cap (a content word after >32 distinct stopwords still makes the query)", spent.query === "distinctive");
  }

  // ===================== CR minors (pre-land round) =====================
  {
    const sectOf = (digest, k) => { const s = digest.indexOf(`(${k})`); const e = digest.indexOf("\n### ", s + 1); return digest.slice(s, e < 0 ? undefined : e); };
    // 1a. a PINNED REST note cited by key renders in full; the same note uncited does not.
    const restLong = entry("rest-cited", longText, { pinned: true });
    check("(CR1a sanity) the fixture is over the threshold", restLong.text.length > R.DIGEST_NOTE_TRUNCATE_OVER_CHARS);
    const citedD = composeProjectMemoryDigest([restLong], [], 100000, () => [], "please read memory key rest-cited first").digest;
    check("(CR1a) a pinned REST note cited by key renders in FULL (tail sentinel present, no pointer)",
      sectOf(citedD, "rest-cited").includes(LATE) && !sectOf(citedD, "rest-cited").includes("memory_read"));
    const uncitedD = composeProjectMemoryDigest([restLong], [], 100000, () => [], "unrelated kickoff").digest;
    check("(CR1a negative control) the same REST note uncited is truncated", !sectOf(uncitedD, "rest-cited").includes(LATE));

    // 1b. packing sizes the RENDERED lead: full size exceeds the budget, the lead fits ⇒ included.
    const fullTok = R.estimateTokens(["## Pinned project memory (always included)", restLong.text].join("\n\n"));
    const budget = Math.floor(fullTok / 2);
    const packed = composeProjectMemoryDigest([restLong], [], budget, () => [], "unrelated kickoff");
    check("(CR1b sanity) full size really exceeds the budget", fullTok > budget);
    check("(CR1b) a note whose FULL size exceeds the remaining budget but whose LEAD fits is included (not dropped)",
      packed.includedIds.includes(restLong.id) && packed.droppedRestKeys.length === 0);

    // 2. extractTaskSection probes.
    const p1 = extractTaskSection("TASK: build X layout\n- constraint-free layout grid spacing\nmore detail");
    check("(CR2) a line merely starting with 'constraint-free' does NOT end the TASK section", p1 !== null && p1.includes("constraint-free layout grid spacing") && p1.includes("more detail"));
    const p2 = extractTaskSection("TASK:\nCONSTRAINTS: no push gate guards lane real description");
    check("(CR2) a bare TASK: header whose body is the constraints block ⇒ null (whole-kickoff fallback)", p2 === null);
    check("(CR2) 'CONSTRAINTS (verbatim):' still stops the section",
      !extractTaskSection("TASK: fix wordiness injected prompts\nCONSTRAINTS (verbatim): gate guards").includes("guards"));
    check("(CR2) CRLF kickoffs stop at the marker too",
      !extractTaskSection("TASK: fix wordiness injected prompts\r\nSTANDING KICKOFF: gate guards").includes("guards"));
    check("(CR2) the fallback reaches the query: source=kickoff and the constraints text is queried",
      buildRecallQuery("TASK:\nCONSTRAINTS: real description").source === "kickoff" && /real/.test(buildRecallQuery("TASK:\nCONSTRAINTS: real description").query));

    // 3. 'task' / 'card' are stopwords.
    const tc = buildRecallQuery("task card topicword task card");
    check("(CR3) 'task' and 'card' are dropped from the query, topic words kept", tc.query === "topicword");

    // 4a. no split surrogate pair at the hard cut.
    const emoji = "😀";
    const long1 = "a".repeat(R.DIGEST_NOTE_LEAD_MAX_CHARS - 1) + emoji.repeat(10) + "tail ".repeat(400);
    const sl = leadOrWhole(long1, "k").split("\n[…")[0];
    check("(CR4a sanity) the hard cut would land between a surrogate pair", long1.charCodeAt(R.DIGEST_NOTE_LEAD_MAX_CHARS - 1) >= 0xd800 && long1.charCodeAt(R.DIGEST_NOTE_LEAD_MAX_CHARS - 1) <= 0xdbff);
    check("(CR4a) the lead has no lone surrogate", !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(sl));
    // 4b. CRLF paragraph breaks behave like LF.
    const paras = ["**Provenance line.**", "## THE RULE\nrule sentence", ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"filler ".repeat(25)}`), LATE];
    const lf = leadOrWhole(paras.join("\n\n"), "k");
    const crlf = leadOrWhole(paras.join("\r\n\r\n"), "k");
    check("(CR4d) CRLF paragraph breaks: lead stops at paragraph granularity, tail omitted, same paragraphs kept as LF",
      !crlf.includes(LATE) && crlf.includes("rule sentence") && crlf.split("Paragraph ").length === lf.split("Paragraph ").length);
  }

  // ===================== (C) round trip through a real Db =====================
  {
    const db = new Db();
    db.insertProject({ id: "p", name: "Rel Test", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    writeProjectMemory(db, "p", { key: "topical-note", text: "notes about wordiness cuts in injected prompts" });
    writeProjectMemory(db, "p", { key: "filler-note", text: "the note is not for the people and that is what this one says" });
    writeProjectMemory(db, "p", { key: "boilerplate-note", text: "gate guards push lane constraints everywhere" });
    const kick = "TASK: cut wordiness in injected prompts for the card\n\nSTANDING KICKOFF CONSTRAINTS: the gate guards push lane";
    const logs = [];
    const orig = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
    let withTitle, noTask;
    try {
      withTitle = retrieveProjectMemoryForKickoff(db, "p", kick, { taskTitle: "Cut wordiness" });
      noTask = retrieveProjectMemoryForKickoff(db, "p", "gate guards for the push lane, not this");
    } finally { console.log = orig; }
    check("(C round-trip) the topical note is delivered", withTitle.includes("(topical-note)"));
    check("(C round-trip) a note matching ONLY stopwords is NOT delivered", !withTitle.includes("(filler-note)"));
    check("(C round-trip) a note matching ONLY the standing-constraints boilerplate is NOT delivered", !withTitle.includes("(boilerplate-note)"));
    check("(C fail-safe round-trip) a taskless kickoff with no TASK section falls back to the whole text (boilerplate-note matches)", noTask.includes("(boilerplate-note)"));
    check("(C) the source is logged, with no kickoff or note content",
      logs.some((l) => l.includes("related-tier query source=title+task-section")) && logs.some((l) => l.includes("source=kickoff"))
      && !logs.some((l) => /wordiness|boilerplate/.test(l)));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
}
if (failures) { console.error(`\n❌ ${failures} FAILURE(S)`); process.exit(1); }
console.log("\n✅ ALL PASS — digest selection by task relevance (card 7c74acd8)");
process.exit(0);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e4e180ad — inbound [[wikilink]] backlinks on memory note reads.
//
// THE DEFECT: when a note exceeds its byte cap, the store's own remedy (mcp/memory.ts's too-long
// rejection) is to split the overflow into a companion key and cross-link the two — but the canonical
// note is at its cap PRECISELY BECAUSE it has no room, so only the companion ever gets to add the
// forward link; the canonical note never gets a back-pointer. A reader who lands on the canonical note
// is never led to its own overflow.
//
// THE FIX (sessions/project-memory-backlinks.ts + sessions/project-memory-annotations.ts): resolve
// inbound backlinks fresh, at READ time, from every note-showing surface — memory_read/memory_list (via
// mcp/memory.ts's `withLinks`) and the kickoff digest (via project-memory-recall.ts's `annotate`
// callback) — mirroring exactly how card e6d270b3's linked-Request annotations already work. Never stored
// on the note itself, so it never counts against that note's own stored `text` byte cap.
//
// This file proves, against the REAL compiled modules:
//   1. extractWikilinkKeys: pure parsing (dedup, ignores malformed brackets, respects the key charset).
//   2. findInboundBacklinks/annotateBacklinks: DB-backed resolution, self-link exclusion, the MAX_BACKLINKS
//      cap + "N of M" truncation notice.
//   3. mcp/memory.ts: memory_read AND memory_list both carry `backlinks`, PAIRED positive/negative control
//      (a linked note and an unlinked note asserted in the SAME run — DoD-4's discrimination requirement).
//   4. The kickoff digest (retrieveProjectMemoryForKickoff) actually renders the backlink annotation on a
//      pinned note — and never against that note's own stored byte cap (DoD-2): a floor-tier note landed
//      right up against MAX_NEVER_DROP_TEXT_BYTES still accepts a write even once another note backlinks
//      to it, because the backlink is resolved outside `text` entirely.
//   5. DoD-3 follow-up (manager review): EVERY note the kickoff digest renders — floor-tier AND ordinary
//      pinned alike — gets backlinks capped at the much tighter MAX_BACKLINKS_DIGEST, never the general
//      MAX_BACKLINKS; memory_read/memory_list (on-demand, not a per-kickoff cost) keep the full cap
//      regardless of tier. Proven via a discriminating control on BOTH a floor-tier note and an ordinary
//      pinned note: memory_read and the digest render STRICTLY DIFFERENT counts for the identical note in
//      both cases (the boundary is digest-vs-on-demand, not floor-vs-ordinary).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-backlinks.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-project-memory-backlinks-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { extractWikilinkKeys, findInboundBacklinks, annotateBacklinks, MAX_BACKLINKS, MAX_BACKLINKS_DIGEST } =
  await import("../dist/sessions/project-memory-backlinks.js");
const { retrieveProjectMemoryForKickoff, NEVER_DROP_TAG } = await import("../dist/sessions/project-memory-recall.js");
const { writeProjectMemory, listProjectMemoryEntries, readProjectMemory } = await import("../dist/mcp/memory.js");

const db = new Db();
const now = new Date().toISOString();

try {
  // ===================== 1. extractWikilinkKeys: pure parsing =====================
  {
    check("(parse) a single [[key]] extracts one key",
      JSON.stringify(extractWikilinkKeys("see [[some-key]] for more")) === JSON.stringify(["some-key"]));
    check("(parse) multiple distinct [[key]]s extract in first-seen order",
      JSON.stringify(extractWikilinkKeys("[[first-key]] then [[second-key]]")) === JSON.stringify(["first-key", "second-key"]));
    check("(parse) a repeated [[key]] is deduped to one entry",
      JSON.stringify(extractWikilinkKeys("[[dup-key]] ... later also [[dup-key]] again")) === JSON.stringify(["dup-key"]));
    check("(parse) no wikilinks at all ⇒ []", extractWikilinkKeys("plain prose, no brackets here").length === 0);
    // NEGATIVE CONTROL: malformed bracket forms must NOT match (proves the pattern is anchored, not a
    // loose bracket-of-any-kind scan).
    check("(parse) a single-bracket [not-a-link] does NOT match", extractWikilinkKeys("[not-a-link]").length === 0);
    check("(parse) an unclosed [[dangling does NOT match", extractWikilinkKeys("[[dangling and more text").length === 0);
    // POSITIVE CONTROL proving the SAME charset the negative case above is scoped against actually can
    // match — a bare "[[]]" (empty key) must not match, but a real key adjacent to it still does.
    check("(parse) an empty [[]] does not match but a real neighboring [[key]] still does",
      JSON.stringify(extractWikilinkKeys("[[]] and [[real-key]]")) === JSON.stringify(["real-key"]));
  }

  // ===================== 2. findInboundBacklinks/annotateBacklinks: DB-backed =====================
  {
    const proj = "proj-backlinks-db";
    db.insertProject({ id: proj, name: "Backlinks DB Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.upsertProjectMemory(proj, { key: "canonical", text: "the capped canonical note, no room to link out" }, 500);
    db.upsertProjectMemory(proj, { key: "companion-a", text: "overflow content, see [[canonical]] for the parent note" }, 500);
    db.upsertProjectMemory(proj, { key: "unrelated", text: "links to [[something-else]], not the canonical note at all" }, 500);
    db.upsertProjectMemory(proj, { key: "self-linker", text: "a note that mentions [[self-linker]] itself" }, 500);

    const { matches, totalFound } = findInboundBacklinks(db, proj, "canonical");
    check("(db) exactly one note backlinks to 'canonical'", totalFound === 1 && matches.length === 1);
    check("(db) the backlink names the correct linking note's key", matches[0].key === "companion-a");
    check("(db) an unrelated note's link to a DIFFERENT key is not counted", !matches.some((m) => m.key === "unrelated"));

    // Self-link exclusion: a note wikilinking its OWN key must never count as its own backlink.
    const selfResult = findInboundBacklinks(db, proj, "self-linker");
    check("(db) a note linking to its OWN key is excluded from its own backlinks", selfResult.totalFound === 0);

    // MEASURED ZERO (DoD-4, negative polarity): a key nothing links to.
    const zeroResult = findInboundBacklinks(db, proj, "companion-a");
    check("(db) a note with NO inbound links returns totalFound:0, matches:[]", zeroResult.totalFound === 0 && zeroResult.matches.length === 0);

    const lines = annotateBacklinks(db, proj, "canonical");
    check("(db) annotateBacklinks renders a line naming the linking note as a wikilink",
      lines.some((l) => l.includes("[[companion-a]]")));
    const zeroLines = annotateBacklinks(db, proj, "companion-a");
    check("(db) annotateBacklinks on a zero-backlink key returns [] (measured zero, not omitted)",
      Array.isArray(zeroLines) && zeroLines.length === 0);

    // ===== DoD-3: MAX_BACKLINKS cap + truncation notice, at scale =====
    const manyProj = "proj-backlinks-scale";
    db.insertProject({ id: manyProj, name: "Backlinks Scale Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.upsertProjectMemory(manyProj, { key: "popular", text: "a note many others link to" }, 500);
    const totalLinkers = MAX_BACKLINKS + 7;
    for (let i = 0; i < totalLinkers; i++) {
      db.upsertProjectMemory(manyProj, { key: `linker-${String(i).padStart(2, "0")}`, text: `references [[popular]] among ${i}` }, 500);
    }
    const scaled = findInboundBacklinks(db, manyProj, "popular");
    check(`(cap) totalFound reports the TRUE total (${totalLinkers}), uncapped`, scaled.totalFound === totalLinkers);
    check(`(cap) matches is capped at MAX_BACKLINKS (${MAX_BACKLINKS})`, scaled.matches.length === MAX_BACKLINKS);
    const scaledLines = annotateBacklinks(db, manyProj, "popular");
    check("(cap) the annotation includes a truncation notice naming shown-of-total",
      scaledLines.some((l) => l.includes(`showing ${MAX_BACKLINKS} of ${totalLinkers}`)));
    // NEGATIVE CONTROL: a corpus UNDER the cap gets NO truncation notice at all.
    check("(cap) NEGATIVE CONTROL: the small 'canonical' case above (1 backlink, well under the cap) has no truncation notice",
      !lines.some((l) => l.includes("showing")));
  }

  // ===================== 3. mcp/memory.ts: memory_read / memory_list carry `backlinks` =====================
  {
    const proj = "proj-backlinks-mcp";
    db.insertProject({ id: proj, name: "Backlinks MCP Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

    const canonical = writeProjectMemory(db, proj, { key: "mcp-canonical", text: "capped canonical note body" });
    check("(mcp) setup: canonical note written", !("error" in canonical));
    const companion = writeProjectMemory(db, proj, { key: "mcp-companion", text: "overflow, see [[mcp-canonical]] for the parent" });
    check("(mcp) setup: companion note written, links to canonical", !("error" in companion));
    const lonely = writeProjectMemory(db, proj, { key: "mcp-lonely", text: "a note nothing links to" });
    check("(mcp) setup: lonely note written", !("error" in lonely));

    // PAIRED positive/negative control, asserted in the SAME run (card e4e180ad's explicit DoD-4 bound:
    // a run where BOTH come back empty must fail loudly, not read as "lonely is correctly empty").
    const readCanonical = readProjectMemory(db, proj, "mcp-canonical");
    const readLonely = readProjectMemory(db, proj, "mcp-lonely");
    check("(mcp) memory_read POSITIVE: canonical's backlinks is non-empty and names the companion",
      Array.isArray(readCanonical.backlinks) && readCanonical.backlinks.length === 1 &&
      readCanonical.backlinks[0].includes("[[mcp-companion]]"));
    check("(mcp) memory_read NEGATIVE (measured zero): lonely's backlinks is [] — present, not absent",
      "backlinks" in readLonely && Array.isArray(readLonely.backlinks) && readLonely.backlinks.length === 0);
    check("(mcp) PAIRED CONTROL SANITY: the two are NOT both empty (a broken resolver would make both zero)",
      !(readCanonical.backlinks.length === 0 && readLonely.backlinks.length === 0));

    check("(mcp) memory_read never mutates the canonical note's own stored text",
      readCanonical.text === "capped canonical note body");

    // memory_list carries the SAME field, same values, for both notes in ONE listing call.
    const listed = listProjectMemoryEntries(db, proj);
    const listedCanonical = listed.find((e) => e.key === "mcp-canonical");
    const listedLonely = listed.find((e) => e.key === "mcp-lonely");
    check("(mcp) memory_list POSITIVE: canonical carries the same non-empty backlinks as memory_read",
      !!listedCanonical && listedCanonical.backlinks.length === 1 && listedCanonical.backlinks[0].includes("[[mcp-companion]]"));
    check("(mcp) memory_list NEGATIVE (measured zero): lonely carries backlinks:[] too",
      !!listedLonely && Array.isArray(listedLonely.backlinks) && listedLonely.backlinks.length === 0);

    // DoD-2: backlinks NEVER count against the note's own stored text byte cap. Prove it by writing a
    // note right at the general 4000-byte cap (so there is ZERO headroom left in `text`), then having
    // ANOTHER note backlink to it — the write already succeeded before any backlink existed, and a
    // backlink appearing later must never retroactively invalidate it or require re-validating the cap.
    const atCapText = "z".repeat(4000);
    const atCap = writeProjectMemory(db, proj, { key: "mcp-at-cap", text: atCapText });
    check("(mcp) setup: a note at the EXACT 4000-byte general cap is accepted", !("error" in atCap) && atCap.text.length === 4000);
    const linkToAtCap = writeProjectMemory(db, proj, { key: "mcp-links-to-at-cap", text: "overflow, see [[mcp-at-cap]]" });
    check("(mcp) setup: a companion linking to the at-cap note is written", !("error" in linkToAtCap));
    const readAtCap = readProjectMemory(db, proj, "mcp-at-cap");
    check("(mcp) DoD-2: the at-cap note's backlinks now show the companion, with its OWN stored text untouched (still exactly 4000 bytes)",
      readAtCap.backlinks.some((l) => l.includes("[[mcp-links-to-at-cap]]")) && readAtCap.text.length === 4000);
  }

  // ===================== 4. kickoff digest: backlinks render, floor-tier byte cap unaffected =====================
  {
    const proj = "proj-backlinks-digest";
    db.insertProject({ id: proj, name: "Backlinks Digest Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

    // DoD-3 in the worst case named by the card: the never-drop FLOOR tier, at its own lower 2000-byte
    // cap, right up against the edge (only ~10 bytes of headroom) — proving a backlink resolved at READ
    // time can NEVER be the thing that pushes this write over its cap, because it isn't in `text` at all.
    const floorTextNearCap = "y".repeat(1990);
    const floorNote = writeProjectMemory(db, proj, {
      key: "floor-canonical", text: floorTextNearCap, pinned: true, tags: [NEVER_DROP_TAG],
    });
    check("(digest) setup: a floor-tier note landed just under its OWN 2000-byte cap", !("error" in floorNote));
    const floorCompanion = writeProjectMemory(db, proj, {
      key: "floor-companion", text: "the overflow that couldn't fit — see [[floor-canonical]] for the parent",
    });
    check("(digest) setup: a companion linking to the floor note is written (itself well under the general cap)",
      !("error" in floorCompanion));

    const framed = retrieveProjectMemoryForKickoff(db, proj, "");
    check("(digest) the kickoff digest actually renders the backlink annotation on the floor note",
      typeof framed === "string" && framed.includes("[backlink: [[floor-companion]] links here]"));
    check("(digest) the floor note's OWN write never had to shrink to make room for the backlink (still ~1990 bytes stored)",
      floorNote.text.length === 1990);

    // A second write to the SAME floor note, at the SAME near-cap size, still succeeds AFTER the backlink
    // exists — proves the cap check itself never counts the read-time-only annotation.
    const floorRewrite = writeProjectMemory(db, proj, {
      key: "floor-canonical", text: "y".repeat(1995), pinned: true, tags: [NEVER_DROP_TAG], baseVersion: floorNote.version,
    });
    check("(digest) DoD-2: re-writing the floor note (now WITH a live backlink) at 1995 bytes still succeeds — the cap never counted the annotation",
      !("error" in floorRewrite));
  }

  // ===================== DoD-3 follow-up (manager review): the WHOLE DIGEST gets a tighter cap =====================
  // Measured live against this project's real corpus: at the general MAX_BACKLINKS=20, the 8 real
  // floor-tier notes add ~2,593 estimated tokens COMBINED, but the 23 ORDINARY pinned notes add a
  // comparable ~2,649 — every note the digest renders is sized against the shared budget on EVERY
  // kickoff regardless of tier, so BOTH populations get the tighter MAX_BACKLINKS_DIGEST in the digest;
  // only memory_read/memory_list (an on-demand pull, not a per-kickoff cost) keep the full MAX_BACKLINKS.
  // Proven for BOTH a floor-tier note AND an ordinary pinned note: same discriminating shape (memory_read
  // vs digest, same note, different counts), boundary moved from tier-based to digest-vs-on-demand.
  {
    const proj = "proj-backlinks-digest-cap";
    db.insertProject({ id: proj, name: "Digest Cap Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    check("(digest-cap) sanity: the digest cap is strictly tighter than the general on-demand cap",
      MAX_BACKLINKS_DIGEST < MAX_BACKLINKS);

    const linkerCount = MAX_BACKLINKS_DIGEST + 6; // > digest cap, still < the general on-demand cap
    const mkHubAndLinkers = (hubKey, hubOpts) => {
      const hub = writeProjectMemory(db, proj, { key: hubKey, text: `a note many others link to (${hubKey})`, ...hubOpts });
      check(`(digest-cap) setup: ${hubKey} hub note written`, !("error" in hub));
      for (let i = 0; i < linkerCount; i++) {
        writeProjectMemory(db, proj, { key: `${hubKey}-linker-${String(i).padStart(2, "0")}`, text: `references [[${hubKey}]] among ${i}` });
      }
    };
    const assertDualCap = (hubKey) => {
      // memory_read (on-demand): ALL linkerCount backlinks fit, since linkerCount < the general MAX_BACKLINKS.
      const readHub = readProjectMemory(db, proj, hubKey);
      check(`(digest-cap) ${hubKey}: memory_read shows ALL ${linkerCount} backlinks (under the general cap, no truncation)`,
        readHub.backlinks.filter((l) => l.startsWith("[backlink:")).length === linkerCount &&
        !readHub.backlinks.some((l) => l.includes("showing")));

      // Kickoff digest: the SAME note is capped at MAX_BACKLINKS_DIGEST, with a truncation notice.
      const framed = retrieveProjectMemoryForKickoff(db, proj, "");
      const linkerPattern = new RegExp(`\\[backlink: \\[\\[${hubKey}-linker-\\d+\\]\\] links here\\]`, "g");
      const shownInDigest = (framed.match(linkerPattern) ?? []).length;
      check(`(digest-cap) ${hubKey}: the KICKOFF DIGEST shows only ${MAX_BACKLINKS_DIGEST} backlinks (the tighter cap)`,
        shownInDigest === MAX_BACKLINKS_DIGEST);
      check(`(digest-cap) ${hubKey}: the digest's truncation notice reports "showing ${MAX_BACKLINKS_DIGEST} of ${linkerCount}"`,
        framed.includes(`showing ${MAX_BACKLINKS_DIGEST} of ${linkerCount}`));
      check(`(digest-cap) ${hubKey}: DISCRIMINATING — the digest shows STRICTLY FEWER backlinks than memory_read did for the identical note`,
        shownInDigest < readHub.backlinks.filter((l) => l.startsWith("[backlink:")).length);
    };

    // Floor-tier hub note: gets the tight digest cap.
    mkHubAndLinkers("floor-hub", { pinned: true, tags: [NEVER_DROP_TAG] });
    assertDualCap("floor-hub");

    // POSITIVE CONTROL (was a negative control before this correction): an ORDINARY pinned note (no
    // never-drop tag) with the SAME linker count is ALSO capped in the digest — the boundary is
    // digest-vs-on-demand, not floor-tier-vs-ordinary, so this population must behave identically.
    mkHubAndLinkers("ordinary-hub", { pinned: true });
    assertDualCap("ordinary-hub");
  }

  // ===================== DoD-5: the REAL Loom-project instance named in card e4e180ad's own evidence =====================
  // The card's evidence names TWO real canonical notes with no back-pointer. Instance #1 is THIS project's
  // own store: `read-the-artifact-before-you-send-not-after` (a pinned never-drop floor note, at its
  // 2000-byte cap) never got a back-pointer to its overflow companion `check-for-an-existing-class-before-
  // minting-one`, even though that companion ALREADY carries `[[read-the-artifact-before-you-send-not-after]]`
  // in its own body (read live via memory_read on 2026-08-28, verbatim below) — so no DATA change is needed
  // at all; the fix is purely in the read path. This seeds a throwaway project with BOTH notes' REAL,
  // verbatim bodies (captured via a live memory_read against this project's actual store) and proves the
  // fixed read path now surfaces the backlink from that real content.
  // Instance #2 (the Codescape peer's own canonical note) lives in a DIFFERENT Loom project — this
  // session's memory tools are scoped server-side to THIS project only, so it cannot be read or verified
  // from here; the mechanism is project-scoped and generic, so it applies identically there once this
  // fix is merged and the daemon is restarted, but that verification is out of this session's reach.
  {
    const realProj = "proj-backlinks-real-instance";
    db.insertProject({ id: realProj, name: "Real Instance Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

    const realCanonicalText = `**2026-08-04. v4 2026-08-27: specimens + numbers split to [[read-the-artifact-before-you-send-evidence]]; nothing deleted.**

## ⭐⭐ THE DISCIPLINE
> **READ THE ARTIFACT BEFORE YOU SEND, NOT AFTER.** Not "be more careful" — **open the file, the card, the predecessor doc, the transcript, FIRST.**
📌 **Every agent:** a done-report, a card body, a peer message, a claim about a commit. **\`git show HEAD:<file>\` before reporting done is the same discipline.**
✅ **EXTENSION (Codescape): DRAIN YOUR INBOX BEFORE COMPOSING A CORRECTION ABOUT A PEER'S STATE** — async means their position can be superseded before your correction lands.

## ⭐⭐ WHY IT WORKS
🔴 **THE ARTIFACT THAT REFUTES YOU IS USUALLY ALREADY IN YOUR TREE, AND HAS BEEN FOR A WHILE.**
⇒ **The invalidator does NOT have to be NEW INFORMATION — it has to be EXTERNAL TO YOUR REASONING:** a second party, a control, a direct question, or THE ARTIFACT. ⛔ **Re-reading your own note is NOT external.**

Related: [[read-the-artifact-before-you-send-evidence]] · [[the-qualifier-dies-in-the-summary-label]] · [[route-verification-to-a-second-reader-not-more-care]].`;
    const realCompanionText = `**Loom \`gen 194\` + the Codescape peer, 2026-08-28. A cross-project adjudication, decided rather than left open.**
📌 **This note is ALSO the overflow home for [[read-the-artifact-before-you-send-not-after]]'s SUB-MECHANISMS** — that note is a pinned \`never-drop\` note at its 2000-byte cap, so the detail lives here by the documented split pattern.

Related: [[read-the-artifact-before-you-send-not-after]] · [[a-discriminator-is-silent-about-the-option-not-in-its-set]] · [[the-qualifier-dies-in-the-summary-label]].`;

    db.upsertProjectMemory(realProj, { key: "read-the-artifact-before-you-send-not-after", text: realCanonicalText, pinned: true, tags: ["method", "never-drop"] }, 500);
    db.upsertProjectMemory(realProj, { key: "check-for-an-existing-class-before-minting-one", text: realCompanionText }, 500);

    const realCanonicalRead = readProjectMemory(db, realProj, "read-the-artifact-before-you-send-not-after");
    check("(DoD-5, real instance) BEFORE this fix, this note's real body carries NO reference to its own overflow companion (confirms the gap was real, not a test artifact)",
      !realCanonicalRead.text.includes("check-for-an-existing-class-before-minting-one"));
    check("(DoD-5, real instance) AFTER this fix: memory_read on the REAL canonical note now surfaces its REAL overflow companion as a backlink",
      realCanonicalRead.backlinks.some((l) => l.includes("[[check-for-an-existing-class-before-minting-one]]")));
  }

  // ===================== zero-notes additive guard: a project with no notes never throws =====================
  check("(additive) findInboundBacklinks on an empty project returns totalFound:0, no throw",
    (() => {
      const emptyProj = "proj-backlinks-empty";
      db.insertProject({ id: emptyProj, name: "Empty Backlinks Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
      const r = findInboundBacklinks(db, emptyProj, "anything");
      return r.totalFound === 0 && r.matches.length === 0;
    })());
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — inbound [[wikilink]] backlinks: pure parsing (dedup, malformed-bracket rejection), " +
    "DB-backed resolution (self-link exclusion, MAX_BACKLINKS cap + truncation notice), memory_read/" +
    "memory_list carrying a paired measured-zero-vs-populated `backlinks` field, and the kickoff digest " +
    "rendering the annotation without it ever counting against a note's own stored byte cap (incl. the " +
    "never-drop floor tier's lower cap) — all claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

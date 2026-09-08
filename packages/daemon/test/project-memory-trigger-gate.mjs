import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aeec1880 — trigger-gate a pinned memory note to a touched-path glob instead of pinning it
// globally, so its byte cost is paid only on kickoffs where it's actually relevant and the freed budget
// goes to the RELATED (FTS-matched) tier the rest of the time.
//
// This file tests the SELECTION DECISION (which notes are chosen for which kickoff shape), not byte
// counts (which drift) — mirrors this project's own testing convention for the digest packer
// (project-memory-related-floor.mjs) and its own standing instruction on this exact card.
//
// Covers:
//   (1) the pure predicate matcher (triggerMatchesKickoff) — including a negative control (a bogus
//       pattern must return false, not "matches everything" by construction).
//   (2) the pure partition decision (partitionPinnedForKickoff) — DB-free, so the selection logic itself
//       is directly testable without a live Db or a real kickoff round-trip.
//   (3) the full round-trip via a REAL Db + writeProjectMemory + retrieveProjectMemoryForKickoff:
//       - a trigger-gated note rides the pinned tier on a matching kickoff, and is ABSENT on a
//         non-matching one that also doesn't FTS-match.
//       - DoD-3: an existing `pinned:true` note with NO predicate is byte-identical in behavior — rides
//         EVERY kickoff regardless of text, exactly as before this card.
//       - DoD-4: a gated-out note has NOT lost its FTS reachability — it surfaces in the RELATED tier on
//         a kickoff whose text matches its own title/text, even though its path predicate didn't fire.
//       - DoD-5: a "never-drop"-tagged note bypasses its own trigger — it still rides even when the
//         predicate does NOT match, so a predicate can never silently weaken that guarantee.
//       - no double-delivery: a trigger-gated note that BOTH fires its predicate AND FTS-matches its own
//         kickoff text is injected exactly once, not twice.
//   (4) mcp/memory.ts's write-time surface: triggerGlob PATCH semantics (omit preserves, "" clears, a
//       value sets), the too-long rejection, and the `triggerGateStatus` informational signal's three
//       shapes (inert-unpinned, inert-never-drop-bypass, active).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-trigger-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-trigger-gate-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const {
  retrieveProjectMemoryForKickoff, triggerMatchesKickoff, partitionPinnedForKickoff, NEVER_DROP_TAG,
} = await import("../dist/sessions/project-memory-recall.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");

const db = new Db();
const now = new Date().toISOString();
const projId = "proj-trigger-gate";
db.insertProject({ id: projId, name: "Trigger Gate Test Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

const mkEntry = (over) => ({
  id: over.id, projectId: projId, key: over.key, title: over.title ?? "", text: over.text,
  pinned: !!over.pinned, tags: over.tags ?? [], createdAt: now, updatedAt: now,
  lastRetrievedAt: null, retrievalCount: 0, version: 1, requestIds: null,
  triggerGlob: over.triggerGlob ?? null,
});

try {
  // ===================== (1) pure predicate matcher =====================
  {
    check("(match) a glob matches a path-like token literally present in the kickoff text",
      triggerMatchesKickoff("packages/daemon/src/memory/**", "Please fix a bug in packages/daemon/src/memory/foo.ts today"));
    check("(match) a bare-filename glob is auto-prefixed to match anywhere (mirrors pathGlobToRegExp)",
      triggerMatchesKickoff("*.ts", "see `packages/daemon/src/db.ts` for details"));
    check("(match) trailing prose punctuation around a backtick-wrapped path is stripped before matching",
      triggerMatchesKickoff("packages/daemon/src/db.ts", "read `packages/daemon/src/db.ts`, then proceed."));
    check("(match) a path mentioned in parentheses at a sentence's end still matches",
      triggerMatchesKickoff("packages/web/**", "the bug is in the UI (packages/web/src/App.tsx)."));

    // Negative control: a pattern that CANNOT match this text must return false, not true by construction —
    // proves the matcher discriminates rather than trivially passing.
    check("(negative control) a glob naming a path that does not appear anywhere in the text returns false",
      triggerMatchesKickoff("packages/web/**", "this kickoff only ever mentions packages/daemon/src/memory/foo.ts") === false);
    check("(negative control) a blank/whitespace-only glob never matches anything (fails closed, not open)",
      triggerMatchesKickoff("   ", "packages/daemon/src/memory/foo.ts is right here in the text") === false);
    check("(negative control) prose with NO path-like token at all never matches",
      triggerMatchesKickoff("packages/daemon/**", "just fix the bug, thanks") === false);
  }

  // ===================== (2) pure partition decision — DB-free =====================
  {
    const always = mkEntry({ id: "id-always", key: "always-pinned", text: "rides every kickoff" });
    const gatedMatch = mkEntry({ id: "id-gated-match", key: "gated-match", text: "gated note", triggerGlob: "packages/daemon/src/memory/**" });
    const gatedNoMatch = mkEntry({ id: "id-gated-no-match", key: "gated-no-match", text: "gated note 2", triggerGlob: "packages/web/**" });
    const neverDropGated = mkEntry({ id: "id-nd-gated", key: "nd-gated", text: "floor note", tags: [NEVER_DROP_TAG], triggerGlob: "packages/web/**" });

    const kickoffText = "this task touches packages/daemon/src/memory/foo.ts only";
    const { forDigest, gatedOut } = partitionPinnedForKickoff([always, gatedMatch, gatedNoMatch, neverDropGated], kickoffText);
    const forDigestIds = forDigest.map((m) => m.id);
    const gatedOutIds = gatedOut.map((m) => m.id);

    check("(partition) an unconditionally-pinned note (no triggerGlob) always lands in forDigest",
      forDigestIds.includes("id-always"));
    check("(partition) a trigger-gated note whose predicate MATCHES lands in forDigest",
      forDigestIds.includes("id-gated-match"));
    check("(partition) a trigger-gated note whose predicate does NOT match lands in gatedOut, not forDigest",
      gatedOutIds.includes("id-gated-no-match") && !forDigestIds.includes("id-gated-no-match"));
    check("(partition) DoD-5: a never-drop note ALWAYS lands in forDigest even though its own trigger did not match",
      forDigestIds.includes("id-nd-gated") && !gatedOutIds.includes("id-nd-gated"));

    // Second kickoff: neither gated note's predicate fires — proves the decision is genuinely PER-KICKOFF,
    // not a fixed property of the note.
    const otherKickoff = "totally unrelated text naming no repo path at all";
    const second = partitionPinnedForKickoff([always, gatedMatch, gatedNoMatch, neverDropGated], otherKickoff);
    check("(partition) the SAME gated note that matched one kickoff is gated OUT on a different, non-matching kickoff",
      second.gatedOut.map((m) => m.id).includes("id-gated-match"));
    check("(partition) never-drop still bypasses on this second kickoff too",
      second.forDigest.map((m) => m.id).includes("id-nd-gated"));
  }

  // ===================== (3) full round-trip: a real Db, writeProjectMemory, retrieveProjectMemoryForKickoff =====================
  {
    const w = writeProjectMemory(db, projId, {
      key: "gated-note", text: "a note about the memory subsystem's internals",
      pinned: true, triggerGlob: "packages/daemon/src/memory/**",
    });
    check("(round-trip) writing a trigger-gated pinned note succeeds", !("error" in w));

    const matchingKickoff = "fix the predicate logic in packages/daemon/src/memory/foo.ts";
    const framedMatch = retrieveProjectMemoryForKickoff(db, projId, matchingKickoff);
    check("(round-trip) a kickoff whose text names a matching path delivers the gated note via the PINNED tier",
      typeof framedMatch === "string"
      && framedMatch.includes("## Pinned project memory")
      && framedMatch.includes("a note about the memory subsystem's internals"));

    // A non-matching kickoff that ALSO shares no >=3-char word with the note's own text (db.ts's
    // ftsProjectMemoryQuery keeps every token of 3+ chars, unfiltered for stopwords — so even an
    // unrelated-sounding sentence sharing a word like "the"/"about" would spuriously FTS-match; this
    // sentence is deliberately built to share NOTHING with "a note about the memory subsystem's
    // internals") — proving the note is genuinely absent, not merely relegated to a related-tier match on
    // different grounds.
    const nonMatchingKickoff = "adjust css colors on buttons";
    const framedNoMatch = retrieveProjectMemoryForKickoff(db, projId, nonMatchingKickoff);
    check("(round-trip) a kickoff whose text names NO matching path, and does not FTS-match either, omits the gated note entirely",
      framedNoMatch === null || !framedNoMatch.includes("a note about the memory subsystem's internals"));
  }

  // ===================== DoD-3: an existing pinned note with NO predicate is byte-identical (rides always) =====================
  {
    const w = writeProjectMemory(db, projId, { key: "always-pinned-note", text: "this rides every kickoff unconditionally", pinned: true });
    check("(DoD-3) writing an ordinary pinned note (no triggerGlob) succeeds", !("error" in w));
    check("(DoD-3) triggerGlob is null on an ordinary pinned note", w.triggerGlob === null);

    for (const kickoffText of ["packages/daemon/src/memory/foo.ts", "totally unrelated text naming no path at all", ""]) {
      const framed = retrieveProjectMemoryForKickoff(db, projId, kickoffText);
      check(`(DoD-3) the ordinary pinned note rides regardless of kickoff shape (kickoff: ${JSON.stringify(kickoffText.slice(0, 30))})`,
        typeof framed === "string" && framed.includes("this rides every kickoff unconditionally"));
    }
  }

  // ===================== DoD-4: a gated-out note has NOT lost its FTS reachability =====================
  {
    const w = writeProjectMemory(db, projId, {
      key: "fts-reachable-gated", title: "quux-frobnicator-widget note",
      text: "distinctive-quuxword-marker appears only here for FTS matching",
      pinned: true, triggerGlob: "packages/web/**", // will NOT fire against a daemon-only kickoff
    });
    check("(DoD-4) writing succeeds", !("error" in w));

    // The kickoff text does NOT contain any web path (predicate does not fire) but DOES contain the
    // distinctive FTS keyword from the note's own text.
    const kickoffText = "please investigate the distinctive-quuxword-marker issue in the daemon";
    const framed = retrieveProjectMemoryForKickoff(db, projId, kickoffText);
    check("(DoD-4) a gated-out note (predicate did not fire) still surfaces via the RELATED tier when its own text FTS-matches",
      typeof framed === "string"
      && framed.includes("## Related project memory")
      && framed.includes("distinctive-quuxword-marker appears only here"));
    check("(DoD-4) it does NOT ALSO appear in the Pinned section (it was genuinely gated out of that tier)",
      !framed.slice(0, framed.indexOf("## Related project memory")).includes("distinctive-quuxword-marker"));
  }

  // ===================== DoD-5: never-drop bypasses its own trigger even when the predicate never fires =====================
  {
    const w = writeProjectMemory(db, projId, {
      key: "floor-note-with-trigger", text: "must always ride, this is a floor guarantee",
      pinned: true, tags: [NEVER_DROP_TAG], triggerGlob: "packages/web/**",
    });
    check("(DoD-5) writing a never-drop note WITH a triggerGlob succeeds", !("error" in w));

    const kickoffText = "a kickoff that names no web path anywhere, and shares no words with the floor note";
    const framed = retrieveProjectMemoryForKickoff(db, projId, kickoffText);
    check("(DoD-5) the never-drop note still rides even though its own trigger predicate did not fire",
      typeof framed === "string" && framed.includes("must always ride, this is a floor guarantee"));
  }

  // ===================== no double-delivery: predicate fires AND the note also FTS-matches its own kickoff =====================
  {
    const w = writeProjectMemory(db, projId, {
      key: "double-delivery-check", title: "gate-double-marker",
      text: "gate-double-marker body text, distinctive for FTS",
      pinned: true, triggerGlob: "packages/daemon/src/orchestration/**",
    });
    check("(dedup) writing succeeds", !("error" in w));

    // This kickoff both (a) names a matching path (fires the trigger) and (b) contains the distinctive
    // marker word (would also FTS-match) — the note must appear exactly once, not twice.
    const kickoffText = "gate-double-marker: please review packages/daemon/src/orchestration/foo.ts";
    const framed = retrieveProjectMemoryForKickoff(db, projId, kickoffText);
    const occurrences = framed ? framed.split("gate-double-marker body text").length - 1 : 0;
    check("(dedup) a note whose predicate fires AND whose text independently FTS-matches is injected EXACTLY ONCE",
      occurrences === 1);
  }

  // ===================== (4) mcp/memory.ts write-time surface: PATCH semantics + validation + status signal =====================
  {
    const proj2 = "proj-trigger-gate-mcp";
    db.insertProject({ id: proj2, name: "Trigger Gate MCP Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

    // --- inert: unpinned note ---
    const wUnpinned = writeProjectMemory(db, proj2, { key: "unpinned-with-trigger", text: "x", triggerGlob: "packages/daemon/**" });
    check("(mcp) triggerGateStatus is present and inert:true on an UNPINNED note", wUnpinned.triggerGateStatus?.inert === true);

    // --- inert: never-drop bypass ---
    const wFloor = writeProjectMemory(db, proj2, { key: "floor-with-trigger", text: "x", pinned: true, tags: [NEVER_DROP_TAG], triggerGlob: "packages/daemon/**" });
    check("(mcp) triggerGateStatus is present and inert:true on a pinned+never-drop note (bypass)", wFloor.triggerGateStatus?.inert === true);

    // --- active: ordinary pinned note ---
    const wActive = writeProjectMemory(db, proj2, { key: "active-trigger", text: "x", pinned: true, triggerGlob: "packages/daemon/**" });
    check("(mcp) triggerGateStatus is present WITHOUT inert on an ordinary pinned+triggerGlob note", wActive.triggerGateStatus !== undefined && wActive.triggerGateStatus.inert === undefined);

    // --- no signal at all when triggerGlob isn't set ---
    const wPlain = writeProjectMemory(db, proj2, { key: "plain-pinned", text: "x", pinned: true });
    check("(mcp) no triggerGateStatus at all on an ordinary pinned note with no triggerGlob", wPlain.triggerGateStatus === undefined);

    // --- PATCH semantics: omitting triggerGlob on an update preserves the stored value ---
    const wUpdate1 = writeProjectMemory(db, proj2, { key: "active-trigger", text: "updated body, same predicate", baseVersion: wActive.version });
    check("(mcp) omitting triggerGlob on update preserves the previously-set predicate", wUpdate1.triggerGlob === "packages/daemon/**");

    // --- PATCH semantics: an explicit "" clears the predicate ---
    const wUpdate2 = writeProjectMemory(db, proj2, { key: "active-trigger", triggerGlob: "", baseVersion: wUpdate1.version });
    check("(mcp) an explicit empty-string triggerGlob clears the predicate back to null", wUpdate2.triggerGlob === null);
    check("(mcp) after clearing, triggerGateStatus is no longer present (note behaves as an ordinary pin)", wUpdate2.triggerGateStatus === undefined);

    // --- validation: too-long triggerGlob is rejected ---
    const tooLong = "a".repeat(500);
    const wTooLong = writeProjectMemory(db, proj2, { key: "too-long-trigger", text: "x", pinned: true, triggerGlob: tooLong });
    check("(mcp) a triggerGlob over the length cap is rejected with an error", "error" in wTooLong);
  }
} catch (err) {
  console.error(err);
  failures++;
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — trigger-gate predicate (card aeec1880): the touched-path glob matcher discriminates " +
    "correctly (proven against a negative control, not merely a passing positive case), the pure partition " +
    "decision correctly separates always-pinned/matched-gated/gated-out/never-drop-bypassed notes per " +
    "kickoff, an existing pinned:true note with no predicate is byte-identical across every kickoff shape " +
    "(DoD-3), a gated-out note stays fully FTS-reachable via the RELATED tier (DoD-4), a never-drop note " +
    "bypasses its own trigger unconditionally (DoD-5), a note is never delivered twice when its predicate " +
    "fires AND it independently FTS-matches, and the memory_write surface's PATCH semantics (omit " +
    "preserves, \"\" clears, a value sets) plus its three-shaped triggerGateStatus signal (inert-unpinned, " +
    "inert-never-drop-bypass, active) all behave as specified. Against the REAL compiled db.ts + " +
    "project-memory-recall.ts + mcp/memory.ts, claude-free, network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);

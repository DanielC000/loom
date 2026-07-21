import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion memory RECALL — turns the self-authored memory store (companion-memory-store.ts) into a
// digest actually placed in front of the model. DETERMINISTIC + CLAUDE-FREE + hermetic. Covers:
//   (1) composeMemoryRecallDigest: two-tier shape (pinned in full, name-sorted; the rest as a compact
//       name+description index, name-sorted), input-order-independent (pure function of the memory SET);
//   (2) byte-bounded with DETERMINISTIC truncation — pinned entries drop from a name-sorted PREFIX at the
//       first overflow, the index drops from the TAIL (alphabetically-later names first), and the bound is
//       EXACT for a MIXED pinned+index digest too (section headers + the "\n\n" join are counted, not just
//       raw content bytes);
//   (3) framedMemoryRecall / buildFramedMemoryRecall: framed as DATA/CONTEXT, never an instruction, AND
//       explicitly SILENT (never a reason to chat_reply on its own — mirrors DEFAULT_HEARTBEAT_PROMPT's
//       "stay quiet unless there's something genuinely worth surfacing"); empty memory ⇒ null (no block);
//   (4) appendMemoryRecallToStartupPrompt (assistant-prompt.ts): the FRESH-spawn half — null ⇒ byte-
//       identical prompt, a framed digest ⇒ appended after a '---' separator;
//   (5) END TO END over a real SessionService + a fake pty: a FRESH assistant spawn with empty memory is
//       byte-identical to today (composeAssistantStartupPrompt alone, no [loom:memory] tag); a RESUMED
//       assistant with memory gets the digest enqueued EXACTLY ONCE as its first pending turn (a
//       documented, deliberate exception to "resume injects nothing" — see sessions/service.ts, and note
//       resume() itself only reaches that code once per activation — the isAlive short-circuit skips an
//       already-live session, so no separate "recalled once" flag is needed); a resumed assistant with
//       EMPTY memory enqueues nothing; and a non-assistant (manager) resume is completely untouched even
//       when a companion-memory dir happens to exist under its session id (role-gated, not existence-gated).
// Run: 1) build (turbo builds shared first), 2) node test/companion-memory-recall.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs). Set BEFORE importing dist.
const tmpHome = path.join(os.tmpdir(), `loom-mem-recall-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeAssistantStartupPrompt, appendMemoryRecallToStartupPrompt } = await import("../dist/sessions/assistant-prompt.js");
const {
  composeMemoryRecallDigest, framedMemoryRecall, buildFramedMemoryRecall, MEMORY_RECALL_TAG,
} = await import("../dist/companion/memory-recall.js");
const { authorCompanionMemory } = await import("../dist/skills/companion-memory-store.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// =========================================================================================================
// Part 1 — composeMemoryRecallDigest: two-tier shape, name-sorted, input-order-independent
// =========================================================================================================
{
  const memories = [
    { name: "zzz-topic", description: "d-zzz", pinned: false },
    { name: "bbb-fact", description: "d-bbb", pinned: true },
    { name: "aaa-fact", description: "d-aaa", pinned: true },
    { name: "mmm-topic", description: "d-mmm", pinned: false },
  ];
  const readFull = (name) => `FULL(${name})`;

  check("digest: empty memory list ⇒ null (empty → no block)", composeMemoryRecallDigest([], readFull) === null);

  const digest = composeMemoryRecallDigest(memories, readFull);
  check("digest: non-null for a non-empty memory set", digest != null);
  check("digest: pinned section header present", digest.includes("## Pinned memories (in full)"));
  check("digest: index section header present", digest.includes("## Other memories"));
  check("digest: pinned entries carry their FULL content", digest.includes("FULL(aaa-fact)") && digest.includes("FULL(bbb-fact)"));
  check("digest: pinned entries are NAME-SORTED (aaa-fact before bbb-fact)", digest.indexOf("### aaa-fact") < digest.indexOf("### bbb-fact"));
  check("digest: pinned section precedes the index section", digest.indexOf("## Pinned memories") < digest.indexOf("## Other memories"));
  check("digest: unpinned entries render as compact name: description lines", digest.includes("- mmm-topic: d-mmm") && digest.includes("- zzz-topic: d-zzz"));
  check("digest: index entries are NAME-SORTED (mmm-topic before zzz-topic)", digest.indexOf("- mmm-topic:") < digest.indexOf("- zzz-topic:"));
  check("digest: unpinned entries are NOT rendered in full (no FULL() marker for them)", !digest.includes("FULL(zzz-topic)") && !digest.includes("FULL(mmm-topic)"));

  const shuffled = [memories[3], memories[0], memories[2], memories[1]];
  check("digest: deterministic regardless of INPUT array order (pure function of the set)", composeMemoryRecallDigest(shuffled, readFull) === digest);
  check("digest: deterministic across repeated calls with the same input", composeMemoryRecallDigest(memories, readFull) === digest);

  // A memory that vanished between list + read (race) is skipped, never throws.
  const withGhost = [...memories, { name: "ghost", description: "d-ghost", pinned: true }];
  const readFullGhost = (name) => (name === "ghost" ? null : `FULL(${name})`);
  const withGhostDigest = composeMemoryRecallDigest(withGhost, readFullGhost);
  check("digest: a pinned entry whose read returns null is skipped, not thrown", withGhostDigest != null && !withGhostDigest.includes("ghost"));
}

// =========================================================================================================
// Part 2 — byte-bounded with DETERMINISTIC truncation
// =========================================================================================================
{
  // 2a. Pinned: a name-sorted PREFIX is included, stopping at the first entry that would overflow.
  const memories = [
    { name: "a-short", description: "short", pinned: true },
    { name: "b-long", description: "long", pinned: true },
  ];
  const readFull = (name) => (name === "a-short" ? "X".repeat(50) : "Y".repeat(9_000));
  const digest = composeMemoryRecallDigest(memories, readFull, 500);
  check("bounded (pinned): the small entry that fits is included", digest.includes("### a-short"));
  check("bounded (pinned): the entry that would overflow is NOT rendered in full", !digest.includes("### b-long"));
  check("bounded (pinned): the whole digest respects the byte budget", Buffer.byteLength(digest, "utf8") <= 500);
  // The bug this fix closes: pinning must never make an entry STRICTLY LESS discoverable than leaving it
  // unpinned — a size-dropped pinned entry falls back into the index as a name+description line.
  check("bounded (pinned): the size-dropped pinned entry still surfaces in the INDEX (name+description)", digest.includes("## Other memories") && digest.includes("- b-long: long"));

  // 2a2. Whole-pinned-section-empty: the OVERSIZED entry is the ONLY pinned one — no surviving pinned
  // sibling to keep the "## Pinned memories" header alive. It must still fall back into the index.
  const sole = [{ name: "only-pinned", description: "important but huge", pinned: true }];
  const soleReadFull = () => "Z".repeat(9_000);
  const soleDigest = composeMemoryRecallDigest(sole, soleReadFull, 500);
  check("bounded (pinned, sole+oversized): no '## Pinned memories' section (nothing survived in full)", !soleDigest.includes("## Pinned memories"));
  check("bounded (pinned, sole+oversized): falls back to the index with name+description", soleDigest.includes("## Other memories") && soleDigest.includes("- only-pinned: important but huge"));
  check("bounded (pinned, sole+oversized): the full oversized content never leaks in", !soleDigest.includes("Z".repeat(9_000)));
  check("bounded (pinned, sole+oversized): the whole digest respects the byte budget", Buffer.byteLength(soleDigest, "utf8") <= 500);

  // 2b. Index: a name-sorted PREFIX of lines is kept — dropped from the TAIL (alphabetically-later first).
  const names = Array.from({ length: 10 }, (_, i) => `mem${String(i).padStart(2, "0")}`);
  const idxMemories = names.map((n) => ({ name: n, description: "d", pinned: false }));
  const header = "## Other memories (name: description — memory_read the name for the full entry)";
  const line = (n) => `- ${n}: d`;

  // Budget = exactly header + the first ONE line → only mem00 should survive.
  const oneLineBudget = Buffer.byteLength([header, line(names[0])].join("\n"), "utf8");
  const oneLineDigest = composeMemoryRecallDigest(idxMemories, () => null, oneLineBudget);
  check("bounded (index): a budget for exactly 1 line keeps ONLY the first name-sorted entry", oneLineDigest.includes(line(names[0])) && !oneLineDigest.includes(line(names[1])));
  check("bounded (index): the kept line is byte-EXACT to the boundary construction", oneLineDigest === [header, line(names[0])].join("\n"));

  // Budget = ALL lines minus 1 byte → the alphabetically-LAST entry (mem09) is the one dropped, not mem00.
  const allLines = names.map(line);
  const fullBudget = Buffer.byteLength([header, ...allLines].join("\n"), "utf8");
  const almostFullDigest = composeMemoryRecallDigest(idxMemories, () => null, fullBudget - 1);
  check("bounded (index): one byte short of fitting ALL drops exactly the TAIL entry (mem09)", almostFullDigest.includes(line(names[0])) && !almostFullDigest.includes(line(names[9])));
  check("bounded (index): the 9-line prefix is byte-EXACT to the boundary construction", almostFullDigest === [header, ...allLines.slice(0, 9)].join("\n"));
  check("bounded (index): the full budget fits every line", composeMemoryRecallDigest(idxMemories, () => null, fullBudget) === [header, ...allLines].join("\n"));

  // 2c. MIXED pinned + index: the OVERALL bound is EXACT — it must count the section headers and the
  // "\n\n" join BETWEEN the two sections, not just the raw content bytes of each (the bug this fix closes).
  const pinnedHeader = "## Pinned memories (in full)";
  const pBlock = `### p\n${"P".repeat(20)}`;
  const pinnedSection = [pinnedHeader, pBlock].join("\n\n");
  const idxHeader = "## Other memories (name: description — memory_read the name for the full entry)";
  const idxLines = ["e1", "e2", "e3"].map((n) => `- ${n}: d`);
  const idxFull = [idxHeader, ...idxLines].join("\n");
  const fullMixedDigest = [pinnedSection, idxFull].join("\n\n");
  const fullMixedBytes = Buffer.byteLength(fullMixedDigest, "utf8");

  const mixedMemories = [
    { name: "p", description: "d-p", pinned: true },
    { name: "e1", description: "d", pinned: false },
    { name: "e2", description: "d", pinned: false },
    { name: "e3", description: "d", pinned: false },
  ];
  const mixedReadFull = (name) => (name === "p" ? "P".repeat(20) : null);

  const atBudget = composeMemoryRecallDigest(mixedMemories, mixedReadFull, fullMixedBytes);
  check("bounded (mixed): the exact-fit budget includes BOTH sections in full", atBudget === fullMixedDigest);
  check("bounded (mixed): the exact-fit digest's byte length matches the budget exactly", Buffer.byteLength(atBudget, "utf8") === fullMixedBytes);

  const oneLess = composeMemoryRecallDigest(mixedMemories, mixedReadFull, fullMixedBytes - 1);
  check("bounded (mixed): one byte under the exact fit NEVER exceeds the budget (the ~31B under-count this fix closes)", Buffer.byteLength(oneLess, "utf8") <= fullMixedBytes - 1);
  check("bounded (mixed): the pinned entry survives (pinned rides first, at full budget)", oneLess.includes("### p"));
  check("bounded (mixed): the index TAIL entry (e3) is the one dropped", oneLess.includes("- e1: d") && oneLess.includes("- e2: d") && !oneLess.includes("- e3: d"));
}

// =========================================================================================================
// Part 3 — framing: DATA/CONTEXT, never an instruction; empty ⇒ null
// =========================================================================================================
{
  const framed = framedMemoryRecall("MY DIGEST BODY");
  check("frame: starts with the [loom:memory] tag", framed.startsWith(MEMORY_RECALL_TAG));
  check("frame: explicitly frames as DATA, never a new instruction", /never/i.test(framed) && /instruction/i.test(framed));
  check("frame: explicitly says it never overrides the base brief / rules", /base brief/i.test(framed) && /never overrides/i.test(framed));
  check("frame: carries the digest body verbatim", framed.includes("MY DIGEST BODY"));
  // SILENT-context language (the blocking fix): recall must never read as a reason to chat_reply on its own.
  check("frame: explicitly says NOT to reply to it", /do not reply/i.test(framed) || /never reply/i.test(framed));
  check("frame: explicitly says not to chat_reply just because it arrived", /chat_reply/i.test(framed) && /just because/i.test(framed));
  check("frame: names itself SILENT background context", /silent/i.test(framed) && /context/i.test(framed));

  const memories = [{ name: "n1", description: "d1", pinned: false }];
  const combined = buildFramedMemoryRecall(memories, () => null);
  check("buildFramedMemoryRecall: composes + frames in one step", combined === framedMemoryRecall(composeMemoryRecallDigest(memories, () => null)));
  check("buildFramedMemoryRecall: empty memory ⇒ null (no block)", buildFramedMemoryRecall([], () => null) === null);
}

// =========================================================================================================
// Part 4 — appendMemoryRecallToStartupPrompt (assistant-prompt.ts): the FRESH-spawn half
// =========================================================================================================
{
  check("append: null recall ⇒ prompt returned BYTE-IDENTICAL", appendMemoryRecallToStartupPrompt("BASE PROMPT", null) === "BASE PROMPT");
  check("append: a framed recall is appended after a '---' separator", appendMemoryRecallToStartupPrompt("BASE PROMPT", "FRAMED RECALL") === "BASE PROMPT\n\n---\n\nFRAMED RECALL");
}

// =========================================================================================================
// Part 5 — end to end: a real SessionService + a fake pty (no real claude, no daemon)
// =========================================================================================================
{
  // A real temp git repo backs the project (cwd must exist for resume()'s cwd guard + a real dir for spawn).
  const repo = path.join(os.tmpdir(), `loom-mem-recall-repo-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# memory-recall test\n");
  execSync(`git init -q && git -c user.email=a@loom -c user.name=a add . && git -c user.email=a@loom -c user.name=a commit -q -m init`, { cwd: repo });

  const now = new Date().toISOString();
  const db = new Db();
  db.insertProject({ id: "pR", name: "Recall", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProfile({ id: "profAsst", name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profMgr", name: "Orchestrator", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentAsst", projectId: "pR", name: "Companion", startupPrompt: "AGENT_OWN_PROMPT", position: 0, profileId: "profAsst" });
  db.insertAgent({ id: "agentMgr", projectId: "pR", name: "Manager", startupPrompt: "MGR_PROMPT", position: 1, profileId: "profMgr" });

  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) {
      this.capture.push(opts);
      return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
    }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const optsFor = (h, sid) => h.capture.find((o) => o.sessionId === sid);

  // Restart-simulate a live session (mirrors assistant-role.mjs): a real transcript + engine id, then
  // exited, then resume() on a FRESH host/service (so the pty is not already-live).
  function simulateResume(sessionId) {
    const eng = `eng-${sessionId}-${Date.now()}`;
    db.setEngineSessionId(sessionId, eng);
    const tFile = engineTranscriptPath(repo, eng);
    fs.mkdirSync(path.dirname(tFile), { recursive: true });
    fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "seed" } }) + "\n");
    db.setProcessState(sessionId, "exited");
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    svc.resume(sessionId);
    return host;
  }

  const host0 = new SeamHost(events);
  const svc0 = new SessionService(db, host0, new OrchestrationControl());

  // ---- (a) FRESH assistant spawn, EMPTY memory ⇒ byte-identical to today's compose (no [loom:memory]) ----
  {
    const sFresh = svc0.startNew("agentAsst");
    const oFresh = optsFor(host0, sFresh.id);
    check("fresh+empty: startupPrompt is byte-identical to composeAssistantStartupPrompt alone", oFresh.startupPrompt === composeAssistantStartupPrompt("AGENT_OWN_PROMPT"));
    // NB: the base brief itself DOCUMENTS the [loom:memory] tag (so the model recognizes it when it does
    // show up) — that mention is expected. What must NOT leak in is an actual RECALL block (the digest
    // preamble), which only appears when composeAssistantStartupPrompt's byte-identical check above holds.
    check("fresh+empty: no actual recall digest block leaked in (only the brief's mention of the tag)", !oFresh.startupPrompt.includes("Recalled from your own durable memory"));
  }

  // ---- (b) RESUME with pre-existing memory ⇒ the digest is enqueued as the first pending turn ----
  {
    const sMem = svc0.startNew("agentAsst"); // fresh spawn first (its own memory dir starts empty)
    const pinnedContent = "---\nname: user-name\ndescription: what to call the user\npinned: true\n---\n\nThe user goes by Dee.";
    const plainContent = "---\nname: user-hobby\ndescription: a hobby the user mentioned\npinned: false\n---\n\nThe user enjoys chess.";
    check("resume+memory: seed memory 1 authored", authorCompanionMemory(sMem.id, "user-name", pinnedContent).ok === true);
    check("resume+memory: seed memory 2 authored", authorCompanionMemory(sMem.id, "user-hobby", plainContent).ok === true);

    const hostR = simulateResume(sMem.id);
    const pending = hostR.getPending(sMem.id);
    check("resume+memory: exactly ONE pending turn was enqueued (the recall)", pending.length === 1);
    check("resume+memory: it is framed [loom:memory]", pending[0]?.startsWith(MEMORY_RECALL_TAG));
    check("resume+memory: the PINNED entry rides in full", pending[0]?.includes("The user goes by Dee."));
    check("resume+memory: the non-pinned entry rides as a compact index line", pending[0]?.includes("user-hobby: a hobby the user mentioned") && !pending[0]?.includes("The user enjoys chess."));
    check("resume+memory: the enqueued turn carries the SILENT-context instruction (no unsolicited reply)", /do not reply/i.test(pending[0] ?? "") && /chat_reply/i.test(pending[0] ?? ""));
    const oR = optsFor(hostR, sMem.id);
    check("resume+memory: resume() STILL injects NO startup prompt (SpawnOpts unaffected — a separate mechanism)", oR?.startupPrompt === undefined);

    // ---- (b2) DEDUP (finding 0e08c0b7): companion memory-recall had NO dedupe of any kind before this fix
    // — every resume re-enqueued the identical digest (observed live as 25+ consecutive identical
    // injections into one companion). A second resume with an UNCHANGED memory set must enqueue NOTHING.
    // `simulateResume` already constructs a BRAND-NEW SessionService+PtyHost on every call (originally just
    // to dodge the isAlive short-circuit) — that incidentally makes this the exact right tool to also prove
    // the dedup survives a simulated daemon restart: the v1-style in-memory-Map approach used for project
    // memory would FAIL this (a fresh process has an empty Map), while the DB-column-backed digest
    // (db.getLastCompanionMemoryDigest/setLastCompanionMemoryDigest) PASSES it, since it's persisted on the
    // session row itself. ----
    const hostR2 = simulateResume(sMem.id);
    check("resume+memory dedup: a second resume with an UNCHANGED memory set enqueues NOTHING, even from a fresh SessionService/host (durable across a daemon-restart-equivalent)",
      hostR2.getPending(sMem.id).length === 0);

    const newContent = "---\nname: user-job\ndescription: what the user does for work\npinned: true\n---\n\nThe user works as a train conductor.";
    check("resume+memory dedup: seed a NEW memory after the dedup baseline", authorCompanionMemory(sMem.id, "user-job", newContent).ok === true);
    const hostR3 = simulateResume(sMem.id);
    const pending3 = hostR3.getPending(sMem.id);
    check("resume+memory dedup: a resume AFTER a genuinely new memory enqueues again (the digest changed)", pending3.length === 1);
    check("resume+memory dedup: the new memory's content is present in the re-injected block", pending3[0]?.includes("train conductor"));

    const hostR4 = simulateResume(sMem.id);
    check("resume+memory dedup: a resume right after the delta injection ALSO dedups (the newly-persisted digest is the new baseline)",
      hostR4.getPending(sMem.id).length === 0);
  }

  // ---- (c) RESUME with EMPTY memory ⇒ nothing enqueued (no block) ----
  {
    const sEmpty = svc0.startNew("agentAsst");
    const hostR = simulateResume(sEmpty.id);
    check("resume+empty: no pending turn enqueued", hostR.getPending(sEmpty.id).length === 0);
  }

  // ---- (d) non-assistant (manager) resume is UNTOUCHED, even if a companion-memory dir exists for its id ----
  {
    const sMgr = svc0.startManager("agentMgr");
    check("non-companion: memory authored under the manager's OWN session id (coincidence, not a companion)", authorCompanionMemory(sMgr.id, "not-for-a-manager", "---\nname: not-for-a-manager\ndescription: x\npinned: true\n---\n\nshould never surface").ok === true);
    const hostR = simulateResume(sMgr.id);
    check("non-companion: resume enqueues NOTHING (role-gated, not existence-gated)", hostR.getPending(sMgr.id).length === 0);
    const oR = optsFor(hostR, sMgr.id);
    check("non-companion: resume() carries role=manager, still no startup prompt", oR?.role === "manager" && oR?.startupPrompt === undefined);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the two-tier [loom:memory] recall digest is correct, byte-bounded EXACTLY (headers + section separators counted, mixed pinned+index boundary verified) with deterministic (pinned-prefix / index-tail) truncation, framed as DATA/CONTEXT never an instruction and explicitly SILENT (never a reason to chat_reply on its own), appended byte-identical-when-empty on a fresh spawn, injected exactly once per activation on resume (a documented exception to \"resume injects nothing\"), leaves every non-companion session and an empty-memory companion untouched, AND (finding 0e08c0b7) a resume with an UNCHANGED memory set does NOT re-inject — proven durable across a simulated daemon restart (a brand-new SessionService/host instance still dedups the persisted digest) — while a genuinely new memory still reaches the very next resume."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

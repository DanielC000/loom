import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion Phase 2 — SELF-AUTHORED SKILLS (isolation + curation, SECURITY-relevant on the write path).
// Fully hermetic: a temp LOOM_HOME + the parameterized companion skill store driven directly, plus the real
// OrchestrationMcpRouter buildServer to prove the tools are companion-session-gated. NO network, NO real
// claude, NO daemon. The isolation invariant is load-bearing: a companion's skills must NEVER touch the
// global SKILLS_DIR and must NEVER escape their per-session base dir. These assert both, plus the redundancy
// (curation) guard and the on-demand list/read/remove surface.
// Run: 1) build (turbo builds shared first), 2) node test/companion-skills.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-skills-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { SKILLS_DIR, COMPANION_SKILLS_DIR, companionSkillsDir } = await import("../dist/paths.js");
const { authorCompanionSkill, listCompanionSkills, readCompanionSkill, removeCompanionSkill, NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS } =
  await import("../dist/skills/companion-store.js");
const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const SESS = "companion-sess";
const skillMd = (sessionId, name) => path.join(companionSkillsDir(sessionId), name, "SKILL.md");

// A skill + a REWORDED near-duplicate under a NEW name (should be rejected) + a genuinely DISTINCT skill.
const SKILL_GIT = `---
name: git-flow
description: how to make a clean conventional git commit
---

# git-flow

When you finish a change, stage the files, run the build, then write a conventional commit message and commit it.
`;
const SKILL_GIT_DUP = `---
name: git-workflow
description: how to make a clean conventional git commit
---

# git-workflow

When you finish a change, stage the files, run the build, then write a conventional commit message and commit it now.
`;
const SKILL_WEATHER = `---
name: weather-report
description: summarize the local forecast for the user
---

# weather-report

Fetch today's temperature, humidity, and precipitation outlook, then reply with a short friendly summary.
`;
// Two SHORT, semantically-distinct skills that SHARE instructional boilerplate ("how to note a … order").
// Their Jaccard would be ~0.8 (≥ NEAR_DUP_THRESHOLD) purely on that boilerplate — a false positive — but the
// token UNION is ~10 (< MIN_DEDUP_UNION_TOKENS), so the min-material gate must accept BOTH.
const SKILL_COFFEE = `---
name: coffee-order
description: how to note a coffee order
---
note the coffee order
`;
const SKILL_TEA = `---
name: tea-order
description: how to note a tea order
---
note the tea order
`;

try {
  // ============ Part 1 — author persists under the companion dir; global SKILLS_DIR is UNTOUCHED ============
  {
    const r = authorCompanionSkill(SESS, "git-flow", SKILL_GIT);
    check("author: returns ok + the updated compact list", r.ok === true && Array.isArray(r.skills) && r.skills.length === 1);
    check("author: SKILL.md persisted under the per-session companion dir", fs.readFileSync(skillMd(SESS, "git-flow"), "utf8") === SKILL_GIT);
    // ISOLATION: nothing landed in the global store (no dir, and — belt — SKILLS_DIR holds no such entry).
    check("isolation: global SKILLS_DIR has NO git-flow entry", !fs.existsSync(path.join(SKILLS_DIR, "git-flow")));
    const globalEntries = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : [];
    check("isolation: global SKILLS_DIR gained NO new entry at all", globalEntries.length === 0);
    check("isolation: the write landed strictly under COMPANION_SKILLS_DIR", skillMd(SESS, "git-flow").startsWith(COMPANION_SKILLS_DIR + path.sep));
  }

  // ============ Part 2 — skill_list compact + skill_read full ============
  {
    const list = listCompanionSkills(SESS);
    check("list: one compact { name, description } entry", list.length === 1 && list[0].name === "git-flow" && list[0].description === "how to make a clean conventional git commit");
    const full = readCompanionSkill(SESS, "git-flow");
    check("read: returns the FULL SKILL.md text", full === SKILL_GIT);
    check("read: a missing name returns null", readCompanionSkill(SESS, "nope") === null);
  }

  // ============ Part 3 — refine-in-place: same name rewrites, no dup dir/file ============
  {
    const refined = SKILL_GIT.replace("commit it.", "commit it, then push.");
    const r = authorCompanionSkill(SESS, "git-flow", refined);
    check("refine: returns ok", r.ok === true);
    check("refine: content updated in place", readCompanionSkill(SESS, "git-flow") === refined);
    check("refine: still exactly ONE skill (no duplicate dir)", listCompanionSkills(SESS).length === 1);
    check("refine: still exactly ONE dir on disk", fs.readdirSync(companionSkillsDir(SESS)).length === 1);
    // restore the original so later similarity math is against the known baseline
    authorCompanionSkill(SESS, "git-flow", SKILL_GIT);
  }

  // ============ Part 4 — redundancy guard: near-dup under a NEW name rejected; distinct accepted ============
  {
    const dup = authorCompanionSkill(SESS, "git-workflow", SKILL_GIT_DUP);
    check("redundancy: a near-duplicate under a NEW name is REJECTED", dup.ok === false && /refine/i.test(dup.error) && /git-flow/.test(dup.error));
    check("redundancy: the rejected near-dup wrote NOTHING", !fs.existsSync(path.join(companionSkillsDir(SESS), "git-workflow")));
    check("redundancy: the existing skill is untouched", readCompanionSkill(SESS, "git-flow") === SKILL_GIT && listCompanionSkills(SESS).length === 1);
    // A genuinely DISTINCT skill under a new name is ACCEPTED (the guard doesn't false-positive).
    const distinct = authorCompanionSkill(SESS, "weather-report", SKILL_WEATHER);
    check("redundancy: a DISTINCT new skill is accepted", distinct.ok === true && distinct.skills.length === 2);
    check("redundancy: threshold is a documented deterministic constant in (0,1)", NEAR_DUP_THRESHOLD > 0 && NEAR_DUP_THRESHOLD < 1);
    // Refining the EXISTING near-dup target under its OWN name is allowed (same-name path bypasses the guard).
    const rerefine = authorCompanionSkill(SESS, "git-flow", SKILL_GIT_DUP.replace("git-workflow", "git-flow"));
    check("redundancy: same-name refine is never blocked by the guard", rerefine.ok === true);
    authorCompanionSkill(SESS, "git-flow", SKILL_GIT); // restore
    // clear the distinct skill so the min-material case below starts from a clean, small store
    removeCompanionSkill(SESS, "weather-report");
    removeCompanionSkill(SESS, "git-flow");

    // MIN-MATERIAL GATE (false-positive fix): two SHORT distinct skills sharing boilerplate → BOTH accepted.
    check("min-material: threshold constant is a documented positive integer", Number.isInteger(MIN_DEDUP_UNION_TOKENS) && MIN_DEDUP_UNION_TOKENS > 0);
    const coffee = authorCompanionSkill(SESS, "coffee-order", SKILL_COFFEE);
    const tea = authorCompanionSkill(SESS, "tea-order", SKILL_TEA);
    check("min-material: first short skill accepted", coffee.ok === true);
    check("min-material: second short distinct-but-boilerplate-sharing skill ALSO accepted (no false reject)", tea.ok === true && listCompanionSkills(SESS).length === 2);
    // ...but a SUBSTANTIAL reworded near-duplicate (union ≥ the gate) is STILL rejected (no regression).
    authorCompanionSkill(SESS, "git-flow", SKILL_GIT);
    const stillRejects = authorCompanionSkill(SESS, "git-workflow", SKILL_GIT_DUP);
    check("min-material: a substantial reworded near-dup is STILL rejected (guard not disabled)", stillRejects.ok === false && /refine/i.test(stillRejects.error));
    // Restore the store to exactly {git-flow, weather-report} so Parts 5 & 6 see the same state as before.
    removeCompanionSkill(SESS, "coffee-order");
    removeCompanionSkill(SESS, "tea-order");
    authorCompanionSkill(SESS, "weather-report", SKILL_WEATHER);
    check("min-material: store restored to {git-flow, weather-report} for later parts", JSON.stringify(listCompanionSkills(SESS).map((s) => s.name)) === JSON.stringify(["git-flow", "weather-report"]));
  }

  // ============ Part 5 — path-escape: traversal/invalid names rejected, NOTHING written outside base ============
  {
    const base = companionSkillsDir(SESS);
    const before = fs.readdirSync(base).sort();
    // NB: a TRAILING hyphen (e.g. "trailing-") is a VALID slug per NAME_RE — only a LEADING one is invalid.
    const bad = ["../evil", "..", "a/b", "/etc/passwd", "C:\\x", "UPPER", "", "with space", ".hidden", "-lead", "a/../b"];
    let allRejected = true;
    for (const name of bad) {
      const r = authorCompanionSkill(SESS, name, "x");
      if (r.ok) { allRejected = false; console.log(`   (unexpectedly accepted bad name: ${JSON.stringify(name)})`); }
      if (readCompanionSkill(SESS, name) !== null) allRejected = false;
      if (removeCompanionSkill(SESS, name).ok) allRejected = false;
    }
    check("path-escape: every traversal/invalid name is rejected by author/read/remove", allRejected);
    // The `../evil` attempt would resolve to <COMPANION_SKILLS_DIR>/evil (one level up from the session base).
    check("path-escape: nothing written one level up (the ../evil target)", !fs.existsSync(path.join(COMPANION_SKILLS_DIR, "evil")));
    const after = fs.readdirSync(base).sort();
    check("path-escape: the session base dir is byte-identical (no stray dirs created)", JSON.stringify(before) === JSON.stringify(after));
    // A leading-hyphen `-lead` is invalid, so no such dir exists either.
    check("path-escape: an invalid-slug name created no dir", !fs.existsSync(path.join(base, "-lead")));
  }

  // ============ Part 6 — remove (curation) ============
  {
    check("remove: removing a distinct skill returns the shrunken list", (() => { const r = removeCompanionSkill(SESS, "weather-report"); return r.ok === true && r.skills.length === 1; })());
    check("remove: the removed dir is gone", !fs.existsSync(path.join(companionSkillsDir(SESS), "weather-report")));
    check("remove: removing a non-existent skill errors", removeCompanionSkill(SESS, "ghost").ok === false);
  }

  // ============ Part 7 — the tools are COMPANION-SESSION-GATED on the MCP surface ============
  {
    const db = new Db(path.join(tmpHome, "p7.db"));
    class SeamHost extends PtyHost {
      createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, svc, { companionSessionIds: new Set([SESS]), deliverReply: async () => ({ delivered: true }) });

    const connect = async (server) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "companion-skills-test", version: "0" });
      await client.connect(clientT);
      return client;
    };
    const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };

    const SKILL_TOOLS = ["skill_author", "skill_list", "skill_read", "skill_remove"];
    const companionTools = await listOf(orch.buildServer(SESS, "assistant"));
    check("gate: the BOUND companion assistant HAS all four skill tools", SKILL_TOOLS.every((t) => companionTools.includes(t)));

    const otherAssistant = await listOf(orch.buildServer("other-sess", "assistant"));
    check("gate: a DIFFERENT assistant session has NONE of the skill tools", SKILL_TOOLS.every((t) => !otherAssistant.includes(t)));
    check("gate: a different assistant also lacks chat_reply (single-session companion gate)", !otherAssistant.includes("chat_reply"));

    const manager = await listOf(orch.buildServer("mgr-sess", "manager"));
    check("gate: a non-companion manager has NONE of the skill tools", SKILL_TOOLS.every((t) => !manager.includes(t)));

    // End-to-end through the MCP tool wiring: author via the tool, then list via the tool.
    const c = await connect(orch.buildServer(SESS, "assistant"));
    const authored = await c.callTool({ name: "skill_author", arguments: { name: "chat-etiquette", content: "---\nname: chat-etiquette\ndescription: keep replies short and warm\n---\n\n# chat-etiquette\n\nBe concise and friendly." } });
    const authoredJson = JSON.parse(authored.content[0].text);
    check("wiring: skill_author over MCP authored the skill", authoredJson.authored === "chat-etiquette" && authoredJson.skills.some((s) => s.name === "chat-etiquette"));
    const listed = JSON.parse((await c.callTool({ name: "skill_list", arguments: {} })).content[0].text);
    check("wiring: skill_list over MCP returns the compact entry", listed.skills.some((s) => s.name === "chat-etiquette" && s.description === "keep replies short and warm"));
    const readBack = JSON.parse((await c.callTool({ name: "skill_read", arguments: { name: "chat-etiquette" } })).content[0].text);
    check("wiring: skill_read over MCP returns the full content", readBack.name === "chat-etiquette" && readBack.content.includes("Be concise and friendly."));
    await c.close();
    // And that end-to-end author STILL touched only the companion store, not the global one.
    check("wiring: the MCP-authored skill also stayed out of the global SKILLS_DIR", !fs.existsSync(path.join(SKILLS_DIR, "chat-etiquette")));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion self-authored skills are ISOLATED (persist under <LOOM_HOME>/companion-skills/<sessionId>/, never the global SKILLS_DIR), loaded on-demand (compact list + full read), refined in place, curated (remove), guarded against near-duplicate NEW names, confined against path traversal, and gated to the single bound companion session on the MCP surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

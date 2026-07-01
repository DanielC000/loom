import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion memory store — the STORAGE LAYER ONLY (no MCP, no recall, no REST — those are later
// sub-cards). Fully hermetic: a temp LOOM_HOME + the parameterized per-companion store driven directly.
// The isolation invariant is load-bearing: a companion's memory entries must NEVER touch the global
// SKILLS_DIR and must NEVER escape their per-session base dir. These assert CRUD, the redundancy (curation)
// guard, and confinement against path traversal / absolute / percent-encoded names.
// Run: 1) build (turbo builds shared first), 2) node test/companion-memory-store.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-memory-store-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { SKILLS_DIR, COMPANION_MEMORY_DIR, companionMemoryDir } = await import("../dist/paths.js");
const {
  authorCompanionMemory, listCompanionMemories, readCompanionMemory, removeCompanionMemory,
  NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS,
} = await import("../dist/skills/companion-memory-store.js");

const SESS = "companion-sess";
const memoryMd = (sessionId, name) => path.join(companionMemoryDir(sessionId), name, "MEMORY.md");

// A memory + a REWORDED near-duplicate under a NEW name (should be rejected) + a genuinely DISTINCT one.
const MEM_TIMEZONE = `---
name: user-timezone
description: the user's home timezone
pinned: true
---

# user-timezone

The user lives in the US Eastern timezone (America/New_York). Prefer that zone when discussing times.
`;
const MEM_TIMEZONE_DUP = `---
name: owner-timezone
description: the owner's home timezone
pinned: false
---

# owner-timezone

The owner lives in the US Eastern timezone (America/New_York). Prefer that zone when discussing times.
`;
const MEM_PET = `---
name: user-pet
description: the user's pet
pinned: false
---

# user-pet

The user has a dog named Biscuit.
`;
// Two SHORT, semantically-distinct entries that SHARE instructional boilerplate ("likes their coffee/tea").
// Their Jaccard would be high purely on that boilerplate — a false positive — but the token UNION is small
// (< MIN_DEDUP_UNION_TOKENS), so the min-material gate must accept BOTH.
const MEM_COFFEE = `---
name: coffee-pref
description: how to note a coffee preference
---
note the coffee preference
`;
const MEM_TEA = `---
name: tea-pref
description: how to note a tea preference
---
note the tea preference
`;

try {
  // ============ Part 1 — author persists under the companion dir; global SKILLS_DIR is UNTOUCHED ============
  {
    const r = authorCompanionMemory(SESS, "user-timezone", MEM_TIMEZONE);
    check("author: returns ok + the updated compact list", r.ok === true && Array.isArray(r.memories) && r.memories.length === 1);
    check("author: MEMORY.md persisted under the per-session companion dir", fs.readFileSync(memoryMd(SESS, "user-timezone"), "utf8") === MEM_TIMEZONE);
    // ISOLATION: nothing landed in the global skill store.
    check("isolation: global SKILLS_DIR has NO user-timezone entry", !fs.existsSync(path.join(SKILLS_DIR, "user-timezone")));
    const globalEntries = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : [];
    check("isolation: global SKILLS_DIR gained NO new entry at all", globalEntries.length === 0);
    check("isolation: the write landed strictly under COMPANION_MEMORY_DIR", memoryMd(SESS, "user-timezone").startsWith(COMPANION_MEMORY_DIR + path.sep));
  }

  // ============ Part 2 — compact list carries name+description+pinned; read returns full text ============
  {
    const list = listCompanionMemories(SESS);
    check("list: one compact { name, description, pinned } entry", list.length === 1 && list[0].name === "user-timezone" && list[0].description === "the user's home timezone" && list[0].pinned === true);
    const full = readCompanionMemory(SESS, "user-timezone");
    check("read: returns the FULL MEMORY.md text", full === MEM_TIMEZONE);
    check("read: a missing name returns null", readCompanionMemory(SESS, "nope") === null);
  }

  // ============ Part 3 — refine-in-place: same name rewrites, no dup dir/file ============
  {
    const refined = MEM_TIMEZONE.replace("pinned: true", "pinned: false");
    const r = authorCompanionMemory(SESS, "user-timezone", refined);
    check("refine: returns ok", r.ok === true);
    check("refine: content updated in place", readCompanionMemory(SESS, "user-timezone") === refined);
    check("refine: pinned flag reflects the refined content", listCompanionMemories(SESS)[0].pinned === false);
    check("refine: still exactly ONE entry (no duplicate dir)", listCompanionMemories(SESS).length === 1);
    check("refine: still exactly ONE dir on disk", fs.readdirSync(companionMemoryDir(SESS)).length === 1);
    // restore the original so later similarity math is against the known baseline
    authorCompanionMemory(SESS, "user-timezone", MEM_TIMEZONE);
  }

  // ============ Part 4 — redundancy guard: near-dup under a NEW name rejected; distinct accepted ============
  {
    const dup = authorCompanionMemory(SESS, "owner-timezone", MEM_TIMEZONE_DUP);
    check("redundancy: a near-duplicate under a NEW name is REJECTED", dup.ok === false && /refine/i.test(dup.error) && /user-timezone/.test(dup.error));
    check("redundancy: the rejected near-dup wrote NOTHING", !fs.existsSync(path.join(companionMemoryDir(SESS), "owner-timezone")));
    check("redundancy: the existing entry is untouched", readCompanionMemory(SESS, "user-timezone") === MEM_TIMEZONE && listCompanionMemories(SESS).length === 1);
    // A genuinely DISTINCT entry under a new name is ACCEPTED (the guard doesn't false-positive).
    const distinct = authorCompanionMemory(SESS, "user-pet", MEM_PET);
    check("redundancy: a DISTINCT new entry is accepted", distinct.ok === true && distinct.memories.length === 2);
    check("redundancy: threshold is a documented deterministic constant in (0,1)", NEAR_DUP_THRESHOLD > 0 && NEAR_DUP_THRESHOLD < 1);
    // Refining the EXISTING near-dup target under its OWN name is allowed (same-name path bypasses the guard).
    const rerefine = authorCompanionMemory(SESS, "user-timezone", MEM_TIMEZONE_DUP.replace("owner-timezone", "user-timezone"));
    check("redundancy: same-name refine is never blocked by the guard", rerefine.ok === true);
    authorCompanionMemory(SESS, "user-timezone", MEM_TIMEZONE); // restore
    // clear the distinct entry so the min-material case below starts from a clean, small store
    removeCompanionMemory(SESS, "user-pet");
    removeCompanionMemory(SESS, "user-timezone");

    // MIN-MATERIAL GATE (false-positive fix): two SHORT distinct entries sharing boilerplate → BOTH accepted.
    check("min-material: threshold constant is a documented positive integer", Number.isInteger(MIN_DEDUP_UNION_TOKENS) && MIN_DEDUP_UNION_TOKENS > 0);
    const coffee = authorCompanionMemory(SESS, "coffee-pref", MEM_COFFEE);
    const tea = authorCompanionMemory(SESS, "tea-pref", MEM_TEA);
    check("min-material: first short entry accepted", coffee.ok === true);
    check("min-material: second short distinct-but-boilerplate-sharing entry ALSO accepted (no false reject)", tea.ok === true && listCompanionMemories(SESS).length === 2);
    // ...but a SUBSTANTIAL reworded near-duplicate (union ≥ the gate) is STILL rejected (no regression).
    authorCompanionMemory(SESS, "user-timezone", MEM_TIMEZONE);
    const stillRejects = authorCompanionMemory(SESS, "owner-timezone", MEM_TIMEZONE_DUP);
    check("min-material: a substantial reworded near-dup is STILL rejected (guard not disabled)", stillRejects.ok === false && /refine/i.test(stillRejects.error));
    // Restore the store to exactly {user-timezone, user-pet} so Parts 5 & 6 see the same state as before.
    removeCompanionMemory(SESS, "coffee-pref");
    removeCompanionMemory(SESS, "tea-pref");
    authorCompanionMemory(SESS, "user-pet", MEM_PET);
    check("min-material: store restored to {user-timezone, user-pet} for later parts", JSON.stringify(listCompanionMemories(SESS).map((s) => s.name)) === JSON.stringify(["user-pet", "user-timezone"]));
  }

  // ============ Part 5 — path-escape: traversal/absolute/encoded/invalid names rejected ============
  {
    const base = companionMemoryDir(SESS);
    const before = fs.readdirSync(base).sort();
    // NB: a TRAILING hyphen (e.g. "trailing-") is a VALID slug per NAME_RE — only a LEADING one is invalid.
    const bad = [
      "../evil", "..", "a/b", "/etc/passwd", "C:\\x", "UPPER", "", "with space", ".hidden", "-lead", "a/../b",
      "%2e%2e", "..%2fevil", "%2e%2e%2f", "%2e%2e%2fevil",
    ];
    let allRejected = true;
    for (const name of bad) {
      const r = authorCompanionMemory(SESS, name, "x");
      if (r.ok) { allRejected = false; console.log(`   (unexpectedly accepted bad name: ${JSON.stringify(name)})`); }
      if (readCompanionMemory(SESS, name) !== null) allRejected = false;
      if (removeCompanionMemory(SESS, name).ok) allRejected = false;
    }
    check("path-escape: every traversal/absolute/encoded/invalid name is rejected by author/read/remove", allRejected);
    // The `../evil` attempt would resolve to <COMPANION_MEMORY_DIR>/evil (one level up from the session base).
    check("path-escape: nothing written one level up (the ../evil target)", !fs.existsSync(path.join(COMPANION_MEMORY_DIR, "evil")));
    const after = fs.readdirSync(base).sort();
    check("path-escape: the session base dir is byte-identical (no stray dirs created)", JSON.stringify(before) === JSON.stringify(after));
    // A leading-hyphen `-lead` is invalid, so no such dir exists either.
    check("path-escape: an invalid-slug name created no dir", !fs.existsSync(path.join(base, "-lead")));
  }

  // ============ Part 6 — remove (curation) ============
  {
    check("remove: removing a distinct entry returns the shrunken list", (() => { const r = removeCompanionMemory(SESS, "user-pet"); return r.ok === true && r.memories.length === 1; })());
    check("remove: the removed dir is gone", !fs.existsSync(path.join(companionMemoryDir(SESS), "user-pet")));
    check("remove: removing a non-existent entry errors", removeCompanionMemory(SESS, "ghost").ok === false);
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion self-authored memory entries are ISOLATED (persist under <LOOM_HOME>/companion-memory/<sessionId>/, never the global SKILLS_DIR), CRUD'd (author/list/read/remove) with name+description+pinned frontmatter, refined in place, curated (remove), guarded against near-duplicate NEW names, and confined against path traversal / absolute / percent-encoded names."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

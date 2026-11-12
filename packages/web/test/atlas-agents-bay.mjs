// Hermetic unit test for the Atlas Agents tab's Launch Bay derivations — src/lib/atlasAgents.ts,
// card 699fe92a (the owner's Atlas feedback: `Remove "What a spawn does" card.` / `Update all UI
// elements. I dont like it currently.`, owner pick direction B via request 891ed41f).
//
// No daemon, no browser: it imports the real functions and asserts on plain objects. These are the
// facts the redesigned card states — the ones the old card had nowhere to put — so each assertion is
// about a field the page already fetched and used to throw away.
//
// Record: docs/decisions/699fe92a-atlas-agents-launch-bay.md
//
// Run it with: node --experimental-strip-types packages/web/test/atlas-agents-bay.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// Same reason as test/atlas-quick-start.mjs: atlasAgents.ts has REAL runtime imports written
// extensionless in the bundler style the app uses, which Node's own resolver cannot follow. The
// import below must therefore be DYNAMIC — a static one would hoist above `register()`.
register("./_tsxLoaderHook.mjs", import.meta.url);

const { engineLine, grantChips, missionLine, rosterAgent, rosterTally, splitRoster } =
  await import("../src/lib/atlasAgents.ts");

/** An agent row as GET /api/projects/:id/agents returns it — only the fields these derivations read. */
const agent = (id, name, profileId = null, startupPrompt = "") =>
  ({ id, name, profileId, startupPrompt, projectId: "p1" });

/** A profile summary — the rig. `skills: null` is "deliver every skill", NOT "no skills". */
const profile = (id, name, role, over = {}) => ({ id, name, role, skills: null, ...over });

const LEAD_RIG = profile("rig-lead", "Orchestrator rig", "manager",
  { model: "claude-opus-4-8", skills: ["a", "b", "c"], browserTesting: true });
const DEV_RIG = profile("rig-dev", "Dev rig", "worker", { harness: "codex", skills: ["a"] });
const PROFILES = [LEAD_RIG, DEV_RIG];

// ── rosterTally: the ONE sentence that reconciles the tab badge with the roster head ─────────────
// Built through the REAL `splitRoster` rather than hand-written `{spawnable, workers}` literals, so
// these numbers fail if the spawnable/worker partition itself changes under them — the defect the
// tally exists to make visible is precisely a count derived one way and displayed as another.
{
  const both = splitRoster(
    [agent("a-lead", "Lead", LEAD_RIG.id), agent("a-plain", "Sketchpad"), agent("a-dev", "Dev", DEV_RIG.id)],
    PROFILES, [],
  );
  assert.equal(both.spawnable.length, 2, "fixture guard: two spawnable");
  assert.equal(both.workers.length, 1, "fixture guard: one worker rig");
  assert.equal(
    rosterTally(both, "loom"),
    "3 agents in loom — 2 you spawn, 1 your manager dispatches",
    "the tally must name the TOTAL and both halves — the tab badge counts all three",
  );
  // No project name resolved yet: the sentence still stands, it just has nowhere to say "in X".
  assert.equal(rosterTally(both), "3 agents — 2 you spawn, 1 your manager dispatches");

  // One-sided: say so in WORDS. A literal "0 your manager dispatches" would name a group the page
  // does not even draw (the dispatched group is omitted outright when the project has no rigs).
  const spawnOnly = splitRoster([agent("a-plain", "Sketchpad")], PROFILES, []);
  assert.equal(rosterTally(spawnOnly, "loom"), "1 agent in loom — all spawned by you");
  const rigsOnly = splitRoster([agent("a-dev", "Dev", DEV_RIG.id)], PROFILES, []);
  assert.equal(rigsOnly.spawnable.length, 0, "fixture guard: nothing spawnable");
  assert.equal(rigsOnly.workers.length, 1);
  assert.equal(rigsOnly.spawnable.length + rigsOnly.workers.length, 1,
    "fixture guard: the one-sided cases must still be a non-empty roster, or they'd hit the empty branch");
  assert.equal(rosterTally(rigsOnly, "loom"), "1 agent in loom — all dispatched by your manager");

  assert.equal(rosterTally(splitRoster([], PROFILES, []), "loom"), "No agents in loom yet");
}

// ── missionLine: the agent's own first prompt line, which the tab has never shown ────────────────
{
  assert.equal(
    missionLine("Plans and merges the board.\n\nAlso files decisions.", "unused fallback"),
    "Plans and merges the board.",
    "the FIRST paragraph is the mission — the rest is the prompt, which the editor owns",
  );
  // A prompt that opens with a markdown heading is NAMING the agent, which the card's own name line
  // says one row above. The first non-heading paragraph is the one that states what it is FOR.
  assert.equal(
    missionLine("# Web Designer — Loom\n\nDesigns and builds the web UI.", "unused fallback"),
    "Designs and builds the web UI.",
  );
  // …unless a heading is ALL there is: something beats nothing.
  assert.equal(missionLine("## Dev", "unused fallback"), "## Dev");
  // Newlines inside one paragraph collapse — the card clamps to two lines and a hard-wrapped prompt
  // would otherwise spend both of them on three words.
  assert.equal(missionLine("Verifies a built\nchange in a   real browser.", "x"),
    "Verifies a built change in a real browser.");
  // No prompt at all: say so, and fall back to the role's own shipped description.
  assert.equal(
    missionLine("", "Just Claude Code in this project — no orchestration."),
    "No startup prompt — Just Claude Code in this project — no orchestration.",
  );
  assert.equal(missionLine("   \n\n  \n", "role copy"), "No startup prompt — role copy");
}

// ── engineLine / grantChips: the rig as labelled FACTS, not one run-together grey string ─────────
{
  const [lead, plain, dev] = splitRoster(
    [agent("a-lead", "Lead", LEAD_RIG.id), agent("a-plain", "Sketchpad"), agent("a-dev", "Dev", DEV_RIG.id)],
    PROFILES, [],
  ).spawnable.concat(splitRoster([agent("a-dev", "Dev", DEV_RIG.id)], PROFILES, []).workers);

  // The whole rig row is carried on the entry now, which is what lets the card state these at all.
  assert.equal(lead.profile, LEAD_RIG, "rosterAgent must carry the resolved profile, not just its name");
  assert.equal(plain.profile, null, "a plain agent has no rig to carry");

  assert.equal(engineLine(lead), "claude · opus-4-8", "the vendor prefix is dropped, the tail is the fact");
  assert.equal(engineLine(dev), "codex · default", "a rig that pins no model still names its harness");
  // A plain agent has no rig, but it still spawns on SOMETHING — leaving this blank would leave the
  // question open rather than answered.
  assert.equal(engineLine(plain), "claude · default");

  assert.deepEqual(grantChips(lead), [
    { label: "browser", kind: "capability" },
    { label: "3 skills", kind: "skills" },
  ], "an opt-in host capability and the skill subset are different questions, so different chips");
  // `skills: null` is EVERY skill. Counting it would print "0 skills" — the opposite fact.
  assert.deepEqual(grantChips(rosterAgent(agent("a2", "N", "rig-all"),
    [profile("rig-all", "All rig", "manager")], [])), [{ label: "all skills", kind: "skills" }]);
  // No rig ⇒ no grants to state. An empty list is what lets the card omit the row entirely rather
  // than printing "none" on every plain agent.
  assert.deepEqual(grantChips(plain), []);
}

console.log("atlas-agents-bay: OK");

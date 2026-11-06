// Hermetic unit test for what opened each agent turn — src/lib/turnCause.ts, card 7627a850.
//
// The tagged fixtures are written in the daemon's own frame shapes: `[loom:worker-report] worker <id>
// (task <id>) — <status>: <summary>` (sessions/service.ts) and `[loom:from-manager]\n<text>`
// (frameFromManager). If those frames change in the daemon, this file and the classifier change too.
// Run it with: node --experimental-strip-types packages/web/test/turn-cause.mjs
import assert from "node:assert/strict";

const { classifyTurnOpener, turnCauses, unwrapTurnText, causeText, excerptOf, EXCERPT_MAX } =
  await import("../src/lib/turnCause.ts");

const later = (text) => classifyTurnOpener(text, false);
const wrap = (inner, id = "97cb") => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;

// Each class, with its label.
{
  const human = later("Owner: go ahead and merge it.");
  assert.equal(human.kind, "human");
  assert.equal(causeText(human), "after your message");
  assert.equal(human.excerpt, "Owner: go ahead and merge it.");

  const opening = classifyTurnOpener("## Worktree\n- Edit only here", true);
  assert.equal(opening.kind, "opening");
  assert.equal(causeText(opening), "after the opening prompt");

  const report = later("[loom:worker-report] worker 9e40d7a1-0000-4000-8000-000000000000 (task 7627a850) — progress: retained view wired, writing the e2e");
  assert.equal(report.kind, "worker-report");
  assert.equal(report.id, "9e40d7a1");
  assert.equal(report.detail, "progress");
  assert.equal(report.excerpt, "retained view wired, writing the e2e");
  assert.equal(causeText(report), "after worker report 9e40d7a1 (progress)");

  const direction = later("[loom:from-manager]\nRebase onto main, then re-run the e2e.");
  assert.equal(direction.kind, "direction");
  assert.equal(causeText(direction), "after manager direction");
  assert.equal(direction.excerpt, "Rebase onto main, then re-run the e2e.");
  assert.equal(causeText(later("[loom:from-manager:redirect]\nStop.")), "after a redirect");
  assert.equal(causeText(later("[loom:from-platform] Please check card x")), "after a Platform Lead message");
  assert.equal(later("[loom:from-owner-via-companion] ship it").kind, "human");

  for (const t of ["merge-done", "merge-rejected", "merge-failed", "merge-batch-done", "already-merged"]) {
    const c = later(`[loom:${t}] worker 1c07b3e5 landed`);
    assert.equal(c.kind, "merge", t);
    assert.equal(causeText(c), "after a merge result", t);
  }
  for (const t of ["gate-done", "gate-failed", "gate-cancelled", "dist-importer-check"]) {
    const c = later(`[loom:${t}] op 12ab34cd`);
    assert.equal(c.kind, "gate", t);
    assert.equal(causeText(c), "after a gate result", t);
  }
  assert.equal(causeText(later('[loom:wake] Your scheduled wake-up (set 2026-11-06) fired. Your note: "x".')), "after a scheduled wake");
  assert.equal(causeText(later("[loom:idle] You've been idle ~12 min.")), "after an idle nudge");
  assert.equal(causeText(later("[loom:worker-idle] worker 1c07b3e5 idle")), "after an idle nudge");
  assert.equal(causeText(later("[loom:reminder]:3 stand-up")), "after a reminder");
  for (const t of ["wake", "idle", "reminder", "heartbeat", "poll"]) assert.equal(later(`[loom:${t}] x`).kind, "wake", t);
  assert.equal(causeText(later("[loom:continuation] You are the successor")), "after a continuation note");
  assert.equal(causeText(later("[loom:daemon-restarted] origin=agent")), "after a restart notice");
  for (const t of ["continuation", "handoff", "daemon-restarted", "crash-recovered"]) {
    assert.equal(later(`[loom:${t}] x`).kind, "continuation", t);
  }
  assert.equal(causeText(later("Base directory for this skill: C:/x/.claude/skills/worker")), "after a skill load");
  assert.equal(later("<command-name>/clear</command-name>").kind, "engine");
}

// A pasted_content wrapper is seen through: the inner tag decides, not the wrapper.
{
  const inner = "[loom:worker-report] worker 2866e4cb-1111-4000-8000-000000000000 (task none) — done: shipped";
  const c = later(wrap(inner));
  assert.equal(c.kind, "worker-report");
  assert.equal(c.id, "2866e4cb");
  assert.equal(c.detail, "done");
  // Leading blank lines before the wrapper, and a possible-duplicate prefix inside it.
  const dup = later(`\n\n${wrap("[loom:possible-duplicate root:abcdef12] [loom:gate-done] op 1 passed")}\n`);
  assert.equal(dup.kind, "gate");
  // A wrapped untagged turn is still a person's message, with the wrapper gone from the excerpt.
  const wrappedHuman = later(wrap("please look at the strip"));
  assert.equal(wrappedHuman.kind, "human");
  assert.equal(wrappedHuman.excerpt, "please look at the strip");
  assert.equal(unwrapTurnText(wrap("[loom:wake] x")), "[loom:wake] x");
}

// An unknown tag falls back honestly, naming the tag; a malformed one falls back without a name.
{
  const c = later("[loom:mainline-moved] main moved outside Loom");
  assert.equal(c.kind, "other");
  assert.equal(c.id, "mainline-moved");
  assert.equal(causeText(c), "after another Loom notice mainline-moved");
  const bad = later("[loom:<script>] x");
  assert.equal(bad.kind, "other");
  assert.equal(bad.id, "");
}

// Coalesced frames: the first decides, the rest are counted.
{
  const c = later("[loom:worker-report] worker aaaaaaaa (task t) — done: a\n\n[loom:worker-report] worker bbbbbbbb (task t) — progress: b");
  assert.equal(c.id, "aaaaaaaa");
  assert.equal(c.more, 1);
  assert.equal(causeText(c), "after worker report aaaaaaaa (done) +1 more");
}

// Hostile text stays text: nothing is stripped or interpreted, only collapsed and cut.
{
  const hostile = `<img src=x onerror="alert(1)"><b>bold</b> ${"z".repeat(200)}`;
  const c = later(hostile);
  assert.equal(c.kind, "human");
  assert.ok(c.excerpt.startsWith(`<img src=x onerror="alert(1)"><b>bold</b> zzz`), c.excerpt);
  assert.equal(c.excerpt.length, EXCERPT_MAX);
  assert.ok(c.excerpt.endsWith("…"));
  const tagged = later(`[loom:from-manager]\n<script>alert(1)</script>`);
  assert.equal(tagged.excerpt, "<script>alert(1)</script>");
  assert.equal(excerptOf("a\n\n  b"), "a b");
}

// Turn numbering matches parseMcpCalls: the Nth user-role turn opens turn N; tool results don't count.
{
  const map = turnCauses([
    { role: "user", text: "Kick off: card a9a7140c." },
    { role: "assistant", text: "[tool] {t1} mcp__loom-tasks__tasks_list({})" },
    { role: "tool_result", text: "-> tool result {t1}: []" },
    { role: "user", text: "[loom:worker-report] worker 1c07b3e5 (task x) — blocked: needs a decision" },
    { role: "assistant", text: "ok" },
    { role: "user", text: "Owner: go ahead." },
  ]);
  assert.deepEqual([...map.keys()], [1, 2, 3]);
  assert.deepEqual([...map.values()].map((c) => c.kind), ["opening", "worker-report", "human"]);
  assert.equal(map.get(0), undefined);
}

console.log("turn-cause: ok");

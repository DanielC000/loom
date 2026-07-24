// Skills spec (card 47cad3f8) — proves the Skills page (/skills) both RENDERS Loom's bundled skill store
// and reflects the server-derived customization state through the real human/REST path. Coverage:
//   1. The list renders the seeded/bundled CORE skills — the daemon seeds ~/.loom/skills from the bundled
//      assets at boot (seedGlobalSkills), so an isolated daemon already has them; no extra seeding needed.
//   2. Opening a skill loads its SKILL.md body into the editor and shows the "bundled" state.
//   3. Customized-vs-pristine state is OBSERVABLE end to end: a freshly seeded bundled skill is pristine
//      (no "customized" badge); editing its body + Save (the customize control) flips it to "customized"
//      via the server-derived state (mine ≠ base), confirmed in the UI, over REST, and across a reload.
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template.
//
// Skills are a DAEMON-GLOBAL store (not project-scoped) — no active-project pin is needed, unlike
// settings.spec.ts. The `loomDaemon` fixture is worker-scoped (one daemon for the whole run), so the
// customize test RESETS the skill it mutated back to shipped at the end (POST /reset) to keep the store
// pristine for any other spec sharing this daemon.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/daemon";

// CORE bundled skills seeded on every boot (packages/daemon/assets/skills) regardless of LOOM_DEV — the
// platform-* skills are dev-gated in the npm build, so we assert only on the always-present CORE set.
const CORE_SKILLS = ["worker", "orchestrate", "web-design", "loom-task-start", "loom-session-end", "loom-pickup", "loom-doc-hygiene"];

// The sidebar skill entries are <button>s whose text is "<name>  ·  bundled". Each CORE name is a unique
// substring across the button set, so a hasText filter pins exactly one. (Nav items are <a> links, not
// buttons, so they never collide.)
function skillButton(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("button").filter({ hasText: name }).first();
}

// The one-time first-run "Welcome to Loom" modal (App.tsx › FirstRunWelcome, a full-viewport overlay that
// intercepts every click on a projectless daemon) is dismissed globally by the fixture (fixtures/daemon.ts),
// so no spec re-derives it.

test("the skills list renders the seeded bundled skills", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);

  // The panel header renders.
  await expect(page.getByText("Skills", { exact: true }).first()).toBeVisible();

  // Every CORE bundled skill shows up as a sidebar entry.
  for (const name of CORE_SKILLS) {
    await expect(skillButton(page, name)).toBeVisible();
  }

  // The entries are marked as bundled (Loom's shipped set, not user-local) — proves the list carries the
  // server-derived `bundled` flag, not just names.
  await expect(page.getByText("· bundled", { exact: false }).first()).toBeVisible();

  // Cross-check against the REST source the list is built from: the seeded store really holds these skills
  // and reports them bundled.
  const res = await fetch(`${loomDaemon.baseURL}/api/skills`);
  const skills = (await res.json()) as Array<{ name: string; bundled: boolean }>;
  for (const name of CORE_SKILLS) {
    expect(skills.find((s) => s.name === name)?.bundled).toBe(true);
  }
});

test("opening a skill loads its SKILL.md body", async ({ page, loomDaemon }) => {
  await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);

  // Before selecting anything, the editor pane shows its empty-state hint.
  await expect(page.getByText("Select a skill to edit its SKILL.md", { exact: false })).toBeVisible();

  await skillButton(page, "web-design").click();

  // The editor mounts with a "· SKILL.md" header and the "bundled" badge for a shipped skill.
  await expect(page.getByText("· SKILL.md", { exact: false })).toBeVisible();
  await expect(page.getByText("bundled", { exact: true })).toBeVisible();

  // The textarea holds the ACTUAL body — a substring distinctive to web-design's SKILL.md, so this proves
  // the right skill's content loaded, not just that a textarea rendered.
  const editor = page.locator("textarea");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/deliberately designed/);
});

test("editing a bundled skill flips it from pristine to customized (observable before/after)", async ({ page, loomDaemon }) => {
  // Use a CORE skill and restore it at the end so the shared worker-scoped daemon stays pristine.
  const target = "loom-pickup";
  await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);

  await skillButton(page, target).click();
  const editor = page.locator("textarea");
  await expect(editor).toBeVisible();

  // BEFORE: a freshly seeded bundled skill is pristine — no "customized" badge, no divergence banner.
  await expect(page.getByText("customized", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your saved copy differs from the current shipped version", { exact: false })).toHaveCount(0);
  // REST cross-check: the store agrees it is not customized.
  const before = await fetch(`${loomDaemon.baseURL}/api/skills`).then((r) => r.json()) as Array<{ name: string; customized?: boolean }>;
  expect(before.find((s) => s.name === target)?.customized ?? false).toBe(false);

  // ACT: exercise the customize control — append a marker line and Save (PUT /api/skills/:name → mine ≠ base).
  const marker = `\n<!-- e2e-customize-${Date.now()} -->\n`;
  const original = await editor.inputValue();
  await editor.fill(original + marker);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();

  // AFTER (observable #1 — UI): the server-derived state now reads "customized" in the header badge, and the
  // divergence banner appears (customized · no shipped update).
  await expect(page.getByText("customized", { exact: true })).toBeVisible();
  await expect(page.getByText("Your saved copy differs from the current shipped version", { exact: false })).toBeVisible();

  // AFTER (observable #2 — REST): the store the UI shares now flags the skill customized.
  await expect
    .poll(async () => {
      const skills = (await fetch(`${loomDaemon.baseURL}/api/skills`).then((r) => r.json())) as Array<{ name: string; customized?: boolean }>;
      return skills.find((s) => s.name === target)?.customized ?? false;
    })
    .toBe(true);

  // AFTER (observable #3 — persistence): a full reload re-derives the customized badge from the store, not
  // optimistic client state, and the saved body carries the marker.
  await page.reload();
  await skillButton(page, target).click();
  await expect(page.getByText("customized", { exact: true })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue(/e2e-customize-/);

  // CLEANUP: restore the skill to its shipped version so the shared daemon's store is pristine again.
  const reset = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/reset`, { method: "POST" });
  expect(reset.ok).toBe(true);
});

// --- Per-file compare / resolve (card c01fd791) ----------------------------------------------------
// The state under test is the one that had NO non-destructive exit: a skill's reference file that is BOTH
// customized AND has a shipped update. `advancePristineExtraFiles` rightly refuses to overwrite the edit,
// so Adopt returned 200 and advanced nothing and THE BADGE NEVER CLEARED — the only escape was Reset, a
// whole-directory discard, offered behind a SKILL.md diff that showed none of what it would take.
//
// Building this state requires writing the store file and its base snapshot directly: reference files
// have no REST/agent write surface BY DESIGN, which is exactly why the dead end existed. That is what
// `loomDaemon.loomHome` is for (see its doc on the fixture) — it models the out-of-band hand-edit the
// card names as the only way in, not a fiction the product could otherwise reach.
test("a customized reference file with a pending update resolves non-destructively (badge clears, edit survives)", async ({ page, loomDaemon }) => {
  // An EXISTING bundled reference file, so the `shipped` side is real. A file invented for the test would
  // have no asset counterpart, and the daemon deliberately leaves such a file untracked (the deletions
  // policy) — the test would then assert on a phantom state the product never produces.
  const target = "web-design";
  const relPath = "references/anti-patterns.md";
  const mine = "MY OUT-OF-BAND EDIT.\n";

  const storeFile = path.join(loomDaemon.loomHome, "skills", target, ...relPath.split("/"));
  const baseFile = path.join(loomDaemon.loomHome, "skill-base", target, ...relPath.split("/"));

  // ARRANGE state 3 entirely inside this daemon's scratch LOOM_HOME — the real repo asset is never
  // touched. mine != base makes it customized; base != shipped makes an update pending.
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.mkdirSync(path.dirname(baseFile), { recursive: true });
  fs.writeFileSync(storeFile, mine);
  fs.writeFileSync(baseFile, "A BASE THAT MATCHES NEITHER SIDE.\n");

  // Confirm the arranged state is REAL through the server's own read before asserting on any UI — if the
  // daemon doesn't see both flags, everything below would be testing a fiction.
  const summary = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/update-diff`).then((r) => r.json()) as
    { files: Array<{ path: string; customized: boolean; updateAvailable: boolean }> };
  const entry = summary.files.find((f) => f.path === relPath);
  expect(entry).toBeTruthy();
  expect(`${entry!.customized}/${entry!.updateAvailable}`).toBe("true/true");

  await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);
  await skillButton(page, target).click();

  // BEFORE (observable): the file's divergence is now NAMED and inspectable, which is the whole point —
  // previously it existed only as a sidebar dot with no diff behind it. Scoped to the file's own row
  // button (not a bare page-wide text search) — `relPath`'s text can otherwise resolve to more than one
  // element on the page (e.g. a title attribute plus the row's own label), tripping strict mode.
  await page.getByRole("button", { name: /Review files|What changed/ }).first().click();
  const fileRow = page.getByRole("button", { name: new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
  await expect(fileRow).toBeVisible();

  // Expanding the row shows a REAL diff of what the user's copy holds — the precondition the card makes
  // structural: no discard is offered until the diff that justifies it is on screen.
  await fileRow.click();
  await expect(page.getByText("MY OUT-OF-BAND EDIT.", { exact: false })).toBeVisible();

  // ACT: "Keep mine" — the non-destructive resolution. This is the escape that did not exist.
  const keepMine = page.getByRole("button", { name: "Keep mine", exact: true });
  await expect(keepMine).toBeVisible();
  await keepMine.click();

  // AFTER (observable #1 — REST round-trip): the file's own updateAvailable clears while `customized`
  // stays true. Both halves matter: the badge clearing is the fix, `customized` persisting is the honesty.
  await expect
    .poll(async () => {
      const s = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/update-diff`).then((r) => r.json()) as
        { files: Array<{ path: string; customized: boolean; updateAvailable: boolean }> };
      const f = s.files.find((x) => x.path === relPath);
      return `${f?.customized}/${f?.updateAvailable}`;
    })
    .toBe("true/false");

  // AFTER (observable #2 — nothing was discarded): the user's file is byte-identical on disk.
  expect(fs.readFileSync(storeFile, "utf8")).toBe(mine);

  // AFTER (observable #3 — no misleading backup): "Keep mine" overwrote nothing, so a .pre-ff-backups
  // entry would misrepresent itself as a copy of something that was replaced.
  expect(fs.existsSync(path.join(loomDaemon.loomHome, "skill-base", ".pre-ff-backups", target, ...relPath.split("/")))).toBe(false);

  // CLEANUP: restore the whole skill (store + every base) so the shared worker-scoped daemon is pristine.
  const reset = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/reset`, { method: "POST" });
  expect(reset.ok).toBe(true);
});

// REGRESSION PIN (code review, card c01fd791): the SKILL.md row must render its own REAL content.
//
// The bug this fails on: `FileDiffList` used to hand SKILL.md's row a shortcut built from the summary
// read, which carries `base`/`shipped` but NOT `mine` — so it substituted `base` for `mine`. In the
// common customized-AND-updateAvailable state that made the "Your edits (base → your copy)" block render
// LineDiff(base, base) = EMPTY, under a label explicitly promising the user's own edits, immediately
// beside a destructive control. Same class of lie as the empty-diff-behind-a-discard that created this
// card, just in a different pane — so it gets a pin, not a comment.
//
// This test FAILS on the pre-fix code (verified by reverting the fix and watching it go red) because the
// user's marker line never appears in the diff.
test("the SKILL.md row shows the user's ACTUAL edits, not an empty block under a 'Your edits' label", async ({ page, loomDaemon }) => {
  const target = "loom-session-end"; // a CORE skill no other spec in this file mutates
  const marker = `e2e-skillmd-edit-${Date.now()}`;
  const baseFile = path.join(loomDaemon.loomHome, "skill-base", `${target}.md`);

  await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);
  await skillButton(page, target).click();
  const editor = page.locator("textarea");
  await expect(editor).toBeVisible();

  // customized: edit + Save through the real REST path (mine != base).
  const original = await editor.inputValue();
  await editor.fill(`${original}\n<!-- ${marker} -->\n`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("customized", { exact: true })).toBeVisible();

  // updateAvailable: rewind the base snapshot so shipped reads as ahead of it (base != shipped). Base
  // snapshots have no REST surface, so this is a direct write — the same reason `loomHome` is exposed.
  fs.writeFileSync(baseFile, "# a base deliberately behind the shipped asset\n");

  await page.reload();
  await skillButton(page, target).click();
  // Precondition: BOTH flags on SKILL.md itself — the state that rendered the empty block.
  await expect(page.getByText("update available", { exact: true }).first()).toBeVisible();

  // Expand the update banner's file list, then the SKILL.md row within it.
  await page.getByRole("button", { name: "What changed", exact: true }).click();
  await page.getByRole("button", { name: /SKILL\.md/ }).first().click();

  // THE ASSERTION — scoped to the "your edits" pane SPECIFICALLY (data-diff-kind="mine"), not the page.
  // A page-wide text assertion does NOT falsify this bug: the marker also appears in the sibling
  // "what Loom shipped" diff and in the editor below, so a loose assertion passes against the very
  // defect it is meant to pin (confirmed — the first version of this test went green on buggy code).
  const yourEdits = page.locator('[data-diff-kind="mine"]');
  await expect(yourEdits).toBeVisible();
  // Lowercase in the DOM — the uppercase look is CSS text-transform, which toContainText doesn't see.
  await expect(yourEdits).toContainText("Your edits");
  // Pre-fix this pane rendered LineDiff(base, base) → the literal string "No textual change."
  await expect(yourEdits).not.toContainText("No textual change");
  await expect(yourEdits).toContainText(marker);

  // CLEANUP: restore the skill (store + every base) so the shared worker-scoped daemon stays pristine.
  const reset = await fetch(`${loomDaemon.baseURL}/api/skills/${target}/reset`, { method: "POST" });
  expect(reset.ok).toBe(true);
});

// A stale `shippedHash` must be REFUSED, not silently applied — assets/** is read live, so `shipped` can
// change between the diff being read and the button being clicked. Driven at the REST layer because the
// race is a server-side guard: the UI's job is only to carry the token it was handed.
test("resolving a file against a stale shippedHash is refused", async ({ loomDaemon }) => {
  const res = await fetch(`${loomDaemon.baseURL}/api/skills/web-design/file-resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "references/anti-patterns.md", take: "shipped", shippedHash: "deadbeefdeadbeef" }),
  });
  expect(res.status).toBe(409);

  // And the guard cannot be skipped by simply omitting the token.
  const noToken = await fetch(`${loomDaemon.baseURL}/api/skills/web-design/file-resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "references/anti-patterns.md", take: "shipped" }),
  });
  expect(noToken.status).toBe(400);
});

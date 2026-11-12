// Card 75ea3f73 — the per-project released-skill panel on Settings, over card 8b38b920's three
// human-only REST routes. Placement + the reviewed-fingerprint contract:
// docs/decisions/75ea3f73-released-skill-panel-placement-and-reviewed-fingerprint.md.
//
// WHY THIS SPEC WRITES TO DISK. A `__released` record has NO REST or agent write surface by design — it
// is written only by `injectSkills` while a real session spawns, which this suite cannot do (the
// no-spawn guard). So the frozen state is arranged exactly where the daemon itself keeps it: the
// `.loom-skills-fingerprints.json` sidecar in the project's own `.claude/skills`, plus the on-disk copy
// it describes. That is what `loomDaemon.loomHome`/the seeded repoPath are for (see the fixture's own
// doc) — it models the out-of-band state the product genuinely produces, not a fiction. Every arranged
// state is then CONFIRMED THROUGH THE SERVER'S OWN READ before any UI assertion, so a mis-seeded
// fixture fails as a seeding error rather than as a silent "the panel showed nothing" pass.
//
// The store side DOES go through REST (`POST /api/skills`) — a uniquely-named user skill per test, so no
// bundled skill is mutated on this worker-scoped daemon and no two tests can collide.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Locator } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";  // lib/activeProject.tsx owns the active-project one

const DAY = 24 * 60 * 60 * 1000;

/** `.loom-skills-fingerprints.json` — the name is `FINGERPRINTS_FILE` in daemon skills/inject.ts. */
const SIDECAR = ".loom-skills-fingerprints.json";

type Seeded = {
  name: string;
  /** `<repoPath>/.claude/skills` — the project's shared doctrine dir. */
  skillsDir: string;
  /** The released copy's own dir under it. */
  destDir: string;
  /** The released copy's SKILL.md. */
  destFile: string;
};

/**
 * Arrange ONE released skill at `repoPath`: a store copy (via REST), an on-disk copy that differs from
 * it, and the `__released` sidecar record naming it. Returns the paths so a test can mutate the on-disk
 * copy out-of-band (the concurrent-hand-edit case) or read it back as the real after-state.
 */
async function seedReleasedSkill(
  baseURL: string,
  repoPath: string,
  opts: { name: string; storeBody: string; onDiskBody: string; reason?: string; firstSeenAt?: number },
): Promise<Seeded> {
  const { name, storeBody, onDiskBody } = opts;
  const reason = opts.reason ?? "modified";
  const firstSeenAt = opts.firstSeenAt ?? Date.now();

  // The STORE copy, through the real write path — this is what a re-adopt will place.
  const created = await fetch(`${baseURL}/api/skills`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, content: storeBody }),
  });
  expect(created.status, `seeding the store copy of ${name} failed: ${await created.text()}`).toBe(201);

  const skillsDir = path.join(repoPath, ".claude", "skills");
  const destDir = path.join(skillsDir, name);
  const destFile = path.join(destDir, "SKILL.md");
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destFile, onDiskBody);
  // One project per test, so this file is written whole rather than merged — nothing else has put a
  // record in it. A test seeding two names into one project would have to merge instead.
  fs.writeFileSync(
    path.join(skillsDir, SIDECAR),
    JSON.stringify({ __released: { [name]: { reason, firstSeenAt } } }, null, 2),
  );
  return { name, skillsDir, destDir, destFile };
}

/**
 * The project's own bound repo directory, read back off the real project row. The fixture creates and
 * `git init`s this directory but does not expose its path on `SeededProject` — and WIDENING that type is
 * not free: `repoPath` is a required field there only if ~17 existing specs that hand-build a
 * `SeededProject` literal also grow it (measured — `tsc -p tsconfig.e2e.json` names every one). Reading
 * it from REST instead keeps this card's blast radius to this file, and exercises a real contract: the
 * list response genuinely carries `repoPath` (it is what the Settings repo editor binds to).
 *
 * Off the LIST, not a by-id GET: there is no `GET /api/projects/:id` route at all (measured — it 404s;
 * every by-id project read in this app is a sub-resource like `.../skills/released`), which is also what
 * `atlas-settings-scope.spec.ts` does when it needs one project's config.
 */
async function repoPathOf(baseURL: string, projectId: string): Promise<string> {
  const r = await fetch(`${baseURL}/api/projects`);
  expect(r.ok, `GET /api/projects -> ${r.status}`).toBe(true);
  const projects = (await r.json()) as Array<{ id: string; repoPath?: string }>;
  const repoPath = projects.find((p) => p.id === projectId)?.repoPath;
  expect(repoPath, "the seeded project has no repoPath, so there is no doctrine dir to seed into").toBeTruthy();
  return repoPath!;
}

type ReleasedRow = { name: string; reason: string; tracked: string; firstSeenAt: number };

/** `GET /api/projects/:id/skills/released` — the server's own view, the after-state DoD-2 asks for. */
async function readReleased(baseURL: string, projectId: string): Promise<ReleasedRow[]> {
  const r = await fetch(`${baseURL}/api/projects/${projectId}/skills/released`);
  expect(r.ok, `GET released -> ${r.status}`).toBe(true);
  return ((await r.json()) as { released: ReleasedRow[] }).released;
}

/** Pin the active project without RE-pinning on every reload (addInitScript re-runs per navigation). */
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** The section's own wrapper — every presence assertion is scoped INSIDE it, never page-wide: "Skills"
 *  is a nav label and "Settings" is two tree labels, so a bare exact-text locator reads the chrome. */
const section = (page: Page) => page.getByTestId("settings-section-released-skills");
const row = (page: Page, name: string) => page.getByTestId(`released-skill-${name}`);

/**
 * Open a frozen row's diff and wait for the reviewed snapshot to actually be on screen.
 *
 * By testid, not by accessible name: the toggle's accessible name is its own CONTENT (skill name, reason
 * badge, age) rather than its `title`, so a role locator would have to match that whole concatenation.
 * `aria-expanded` is asserted on both sides of the click, so this is still a real before/after on the
 * control a reader uses, not merely a programmatic open.
 */
async function openDiff(page: Page, name: string): Promise<Locator> {
  const r = row(page, name);
  const toggle = r.getByTestId(`released-skill-toggle-${name}`);
  await expect(toggle, "the row reads as already expanded before it was clicked").toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle, "clicking the row did not expand it").toHaveAttribute("aria-expanded", "true");
  await expect(r.getByTestId("released-skill-diff-summary")).toBeVisible();
  return r;
}

test.describe("released skill copies on project Settings (card 75ea3f73)", () => {
  test("a project Loom is still managing reports nothing frozen", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`released-empty-${Date.now()}`);
    // The control for the empty state: the SERVER agrees there is nothing, so the message below is the
    // real empty state and not a panel that failed to load.
    expect(await readReleased(loomDaemon.baseURL, project.id)).toEqual([]);

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/settings");

    const box = section(page);
    await expect(box, "the released-skills section is not on the project Settings page").toHaveCount(1);
    await expect(box.getByText("Released skills", { exact: true })).toBeVisible();
    await expect(box.getByTestId("released-skills-empty")).toBeVisible();
    await expect(box.getByText("Frozen copies (0)", { exact: true })).toBeVisible();
    // And no re-adopt affordance exists with nothing to re-adopt.
    await expect(box.getByTestId("readopt-start")).toHaveCount(0);
  });

  test("a frozen copy is listed with its reason and age, its diff opens, and re-adopting clears it", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`released-readopt-${Date.now()}`);
    const name = `loom-e2e-readopt-${Date.now()}`;
    // Distinct sentinels on each side, so every assertion below names WHICH copy it is looking at and a
    // silent fallback to other data (another project's dir, the store instead of the copy) fails loudly.
    const storeLine = `STORE-SIDE-${name}`;
    const diskLine = `HAND-EDITED-${name}`;
    const seeded = await seedReleasedSkill(loomDaemon.baseURL, await repoPathOf(loomDaemon.baseURL, project.id), {
      name,
      storeBody: `# ${name}\n\n${storeLine}\n`,
      onDiskBody: `# ${name}\n\n${diskLine}\n`,
      reason: "modified",
      firstSeenAt: Date.now() - (3 * DAY + 60 * 60 * 1000), // comfortably "3 days ago", not a rounding edge
    });

    // BEFORE — the server's own view, and the bytes on disk.
    const before = await readReleased(loomDaemon.baseURL, project.id);
    expect(before.map((r) => r.name), "the seeded release is not visible to the server").toContain(name);
    expect(before.find((r) => r.name === name)?.reason).toBe("modified");
    expect(before.find((r) => r.name === name)?.tracked,
      "a freshly `git init`ed fixture repo should report the copy as untracked").toBe("untracked");
    expect(fs.readFileSync(seeded.destFile, "utf8")).toContain(diskLine);

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/settings");

    const box = section(page);
    await expect(box.getByText("Frozen copies (1)", { exact: true })).toBeVisible();
    const r = row(page, name);
    await expect(r).toBeVisible();
    await expect(r.getByText("modified", { exact: true }), "the reason badge is missing").toBeVisible();
    await expect(r.getByText("frozen 3 days ago", { exact: true }), "the age is missing or wrong").toBeVisible();
    await expect(r, "the reason's gloss is not shown beside the badge").toContainText("Loom stopped overwriting it");
    // `modified` is not a refusal, so nothing should claim one.
    await expect(r.getByText(/Re-adopting is refused/)).toHaveCount(0);

    // The DIFF, and the fact it shows BOTH sides of the real content — a diff that renders an empty
    // block under a "what differs" label is the exact defect card c01fd791 fixed on the Skills page.
    await openDiff(page, name);
    await expect(r.getByTestId("released-skill-diff-summary")).toHaveText("1 of 1 file differs from the store");
    await r.getByTestId("released-file-toggle-SKILL.md").click();
    await expect(r.getByText(`- ${storeLine}`, { exact: true }), "the store side is missing from the diff").toBeVisible();
    await expect(r.getByText(`+ ${diskLine}`, { exact: true }), "the on-disk side is missing from the diff").toBeVisible();

    // The action is ONLY inside the expanded diff, and it confirms before it writes.
    const start = r.getByTestId("readopt-start");
    await expect(start).toBeVisible();
    await start.click();
    const confirm = r.getByTestId("readopt-confirm");
    await expect(confirm, "the re-adopt did not ask for a confirmation first").toBeVisible();
    // The confirm names what it will destroy and that it cannot be undone — not a bare "are you sure".
    await expect(r).toContainText("The file above is overwritten, and that cannot be undone from here.");
    await confirm.click();

    // AFTER (UI) — the row is gone and the panel reads as empty again.
    await expect(row(page, name), "the re-adopted row is still listed").toHaveCount(0);
    await expect(box.getByTestId("released-skills-empty")).toBeVisible();
    await expect(box.getByText("Frozen copies (0)", { exact: true })).toBeVisible();

    // AFTER (REST) — the server agrees the record is gone.
    const after = await readReleased(loomDaemon.baseURL, project.id);
    expect(after.map((r2) => r2.name), "the release record survived the re-adopt").not.toContain(name);

    // AFTER (disk) — and the copy really was replaced, which is the point of the whole action.
    const landed = fs.readFileSync(seeded.destFile, "utf8");
    expect(landed, "the store content never reached the project's copy").toContain(storeLine);
    expect(landed, "the hand edit was not overwritten, so nothing actually happened").not.toContain(diskLine);
  });

  // THE REFUSAL THAT IS THE WHOLE POINT of card 8b38b920's fingerprint parameter: an edit landing
  // between the diff and the click must be REPORTED, never discarded unseen. This is also the
  // regression pin for the UI half of that contract — if the panel ever refetched the fingerprint at
  // click time, this test would go GREEN on a successful overwrite instead, silently losing the edit.
  test("an edit made after the diff was reviewed is refused, and nothing is discarded", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`released-stale-${Date.now()}`);
    const name = `loom-e2e-stale-${Date.now()}`;
    const storeLine = `STORE-SIDE-${name}`;
    const firstEdit = `FIRST-EDIT-${name}`;
    const secondEdit = `SECOND-EDIT-AFTER-REVIEW-${name}`;
    const seeded = await seedReleasedSkill(loomDaemon.baseURL, await repoPathOf(loomDaemon.baseURL, project.id), {
      name,
      storeBody: `# ${name}\n\n${storeLine}\n`,
      onDiskBody: `# ${name}\n\n${firstEdit}\n`,
      reason: "modified",
    });
    expect((await readReleased(loomDaemon.baseURL, project.id)).map((r) => r.name)).toContain(name);

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/settings");

    const r = row(page, name);
    await openDiff(page, name);
    // The reviewed snapshot is now on screen, carrying the fingerprint of `firstEdit`.
    await r.getByTestId("released-file-toggle-SKILL.md").click();
    await expect(r.getByText(`+ ${firstEdit}`, { exact: true })).toBeVisible();

    // The concurrent hand edit, out-of-band — exactly the window the fingerprint exists to close.
    fs.writeFileSync(seeded.destFile, `# ${name}\n\n${secondEdit}\n`);

    await r.getByTestId("readopt-start").click();
    await r.getByTestId("readopt-confirm").click();

    // The server's own 409 text, shown verbatim and inline — never a silent no-op.
    const err = r.getByTestId("readopt-error");
    await expect(err, "the refusal was not surfaced to the reader").toBeVisible();
    await expect(err).toContainText("changed since you reviewed it");

    // And the refusal really refused: the record stands and the SECOND edit is still on disk, untouched.
    expect((await readReleased(loomDaemon.baseURL, project.id)).map((r2) => r2.name),
      "the release record was cleared despite the refusal").toContain(name);
    await expect(row(page, name), "the row disappeared despite the refusal").toBeVisible();
    const onDisk = fs.readFileSync(seeded.destFile, "utf8");
    expect(onDisk, "the concurrent edit was discarded — the guard this test exists for did not hold").toContain(secondEdit);
    expect(onDisk, "the store content was written over the concurrent edit").not.toContain(storeLine);
  });

  // The OTHER refusal, and the only one a reader can see BEFORE clicking: card 8b38b920's lead decision
  // that a git-tracked copy is repo-owned content Loom will not overwrite. Stated on the row itself, so
  // nobody has to click to find out — and no re-adopt button is offered at all.
  test("a git-tracked copy says so before any click, and offers no re-adopt", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`released-tracked-${Date.now()}`);
    const name = `loom-e2e-tracked-${Date.now()}`;
    const repoPath = await repoPathOf(loomDaemon.baseURL, project.id);
    const seeded = await seedReleasedSkill(loomDaemon.baseURL, repoPath, {
      name,
      storeBody: `# ${name}\n\nSTORE-SIDE-${name}\n`,
      onDiskBody: `# ${name}\n\nREPO-OWNED-${name}\n`,
      reason: "unverifiable-legacy",
    });
    // `git add` alone is enough: `git ls-files` reports the INDEX, so no commit (and no committer
    // identity in this throwaway fixture repo) is needed to make the daemon's check say "tracked".
    execFileSync("git", ["add", "--", path.relative(repoPath, seeded.destFile).split(path.sep).join("/")],
      { cwd: repoPath });

    // The control that makes this test about the UI rather than about whether `git add` worked.
    const before = await readReleased(loomDaemon.baseURL, project.id);
    expect(before.find((r) => r.name === name)?.tracked,
      "the fixture failed to make the copy git-tracked, so the assertions below prove nothing").toBe("tracked");

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/settings");

    const r = row(page, name);
    await expect(r).toBeVisible();
    await expect(r.getByText("git-tracked", { exact: true }), "the tracked badge is missing").toBeVisible();
    await expect(r, "the row does not say why a re-adopt will be refused").toContainText("Re-adopting is refused");
    await expect(r, "the reason names the wrong cause").toContainText("tracked by git");
    // `unverifiable-legacy` must not be worded as an edit either (it is a bookkeeping gap).
    await expect(r).toContainText("cannot prove the content is its own");

    // Open the diff anyway: the refusal is restated there and the action is withheld, not merely disabled.
    await openDiff(page, name);
    await expect(r.getByTestId("readopt-start"), "a re-adopt was offered for repo-owned content").toHaveCount(0);
    await expect(r.getByTestId("readopt-confirm")).toHaveCount(0);
  });

  // The card's named placement. Asserted as BEHAVIOUR (the same seeded row is really listed there), not
  // merely as presence — `atlas-settings-scope.spec.ts` already sweeps presence off the section array.
  test("the Atlas project Settings node lists the same frozen copy", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`released-atlas-${Date.now()}`);
    const name = `loom-e2e-atlas-${Date.now()}`;
    await seedReleasedSkill(loomDaemon.baseURL, await repoPathOf(loomDaemon.baseURL, project.id), {
      name,
      storeBody: `# ${name}\n\nSTORE-SIDE-${name}\n`,
      onDiskBody: `# ${name}\n\nDISK-SIDE-${name}\n`,
      reason: "abandoned",
    });
    expect((await readReleased(loomDaemon.baseURL, project.id)).map((r) => r.name)).toContain(name);

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/settings");

    // It really is the Atlas project node, so the row below cannot be attributed to the classic page.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(project.name);
    const r = row(page, name);
    await expect(r, "the Atlas project Settings node does not list the frozen copy").toBeVisible();
    await expect(r.getByText("abandoned", { exact: true })).toBeVisible();
    // ⛔ `abandoned` is an age/cap give-up, NOT a claim that anything was edited (the content may be
    // byte-identical to Loom's own placement) — pinned here because wording it as a change would send a
    // reader hunting for a diff that does not exist. test/released-skills.mjs pins the same rule on the
    // gloss itself; this is the rendered half.
    await expect(r).toContainText("The content may still be Loom's own.");
    await expect(r.getByText(/Re-adopting is refused/)).toHaveCount(0);
  });
});

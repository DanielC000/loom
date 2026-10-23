// Atlas P2-12 — Settings split by the scope its sections actually write (card 595e2a47, closing
// parity gap §J.9). Decisions + the full section → write-call → read-call table:
// docs/decisions/595e2a47-atlas-settings-scope-split.md.
//
// The card's claim has three halves, and each is asserted against the live app rather than a list
// typed into this file:
//   1. PLACEMENT, swept. The section list is parsed out of the real `SETTINGS_SECTIONS` declaration
//      in src/pages/Settings.tsx, and EVERY row is required to render on its own Atlas node and on
//      neither other node. A hand-copied list here would go stale exactly as the thing it guards.
//   2. SCOPE, exercised. A project row's Save writes the ACTIVE project's config and not a decoy
//      project's; a workspace row's Save writes the one platform override. "It rendered in the right
//      column" is a weaker claim than "it edits the right store", so both are made.
//   3. SWITCH OFF is untouched. The classic page still renders every row in one column, and the
//      Atlas-only /workspace-settings address renders nothing there.
//
// ⚠️ Locator discipline (see the project-memory note `atlas-nav-labels-collide-with-exact-text-locators`):
// "Settings" is now TWO tree labels and "Memory" is a tree label too, so a page-wide exact-text
// locator resolves to the chrome as readily as to the content. PRESENCE is scoped to the section's own
// `settings-section-<key>` wrapper; ABSENCE is scoped to `main` — wide enough to span every panel,
// narrow enough to decline to read the tree.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only, so a spec cannot pull `src/` in.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_SOURCE = path.resolve(__dirname, "..", "src", "pages", "Settings.tsx");

/** The project tier's Settings node, and the Workspace tier's own. */
const PROJECT_NODE = "/settings";
const WORKSPACE_NODE = "/workspace-settings";

type ParsedSection = { key: string; label: string; scope: string };

// Parsed out of the real source, with the filtered row count checked against the declaration's own
// raw marker count — same idiom (and same reason) as atlas-tree.spec.ts's `parseAtlasHomes`. A regex
// that quietly stopped matching a row would otherwise return a plausible SUBSET, and a subset would
// let a mis-scoped section through as "not declared".
function parseSettingsSections(): { rows: ParsedSection[]; rawMarkers: number; block: string } {
  const src = readFileSync(SETTINGS_SOURCE, "utf8");
  const start = src.indexOf("export const SETTINGS_SECTIONS");
  if (start < 0) throw new Error(`no SETTINGS_SECTIONS declaration found in ${SETTINGS_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`SETTINGS_SECTIONS in ${SETTINGS_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bkey:\s*"/g) ?? []).length;
  const rows = [...block.matchAll(/\bkey:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*scope:\s*"([^"]+)"/g)]
    .map((m) => ({ key: m[1] ?? "", label: m[2] ?? "", scope: m[3] ?? "" }));
  return { rows, rawMarkers, block };
}

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Guarded, not unconditional: an unconditional setItem RE-PINS on every reload, which would make a
// "selection survived" leg measure the helper rather than the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

// Locate a config field's control by the EXACT text of its label <span>. getByLabel is unusable: each
// field's <label> nests its Hint text too, which pollutes the accessible name AND makes "Gate command"
// collide with "Gate command timeout (s)". Lifted verbatim from settings.spec.ts.
function field(page: Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

const sectionBox = (page: Page, key: string) => page.getByTestId(`settings-section-${key}`);

test.describe("Atlas Settings scope split (card 595e2a47)", () => {
  test("every declared section renders on exactly one Atlas node", async ({ page, loomDaemon }) => {
    const { rows, rawMarkers, block } = parseSettingsSections();

    // Controls on the PARSE itself, before anything is asserted about the app.
    expect(rows.length, `the SETTINGS_SECTIONS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
    expect(rows.length,
      `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
      + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
    expect(new Set(rows.map((r) => r.key)).size, "two sections share a key").toBe(rows.length);
    for (const r of rows) {
      expect(["project", "workspace"], `section ${r.key} has an unknown scope ${JSON.stringify(r.scope)}`)
        .toContain(r.scope);
    }

    const project = rows.filter((r) => r.scope === "project");
    const workspace = rows.filter((r) => r.scope === "workspace");
    // ⭐ Without this the whole sweep is satisfiable by a list that is entirely one scope — every
    // absence would then hold for the trivial reason that the other node was always empty.
    expect(project.length, "no section is declared project-scoped, so the split is vacuous").toBeGreaterThan(0);
    expect(workspace.length, "no section is declared workspace-scoped, so the split is vacuous").toBeGreaterThan(0);

    await pinProject(page, (await loomDaemon.createProject(`atlas-settings-sweep-${Date.now()}`)).id);
    await seedAtlasOn(page);

    for (const node of [PROJECT_NODE, WORKSPACE_NODE] as const) {
      await page.goto(loomDaemon.baseURL + node);
      const main = page.locator("main");
      await expect(main).toBeVisible();

      const expected = node === PROJECT_NODE ? project : workspace;
      const absent = node === PROJECT_NODE ? workspace : project;

      for (const r of expected) {
        const box = sectionBox(page, r.key);
        await expect(box, `${node} is missing the ${r.scope} section ${r.key}`).toHaveCount(1);
        // The wrapper could in principle render with the wrong heading inside it, so the LABEL is
        // asserted too — scoped to this box, never page-wide (several labels are also tree labels).
        await expect(box.getByText(r.label, { exact: true }),
          `${node}'s ${r.key} wrapper does not carry its own "${r.label}" label`).toHaveCount(1);
      }
      for (const r of absent) {
        await expect(sectionBox(page, r.key),
          `${node} renders ${r.key}, which is ${r.scope}-scoped and belongs on the other node`).toHaveCount(0);
        // And the label itself is gone from the content column, not merely its wrapper — a section
        // rendered without its wrapper would pass the count check above and still be misplaced.
        await expect(main.getByText(r.label, { exact: true }),
          `${node}'s content still shows the ${r.scope}-scoped label "${r.label}"`).toHaveCount(0);
      }
    }

    // The Workspace node is still reachable from the tree, and still at workspace depth (not the
    // project's). Card 0d0c6cee moved it out of the tree's ROWS and into the escape hatch at the
    // foot of the tree — it is a `ROOT_TABS` row in the approved design, so cards 41eab0eb /
    // 25c08fba re-home it as a Workspace node tab. What this test is about — that a workspace-tier
    // Settings address exists, is reachable, and reads at workspace depth — is unchanged; only which
    // control reaches it moved. ⚠️ Re-point at the tab when those cards land.
    await page.goto(loomDaemon.baseURL + "/home");
    // The hatch is a <details> that auto-opens only on one of its OWN destinations, and /home is not
    // one — so it has to be opened before its rows can be clicked. Exercised as a reader would, by
    // clicking the summary, with the before/after state asserted on both sides: a bare
    // `open = true` would prove the row works while leaving the only new control here unexercised.
    const hatch = page.getByTestId("atlas-unhomed");
    await expect(hatch, "the escape hatch is open on /home, which is not one of its destinations")
      .not.toHaveAttribute("open", /.*/);
    await hatch.locator("summary").click();
    await expect(hatch, "clicking the escape hatch's summary did not open it").toHaveAttribute("open", /.*/);
    const treeRow = page.getByTestId("atlas-unhomed-/workspace-settings");
    await expect(treeRow).toBeVisible();
    expect(await treeRow.evaluate((el) => !!el.closest("ul.loom-atlas-nodes.is-kids")),
      "the Workspace Settings row is nested under the project branch").toBe(false);
    await treeRow.click();
    await expect.poll(() => new URL(page.url()).pathname,
      { message: "clicking the Workspace Settings tree node did not navigate" }).toBe(WORKSPACE_NODE);
    // The frame agrees about where that is: workspace depth, so the project name is NOT a crumb.
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText("Settings");
    // The crumb TEXT span, not the whole <li>: every <li> past the first also nests an aria-hidden
    // "/" separator, which innerText folds into the label ("/\nSettings").
    const crumbs = await page.getByTestId("atlas-breadcrumb")
      .locator("li > span:not([aria-hidden])").allInnerTexts();
    expect(crumbs.map((c) => c.trim()), "the Workspace Settings crumb trail is not workspace-depth")
      .toEqual(["Workspace", "Settings"]);
  });

  test("the project node's Settings edits the ACTIVE project's config, not a decoy's", async ({ page, loomDaemon }) => {
    const active = await loomDaemon.createProject(`atlas-settings-active-${Date.now()}`);
    const decoy = await loomDaemon.createProject(`atlas-settings-decoy-${Date.now()}`);
    await pinProject(page, active.id);
    await seedAtlasOn(page);

    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    // The node is the project's — its crumb names the pinned project, so a write below cannot be
    // attributed to a node that was silently scoped somewhere else.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(active.name);

    const gate = field(page, "Gate command");
    await expect(gate).toBeVisible();
    await expect(gate, "a freshly seeded project should carry no gateCommand override").toHaveValue("");

    const value = `pnpm build --atlas-${Date.now()}`;
    await gate.fill(value);
    // Under Atlas this node renders the project column ALONE, so there is exactly one Save on it —
    // asserted, rather than reaching for `.first()`, because "only the project form is here" is
    // precisely what this card changed and is therefore worth failing on.
    const save = page.locator("main").getByRole("button", { name: "Save", exact: true });
    await expect(save, "the project Settings node should hold exactly one Save button").toHaveCount(1);
    await expect(save).toBeEnabled();
    await save.click();

    const readGate = async (id: string) => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { gateCommand?: string } } }>;
      return projects.find((p) => p.id === id)?.config?.orchestration?.gateCommand ?? null;
    };
    await expect.poll(() => readGate(active.id), { message: "the active project's gateCommand never persisted" })
      .toBe(value);
    // The decoy is what makes the line above mean "the ACTIVE project" rather than "a project".
    expect(await readGate(decoy.id), "the write reached the decoy project too").toBeNull();
  });

  test("a daemon-global section is only on the Workspace node, and writes the platform override", async ({ page, loomDaemon }) => {
    await pinProject(page, (await loomDaemon.createProject(`atlas-settings-global-${Date.now()}`)).id);
    await seedAtlasOn(page);

    // Rate Limits is the plan's own named daemon-global example (§J.9). It is NOT on the project node.
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    const projectMain = page.locator("main");
    await expect(projectMain, "the project node rendered nothing, so the absence below proves nothing")
      .toContainText("Project Settings");
    await expect(projectMain.getByText("Rate Limits", { exact: true }),
      "the daemon-global Rate Limits section is still on the project node").toHaveCount(0);

    await page.goto(loomDaemon.baseURL + WORKSPACE_NODE);
    await expect(sectionBox(page, "global-daemon").getByText("Rate Limits", { exact: true })).toBeVisible();

    // Exercised, not merely rendered: the control writes the one daemon-global store. A value distinct
    // from every other spec's on this shared worker daemon, so the read-back is unambiguous.
    const pct = field(page, "Exhausted threshold (%)");
    await expect(pct).toBeVisible();
    await pct.fill("63");
    const save = page.locator("main").getByRole("button", { name: "Save", exact: true });
    await expect(save, "the Workspace Settings node should hold exactly one Save button").toHaveCount(1);
    await expect(save).toBeEnabled();
    await save.click();

    await expect
      .poll(async () => {
        const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
        const body = (await res.json()) as { override?: { rateLimit?: { exhaustedThresholdPct?: number } } };
        return body?.override?.rateLimit?.exhaustedThresholdPct ?? null;
      }, { message: "the Workspace node's Save never reached the platform override" })
      .toBe(63);
  });

  test("the human-only controls keep their gating and confirm UI on the Workspace node", async ({ page, loomDaemon }) => {
    // These are trust-boundary surfaces (gateCommand, the merge-gate cadence, maxConcurrentGates,
    // the default harness): the split must MOVE them, never relax them. Each is asserted where it now
    // lives, in the shape it had before.
    await pinProject(page, (await loomDaemon.createProject(`atlas-settings-human-${Date.now()}`)).id);
    await seedAtlasOn(page);

    await page.goto(loomDaemon.baseURL + WORKSPACE_NODE);
    // maxConcurrentGates — still its own control with its own inherit placeholder.
    const gates = field(page, "Max concurrent merge/deploy gates");
    await expect(gates).toBeVisible();
    await expect(gates).toHaveAttribute("placeholder", /^inherit \(default \d+\)$/);
    // The platform default-harness panel, with its own testid, still on the daemon-global side.
    await expect(page.getByTestId("default-harness-platform")).toBeVisible();
    await expect(page.getByTestId("default-harness-project"),
      "the PROJECT default-harness panel leaked onto the Workspace node").toHaveCount(0);

    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    // Gate command + the merge-gate cadence panel + the project harness panel, all still project-side.
    await expect(field(page, "Gate command")).toBeVisible();
    await expect(field(page, "Ungated landing check command")).toBeVisible();
    await expect(page.getByTestId("default-harness-project")).toBeVisible();
    await expect(page.getByTestId("default-harness-platform"),
      "the PLATFORM default-harness panel leaked onto the project node").toHaveCount(0);
    await expect(page.locator("main").getByText("Merge gate", { exact: true })).toBeVisible();
  });

  test("with the switch OFF the classic page is untouched and the Atlas-only address renders nothing", async ({ page, loomDaemon }) => {
    const { rows } = parseSettingsSections();
    await pinProject(page, (await loomDaemon.createProject(`atlas-settings-off-${Date.now()}`)).id);

    // No seedAtlasOn: OFF is the default.
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(page.locator(".loom-rail"), "the classic shell did not render").toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    // EVERY row, both scopes, in ONE column — the classic page keeps the whole page it always had.
    for (const r of rows) {
      await expect(sectionBox(page, r.key),
        `the classic Settings page lost the ${r.scope} section ${r.key}`).toHaveCount(1);
    }
    // And in declaration order, which is the order the page has always rendered in (Disk Reclaim last).
    const rendered = await page.locator("main [data-testid^='settings-section-']")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")?.replace("settings-section-", "") ?? ""));
    expect(rendered, "the classic Settings page reordered its sections").toEqual(rows.map((r) => r.key));

    // The Workspace node is an ATLAS_HOMES address; LegacyShell deliberately mounts none of those, so
    // under the classic shell this path renders an empty content column rather than a second Settings.
    await page.goto(loomDaemon.baseURL + WORKSPACE_NODE);
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.locator("main [data-testid^='settings-section-']"),
      "the Atlas-only /workspace-settings address rendered Settings under the classic shell").toHaveCount(0);
  });
});

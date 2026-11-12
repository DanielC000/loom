// Card bafbca40 (Atlas audit finding A-29): the ⌘K palette jumps to projects, agents and live
// sessions, walks with the arrow keys, says what kind of thing each row is, tells apart the rows that
// share a label, and has a visible door in the Atlas crumb bar.
//
// Every navigation claim is EXERCISED to an observable (the URL, and the node that renders there),
// and the arrow-key claim is read off the combobox's own `aria-activedescendant`, so a highlight that
// only moved visually would fail it. The ranking itself is unit-tested in test/palette-commands.mjs.
import { expect, test, type Page } from "./fixtures/daemon";

const field = (page: Page) => page.getByRole("combobox", { name: /Jump to/ });
const options = (page: Page) => page.getByRole("option");

test.describe("Command palette jumps (card bafbca40)", () => {
  test("typing a project's name ranks the PROJECT first, and Enter opens its node", async ({ page, loomDaemon }) => {
    const tag = Math.random().toString(36).slice(2, 7);
    const seeded = await loomDaemon.seedLiveSession({ role: "manager", agentName: `Pal-${tag}` });    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    await page.keyboard.press("Control+k");
    await expect(field(page)).toBeVisible();
    await field(page).fill(seeded.projectName);

    // The first option is the project itself, labelled as one.
    const first = options(page).first();
    await expect(first).toHaveAttribute("data-kind", "project");
    await expect(first).toHaveAttribute("data-label", seeded.projectName);
    await expect(first).toHaveAttribute("aria-selected", "true");
    // Its live session and its agent are offered too, each with its own kind and its project as context.
    await expect(page.locator(`[role="option"][data-kind="session"][data-label="${seeded.agentName}"]`)).toHaveCount(1);
    await expect(page.locator(`[role="option"][data-kind="agent"][data-label="${seeded.agentName}"]`)).toHaveCount(1);

    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/project$/);
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.projectName);
  });

  test("↑/↓ move the active option, and Enter runs the active one, not row 1", async ({ page, loomDaemon }) => {
    const tag = Math.random().toString(36).slice(2, 7);
    const seeded = await loomDaemon.seedLiveSession({ role: "manager", agentName: `Arrow-${tag}` });    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    await page.keyboard.press("Control+k");
    // The agent's name is unique to this test, so exactly its session row and agent row match.
    await field(page).fill(seeded.agentName);
    await expect(options(page)).toHaveCount(2);
    const ids = await options(page).evaluateAll((els) => els.map((el) => el.id));
    const kinds = await options(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-kind")));
    expect(kinds.sort()).toEqual(["agent", "session"]);

    // Before: row 1 is active.
    await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[0]!);
    await page.keyboard.press("ArrowDown");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[1]!);
    await expect(page.locator(`#${ids[1]}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#${ids[0]}`)).toHaveAttribute("aria-selected", "false");
    // Wraps at the end, and ArrowUp walks back.
    await page.keyboard.press("ArrowDown");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[0]!);
    await page.keyboard.press("ArrowUp");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[1]!);

    // Enter runs the ACTIVE (second) row.
    const activeKind = await page.locator(`#${ids[1]}`).getAttribute("data-kind");
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveCount(0);
    if (activeKind === "session") {
      await expect(page).toHaveURL(new RegExp(`/session/${seeded.sessionId}$`));
    } else {
      // An agent row lands on the Agents node with that agent's editor open, and the deep-link
      // parameter is consumed so a reload would not reopen it.
      await expect(page).toHaveURL(/\/agents$/);
      await expect(page.getByTestId("atlas-agent-editor")).toBeVisible();
    }
  });

  test("the agent row opens that agent's editor on the Agents node", async ({ page, loomDaemon }) => {
    const tag = Math.random().toString(36).slice(2, 7);
    const seeded = await loomDaemon.seedLiveSession({ role: "manager", agentName: `Ed-${tag}` });    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    await page.keyboard.press("Control+k");
    await field(page).fill(seeded.agentName);
    await page.locator(`[role="option"][data-kind="agent"]`).click();
    await expect(page).toHaveURL(/\/agents$/);
    const editor = page.getByTestId("atlas-agent-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(seeded.agentName);
  });

  test("rows that share a label are told apart by their context, and Home is offered", async ({ page, loomDaemon }) => {
    await loomDaemon.createProject();    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    await page.keyboard.press("Control+k");
    await expect(field(page)).toBeVisible();
    const pages = await page.locator('[role="option"][data-kind="page"]').evaluateAll((els) =>
      els.map((el) => `${el.getAttribute("data-label")}|${el.getAttribute("data-context")}`));
    // No two page rows say the same thing.
    expect(new Set(pages).size, `duplicate page rows: ${pages.join(", ")}`).toBe(pages.length);
    // Both Homes and both Settings are there, one on each tier.
    const tiers = (label: string) => pages.filter((p) => p.startsWith(`${label}|`)).map((p) => p.split("|")[1]);
    expect(tiers("Home")).toContain("Workspace");
    expect(tiers("Home").length).toBe(2);
    expect(tiers("Settings")).toContain("Workspace");
    expect(tiers("Settings").length).toBe(2);
    expect(pages.some((p) => p.startsWith("Skills|"))).toBe(true);
  });

  test("the crumb bar's ⌘K button opens the palette, and Esc returns focus to it", async ({ page, loomDaemon }) => {    await page.goto(loomDaemon.baseURL + "/home");
    const door = page.getByTestId("atlas-jump");
    await expect(door).toBeVisible();
    await expect(field(page)).toHaveCount(0);

    await door.click();
    await expect(field(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await expect(door).toBeFocused();

    // Still reachable at phone width, where the word drops and the key hint stays.
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(door).toBeVisible();
    await door.click();
    await expect(field(page)).toBeVisible();
  });
});

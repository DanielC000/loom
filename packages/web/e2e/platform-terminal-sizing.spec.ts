// The Platform node's live terminal cards size like every other terminal surface (card b8b7b969).
//
// Owner feedback: "On Platform page: The terminal cards havbe odd sizes and behave differently. Test in
// multiple page ratios, observe behavior and fix".
//
// ROOT CAUSE this pins: PlatformView gave its cards their own HUG cap (440 in the dev grid, 480 in the
// end-user tiles) instead of the shared TILE_MAX_HEIGHT (lib/terminalLayout.ts). At that cap the pinned
// grid is HEIGHT-bound once a card passes ~560px, so the card widens around a stalled terminal, and since
// each card's budget is the cap minus its OWN chrome, a card with a bound-task bar draws a smaller
// terminal than its neighbour. Its grid template also lacked `min(100%, …)`, so a phone overflowed.
//
// Measured as GEOMETRY, never as the props: each card's `.xterm-screen` (the grid the font solver
// actually drew) against its card and against its neighbour. Every invariant is POLLED, because the font
// solver settles over a few frames; the old code never converges, so it fails on the poll's timeout.
//
// Fixture: two LIVE sessions seeded into the reserved Platform home through the fixture's test-only
// insert path (no real claude is spawned). The auditor carries a bound task so the two cards differ in
// chrome, which is exactly the case that drew two terminal sizes. The dev edition is reached the same way
// atlas-platform.spec.ts reaches it: by serving `GET /api/platform/home` with the REAL reserved home.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// The shipped default pty geometry (packages/shared/src/config.ts `pty`), so the cards render the grid
// a real Platform session would.
const GEOMETRY = { cols: 80, rows: 24 };

type SetupHome = {
  project: { id: string; name: string };
  agents: { id: string; name: string; profileId: string | null }[];
  resolvedLead: { agentId: string | null; role: string | null };
};

async function readSetupHome(d: LoomDaemon): Promise<SetupHome> {
  const res = await fetch(`${d.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${d.loopbackSecret}` } });
  if (!res.ok) throw new Error(`GET /api/setup/home -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as SetupHome;
}

/** Seed an operator + an auditor session into the reserved home, and (dev) serve the dev edition. */
async function seedPlatform(page: Page, d: LoomDaemon, edition: "dev" | "enduser") {
  const home = await readSetupHome(d);
  // Fixture identity: a payload built from the wrong home would render a plausible, wrong page.
  expect(home.project.name, "the reserved home").toBe("Platform");
  const operator = home.agents.find((a) => a.name === "Platform");
  const auditor = home.agents.find((a) => a.name === "Workspace Auditor");
  expect(operator, "the reserved home's operator agent").toBeTruthy();
  expect(auditor, "the reserved home's workspace-auditor agent").toBeTruthy();

  const stamp = Date.now();
  await d.seedLiveSession({
    project: home.project, id: `b8op-${stamp}`, agentId: operator!.id, agentName: operator!.name,
    role: (home.resolvedLead.role ?? "platform") as never, ptyGeometry: GEOMETRY, ptyBytes: "B8-OPERATOR-PTY\r\n",
  });
  await d.seedLiveSession({
    project: home.project, id: `b8au-${stamp}`, agentId: auditor!.id, agentName: auditor!.name,
    role: "workspace-auditor" as never, ptyGeometry: GEOMETRY, ptyBytes: "B8-AUDITOR-PTY\r\n",
    task: { title: "Fictional audit sweep" },
  });

  if (edition === "dev") {
    const payload = {
      project: home.project,
      agents: home.agents.map((a) => (a.id === auditor!.id ? { ...a, name: "Platform Auditor" } : a)),
      liveSessions: [],
    };
    await page.route("**/api/platform/home", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(payload),
    }));
  }
}

type CardGeom = { cardX: number; cardW: number; screenW: number; containerX: number; containerW: number };

/**
 * Every visible terminal card on the Home panel: the card box (the element directly inside its grid or
 * section), the drawn grid's width, and its container's box.
 */
function cardGeometry(page: Page): Promise<CardGeom[]> {
  return page.getByTestId("platform-panel-home").evaluate((root) => {
    const out: CardGeom[] = [];
    for (const screen of Array.from(root.querySelectorAll<HTMLElement>(".xterm-screen"))) {
      if (!screen.offsetParent) continue;
      let card: HTMLElement = screen;
      while (card.parentElement && card.parentElement !== root
        && getComputedStyle(card.parentElement).display !== "grid" && card.parentElement.tagName !== "SECTION") {
        card = card.parentElement;
      }
      const c = card.getBoundingClientRect();
      const p = card.parentElement!.getBoundingClientRect();
      out.push({ cardX: c.x, cardW: c.width, screenW: screen.getBoundingClientRect().width, containerX: p.x, containerW: p.width });
    }
    return out;
  });
}

async function openPlatform(page: Page, d: LoomDaemon, vp: { width: number; height: number }) {
  await page.setViewportSize(vp);
  await page.goto(`${d.baseURL}/platform`);
  // Both cards attached to their own live pty (the replayed sentinel), not merely drew a frame.
  for (const sentinel of ["B8-OPERATOR-PTY", "B8-AUDITOR-PTY"]) {
    await expect(page.getByTestId("platform-panel-home").locator(".xterm-accessibility-tree > div")
      .filter({ hasText: sentinel })).toHaveCount(1, { timeout: 15_000 });
  }
}

/** The two cards draw the SAME terminal width, and each terminal fills its card edge to edge. */
async function expectConsistentCards(page: Page, label: string) {
  await expect.poll(async () => {
    const g = await cardGeometry(page);
    if (g.length !== 2) return `expected 2 terminal cards, saw ${g.length}`;
    const [a, b] = g as [CardGeom, CardGeom];
    if (Math.abs(a.screenW - b.screenW) > 2) return `terminal widths differ: ${Math.round(a.screenW)} vs ${Math.round(b.screenW)}`;
    // Card chrome is the panel's padding + border (~14px); 40 leaves room for it and nothing like the
    // ~280px empty strip a height-bound grid leaves in a wide card.
    for (const c of g) {
      if (c.cardW - c.screenW > 40) return `terminal ${Math.round(c.screenW)}px does not fill its ${Math.round(c.cardW)}px card`;
    }
    return "ok";
  }, { message: label, timeout: 10_000 }).toBe("ok");
}

test.describe("Platform node terminal cards size consistently (card b8b7b969)", () => {
  test("dev grid: equal terminals that fill their cards at two page ratios", async ({ page, loomDaemon }) => {
    await seedPlatform(page, loomDaemon, "dev");
    for (const vp of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await openPlatform(page, loomDaemon, vp);
      await expect(page.getByTestId("platform-sessions-grid"), "the dev edition's sessions grid").toBeVisible();
      await expectConsistentCards(page, `dev grid at ${vp.width}x${vp.height}`);
    }
  });

  test("dev grid: a phone-width page keeps every card inside its column", async ({ page, loomDaemon }) => {
    await seedPlatform(page, loomDaemon, "dev");
    await openPlatform(page, loomDaemon, { width: 390, height: 844 });
    await expect.poll(async () => {
      const g = await cardGeometry(page);
      if (g.length !== 2) return `expected 2 terminal cards, saw ${g.length}`;
      const over = g.find((c) => c.cardX + c.cardW > c.containerX + c.containerW + 1);
      return over ? `a ${Math.round(over.cardW)}px card overflows its ${Math.round(over.containerW)}px column` : "ok";
    }, { timeout: 10_000 }).toBe("ok");
  });

  test("end-user: the operator and auditor tiles draw the same terminal", async ({ page, loomDaemon }) => {
    await seedPlatform(page, loomDaemon, "enduser");
    for (const vp of [{ width: 1440, height: 900 }, { width: 1080, height: 1920 }]) {
      await openPlatform(page, loomDaemon, vp);
      await expectConsistentCards(page, `end-user tiles at ${vp.width}x${vp.height}`);
    }
  });
});

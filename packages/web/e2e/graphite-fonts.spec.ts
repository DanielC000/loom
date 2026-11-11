// Graphite type (epic e25fa8a9, card 99ae5981): the UI face is self-hosted Instrument Sans, data is
// self-hosted Geist Mono, and the terminal keeps xterm's own default font.
//
// What this spec pins, each against the RUNNING app rather than the source:
//   1. every font the page fetches comes from the daemon's own origin, and at least one IS fetched
//      (the positive control: a request log that recorded nothing would also report "none external");
//   2. both faces actually load, and body / mono text resolve to them, with the Graphite body metrics
//      (14px / 1.45, tabular figures) and the --loom-fs-* scale;
//   3. the xterm grid does NOT use either face (fixed pty geometry: cell width is a separate risk);
//   4. Overview, Board, a session and Settings have no page-level horizontal overflow at 1440 and 900,
//      in dark and light.
//
// Set LOOM_E2E_SHOTS to a directory to persist a screenshot of every page × width × theme for review.
import path from "node:path";
import { expect, test, type Page } from "./fixtures/daemon";

const shotDir = process.env.LOOM_E2E_SHOTS;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => { localStorage.setItem("loom.theme", t); }, theme);
}

test("fonts are self-hosted Instrument Sans + Geist Mono, and the terminal keeps xterm's default", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  const origin = new URL(loomDaemon.baseURL).origin;
  const fontUrls: string[] = [];
  page.on("request", (req) => {
    if (req.resourceType() === "font" || /\.(woff2?|ttf|otf)(\?|$)/.test(req.url())) fontUrls.push(req.url());
  });
  const seeded = await loomDaemon.seedLiveSession({
    role: "plain",
    ptyGeometry: { cols: 60, rows: 12 },
    ptyBytes: "GRAPHITE-FONTS-99ae5981\r\n",
    task: { title: `fonts-card-${Date.now()}`, columnKey: "review" },
  });
  await page.addInitScript((id) => { try { localStorage.setItem("loom.projectId", id); } catch { /* storage blocked */ } }, seeded.projectId);

  await page.goto(loomDaemon.baseURL + "/board");
  await expect(page.getByText(seeded.taskTitle!, { exact: true }).first()).toBeVisible();
  // Force both faces through the loader, so "loaded" below is the real face and not a race.
  await page.evaluate(() => Promise.all([
    document.fonts.load('14px "Instrument Sans"'),
    document.fonts.load('12.5px "Geist Mono"'),
  ]));
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")));
  expect(loaded, "Instrument Sans loaded").toContain("Instrument Sans");
  expect(loaded, "Geist Mono loaded").toContain("Geist Mono");
  expect(loaded.filter((f) => /Space Grotesk|JetBrains Mono/.test(f)), "the old faces are gone").toEqual([]);

  // (1) Positive control first, then the absence claim it makes meaningful.
  expect(fontUrls.length, "the page fetched at least one font file").toBeGreaterThan(0);
  expect(fontUrls.filter((u) => new URL(u).origin !== origin), "no font request leaves the daemon origin").toEqual([]);
  expect(fontUrls.every((u) => /\/assets\/(instrument-sans|geist-mono)-latin(-ext)?-wght-normal-[\w-]+\.woff2$/.test(u)),
    `only the bundled variable woff2 files are fetched: ${fontUrls.join(", ")}`).toBe(true);

  // (2) Body + mono resolve to the new faces and the Graphite metrics.
  const metrics = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--loom-font-mono)";
    probe.textContent = "0123";
    document.body.appendChild(probe);
    const mono = getComputedStyle(probe).fontFamily;
    probe.remove();
    const root = getComputedStyle(document.documentElement);
    const fs = Object.fromEntries(["xs", "sm", "mono", "body", "lg", "h1", "kpi"].map((k) => [k, root.getPropertyValue(`--loom-fs-${k}`).trim()]));
    return {
      family: body.fontFamily, size: body.fontSize, lineHeight: body.lineHeight, numeric: body.fontVariantNumeric,
      mono, fs,
    };
  });
  expect(metrics.family.startsWith('"Instrument Sans"'), `body font-family: ${metrics.family}`).toBe(true);
  expect(metrics.size).toBe("14px");
  expect(parseFloat(metrics.lineHeight)).toBeCloseTo(14 * 1.45, 1);
  expect(metrics.numeric).toBe("tabular-nums");
  expect(metrics.mono.startsWith('"Geist Mono"'), `mono font-family: ${metrics.mono}`).toBe(true);
  expect(metrics.fs).toEqual({ xs: "11px", sm: "12px", mono: "12.5px", body: "14px", lg: "17.5px", h1: "22px", kpi: "27.5px" });

  // (3) The terminal grid keeps xterm's default font. Read off the rows xterm itself styles.
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);
  const rows = page.locator(".xterm-rows").first();
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "GRAPHITE-FONTS-99ae5981" })).toBeVisible();
  const termFont = await rows.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(termFont, "the terminal uses xterm's default font, not a Graphite face").toMatch(/courier/i);
  expect(termFont).not.toMatch(/Instrument Sans|Geist Mono/);
});

test("Overview, Board, a session and Settings do not overflow at 1440 and 900, dark and light", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const seeded = await loomDaemon.seedLiveSession({
    role: "plain",
    ptyGeometry: { cols: 60, rows: 12 },
    ptyBytes: "GRAPHITE-FONTS-SWEEP\r\n",
    task: { title: `fonts-sweep-${Date.now()}`, columnKey: "review" },
  });
  await page.addInitScript((id) => { try { localStorage.setItem("loom.projectId", id); } catch { /* storage blocked */ } }, seeded.projectId);
  const routes: Array<[string, string]> = [
    ["project", "/project"], ["board", "/board"], ["session", `/session/${seeded.sessionId}`], ["settings", "/settings"],
    // Settings is two pages since card acbb6df6 split it by scope: the project tab above, and the
    // Workspace node's tab, which holds the theme control.
    ["workspace-settings", "/home?tab=settings"],
  ];
  await page.goto(loomDaemon.baseURL + "/settings");
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, route] of routes) {
        await page.goto(loomDaemon.baseURL + route);
        expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);
        // Fixture identity: the seeded task (or, on the session page, its pty output; on Settings, the
        // project section; on the Workspace Settings tab, the theme control) proves this is the seeded daemon's page and not an empty fallback.
        if (name === "session") {
          await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "GRAPHITE-FONTS-SWEEP" })).toBeVisible();
        } else if (name === "settings") {
          await expect(page.getByTestId("settings-section-project-settings")).toBeVisible();
        } else if (name === "workspace-settings") {
          await expect(page.getByTestId("theme-switch").getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true }))
            .toHaveAttribute("aria-checked", "true");
        } else {
          await expect(page.getByText(seeded.taskTitle!, { exact: true }).first()).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} @ ${width} (${theme}) overflows the page horizontally`).toBeLessThanOrEqual(0);
        if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}-${width}-${theme}.png`) });
      }
    }
  }
});

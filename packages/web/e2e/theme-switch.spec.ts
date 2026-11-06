// The colour-theme switch (Graphite epic e25fa8a9, card 593674a7): System / Light / Dark in
// Settings → Interface, stored per browser under `loom.theme` and applied as `data-theme` on <html>.
//
// What this spec pins, each against the RUNNING app rather than the source:
//   1. each Settings option sets `data-theme` (and `color-scheme`), and the choice survives a reload;
//   2. no flash: the theme is already on <html> before the stylesheet or the app's module script is
//      even parsed, so first paint is the right theme;
//   3. "System" follows the OS setting live, and another tab's change is applied at once;
//   4. the terminal stays a dark well in BOTH themes, and its xterm theme follows the switch live;
//   5. the main contrast pairs clear WCAG AA in both themes, read from LIVE computed token values;
//   6. Overview, the board and a session render in light.
//
// Set LOOM_E2E_SHOTS to a directory to persist light/dark screenshots of those three pages for review.
import path from "node:path";
import { expect, test, type Page } from "./fixtures/daemon";

const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (page: Page, name: string) => {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: false });
};

const themeOf = (page: Page) => page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-theme"),
  scheme: document.documentElement.style.colorScheme,
  stored: (() => { try { return localStorage.getItem("loom.theme"); } catch { return "unreadable"; } })(),
}));

/**
 * Resolve any CSS colour (a token name or an expression) to sRGB [r, g, b] as the page renders it. A
 * canvas does the conversion, so OKLCH, color-mix and var() all come back as plain channel values.
 */
function rgbOf(page: Page, value: string): Promise<[number, number, number]> {
  const css = value.startsWith("--") ? `var(${value})` : value;
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!] as [number, number, number];
  }, css);
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const parseRgb = (s: string): [number, number, number] => {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`not an rgb() colour: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 1);
/** The page's own rendered background, as sRGB (computed style keeps OKLCH, so it goes via `rgbOf`). */
const pageBg = async (page: Page) => rgbOf(page, await page.evaluate(() => getComputedStyle(document.body).backgroundColor));

async function pickTheme(page: Page, label: "System" | "Light" | "Dark") {
  const sw = page.getByTestId("theme-switch");
  await sw.getByRole("radio", { name: label, exact: true }).click();
  await expect(sw.getByRole("radio", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
}

test("each Settings option sets data-theme on <html>, and the choice survives a reload", async ({ page, loomDaemon }) => {
  await page.goto(loomDaemon.baseURL + "/settings");
  // The default is dark until the last Graphite card flips it to system.
  expect(await themeOf(page)).toMatchObject({ attr: "dark", scheme: "dark", stored: null });
  await expect(page.getByTestId("theme-switch").getByRole("radio", { name: "Dark", exact: true }))
    .toHaveAttribute("aria-checked", "true");

  await pickTheme(page, "Light");
  expect(await themeOf(page)).toEqual({ attr: "light", scheme: "light", stored: "light" });
  // The page itself actually turned light, not just the attribute.
  expect(luminance(await pageBg(page))).toBeGreaterThan(0.8);

  await page.reload();
  expect(await themeOf(page)).toEqual({ attr: "light", scheme: "light", stored: "light" });
  await expect(page.getByTestId("theme-switch").getByRole("radio", { name: "Light", exact: true }))
    .toHaveAttribute("aria-checked", "true");

  await pickTheme(page, "Dark");
  expect(await themeOf(page)).toEqual({ attr: "dark", scheme: "dark", stored: "dark" });
  expect(luminance(await pageBg(page))).toBeLessThan(0.05);
  await page.reload();
  expect(await themeOf(page)).toMatchObject({ attr: "dark", stored: "dark" });

  // System follows the OS setting, and keeps following it while the page is open.
  await page.emulateMedia({ colorScheme: "light" });
  await pickTheme(page, "System");
  expect(await themeOf(page)).toEqual({ attr: "light", scheme: "light", stored: "system" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await themeOf(page)).attr).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await themeOf(page)).attr).toBe("light");
  await page.reload();
  expect(await themeOf(page)).toMatchObject({ attr: "light", stored: "system" });
});

test("no flash: the stored theme is on <html> before the stylesheet and the app script are parsed", async ({ page, loomDaemon }) => {
  await page.goto(loomDaemon.baseURL + "/settings");
  await pickTheme(page, "Light");

  // A PROBE, not a seed: it only records what the page's own inline script has done by the time the
  // parser reaches the first stylesheet and the first module script. If either were reached with no
  // data-theme (or the wrong one), first paint could show the wrong theme.
  await page.addInitScript(() => {
    const seen: Record<string, string | null> = {};
    (window as unknown as { __themeAtParse: typeof seen }).__themeAtParse = seen;
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof HTMLElement)) continue;
        const key = n.tagName === "LINK" && (n as HTMLLinkElement).rel === "stylesheet" ? "stylesheet"
          : n.tagName === "SCRIPT" && (n as HTMLScriptElement).type === "module" ? "moduleScript" : null;
        if (key && !(key in seen)) seen[key] = document.documentElement.getAttribute("data-theme");
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  const atParse = await page.evaluate(() => (window as unknown as { __themeAtParse: Record<string, string | null> }).__themeAtParse);
  expect(atParse, "the built page links a stylesheet and a module script, and both saw the theme already set")
    .toEqual({ stylesheet: "light", moduleScript: "light" });
});

test("another tab's change is applied at once", async ({ page, loomDaemon, context }) => {
  await page.goto(loomDaemon.baseURL + "/settings");
  const other = await context.newPage();
  await other.goto(loomDaemon.baseURL + "/settings");
  expect((await themeOf(other)).attr).toBe("dark");

  await pickTheme(page, "Light");
  await expect.poll(async () => (await themeOf(other)).attr).toBe("light");
  await expect(other.getByTestId("theme-switch").getByRole("radio", { name: "Light", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await other.close();
});

test("the main contrast pairs clear AA in both themes, read from live token values", async ({ page, loomDaemon }) => {
  // Direction C's ("Ink & Signal", card d2a44f7b) contrast table, every pair of the vault README's
  // §WCAG contrast, plus the secondary-on-panel pair: [label, foreground, background, floor]. Text
  // needs 4.5:1; UI (dots, edges, borders, the focus ring, a meter fill) needs 3:1. A background may be
  // an expression: the "needs you" band is an 11% attn wash over the panel, measured as rendered.
  const ATTN_BAND = "color-mix(in oklab, var(--loom-attn) 11%, var(--loom-surface))";
  const PAIRS: [string, string, string, number][] = [
    ["primary text", "--loom-text", "--loom-bg", 4.5],
    ["secondary text", "--loom-text-2", "--loom-bg", 4.5],
    ["muted text on page", "--loom-text-3", "--loom-bg", 4.5],
    ["muted text on panel", "--loom-text-3", "--loom-surface", 4.5],
    ["link / accent text", "--loom-accent-fg", "--loom-bg", 4.5],
    ["primary button label", "--loom-on-accent", "--loom-accent", 4.5],
    ["selected row text", "--loom-text", "--loom-selected", 4.5],
    ["live capsule text", "--loom-live-text", "--loom-live-soft", 4.5],
    ["working capsule text", "--loom-work-text", "--loom-work-soft", 4.5],
    ["needs-you capsule text", "--loom-attn-text", "--loom-attn-soft", 4.5],
    ["needs-you text on panel", "--loom-attn-text", "--loom-surface", 4.5],
    ["error capsule text", "--loom-danger-text", "--loom-danger-soft", 4.5],
    ["error text on panel", "--loom-danger-text", "--loom-surface", 4.5],
    ["danger button label", "--loom-on-danger", "--loom-danger-fill", 4.5],
    ["solid needs-you label", "--loom-on-attn", "--loom-attn", 4.5],
    ["text on a needs-you band", "--loom-text", ATTN_BAND, 4.5],
    ["live dot (UI)", "--loom-live", "--loom-surface", 3],
    ["working dot (UI)", "--loom-work", "--loom-surface", 3],
    ["needs-you edge (UI)", "--loom-attn", "--loom-surface", 3],
    ["error dot (UI)", "--loom-danger", "--loom-surface", 3],
    ["input border (UI)", "--loom-line-strong", "--loom-field-bg", 3],
    ["focus ring (UI)", "--loom-ring", "--loom-bg", 3],
    ["healthy meter fill (UI)", "--loom-meter-ok", "--loom-track", 3],
    ["secondary text on a panel", "--loom-text-2", "--loom-surface", 4.5],
  ];
  await page.goto(loomDaemon.baseURL + "/settings");
  const bgByTheme: Record<string, [number, number, number]> = {};
  for (const theme of ["Dark", "Light"] as const) {
    await pickTheme(page, theme);
    bgByTheme[theme] = await rgbOf(page, "--loom-bg");
    for (const [label, f, b, need] of PAIRS) {
      const r = contrast(await rgbOf(page, f), await rgbOf(page, b));
      expect(r, `${theme}: ${label} (${f} on ${b}) is ${r.toFixed(2)}:1, below ${need}:1`).toBeGreaterThanOrEqual(need);
    }
  }
  // Positive control: the two themes really did resolve to different values, so the loop above checked
  // two palettes and not the same one twice.
  expect(close(bgByTheme.Dark!, bgByTheme.Light!)).toBe(false);
  // Positive control for the instrument: a pair KNOWN to sit far below 3:1 (the track and the hairline,
  // two adjacent neutrals) must measure that way, so the loop cannot pass because the resolver returns
  // a constant.
  const known = contrast(await rgbOf(page, "--loom-track"), await rgbOf(page, "--loom-line"));
  expect(known, "a near-identical neutral pair measures well under 3:1").toBeLessThan(3);
});

test("every token in the contrast table is defined, so no pair is measured against an inherited fallback", async ({ page, loomDaemon }) => {
  // An undefined custom property in `color: var(--x)` silently resolves to the INHERITED text colour,
  // which would pass most text-on-background pairs vacuously. So name every token and require a value.
  const TOKENS = [
    "--loom-text", "--loom-text-2", "--loom-text-3", "--loom-bg", "--loom-surface", "--loom-selected",
    "--loom-accent", "--loom-accent-fg", "--loom-on-accent", "--loom-field-bg", "--loom-line-strong",
    "--loom-ring", "--loom-track", "--loom-meter-ok",
    "--loom-live", "--loom-live-text", "--loom-live-soft",
    "--loom-work", "--loom-work-text", "--loom-work-soft",
    "--loom-attn", "--loom-attn-text", "--loom-attn-soft", "--loom-on-attn",
    "--loom-danger", "--loom-danger-text", "--loom-danger-soft", "--loom-danger-fill", "--loom-on-danger",
  ];
  await page.goto(loomDaemon.baseURL + "/settings");
  for (const theme of ["Dark", "Light"] as const) {
    await pickTheme(page, theme);
    const missing = await page.evaluate((names) => names.filter(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() === ""), TOKENS);
    expect(missing, `${theme}: tokens with no value`).toEqual([]);
  }
  // Positive control: the same probe DOES report a token that is genuinely absent (the retired busy).
  const retired = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--loom-busy").trim());
  expect(retired, "the retired --loom-busy token is gone, and the probe can see an absence").toBe("");
});

test("Overview, the board and a session render in light; the terminal stays a dark well and re-themes live", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seeded = await loomDaemon.seedLiveSession({
    role: "plain",
    ptyGeometry: { cols: 60, rows: 12 },
    ptyBytes: "THEME-SWITCH-593674a7\r\n",
    task: { title: `theme-card-${Date.now()}`, columnKey: "review" },
  });
  await page.addInitScript((id) => { try { localStorage.setItem("loom.projectId", id); } catch { /* storage blocked */ } }, seeded.projectId);

  // The session page, with its real terminal attached.
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "THEME-SWITCH-593674a7" })).toBeVisible();
  const viewport = page.locator(".xterm-viewport").first();
  const termBg = () => viewport.evaluate((el) => getComputedStyle(el).backgroundColor).then(parseRgb);

  // xterm writes `theme.background` onto its viewport, so this IS term.options.theme.background.
  const darkWell = await rgbOf(page, "--loom-term-bg");
  expect(close(await termBg(), darkWell), "dark: the xterm background is --loom-term-bg").toBe(true);
  await shoot(page, "session-dark.png");

  // Switch theme from Settings and come back: the SAME token now resolves to the light page's well.
  await page.goto(loomDaemon.baseURL + "/settings");
  await pickTheme(page, "Light");
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "THEME-SWITCH-593674a7" })).toBeVisible();
  expect((await themeOf(page)).attr).toBe("light");
  const lightWell = await rgbOf(page, "--loom-term-bg");
  expect(close(lightWell, darkWell), "the light page's well is lifted, not identical").toBe(false);
  await expect.poll(async () => close(await termBg(), lightWell), { message: "light: the xterm background is --loom-term-bg" }).toBe(true);
  expect(luminance(await termBg()), "the terminal stays a DARK well on the light page").toBeLessThan(0.05);
  expect(luminance(await pageBg(page))).toBeGreaterThan(0.8);
  await shoot(page, "session-light.png");

  // LIVE re-theme of an open terminal: flip the preference from another tab while this one stays put.
  // The pane must follow without being re-created (re-creating would drop the pty attach).
  const settings = await page.context().newPage();
  await settings.goto(loomDaemon.baseURL + "/settings");
  await pickTheme(settings, "Dark");
  await settings.close();
  await expect.poll(async () => close(await termBg(), darkWell), { message: "the open terminal re-themed live" }).toBe(true);
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "THEME-SWITCH-593674a7" })).toBeVisible();
  await shoot(page, "session-dark-after-live-switch.png");

  // Overview and the board, in light.
  await page.goto(loomDaemon.baseURL + "/settings");
  await pickTheme(page, "Light");
  for (const [route, name] of [["/overview", "overview"], ["/board", "board"]] as const) {
    await page.goto(loomDaemon.baseURL + route);
    expect((await themeOf(page)).attr).toBe("light");
    await expect(page.getByText(seeded.taskTitle!, { exact: true }).first()).toBeVisible();
    expect(luminance(await pageBg(page))).toBeGreaterThan(0.8);
    await shoot(page, `${name}-light.png`);
  }
  await pickThemeVia(page, loomDaemon.baseURL, "Dark");
  for (const [route, name] of [["/overview", "overview"], ["/board", "board"]] as const) {
    await page.goto(loomDaemon.baseURL + route);
    await expect(page.getByText(seeded.taskTitle!, { exact: true }).first()).toBeVisible();
    await shoot(page, `${name}-dark.png`);
  }
});

async function pickThemeVia(page: Page, baseURL: string, label: "System" | "Light" | "Dark") {
  await page.goto(baseURL + "/settings");
  await pickTheme(page, label);
}

// Inbox attachment TEXT VIEWER e2e (card c7f999f4). The owner's ask: "Open" on a text or markdown
// attachment must show it in a large in-app dialog, never download it. Drives the real inbox against the
// isolated fixture daemon (no real claude):
//   1. A .md attachment's Open shows the viewer with the markdown RENDERED (a real <h1>, a real list).
//   2. Untrusted markdown is inert: no <script> and no on* handler reaches the DOM, nothing executes, a
//      `javascript:` link is not a link, an external image is not fetched, external links carry noopener.
//   3. A .txt attachment shows as monospace, wrapped, with markup shown as literal text.
//   4. Esc closes ONLY the viewer (the Request dialog stays); a backdrop click closes it too; Tab stays inside.
//   5. NO download event fires for any of the above. The in-dialog Download still downloads.
//   6. An image attachment's Open is unchanged: a new-tab link, no viewer.
// Every locator is scoped to THIS spec's seeded request, so a sibling spec's row on the shared worker
// daemon can never satisfy an assertion.
import type { Download } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAAKElEQVR4nGPQe5aHH3Fx8+BH+LUzjFowasGoBaMWjFowasGoBcRYAAD2QpXDu2UFvQAAAABJRU5ErkJggg==";

const NOTES_MD = [
  "# Viewer heading sentinel",
  "",
  "Some **bold** prose and a [safe link](https://example.com/docs).",
  "",
  "- first item",
  "- second item",
  "",
  "[bad link](javascript:window.__pwned='link')",
  "",
  "<script>window.__pwned = 'script';</script>",
  "",
  "<img src=\"x\" onerror=\"window.__pwned = 'onerror'\">",
  "",
  "<iframe src=\"https://example.com\"></iframe>",
  "",
  "![remote beacon](https://example.com/beacon.png)",
  "",
].join("\n");

const LOG_TXT = "line one of the log sentinel\n<b>not bold</b>\n" + "x".repeat(600) + "\nlast line\n";

test.describe("inbox attachment text viewer (card c7f999f4)", () => {
  test("markdown renders inert in a large dialog, text shows wrapped, nothing downloads, image Open unchanged", async ({ page, loomDaemon }) => {
    const downloads: Download[] = [];
    page.on("download", (d) => downloads.push(d));

    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ViewerMgr" });
    const title = uniq("viewer-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Notes and a log are attached.", options: ["ok", "not ok"],
      attachments: [
        { label: "notes.md", content: NOTES_MD },
        { label: "run.log.txt", content: LOG_TXT },
        { label: "shot.png", contentBase64: PNG, imageDimensions: { width: 32, height: 20 } },
      ],
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const row = page.locator("main").getByTestId("request-row").filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("attachment-count-chip")).toHaveText(/1 image · 1 md · 1 text/);
    await row.getByRole("button", { name: "Answer →" }).click();

    const req = page.getByRole("dialog").filter({ hasText: title });
    await expect(req.getByText(title)).toBeVisible();
    const rows = req.getByTestId("attachment-row");
    await expect(rows).toHaveCount(3);
    const viewer = page.getByTestId("attachment-viewer");

    // ── (1) + (2) markdown ────────────────────────────────────────────────────────────────────────────
    const mdRow = rows.filter({ hasText: "notes.md" });
    await expect(mdRow.getByTestId("attachment-state")).toHaveText("new");
    const mdOpen = mdRow.getByTestId("attachment-open");
    // Not a link any more — a button that opens a dialog in place.
    await expect(mdOpen).toHaveAttribute("aria-haspopup", "dialog");
    await mdOpen.click();
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute("data-viewer-kind", "markdown");
    await expect(viewer.getByRole("heading", { level: 2, name: "notes.md" })).toBeVisible();
    // Rendered, not raw source: a real <h1> and a real list.
    await expect(viewer.locator("h1", { hasText: "Viewer heading sentinel" })).toBeVisible();
    await expect(viewer.locator("li")).toHaveText(["first item", "second item"]);
    await expect(viewer.locator("strong", { hasText: "bold" })).toBeVisible();
    // Large: most of the viewport.
    const box = await viewer.boundingBox();
    const vp = page.viewportSize();
    expect(box && vp && box.height >= vp.height * 0.8).toBeTruthy();

    // Inert: no executable markup in the DOM, and nothing ran.
    await expect(viewer.locator("script")).toHaveCount(0);
    await expect(viewer.locator("iframe")).toHaveCount(0);
    expect(await viewer.evaluate((el) => Array.from(el.querySelectorAll("*")).some((n) =>
      Array.from(n.attributes).some((a) => a.name.toLowerCase().startsWith("on"))))).toBe(false);
    await expect(viewer.locator('a[href^="javascript:" i]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
    // External image: a labelled placeholder, never an <img> pointing off-host.
    await expect(viewer.locator("img")).toHaveCount(0);
    await expect(viewer.getByText(/image not loaded · remote beacon/)).toBeVisible();
    // External link opens safely.
    const safe = viewer.getByRole("link", { name: "safe link" });
    await expect(safe).toHaveAttribute("target", "_blank");
    await expect(safe).toHaveAttribute("rel", /noopener/);

    // ── (4) Tab stays inside, Esc closes ONLY the viewer ────────────────────────────────────────────────
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(req.getByText(title)).toBeVisible();
    // Open stamped openedAt, exactly like the new-tab Open does.
    await expect(mdRow.getByTestId("attachment-state")).toHaveText(/^opened/);

    // ── (3) plain text ───────────────────────────────────────────────────────────────────────────────
    const txtRow = rows.filter({ hasText: "run.log.txt" });
    await txtRow.getByTestId("attachment-open").click();
    await expect(viewer).toHaveAttribute("data-viewer-kind", "text");
    const pre = viewer.getByTestId("attachment-viewer-text");
    await expect(pre).toContainText("line one of the log sentinel");
    await expect(pre).toContainText("<b>not bold</b>"); // markup is literal text
    await expect(pre.locator("b")).toHaveCount(0);
    await expect(pre).toHaveCSS("white-space", "pre-wrap");
    // Wrapped: the 600-char line does not push the block wider than the viewer.
    const sizes = await pre.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);

    // Backdrop click closes it (a real positioned mouse click on the overlay, outside the panel).
    await page.getByTestId("attachment-viewer-backdrop").click({ position: { x: 4, y: 4 } });
    await expect(viewer).toHaveCount(0);
    await expect(req.getByText(title)).toBeVisible();

    // ── (5) nothing above downloaded anything. The positive control is the in-dialog Download at the end,
    // observed through this SAME collector — so this zero is a measured zero, not a dead listener. ───────
    expect(downloads.map((d) => d.suggestedFilename())).toEqual([]);

    // ── (6) the image's Open is unchanged: a new-tab link, and no viewer ───────────────────────────────
    const imgOpen = rows.filter({ hasText: "shot.png" }).getByTestId("attachment-open");
    await expect(imgOpen).toHaveAttribute("target", "_blank");
    await expect(imgOpen).toHaveAttribute("rel", /noopener/);
    const [popup] = await Promise.all([page.context().waitForEvent("page"), imgOpen.click()]);
    await popup.close();
    await expect(viewer).toHaveCount(0);

    // The in-dialog Download keeps the old behaviour reachable — and it is the ONLY download.
    await txtRow.getByTestId("attachment-open").click();
    await expect(viewer).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent("download"), viewer.getByTestId("attachment-viewer-download").click()]);
    expect(dl.suggestedFilename()).toBe("run.log.txt");
    expect(downloads).toHaveLength(1);
  });
});

// Inbox ATTACHMENT MANIFEST e2e (epic 7d1d66ab, card 19b7cf7a — Direction B "Manifest", the owner's pick
// on request 0bbf7d1b). Drives the real thing end-to-end against the isolated daemon with NO real claude:
//   1. The COLLAPSED row carries a typed count chip ("2 image · 2 html" + ✕1), on ONE line.
//   2. The OPENED detail renders one manifest row per file, including the UNAVAILABLE one — struck
//      through, action disabled, never dropped.
//   3. SELECTING a row changes the single preview pane (before/after, both the mode and the named file).
//   4. The HTML preview iframe's `sandbox` is EXACTLY "allow-scripts" — never `allow-same-origin`.
//   5. `Open ↗` flips that row's STATE from NEW to OPENED and decrements the chip's unopened count.
//
// Seeding: `loomDaemon.seedQuestion({ attachments })` writes REAL BYTES into the same per-question store
// dir the serving route streams from, so `available` is derived by the daemon's own live existsSync — an
// attachment seeded here is genuinely servable, and the UNAVAILABLE row is a record with no file behind it
// (the GC'd case, card 6f27469b), not a hand-set flag. Every assertion names the fixture's own labels, so
// a silent fallback to some other request's data on the shared worker daemon fails loudly.
import { expect, test } from "./fixtures/daemon";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// 32×20 true-colour PNGs (97 bytes each), generated with node's own zlib — real decodable image bytes, so
// the pane renders an actual <img> rather than a broken-image glyph, at a size that keeps this file small.
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAAKElEQVR4nGPQe5aHH3Fx8+BH+LUzjFowasGoBaMWjFowasGoBcRYAAD2QpXDu2UFvQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAAKElEQVR4nGOIPvEfP+Li5sGP8GtnGLVg1IJRC0YtGLVg1IJRC4ixAAD7v5xSlu826AAAAABJRU5ErkJggg==";
const HTML_MOCKUP = (name: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1><script>document.title = "${name} (scripted)";</script></body></html>`;

test.describe("inbox attachment manifest (card 19b7cf7a)", () => {
  test("the collapsed chip, the manifest, row selection, the sandboxed iframe, and the NEW → OPENED flip", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AttachMgr" });
    const title = uniq("attachments-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Both mockups are interactive. One source was reaped before this was filed.",
      options: ["Direction A", "Direction B"],
      attachments: [
        { label: "gate-strip-A.png", contentBase64: PNG_A, imageDimensions: { width: 1440, height: 420 } },
        { label: "gate-strip-B.png", contentBase64: PNG_B, imageDimensions: { width: 1440, height: 420 } },
        { label: "direction-a-contact-sheet.html", content: HTML_MOCKUP("direction-a-contact-sheet") },
        { label: "direction-b-manifest.html", content: HTML_MOCKUP("direction-b-manifest") },
        // No bytes at all ⇒ a record with no file behind it: the UNAVAILABLE row.
        { label: "raw-gate-log.png", kind: "image", sizeBytes: 61_000 },
      ],
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    // FIXTURE IDENTITY first: everything below is scoped to THIS seeded row, so a silent fallback to a
    // sibling spec's request on the shared daemon can never pass as a green.
    const row = main.getByTestId("request-row").filter({ hasText: title });
    await expect(row).toHaveCount(1);

    // (1) The collapsed row's typed count chip — kinds in the helper's fixed order, the unavailable one
    // counted apart (✕1) rather than folded into a kind tally.
    const chip = row.getByTestId("attachment-count-chip").first();
    await expect(chip).toHaveText(/2 image · 2 html/);
    await expect(chip).toHaveText(/✕1/);
    await expect(chip).toHaveAttribute("title", /4 not yet opened/);
    await expect(chip).toHaveAttribute("title", /1 unavailable/);

    // Open the detail modal in place (the same opener every in-app affordance funnels through).
    await row.getByRole("button", { name: "Answer →" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(title)).toBeVisible();

    // (2) One manifest row per file — all five, including the unavailable one.
    await expect(dialog.getByText("Attached · 5")).toBeVisible();
    await expect(dialog.getByText("4 unopened")).toBeVisible();
    await expect(dialog.getByText("1 unavailable")).toBeVisible();
    const rows = dialog.getByTestId("attachment-row");
    await expect(rows).toHaveCount(5);

    // The unavailable row KEEPS its place: struck through, state UNAVAILABLE, action disabled.
    const goneRow = rows.filter({ hasText: "raw-gate-log.png" });
    await expect(goneRow).toHaveCount(1);
    await expect(goneRow.getByText("raw-gate-log.png")).toHaveCSS("text-decoration-line", "line-through");
    await expect(goneRow.getByTestId("attachment-state")).toHaveText("unavailable");
    await expect(goneRow.getByTestId("attachment-open")).toBeDisabled();

    // (3) BEFORE — the pane opens on the first AVAILABLE attachment, rendering a real image.
    const pane = dialog.getByTestId("attachment-preview");
    await expect(pane).toHaveAttribute("data-preview-mode", "image");
    await expect(pane).toContainText("gate-strip-A.png");
    await expect(pane).toContainText("1440×420");
    await expect(pane.locator("img")).toBeVisible();
    await expect(dialog.getByTestId("attachment-preview-frame")).toHaveCount(0);

    // (3) AFTER — selecting the html row changes the SAME single pane (mode and named file both move).
    const htmlRow = rows.filter({ hasText: "direction-b-manifest.html" });
    await htmlRow.locator("button").first().click();
    await expect(pane).toHaveAttribute("data-preview-mode", "html");
    await expect(pane).toContainText("direction-b-manifest.html");
    await expect(pane).not.toContainText("gate-strip-A.png");
    // Still exactly ONE pane, however many files are attached — that is the direction's own property.
    await expect(dialog.getByTestId("attachment-preview")).toHaveCount(1);

    // (4) The preview iframe is sandboxed, and `allow-same-origin` is NEVER among the tokens — an
    // agent-authored document must land in an opaque origin with no reach into this origin's localStorage,
    // where the loopback/gateway tokens live. Asserted as an EXACT attribute value, so a later edit that
    // "just adds one token" fails here rather than silently widening the sandbox.
    const frame = dialog.getByTestId("attachment-preview-frame");
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");

    // (5) NEW → OPENED. The row reads NEW before the click; `Open ↗` opens the real route in a new tab and
    // stamps openedAt, which is what flips the state. The popup is closed immediately — this asserts the
    // STATE FLIP, not whatever the new tab happens to render.
    await expect(htmlRow.getByTestId("attachment-state")).toHaveText("new");
    const openLink = htmlRow.getByTestId("attachment-open");
    await expect(openLink).toHaveAttribute("rel", /noopener/);
    await expect(openLink).toHaveAttribute("rel", /noreferrer/);
    const [popup] = await Promise.all([page.context().waitForEvent("page"), openLink.click()]);
    await popup.close();

    await expect(htmlRow.getByTestId("attachment-state")).toHaveText(/^opened/);
    // And the collapsed row's chip agrees — both surfaces read the SAME openedAt, so the unopened tally
    // drops with it (4 → 3) rather than the two views disagreeing about what has been looked at.
    await expect(chip).toHaveAttribute("title", /3 not yet opened/);
    await expect(dialog.getByText("3 unopened")).toBeVisible();
  });

  test("a request with no attachments renders no chip and no Attached panel", async ({ page, loomDaemon }) => {
    // The negative control for the whole feature: every surface above is additive, so a request without
    // files must be byte-identical to before this card. Without this, a chip that rendered unconditionally
    // (an empty "▨" shell, or an "Attached · 0" panel) would pass every assertion in the test above.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NoAttachMgr" });
    const title = uniq("bare-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "input",
      body: "no files on this one",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    const row = main.getByTestId("request-row").filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("attachment-count-chip")).toHaveCount(0);

    await row.getByRole("button", { name: "Answer →" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(title)).toBeVisible();
    await expect(dialog.getByTestId("attachment-row")).toHaveCount(0);
    await expect(dialog.getByTestId("attachment-preview")).toHaveCount(0);
    await expect(dialog.getByText(/^Attached · /)).toHaveCount(0);
    // ⛔ The answer control is untouched by this card (the owner's note: "answer options optional as
    // always, and the note field as before") — the input control's own answer box still mounts.
    await expect(dialog.getByPlaceholder("type your answer…")).toBeVisible();
  });
});

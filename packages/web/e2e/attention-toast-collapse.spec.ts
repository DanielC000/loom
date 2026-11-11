// Attention-toast collapse (card 0d27f20c). N pending Requests used to stack N persistent toasts over the
// bottom-right of EVERY page (occluding primary actions like /platform's template CTA and /inbox's answer
// buttons) and triple-announced state already shown by the sidebar badge + Mission Control queue + /inbox.
// This spec proves the fix end-to-end against the isolated daemon, with NO real claude:
//   1. On a page NOT already showing the queue (/platform), FOUR pending requests collapse to ONE compact
//      count pill — not four stacked toasts. No request toast renders its title/kind-label outside <main>.
//   2. The pill sits in the bottom-right corner and does NOT occlude the top launcher CTA (geometry check).
//   3. On Mission Control ("/") and /inbox — pages that already render the queue — the pill is suppressed,
//      and /inbox's "Answer →" buttons are fully visible.
//   4. Dismissing the pill survives client navigation (the container mounts once at the app root).
//   5. Clicking the pill body jumps to /inbox.
//
// Seeding (the no-real-claude invariant): a live manager is a `processState:"live"` DB row via POST
// /internal/test/seed (never startSession → no `[pty] spawn`), and each of the four typed requests is a
// seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion — the same writer question_ask uses).
import { expect, test } from "./fixtures/daemon";

test.describe("attention toast collapse (card 0d27f20c)", () => {
  test("N pending requests collapse to one count pill, suppressed on the queue pages, not occluding primary actions", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ToastMgr" });
    const stamp = Date.now();
    const titles = [
      `Rate-limit strategy ${stamp}`,
      `Name the release branch ${stamp}`,
      `OpenAI key needed ${stamp}`,
      `Approve force-push ${stamp}`,
    ];
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: titles[0], type: "decision", options: ["Keep warm", "Fail fast"] });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: titles[1], type: "input" });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: titles[2], type: "credential", credentialEnvVar: "MYAPP_OPENAI_KEY" });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: titles[3], type: "permission", permissionAction: "git push --force" });

    // (1) On /platform (NOT in the pill's suppression set) the four requests collapse to ONE count pill.
    await page.goto(`${loomDaemon.baseURL}/platform`);
    const pill = page.getByTestId("request-count-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/4\s*requests need you/);

    // Regression witness: NO per-request toast stacks. Pre-fix, four toasts rendered their kind label
    // ("Decision needed" / "Input needed" / "Secret needed" / "Permission needed", sentence case since
    // Graphite card 542f642f) and their title text in the bottom-right overlay. Post-fix none render — the
    // pill carries only a count, no title/kind label. The pattern is the exact rendered label, anchored,
    // so it cannot pass vacuously on a casing change: step (3) below proves the same label renders.
    await expect(page.getByText(/^(Decision|Input|Secret|Permission) needed$/)).toHaveCount(0);
    for (const t of titles) await expect(page.getByText(t)).toHaveCount(0);

    // (2) The primary CTA is fully visible and sits clearly ABOVE the corner pill (no occlusion).
    const cta = page.getByRole("button", { name: "Start guided setup →" });
    await expect(cta).toBeVisible();
    const ctaBox = await cta.boundingBox();
    const pillBox = await pill.boundingBox();
    expect(ctaBox).not.toBeNull();
    expect(pillBox).not.toBeNull();
    // The CTA's bottom edge is above the pill's top edge → the two rectangles do not overlap vertically.
    expect(ctaBox!.y + ctaBox!.height).toBeLessThan(pillBox!.y);

    // (3) Suppressed on the Workspace node ("/" lands there since card acbb6df6 deleted Mission Control) and
    //     /inbox — those pages already render the queue.
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.getByTestId("request-count-pill")).toHaveCount(0);
    // The queue itself is present on the page (the pill's job is done by the page). Any of the four kinds:
    // the Needs-you band is height-fitted, so WHICH of them make the cut is the band's choice, not this spec's.
    await expect(page.getByTestId("atlas-band-needs")
      .getByText(/^(Decision|Input|Secret|Permission) needed$/).first()).toBeVisible();

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await expect(page.getByTestId("request-count-pill")).toHaveCount(0);
    // The primary action on each inbox row is fully visible (no overlay here at all).
    await expect(page.locator("main").getByRole("button", { name: "Answer →" }).first()).toBeVisible();

    // (4) Dismiss survives CLIENT navigation: dismiss on /platform, then navigate via the tree's
    // React-Router link (NOT page.goto, which is a hard browser reload) — the pill stays gone. ToastContainer
    // mounts ONCE at the app root outside <Routes>, so its dismissedAtCount state only survives a route change
    // that stays within the SPA; a page.goto here would remount the whole app (dismissedAtCount resets to 0)
    // and made this assertion an outright race against the openQuestions poll, flaky in-suite under shared-
    // daemon load (card ba6522e1) even though it happened to pass standalone on a fast local daemon.
    await page.goto(`${loomDaemon.baseURL}/platform`);
    await expect(pill).toBeVisible();
    await pill.getByRole("button", { name: "dismiss" }).click();
    await expect(page.getByTestId("request-count-pill")).toHaveCount(0);
    // The Atlas tree's own Terminals row (the classic rail's Memory link went with that shell, card
    // acbb6df6) — any in-app link to a page outside the pill's suppression set proves the same thing.
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: /^Terminals/ }).click();
    await expect(page).toHaveURL(/\/workspace-terminals$/);
    await expect(page.getByTestId("request-count-pill")).toHaveCount(0);

    // (5) A fresh load resets the in-memory dismiss; clicking the pill body jumps to /inbox.
    await page.goto(`${loomDaemon.baseURL}/platform`);
    await page.reload();
    const pill2 = page.getByTestId("request-count-pill");
    await expect(pill2).toBeVisible();
    await pill2.click();
    // The Inbox is the Workspace node's `inbox` tab (card 41eab0eb), so `/inbox` lands there.
    await expect(page).toHaveURL(/\/home\?tab=inbox$/);
  });
});

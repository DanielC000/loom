// Request answer-draft guard e2e (card 544960ed — owner report: "the request dialog that opens on Answer
// can be closed by one click outside it even when the user has already typed something, so a stray click
// loses the draft the user still wants to work on and send").
//
// The fix has two halves, and this spec is the regression witness for both:
//   • the GUARD — while the answer form holds unsent input, the two ACCIDENTAL close gestures (a backdrop
//     click, Escape) refuse to close and say why; the deliberate ✕ always closes.
//   • the RETENTION — the draft survives every close path, keyed by request id, and is cleared only by a
//     successful submit. A CREDENTIAL secret is the one deliberate exception: its value is never retained
//     (see docs/decisions/544960ed-request-answer-draft-retention.md), only the fact that one is typed, so
//     the guard still protects it from the stray click.
// A clean form must keep closing exactly as it did before — the first test below is that control, since a
// guard that fired unconditionally would pass every other assertion here.
//
// Seeding (the no-real-claude invariant): a live manager is a `processState:"live"` DB row via the seed
// endpoint, and each pending Request is a seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion,
// the same writer question_ask uses). Every interaction below is a real click/keystroke; no `[pty] spawn`.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";

type Kind = "decision" | "input" | "permission" | "credential";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// The inbox row's action label is PER-TYPE (src/lib/questions › requestActionLabel) — a permission row
// says "Review →" and a credential row "Provide →", so this can't be one hard-coded string.
const ACTION_LABEL: Record<Kind, string> = {
  decision: "Answer →", input: "Answer →", permission: "Review →", credential: "Provide →",
};

// The backdrop is the `role="dialog"` element itself; the inner panel stops propagation. Its top-left
// corner is always backdrop (the panel starts 6vh down and is centred), and is clear of the toast stack
// in the opposite corner.
const clickBackdrop = (dialog: Locator) => dialog.click({ position: { x: 5, y: 5 } });

// Open the seeded Request from the global inbox — the same affordance the owner clicked.
//
// ⭐ This deliberately does NOT navigate, so a REOPEN is a plain SPA click on the page we're already on.
// Drafts are in-memory by design (see src/lib/requestDrafts.ts), so a full `page.goto` reload legitimately
// drops them — and a reload is not the stray click this card is about. An earlier draft of this spec
// re-navigated on every open and therefore measured the reload instead of the feature: every retention
// assertion failed against a correct implementation. Navigate once per test, with gotoInbox.
async function openFromInbox(page: Page, kind: Kind): Promise<Locator> {
  await page.locator("main").getByRole("button", { name: ACTION_LABEL[kind] }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const gotoInbox = (page: Page, baseURL: string) => page.goto(`${baseURL}/inbox`);

test.describe("the Request answer dialog keeps a typed draft (card 544960ed)", () => {
  test("CONTROL — a CLEAN form still closes on a backdrop click and on Escape", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "CleanFormMgr" });
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("clean-form-decision"),
      type: "decision", body: "Nothing typed — this dialog must still close.", options: ["Ship", "Hold"],
    });
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "decision");
    await clickBackdrop(dialog);
    await expect(dialog).toHaveCount(0);

    const reopened = await openFromInbox(page, "decision");
    await page.keyboard.press("Escape");
    await expect(reopened).toHaveCount(0);
  });

  test("decision — a typed note survives the backdrop + Escape, is restored after ✕, and clears on submit", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DraftDecMgr" });
    const title = uniq("draft-decision");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Ship the release now, or hold for the audit?", options: ["Ship", "Hold"],
    });
    const draft = "hold it — the audit lands tomorrow and I want its result first";
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "decision");
    const note = dialog.locator("textarea");
    await note.fill(draft);

    // BEFORE the fix this click destroyed the dialog and the draft with it. Now: still open, text intact,
    // and the refusal names the ✕ as the way out.
    await clickBackdrop(dialog);
    await expect(dialog).toBeVisible();
    await expect(note).toHaveValue(draft);
    await expect(dialog.getByTestId("request-close-refused")).toHaveText("Draft kept — ✕ to close");

    // Escape is the other accidental gesture and is refused the same way.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(note).toHaveValue(draft);

    // The deliberate ✕ DOES close — and the draft outlives it, restored on reopen.
    await dialog.getByRole("button", { name: "✕" }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openFromInbox(page, "decision");
    await expect(reopened.getByText(title)).toBeVisible();
    await expect(reopened.locator("textarea")).toHaveValue(draft);

    // A successful submit retires the draft: the recorded readout replaces the form, and the dialog is
    // freely closable again (nothing unsent is being held).
    await reopened.getByRole("button", { name: "Submit answer" }).click();
    await expect(reopened.getByText("ANSWERED", { exact: true })).toBeVisible();
    await clickBackdrop(reopened);
    await expect(reopened).toHaveCount(0);
  });

  test("decision — a picked option with no text also counts as unsent input", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DraftPickMgr" });
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("draft-pick"), type: "decision",
      body: "Pick one — then try to click away.", options: ["Keep workers warm", "Fail fast"],
    });
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "decision");
    await dialog.getByText("Keep workers warm").click();
    await clickBackdrop(dialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("request-close-refused")).toBeVisible();

    // And the pick itself is restored after an explicit close — the Submit button stays enabled on reopen,
    // which it only is while a choice or a note is held.
    await dialog.getByRole("button", { name: "✕" }).click();
    const reopened = await openFromInbox(page, "decision");
    await expect(reopened.getByRole("button", { name: "Submit answer" })).toBeEnabled();
  });

  test("input — the typed answer blocks both accidental closes and is restored on reopen", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DraftInputMgr" });
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("draft-input"), type: "input",
      body: "Which hostname should the gateway bind?",
    });
    const draft = "bind it to 127.0.0.1 only";
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "input");
    await dialog.locator("textarea").fill(draft);

    await clickBackdrop(dialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea")).toHaveValue(draft);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "✕" }).click();
    const reopened = await openFromInbox(page, "input");
    await expect(reopened.locator("textarea")).toHaveValue(draft);
  });

  test("permission — a note blocks the backdrop, and so does moving the scope off the asker's default", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DraftPermMgr" });
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("draft-permission"), type: "permission",
      body: "Authorize the push to origin?", permissionAction: "git push origin main", permissionScopeHint: "once",
    });
    const draft = "only this once, and tell me what landed";
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "permission");
    await dialog.locator("textarea").fill(draft);
    await clickBackdrop(dialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea")).toHaveValue(draft);

    await dialog.getByRole("button", { name: "✕" }).click();
    const reopened = await openFromInbox(page, "permission");
    await expect(reopened.locator("textarea")).toHaveValue(draft);

    // Clearing the note by hand retires the draft — the guard releases rather than latching on once-dirty.
    await reopened.locator("textarea").fill("");
    await clickBackdrop(reopened);
    await expect(reopened).toHaveCount(0);

    // A scope the human moved off the seeded "once" hint is unsent input too, with no text typed at all.
    const third = await openFromInbox(page, "permission");
    await third.getByText("standing", { exact: true }).click();
    await clickBackdrop(third);
    await expect(third).toBeVisible();
    await expect(third.getByTestId("request-close-refused")).toHaveText("Draft kept — ✕ to close");
  });

  test("a request answered OUT OF BAND retires its draft — the reopened dialog closes freely", async ({ page, loomDaemon }) => {
    // The guard's one way to strand a dialog: the draft is retired by the answer MUTATION, but a request
    // can stop being answerable without that mutation ever running — the owner answers it in chat
    // (question_resolve), from another tab, or a manager cancels it. The control then stops mounting, so
    // nothing clears the store, and the reopened dialog would refuse its own backdrop/Escape close over a
    // draft that can never be sent — with the answered READOUT on screen and no form to explain why.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "OutOfBandMgr" });
    const title = uniq("draft-out-of-band");
    const id = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Resolved elsewhere while a draft was held here.", options: ["Ship", "Hold"],
    });
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "decision");
    await dialog.locator("textarea").fill("a draft that is about to become unsendable");
    await dialog.getByRole("button", { name: "✕" }).click();
    await expect(dialog).toHaveCount(0);

    // Answer it OUT OF BAND: the REAL human-only REST answer route, never this dialog. (The fixture's
    // global fetch patch supplies the loopback auth header for a non-GET to the daemon.)
    const res = await fetch(`${loomDaemon.baseURL}/api/questions/${id}/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "answered in chat, not in the dialog" }),
    });
    expect(res.ok).toBeTruthy();

    // The row leaves the pending section and reopens as a read-only readout via "View".
    //
    // ⭐ Narrow the inbox to THIS test's own project first. The loomDaemon fixture is worker-scoped, so
    // every EARLIER test's seeded request has been answered by the autoIsolation cleanup and is sitting
    // here with its own "View" button — a bare `.first()` clicks a SIBLING TEST'S row, which holds no
    // draft, closes freely, and passes vacuously against unfixed code. (It did exactly that: this test
    // went green in its first RED run.) seedLiveSession mints a fresh project per call, so the inbox's
    // own per-project facet chip leaves exactly one row, with no DOM-ancestor archaeology to go stale.
    await page.locator("main").getByRole("button", { name: new RegExp(mgr.projectName) }).click();
    const view = page.locator("main").getByRole("button", { name: "View" });
    await expect(view).toBeVisible({ timeout: 10_000 });
    await view.click();
    const reopened = page.getByRole("dialog");
    await expect(reopened).toBeVisible();
    // Identity, for the same reason: prove the dialog is THIS request before trusting what it does next.
    await expect(reopened.getByText(title)).toBeVisible();
    await expect(reopened.getByText("Answered · waiting on manager pickup")).toBeVisible();

    // The stranded-dirty-flag regression: both accidental gestures must close it again.
    await page.keyboard.press("Escape");
    await expect(reopened).toHaveCount(0);
    await view.click();
    const third = page.getByRole("dialog");
    await expect(third).toBeVisible();
    await expect(third.getByText(title)).toBeVisible();
    await clickBackdrop(third);
    await expect(third).toHaveCount(0);
  });

  test("credential — a typed secret blocks the backdrop, and its VALUE is never retained across a close", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DraftCredMgr" });
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("draft-credential"), type: "credential",
      body: "The deploy needs the registry token.", credentialEnvVar: "REGISTRY_TOKEN",
    });
    await gotoInbox(page, loomDaemon.baseURL);

    const dialog = await openFromInbox(page, "credential");
    const secret = dialog.locator('input[type="password"]');
    await secret.fill("not-a-real-token-0123456789");

    // The guard protects the secret from the stray click exactly like a draft — but the copy tells the
    // truth about what ✕ will do, instead of promising a draft that is about to be discarded.
    await clickBackdrop(dialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("request-close-refused")).toHaveText("Secret not kept — ✕ discards it");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    // ✕ discards it: the reopened form is EMPTY (no value was ever stored), and — the stale-flag
    // regression — the now-clean form closes on the backdrop again rather than staying stuck open.
    await dialog.getByRole("button", { name: "✕" }).click();
    const reopened = await openFromInbox(page, "credential");
    await expect(reopened.locator('input[type="password"]')).toHaveValue("");
    await clickBackdrop(reopened);
    await expect(reopened).toHaveCount(0);
  });
});

// Composer preset INSERT — the "Spark" popover (Direction 2, owner-picked 2026-07-07). Presets moved off
// the terminal card and into the composer: the bottom-right sparkle trigger opens a full-bleed overlay of
// the textarea, and clicking a preset INSERTS its prompt into the box for review/edit — it must NOT fire
// at the agent (the old api.sendInput-on-click send path is gone). This drives the REAL composer and
// asserts the OBSERVABLE before/after of an insert: box empty + Send disabled → click a preset → box holds
// the prompt + Send enabled + popover closed (and the text is NOT cleared, i.e. nothing was sent).
//
// Hermetic, same recipe as terminal-composer-queued-caption.spec: seed the reserved Platform "Operator
// session" as a canned-pty tile, seed one global preset via the REST CRUD, then interact through the UI.
import { expect, test } from "./fixtures/daemon";

test("clicking a preset INSERTS its prompt into the composer (Send enables, popover closes) — it does not send", async ({ page, loomDaemon }) => {
  // Seed ONE global preset via the same CRUD the popover manages. Distinct sentinel text so the textarea
  // assertion is unambiguous.
  const LABEL = "E2E · run the suite";
  const PROMPT = "E2E-INSERTED-PROMPT: run the full test suite and report failures with file:line.";
  const created = await (await fetch(`${loomDaemon.baseURL}/api/preset-prompts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, prompt: PROMPT }),
  })).json();
  expect(created.id, "the preset should be created").toBeTruthy();

  // Resolve the reserved Platform home + its operator agent exactly as the PlatformView end-user edition does.
  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();

  // Production-like 120×40 grid so the terminal hugs its grid and the composer sits flush + stable.
  await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: "LOOM-PRESET-INSERT\r\nopen the sparkle and insert a preset\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(700); // let the height-budget measure + font scale settle before interacting

  const box = page.getByPlaceholder("Send a turn to this session", { exact: false });
  const sendBtn = page.getByRole("button", { name: "Send turn" });
  await expect(box).toBeVisible();

  // BEFORE: the box is empty and Send is disabled.
  await expect(box).toHaveValue("");
  await expect(sendBtn).toBeDisabled();

  // Open the Spark popover from the bottom-right sparkle trigger. `force` bypasses the actionability
  // "stable" check — the corner button is positioned over the terminal, whose font settle can jitter it a
  // sub-pixel (the queued-caption spec forces its Send click for the same reason).
  await page.getByRole("button", { name: "Preset prompts" }).first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Preset prompts" });
  await expect(dialog).toBeVisible();

  // Click the seeded preset row (its label). This INSERTS — it must not send.
  await dialog.getByText(LABEL, { exact: true }).click({ force: true });

  // AFTER: the prompt is in the box, Send is enabled, and the popover closed. The text is NOT cleared —
  // a send would have cleared it — so this proves the insert did not fire at the agent.
  await expect(box).toHaveValue(new RegExp("E2E-INSERTED-PROMPT"));
  await expect(sendBtn).toBeEnabled();
  await expect(dialog).toHaveCount(0);
});

// Gates page · override landings (card 87798130, owner pick B · Disclosure). A merge that landed
// interval-skipped over a red run_gate self-check carries the manager's `overrideReason` (card 4a95e9fc)
// and, since this card, the `redSelfCheckOpId` it overrode. The History row shows an amber `override`
// chip that is a real disclosure button; the panel says who wrote the reason, that Loom did not verify it,
// what it overrode (a jump to that red row) and that it never counts as a pass.
//
// Seeding follows gates.spec.ts: seeded worker sessions (never a real spawn) plus orchestration events
// written by the same appendEvent writer the daemon uses. Every absence assertion below is paired with the
// SAME locator hitting on the override row, so a broken locator can't pass as a clean absence.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const REASON = "The red is pty-prompt-mismatch.mjs timing out under host load.\nLanding ungated to unblock the batch.";
const RED_OP = "7f3a91c2-1111-4222-8333-944455556666";

async function seedOverrideFixture(loomDaemon: LoomDaemon) {
  const stamp = Date.now();
  const w = await loomDaemon.seedLiveSession({
    role: "worker", agentName: "Web Designer", branch: `loom/ovr-${stamp}`, task: { title: `ovr-${stamp}` },
  });
  // The red self-check first (older), then the override landing on the SAME branch (newest, top row).
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: w.sessionId, workerSessionId: w.sessionId, taskId: w.taskId,
    kind: "worker_gate", detail: { passed: false, durationMs: 2472000, failingTest: "pty-prompt-mismatch.mjs", opId: RED_OP },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: w.sessionId, workerSessionId: w.sessionId, taskId: w.taskId,
    kind: "build_gate",
    detail: { skipped: true, gateSpawned: false, skipReason: "gate-interval", overrideReason: REASON, redSelfCheckOpId: RED_OP, durationMs: 3000 },
  });
  // A plain interval skip with NO override, on its own branch: the row must stay unchanged.
  const plain = await loomDaemon.seedLiveSession({
    project: w.project, agentId: w.agentId, role: "worker", branch: `loom/plain-${stamp}`, task: { title: `plain-${stamp}` },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: plain.sessionId, workerSessionId: plain.sessionId, taskId: plain.taskId,
    kind: "build_gate", detail: { skipped: true, gateSpawned: false, skipReason: "gate-interval", durationMs: 2000 },
  });
  return { w, plainBranch: `loom/plain-${stamp}`, ovrBranch: `loom/ovr-${stamp}` };
}

async function openGates(page: Page, baseURL: string, projectName: string, theme?: "dark" | "light") {
  await page.goto(`${baseURL}/gates`);
  if (theme) {
    await page.evaluate((t) => localStorage.setItem("loom.theme", t), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  }
  await page.getByRole("button", { name: projectName, exact: true }).click();
}

test.describe("Gates page · override landings (card 87798130)", () => {
  test("the override chip discloses the detail panel by mouse and keyboard; a row without an override is unchanged", async ({ page, loomDaemon }) => {
    const { w, plainBranch, ovrBranch } = await seedOverrideFixture(loomDaemon);
    await openGates(page, loomDaemon.baseURL, w.projectName);

    // The landing row is the newest, so it sits ABOVE its red self-check: select it as the skipped row.
    const ovrRow = page.locator("tr", { hasText: ovrBranch }).filter({ hasText: "skipped" });
    const plainRow = page.locator("tr", { hasText: plainBranch });
    const chip = ovrRow.getByRole("button", { name: /override/ });
    await expect(chip).toBeVisible();
    // Fixture identity: the override row is the interval skip, the plain row the same shape minus the reason.
    await expect(ovrRow.getByText("no gate ran", { exact: true })).toBeVisible();
    await expect(plainRow.getByText("no gate ran", { exact: true })).toBeVisible();
    await expect(plainRow.getByRole("button", { name: /override/ })).toHaveCount(0);
    await expect(plainRow.getByText("override", { exact: true })).toHaveCount(0);
    await expect(ovrRow.getByText("override", { exact: true })).toHaveCount(1);

    // The Duration tooltip names the interval, never "proven inert" (the nonRunReason fix).
    const durCell = (row: typeof ovrRow) => row.locator("td").nth(5);
    await expect(durCell(plainRow)).toHaveAttribute("title", /merge-gate interval let this landing through ungated/);
    await expect(durCell(plainRow)).not.toHaveAttribute("title", /proven inert/);

    // The footer note explains the chip whenever an override row is loaded.
    await expect(page.getByTestId("override-note")).toContainText("Loom stores the text as written and does not check it");
    await expect(page.getByText(/or a landing the merge-gate interval let through ungated/)).toBeVisible();

    // Closed by default.
    const panel = page.getByTestId("override-panel");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);

    // Mouse: open.
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(chip).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
    // Reason verbatim, line break and all.
    const reasonText = await panel.locator("dd").first().innerText();
    expect(reasonText).toBe(`“${REASON}”`);
    await expect(panel).toContainText("Written by");
    await expect(panel).toContainText("The manager that confirmed this merge, as free text.");
    await expect(panel).toContainText("Verified");
    await expect(panel).toContainText("No. Loom stores the text exactly as written and does not check any claim in it.");
    await expect(panel).toContainText("What it overrode");
    await expect(panel).toContainText("Counts as");
    await expect(panel).toContainText("An ungated landing. Never a pass.");

    // The link to the red self-check (redSelfCheckOpId → that row) jumps to and focuses it.
    const jump = panel.getByRole("link", { name: /worker reject .*7f3a91c2/ });
    await expect(jump).toBeVisible();
    await jump.click();
    const redRow = page.locator(`tr[data-gate-op="${RED_OP}"]`);
    await expect(redRow).toContainText("pty-prompt-mismatch.mjs");
    await expect(redRow).toBeFocused();

    // Mouse: close.
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);

    // Keyboard: the chip is a real button, so Enter and Space toggle it.
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Space");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);
  });

  for (const theme of ["dark", "light"] as const) {
    for (const vp of [{ name: "1440", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      test(`the open panel stays inside the viewport (${theme}, ${vp.name})`, async ({ page, loomDaemon }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const { w, ovrBranch } = await seedOverrideFixture(loomDaemon);
        await openGates(page, loomDaemon.baseURL, w.projectName, theme);
        const chip = page.locator("tr", { hasText: ovrBranch }).filter({ hasText: "skipped" }).getByRole("button", { name: /override/ });
        await chip.scrollIntoViewIfNeeded();
        await chip.click();
        const panel = page.getByTestId("override-panel");
        await expect(panel).toBeVisible();
        await panel.scrollIntoViewIfNeeded();
        const box = (await panel.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      });
    }
  }
});

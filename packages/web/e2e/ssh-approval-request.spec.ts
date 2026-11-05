// The Requests dialog for an ssh_exec command hold (design record a3d5c7f4): a STANDING grant authorizes a
// command to run unattended repeatedly, so the daemon rejects one without an expiry and this dialog must not
// offer "no expiry" for it. An ordinary permission Request keeps the optional expiry (the control that proves
// the restriction is specific to the ssh hold, not a blanket change).
//
// Seeding (no-real-claude invariant): a live manager row + seeded pending Requests via loomDaemon.seedQuestion.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SSH_ACTION = 'ssh_exec connection=conn-e2e target=loom@10.0.0.9:22 pin=0123456789ab command="reboot"';

async function openOnlyRequest(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/inbox`);
  await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("an ssh command hold: standing needs an expiry (no 'no expiry' choice) and Authorize stays enabled once one is picked", async ({ page, loomDaemon }) => {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "SshHoldMgr" });
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("ssh-hold"), type: "permission",
    body: "A session asks to run `reboot`.", permissionAction: SSH_ACTION, permissionScopeHint: "once",
  });
  const dialog = await openOnlyRequest(page, loomDaemon.baseURL);
  const authorize = dialog.getByRole("button", { name: "Authorize" });
  const expiry = dialog.getByTestId("permission-expiry");

  // once: no expiry involved, Authorize is available
  await expect(authorize).toBeEnabled();
  // standing: the picker defaults to a real duration, offers no "no expiry" option, and Authorize is enabled
  await dialog.getByText("keep authorizing this class").click();
  await expect(expiry).toHaveValue("24h");
  await expect(expiry.locator("option", { hasText: "no expiry" })).toHaveCount(0);
  await expect(authorize).toBeEnabled();
});

test("CONTROL — an ordinary permission Request keeps the optional 'no expiry' choice", async ({ page, loomDaemon }) => {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "PlainPermMgr" });
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("plain-perm"), type: "permission",
    body: "Authorize the push to origin?", permissionAction: "git push origin main", permissionScopeHint: "once",
  });
  const dialog = await openOnlyRequest(page, loomDaemon.baseURL);
  await dialog.getByText("keep authorizing this class").click();
  const expiry = dialog.getByTestId("permission-expiry");
  await expect(expiry.locator("option", { hasText: "no expiry" })).toHaveCount(1);
  await expect(expiry).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Authorize" })).toBeEnabled();
});

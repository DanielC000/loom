// Pending-bindings queue + Review-&-grant flow (card 12dc7fc9, "Direction B") — end to end on the shared
// `loomDaemon` fixture. Proves the credential auto-provisioning binding UX:
//   1. A real pending binding is created the honest way — seed a credential Question carrying a
//      `provisionTarget` (connection + binding.profileId), then answer it via the human-only
//      POST /api/questions/:id/answer. That answer stores the secret, auto-provisions a Connection, and
//      records the binding as PENDING (never auto-applied).
//   2. Settings → "Pending bindings" renders that row (connection → profile, "by <agent>"), and the
//      Connections panel badges the connection "Auto-provisioned" + "Unbound".
//   3. "Review & grant" deep-links to the profile's connection allowlist with the connection PRE-SELECTED
//      (a pre-select banner + a "requested by <agent>" hint), but nothing is granted yet.
//   4. The grant is committed only by an explicit Save — an observable before/after: the profile's
//      allowlist is empty before, and contains the connection after (REST read-back).
//
// The binding stays the deliberate owner-only trust decision — the whole point of Direction B.
import { expect, test } from "./fixtures/daemon";

async function apiGet<T>(baseURL: string, url: string): Promise<T> {
  const res = await fetch(baseURL + url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function apiPost<T>(baseURL: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(baseURL + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test("pending binding surfaces in Settings, then Review & grant commits only on Save", async ({ page, loomDaemon }) => {
  const base = loomDaemon.baseURL;
  const ts = Date.now();

  // A live manager session (its agent is who "requested" the binding) + a worker profile to bind onto.
  const seeded = await loomDaemon.seedLiveSession({ role: "manager", agentName: `Billing Bot ${ts}` });
  const profile = await apiPost<{ id: string; name: string }>(base, "/api/profiles", {
    name: `Payments Worker ${ts}`, role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null,
  });

  const connName = `E2E Stripe ${ts}`;
  // Seed a credential Question with a provisioning target (connection + binding), then answer it the real
  // way. The answer boundary provisions the Connection + records the PENDING binding — never auto-applied.
  const seedRes = await apiPost<{ questionIds: string[] }>(base, "/internal/test/seed", {
    questions: [{
      sessionId: seeded.sessionId, projectId: seeded.projectId, type: "credential",
      title: `Need the ${connName} key`, body: "billing egress",
      provisionTarget: { connection: { name: connName, host: "api.stripe.com" }, binding: { profileId: profile.id } },
      state: "pending",
    }],
  });
  const questionId = seedRes.questionIds[0];
  await apiPost(base, `/api/questions/${questionId}/answer`, { secret: `sk_live_${ts}` });

  // The pending-binding read surface reflects it (also gives us the provisioned connection id).
  const bindings = await apiGet<{ questionId: string; connectionId: string; profileId: string }[]>(base, "/api/pending-bindings");
  const mine = bindings.find((b) => b.questionId === questionId);
  expect(mine, "the answered credential produced a pending binding").toBeTruthy();
  const connectionId = mine!.connectionId;

  // Before the grant: the profile's allowlist is EMPTY (nothing auto-applied).
  const before = await apiGet<{ connections?: string[] }>(base, `/api/profiles/${profile.id}`);
  expect(before.connections ?? []).not.toContain(connectionId);

  // --- Settings: the Pending bindings queue + the Connections badges ---
  await pinActiveProject(page, seeded.projectId);
  await page.goto(`${base}/settings`);

  await expect(page.getByText("Pending bindings", { exact: true }).first()).toBeVisible();
  const reviewBtn = page.getByRole("button", { name: "Review & grant" });
  await expect(reviewBtn).toBeVisible();
  // The row names who asked and the target profile.
  await expect(page.getByText(`by Billing Bot ${ts}`, { exact: false })).toBeVisible();
  await expect(page.getByText(`Payments Worker ${ts}`, { exact: false }).first()).toBeVisible();

  // The Connections panel badges the auto-provisioned, not-yet-bound connection. This connection is the
  // only auto-provisioned / api-key row on the daemon, so the first badge of each kind is ours.
  await expect(page.getByText("Auto-provisioned", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Unbound", { exact: true }).first()).toBeVisible();

  // --- Review & grant → the profile's allowlist, pre-selected ---
  await reviewBtn.click();
  await expect(page).toHaveURL(/\/actors\?tab=profiles&profile=.*&grant=/);

  // The pre-select banner + the "requested by" hint prove the deep-link landed and pre-selected — unsaved.
  await expect(page.getByText(/is pre-selected below/)).toBeVisible();
  await expect(page.getByText(`requested by Billing Bot ${ts}`, { exact: false })).toBeVisible();

  // Nothing has been granted yet — the allowlist is still empty at rest.
  const stillEmpty = await apiGet<{ connections?: string[] }>(base, `/api/profiles/${profile.id}`);
  expect(stillEmpty.connections ?? []).not.toContain(connectionId);

  // The deliberate Save is what commits the grant.
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Observable after-state: the profile's allowlist now contains the connection (REST read-back).
  await expect.poll(async () => {
    const after = await apiGet<{ connections?: string[] }>(base, `/api/profiles/${profile.id}`);
    return after.connections ?? [];
  }).toContain(connectionId);

  // Clean up the profile + connection so the shared daemon doesn't carry them into later specs.
  await fetch(`${base}/api/profiles/${profile.id}`, { method: "DELETE" });
  await fetch(`${base}/api/connections/${connectionId}`, { method: "DELETE" });
});

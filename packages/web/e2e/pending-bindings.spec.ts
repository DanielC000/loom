// Pending-bindings queue + Review-&-grant flow (card 12dc7fc9, "Direction B") — end to end on the shared
// `loomDaemon` fixture. Proves the credential auto-provisioning binding UX:
//   1. A real pending binding is created the honest way — seed a credential Question carrying a
//      `provisionTarget` (connection + binding.profileId), then answer it via the human-only
//      POST /api/questions/:id/answer. That answer stores the secret, auto-provisions a Connection, and
//      records the binding as PENDING (never auto-applied).
//   2. Settings → "Pending bindings" renders that row (connection → profile, "by <agent>"), and the
//      Connections panel badges the connection "Auto-provisioned" + "Unbound".
//   3. "Review & grant" opens an inline confirm naming the REQUESTING agent (card afe1bc90: the grant
//      is agent-level, never the whole profile); Cancel declines with nothing written.
//   4. The grant is committed only by the confirm's explicit Grant — an observable before/after: the
//      agent's allowlist is empty before, contains the connection after (REST read-back), and the
//      profile named in the ask gains nothing.
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
  const bindings = await apiGet<{ questionId: string; connectionId: string; profileId: string; agentId: string | null }[]>(base, "/api/pending-bindings");
  const mine = bindings.find((b) => b.questionId === questionId);
  expect(mine, "the answered credential produced a pending binding").toBeTruthy();
  const connectionId = mine!.connectionId;
  const agentId = mine!.agentId!;
  expect(agentId, "the pending binding names the REQUESTING agent (the grant target)").toBeTruthy();
  const agentConnections = async () =>
    (await apiGet<{ id: string; connections?: string[] }[]>(base, "/api/agents")).find((a) => a.id === agentId)?.connections ?? [];

  // Before the grant: the requesting AGENT's allowlist is EMPTY (nothing auto-applied).
  expect(await agentConnections()).not.toContain(connectionId);

  // --- Settings: the Pending bindings queue + the Connections badges ---
  await pinActiveProject(page, seeded.projectId);
  await page.goto(`${base}/home?tab=settings`);

  await expect(page.getByText("Pending bindings", { exact: true }).first()).toBeVisible();
  const reviewBtn = page.getByRole("button", { name: "Review & grant" });
  await expect(reviewBtn).toBeVisible();
  // The row names the REQUESTING agent (the grant target) and, as context, the profile named in the ask.
  await expect(page.getByTestId("settings-section-pending-bindings").getByText(`Billing Bot ${ts}`, { exact: true })).toBeVisible(); // scoped: the entity tree names the session too
  await expect(page.getByText(`profile Payments Worker ${ts}`, { exact: false }).first()).toBeVisible();

  // The Connections panel badges the auto-provisioned, not-yet-bound connection. This connection is the
  // only auto-provisioned / api-key row on the daemon, so the first badge of each kind is ours.
  await expect(page.getByText("Auto-provisioned", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Unbound", { exact: true }).first()).toBeVisible();

  // --- Review & grant → an inline confirm naming the REQUESTING agent; nothing written yet ---
  await reviewBtn.click();
  const confirm = page.getByTestId(`pending-binding-confirm-${questionId}`);
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`agent Billing Bot ${ts} only`);
  expect(await agentConnections(), "opening the confirm grants nothing").not.toContain(connectionId);

  // Cancel is a real decline: still nothing granted, the row stays queued.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(await agentConnections()).not.toContain(connectionId);

  // Card b1df40f2: the page's cached agent list is now STALE — another grant lands on the same agent
  // (agent REST) AFTER the page loaded. The panel grants through the server-side atomic add-one
  // (POST /api/agents/:id/connections), which appends to the agent's CURRENT list, so this second grant
  // must survive. The page must NOT fall back to the whole-list write (asserted below on the request).
  const otherConn = await apiPost<{ id: string }>(base, "/api/connections", { name: `E2E Other ${ts}`, host: "other.example.com", authScheme: "bearer", secret: `tok_${ts}` });
  await apiPost(base, `/api/agents/${agentId}`, { connections: [otherConn.id] });
  expect(await agentConnections()).toEqual([otherConn.id]);

  // The deliberate Grant is what commits it — to the agent, not the profile.
  await page.getByRole("button", { name: "Review & grant" }).click();
  const grantRequest = page.waitForRequest((r) => r.method() === "POST" && new RegExp(`/api/agents/${agentId}(/connections)?$`).test(new URL(r.url()).pathname));
  await page.getByTestId(`pending-binding-confirm-${questionId}`).getByRole("button", { name: "Grant", exact: true }).click();
  const sent = await grantRequest;
  expect(new URL(sent.url()).pathname, "the grant goes through the atomic add-one route, not the whole-list write").toBe(`/api/agents/${agentId}/connections`);
  expect(sent.postDataJSON()).toEqual({ connectionId });

  // Observable after-state: the AGENT's allowlist now contains the connection (REST read-back) …
  await expect.poll(agentConnections).toContain(connectionId);
  expect(await agentConnections(), "the grant added elsewhere after page load survives the add-one (no whole-list overwrite)").toContain(otherConn.id);
  // … and the row left the queue. (That the profile named in the ask gained nothing is asserted against the RAW
  // column in daemon/test/pending-bindings.mjs — the profile REST body has no grant key, so it cannot show it.)
  await expect.poll(async () => (await apiGet<{ questionId: string }[]>(base, "/api/pending-bindings")).some((b) => b.questionId === questionId)).toBe(false);

  // Clean up the profile + connection so the shared daemon doesn't carry them into later specs.
  await fetch(`${base}/api/profiles/${profile.id}`, { method: "DELETE" });
  await fetch(`${base}/api/connections/${connectionId}`, { method: "DELETE" });
  await fetch(`${base}/api/connections/${otherConn.id}`, { method: "DELETE" });
});

// Poll-jobs Settings UI spec (card 5a16377f) — proves the Poll Jobs panel (/settings) does full CRUD over
// the human-only /api/poll-jobs REST surface with an OBSERVABLE before/after for each new control:
//   1. Create — fill the form (connection + path + interval + spawn-agent target) → the row appears AND the
//      REST list carries the new job.
//   2. The 60s cadence floor — an interval below MIN_POLL_INTERVAL_MS (60s) disables the submit + shows a
//      warning (the client gate; the daemon re-enforces it).
//   3. Toggle enabled — Disable flips the row badge AND the REST row's `enabled` to false.
//   4. Delete — Confirm removes the row AND drops it from the REST list.
// Poll jobs are daemon-GLOBAL (not project-scoped), and the panel binds a Connection + a spawn/wake target,
// so the spec seeds a connection + an agent over REST first (no fixture helper exists for those). Builds on
// the shared `loomDaemon` fixture; settings.spec.ts is the template.
import { expect, test } from "./fixtures/daemon";

// Locate a form field's control by the EXACT text of its label <span> (same idiom as settings.spec.ts).
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

async function seedConnection(baseURL: string, name: string, host: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, host, authScheme: "api-key", secret: "e2e-secret" }),
  });
  if (!res.ok) throw new Error(`seed connection -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function seedAgent(baseURL: string, projectId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`seed agent -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function pollJobByPath(baseURL: string, path: string): Promise<{ id: string; enabled: boolean } | null> {
  const res = await fetch(`${baseURL}/api/poll-jobs`);
  const jobs = (await res.json()) as Array<{ id: string; path: string; enabled: boolean }>;
  return jobs.find((j) => j.path === path) ?? null;
}

test("create → floor-gate → toggle → delete a poll job end to end", async ({ page, loomDaemon }) => {
  const stamp = Date.now();
  const project = await loomDaemon.createProject(`poll-${stamp}`);
  const connName = `e2e-conn-${stamp}`;
  const connHost = `api.e2e-${stamp}.test`;
  await seedConnection(loomDaemon.baseURL, connName, connHost);
  const agentName = `e2e-poll-agent-${stamp}`;
  await seedAgent(loomDaemon.baseURL, project.id, agentName);
  const pollPath = `/e2e-poll-${stamp}`;

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // The Poll Jobs section renders (its data queries — poll-jobs + connections — resolved).
  await expect(page.getByText("Poll Jobs", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New poll job" }).click();

  // --- Fill the create form. Connection + agent selects are located by their (unique) option text so the
  // locator never depends on label whitespace; path + interval by their exact label span. ---
  const connOption = `${connName} (${connHost})`;
  await page.locator(`select:has(option:text-is(${JSON.stringify(connOption)}))`).selectOption({ label: connOption });
  await field(page, "Path").fill(pollPath);

  const interval = field(page, "Poll interval (seconds)");
  const createBtn = page.getByRole("button", { name: "Create poll job" });

  // BEFORE→AFTER (observable #2, the 60s floor): an interval below the floor disables submit + warns; 60 clears it.
  await interval.fill("30");
  await expect(page.getByText("Minimum 60s (the poll cadence floor).")).toBeVisible();
  await expect(createBtn).toBeDisabled();
  await interval.fill("60");
  await expect(page.getByText("Minimum 60s (the poll cadence floor).")).toHaveCount(0);

  // Mode defaults to "spawn" → a Target agent picker is shown. Select the seeded agent by its label.
  const agentLabel = `${project.name} / ${agentName}`;
  await page.locator(`select:has(option:text-is(${JSON.stringify(agentLabel)}))`).selectOption({ label: agentLabel });

  // BEFORE (observable #1): no poll job with this path exists yet.
  expect(await pollJobByPath(loomDaemon.baseURL, pollPath)).toBeNull();

  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  // AFTER (observable #1): the row appears in the panel AND the REST list carries it (enabled by default).
  // Scope to the poll-job row (the div holding the path chip + an Edit button) — the connection name also
  // appears up in the Connections list, so a global text match would be ambiguous.
  await expect(page.getByText(pollPath, { exact: true })).toBeVisible();
  const row = page.locator("div").filter({ has: page.getByText(pollPath, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
  await expect(row.getByText(connName, { exact: true })).toBeVisible();
  await expect.poll(() => pollJobByPath(loomDaemon.baseURL, pollPath).then((j) => j?.enabled ?? null)).toBe(true);

  // Exactly one poll job on this daemon now (no other spec creates them) → the row's action buttons are
  // unambiguous.
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(1);

  // --- Toggle (observable #3): Disable flips the badge to "disabled" AND the REST row's enabled to false. ---
  await expect(row.getByText("enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("disabled", { exact: true })).toBeVisible();
  await expect.poll(() => pollJobByPath(loomDaemon.baseURL, pollPath).then((j) => j?.enabled ?? null)).toBe(false);

  // --- Delete (observable #4): Confirm removes the row AND drops it from the REST list. ---
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(pollPath, { exact: true })).toHaveCount(0);
  await expect.poll(() => pollJobByPath(loomDaemon.baseURL, pollPath)).toBeNull();

  // Clean up the seeded connection (the agent + project belong to the throwaway daemon and vanish with it).
  const conns = (await (await fetch(`${loomDaemon.baseURL}/api/connections`)).json()) as Array<{ id: string; name: string }>;
  const conn = conns.find((c) => c.name === connName);
  if (conn) await fetch(`${loomDaemon.baseURL}/api/connections/${conn.id}`, { method: "DELETE" });
});

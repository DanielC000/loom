// An api-key connection can name the request header that carries its secret (card 0683ac4d; Plex's X-Plex-Token),
// driven through the real Settings UI against the fixture daemon. The text field exists for api-key only (placeholder
// X-API-Key), a forbidden name is refused with the daemon's own error and nothing is saved, a valid name saves, and a
// blank one clears it. The daemon's own read is asserted beside every UI claim so a UI that merely LOOKS saved cannot pass.
import { expect, test } from "./fixtures/daemon";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

type Row = { id: string; name: string; host: string; authScheme: string; apiKeyHeader?: string };
const rowsOf = async (baseURL: string) => (await (await fetch(`${baseURL}/api/connections`)).json()) as Row[];
const rowById = async (baseURL: string, id: string) => (await rowsOf(baseURL)).find((r) => r.id === id);
const field = (page: import("@playwright/test").Page, labelText: string) =>
  page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`).locator("input, select, textarea");

test("the edit form names, refuses, saves and clears the api-key header; it is absent for bearer", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("conn-akh"));
  const created = (await (await fetch(`${loomDaemon.baseURL}/api/connections`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("plex"), host: "api.example.com", authScheme: "api-key", secret: "s" }),
  })).json()) as { id: string };
  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
    await expect(page.getByTestId(`connection-row-${created.id}`)).toBeVisible();
    await page.getByTestId(`connection-edit-open-${created.id}`).click();
    const form = page.getByTestId(`connection-edit-${created.id}`);
    const input = page.getByTestId(`connection-edit-api-key-header-${created.id}`);

    // Shown for api-key, empty, with the default as its placeholder.
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "X-API-Key");

    // Hidden once the scheme is bearer, back again for api-key.
    await form.getByLabel("Connection auth scheme").selectOption("bearer");
    await expect(input).toHaveCount(0);
    await form.getByLabel("Connection auth scheme").selectOption("api-key");
    await expect(input).toBeVisible();

    // A forbidden name is refused by the daemon, the UI shows that error, nothing is saved.
    await input.fill("Authorization");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form.getByRole("alert")).toContainText(/apiKeyHeader/);
    expect((await rowById(loomDaemon.baseURL, created.id))?.apiKeyHeader).toBeUndefined();

    // A valid name saves; the daemon agrees; reopening shows it pre-filled.
    await input.fill("X-Plex-Token");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form).toHaveCount(0);
    expect((await rowById(loomDaemon.baseURL, created.id))?.apiKeyHeader).toBe("X-Plex-Token");
    await page.getByTestId(`connection-edit-open-${created.id}`).click();
    await expect(page.getByTestId(`connection-edit-api-key-header-${created.id}`)).toHaveValue("X-Plex-Token");

    // A blank value clears it back to the default.
    await page.getByTestId(`connection-edit-api-key-header-${created.id}`).fill("");
    await page.getByTestId(`connection-edit-${created.id}`).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId(`connection-edit-${created.id}`)).toHaveCount(0);
    expect((await rowById(loomDaemon.baseURL, created.id))?.apiKeyHeader).toBeUndefined();
  } finally {
    await fetch(`${loomDaemon.baseURL}/api/connections/${created.id}`, { method: "DELETE" });
  }
});

test("the create form carries the header field for api-key only and sends it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("conn-akh-new"));
  const name = uniq("plex-new");
  let createdId: string | undefined;
  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
    await page.getByRole("button", { name: "New connection" }).click();
    await page.getByRole("button", { name: "Custom", exact: true }).click();

    const input = page.getByTestId("connection-create-api-key-header");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "X-API-Key");
    await field(page, "Auth scheme").selectOption("bearer");
    await expect(input).toHaveCount(0);
    await field(page, "Auth scheme").selectOption("api-key");
    await expect(input).toBeVisible();

    await field(page, "Name").fill(name);
    await field(page, "Host").fill("192.168.178.136:32400");
    await field(page, "Secret").fill("e2e-secret");
    await page.getByTestId("connection-create-plain-http").check();
    await input.fill("X-Plex-Token");
    await page.getByRole("button", { name: "Create connection" }).click();

    await expect.poll(async () => (await rowsOf(loomDaemon.baseURL)).find((r) => r.name === name)?.apiKeyHeader).toBe("X-Plex-Token");
    createdId = (await rowsOf(loomDaemon.baseURL)).find((r) => r.name === name)?.id;
  } finally {
    if (createdId) await fetch(`${loomDaemon.baseURL}/api/connections/${createdId}`, { method: "DELETE" });
  }
});

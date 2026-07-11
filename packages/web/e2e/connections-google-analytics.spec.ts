// Google Analytics connector preset spec (card 0d272cda) — proves the turnkey "Google Analytics" preset
// on the Settings Connections panel creates an oauth2 connection with provider "google" and exactly the
// ticked read scopes, over the SAME human-only POST /api/connections/oauth surface the custom form uses.
// The security posture (encrypted at rest, never echoed, server-side injection) is unchanged by this card —
// it adds a UX preset only, so this spec exercises the preset flow + the resulting connection metadata,
// NOT any secret material (which no read ever returns). A REAL GA4 Data API call needs live Google creds
// and is owner-verified post-merge; hermetically we can only assert the connection is created correctly.
// Builds on the shared `loomDaemon` fixture; settings.spec.ts is the template.
import { expect, test } from "./fixtures/daemon";

// Locate a form control by the EXACT text of its label <span> (mirrors settings.spec.ts's `field`): the
// GA preset fields are `<label><span style=fieldLabel>Client ID</span><Input/></label>`, so this pins the
// label span then descends to the control — unaffected by any hint text nested in the same label.
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Connections are daemon-global with no fixture-level auto-cleanup (unlike sessions/questions), so each
// test deletes the row it created by its unique name — keeping the shared worker daemon's list tidy for
// any later count/empty-state assertion (mirrors poll-jobs.spec.ts's own connection cleanup).
async function deleteConnectionByName(baseURL: string, name: string) {
  const conns = (await (await fetch(`${baseURL}/api/connections`)).json()) as Array<{ id: string; name: string }>;
  const conn = conns.find((c) => c.name === name);
  if (conn) await fetch(`${baseURL}/api/connections/${conn.id}`, { method: "DELETE" });
}

test("Google Analytics preset creates an oauth2 google connection with the ticked read scopes", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`ga-preset-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // The Connections panel is daemon-global; open the New-connection form.
  await expect(page.getByText("Connections", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "New connection" }).click();

  // The form leads with the turnkey preset selected by default (no auth-scheme/provider dropdown to hunt
  // through — that's the whole point of the preset). The "Custom" alternative is one click away. `exact`
  // avoids colliding with the project-picker button, whose accessible name may contain "Custom".
  await expect(page.getByRole("button", { name: "Google Analytics", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Custom", exact: true })).toBeVisible();

  // Default scope state: Analytics Data API ticked (the headline use), the other two products off.
  const analyticsBox = page.locator('label:has-text("Analytics Data API") input[type="checkbox"]');
  const searchConsoleBox = page.locator('label:has-text("Search Console") input[type="checkbox"]');
  const adsenseBox = page.locator('label:has-text("AdSense") input[type="checkbox"]');
  await expect(analyticsBox).toBeChecked();
  await expect(searchConsoleBox).not.toBeChecked();
  await expect(adsenseBox).not.toBeChecked();

  // Tick a second product — observable state change on an interactive control (unchecked → checked).
  await searchConsoleBox.check();
  await expect(searchConsoleBox).toBeChecked();

  // A unique name so the REST read-back can find THIS connection on the shared worker daemon.
  const uniqueName = `GA e2e ${Date.now()}`;
  await field(page, "Name").fill(uniqueName);
  await field(page, "Client ID").fill("e2e-ga-client-id.apps.googleusercontent.com");
  await field(page, "Client secret").fill("e2e-ga-client-secret");

  await page.getByRole("button", { name: "Create connection" }).click();

  // Observable #1 (the DoD): the connection was created over the human-only REST surface with provider
  // "google" and EXACTLY the two ticked read scopes — read straight off the same store the UI shares. The
  // secret material is never in this response (metadata only), so nothing sensitive is asserted here.
  const expectedScopes = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ];
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/connections`);
      const conns = (await res.json()) as Array<{ name: string; authScheme: string; provider?: string; scopes?: string[] }>;
      const mine = conns.find((c) => c.name === uniqueName);
      return mine ? { authScheme: mine.authScheme, provider: mine.provider, scopes: mine.scopes } : null;
    })
    .toEqual({ authScheme: "oauth2", provider: "google", scopes: expectedScopes });

  // Observable #2: the new row renders in the panel with its provider ("oauth2 · google") + the per-product
  // scope labels, and an oauth2 connection shows "Not connected" until a consent round-trip completes.
  await expect(page.getByText(uniqueName, { exact: true })).toBeVisible();
  await expect(page.getByText("oauth2 · google", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Analytics Data API", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Search Console", { exact: true }).last()).toBeVisible();

  await deleteConnectionByName(loomDaemon.baseURL, uniqueName);
});

test("Custom connector remains available for a non-preset oauth2/api-key connection", async ({ page, loomDaemon }) => {
  // The preset must not remove the general path: switching to "Custom" restores the full form (auth-scheme
  // dropdown + free-text fields), so an api-key/bearer/custom-oauth2 connection is still creatable.
  const project = await loomDaemon.createProject(`ga-custom-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);
  await page.getByRole("button", { name: "New connection" }).click();

  // In the default GA preset, the auth-scheme dropdown is absent (it's a preset, not the raw form).
  await expect(field(page, "Auth scheme")).toHaveCount(0);

  await page.getByRole("button", { name: "Custom", exact: true }).click();
  // Switching to Custom brings back the full form — the auth-scheme dropdown reappears.
  await expect(field(page, "Auth scheme")).toBeVisible();

  const uniqueName = `Custom e2e ${Date.now()}`;
  await field(page, "Name").fill(uniqueName);
  await field(page, "Host").fill("api.example.com");
  // Default auth scheme is api-key → a single Secret field.
  await field(page, "Secret").fill("e2e-api-key-secret");
  await page.getByRole("button", { name: "Create connection" }).click();

  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/connections`);
      const conns = (await res.json()) as Array<{ name: string; authScheme: string; host: string }>;
      const mine = conns.find((c) => c.name === uniqueName);
      return mine ? { authScheme: mine.authScheme, host: mine.host } : null;
    })
    .toEqual({ authScheme: "api-key", host: "api.example.com" });

  await deleteConnectionByName(loomDaemon.baseURL, uniqueName);
});

// Connector-preset Name spec (card 7fba8d90) — switching the connector preset in the New-connection form
// must re-derive the Name from the newly-picked preset, WITHOUT ever discarding a name the user typed.
//
// ⚠️ THIS SPEC ASSERTS `input.value`, NEVER THE PLACEHOLDER. The original defect was invisible to a
// placeholder assertion: the placeholder updated correctly for the new preset the whole time while the
// VALUE stayed on the previous preset's name (so a SonarQube connection could be saved as
// "Google Analytics"). A placeholder pin is green against both the broken and the fixed code, which makes
// it worse than no test at all — the same distinction that bit card 5a8a74e1. One placeholder assertion
// IS present below, explicitly labelled as a control demonstrating exactly that: it cannot discriminate.
//
// The rule under test: the Name field is USER-OWNED the moment it holds text the user typed, and reverts
// to preset-derived the moment it is cleared back to empty. A preset switch rewrites the Name only while
// it is NOT user-owned. "Custom" has no product name, so its preset-derived default is the empty string.
//
// Builds on the shared `loomDaemon` fixture; connections-google-analytics.spec.ts is the template. No
// connection is ever created here — this is form state only, so there is nothing to clean up.
import { expect, test } from "./fixtures/daemon";

// Locate a form control by the EXACT text of its label <span> (mirrors connections-google-analytics.spec.ts).
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

const PRESET_NAME = {
  "Google Analytics": "Google Analytics",
  SonarQube: "SonarQube",
  Custom: "",
} as const;
type PresetLabel = keyof typeof PRESET_NAME;

async function openNewConnectionForm(page: import("@playwright/test").Page, baseURL: string, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
  await page.goto(`${baseURL}/settings`);
  await expect(page.getByText("Connections", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "New connection" }).click();
  // The form opens on the Google Analytics preset with its own name pre-filled.
  await expect(field(page, "Name")).toHaveValue(PRESET_NAME["Google Analytics"]);
}

function pickPreset(page: import("@playwright/test").Page, label: PresetLabel) {
  // `exact` avoids colliding with the project-picker button, whose accessible name may contain "Custom".
  return page.getByRole("button", { name: label, exact: true }).click();
}

test("a preset switch re-derives the Name — every transition, both directions, asserted on input.value", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`preset-name-${Date.now()}`);
  await openNewConnectionForm(page, loomDaemon.baseURL, project.id);

  const name = field(page, "Name");

  // All six ordered transitions across the three presets. The card's own provenance was n=1
  // (Google Analytics → SonarQube) with the rest ASSUMED to behave the same because they share one
  // component — so every one is measured here rather than inherited.
  const transitions: Array<[PresetLabel, PresetLabel]> = [
    ["Google Analytics", "SonarQube"],
    ["SonarQube", "Google Analytics"],
    ["Google Analytics", "Custom"],
    ["Custom", "Google Analytics"],
    ["Google Analytics", "SonarQube"], // reposition for the SonarQube ⇄ Custom pair
    ["SonarQube", "Custom"],
    ["Custom", "SonarQube"],
  ];

  for (const [from, to] of transitions) {
    // BEFORE: the form is on `from` and carries `from`'s own preset name.
    await expect(name, `before ${from} → ${to}: Name should hold ${from}'s preset value`).toHaveValue(PRESET_NAME[from]);
    await pickPreset(page, to);
    // AFTER: the value — not the placeholder — is the NEW preset's name. Pre-fix this held PRESET_NAME[from].
    await expect(name, `after ${from} → ${to}: Name should hold ${to}'s preset value`).toHaveValue(PRESET_NAME[to]);
  }

  // CONTROL — deliberately the assertion that CANNOT catch this bug. Back on the SonarQube preset the
  // placeholder reads "e.g. SonarQube"; it read exactly that on the broken build too, while the value was
  // still "Google Analytics". Kept to document that the placeholder is not, and never was, the signal.
  await expect(name).toHaveAttribute("placeholder", "e.g. SonarQube");
});

test("a preset switch preserves a Name the USER typed, and resumes preset defaults once it is cleared", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`preset-name-typed-${Date.now()}`);
  await openNewConnectionForm(page, loomDaemon.baseURL, project.id);

  const name = field(page, "Name");

  // The user types their own name over the Google Analytics default.
  await name.fill("Marketing site analytics");
  await expect(name).toHaveValue("Marketing site analytics");

  // Every subsequent preset switch must leave it alone — this project has a standing rule against
  // destroying a user's unfinished input, so an unconditional reset would trade one bug for a worse one.
  for (const to of ["SonarQube", "Custom", "Google Analytics", "SonarQube"] as PresetLabel[]) {
    await pickPreset(page, to);
    await expect(name, `after switching to ${to}: a user-typed Name must survive`).toHaveValue("Marketing site analytics");
  }

  // Clearing the field hands ownership back: it is no longer user-owned, so the next preset switch
  // re-derives the default instead of stranding the user on a permanently empty box.
  await name.fill("");
  await expect(name).toHaveValue("");
  await pickPreset(page, "Google Analytics");
  await expect(name, "a cleared Name resumes preset-derived defaults").toHaveValue(PRESET_NAME["Google Analytics"]);

  // And whitespace alone is not ownership — it is an empty field with spaces in it.
  await name.fill("   ");
  await pickPreset(page, "SonarQube");
  await expect(name, "a whitespace-only Name is not user-owned").toHaveValue(PRESET_NAME.SonarQube);
});

// Card 2790ce05 asked whether `host`, `secret` and `clientId` should ALSO reset on a preset switch, the
// way the Name now does. The answer is NO for every one of them, and this test pins that decision so the
// next reader of 7fba8d90 cannot "finish the job" by extending the Name fix across the form.
//
// The Name fix keyed on `nameTouched` — preset-DERIVED until the user types, then user-owned. That
// discriminator cannot be reused here, because it has nothing to revert TO: `setName(CONNECTOR_PRESET_NAMES[m])`
// is the ONLY programmatic write to any field in this form, so a host or a credential is user-typed 100% of
// the time. Clearing one would therefore be a pure destruction of the user's unfinished input — the exact
// thing this project has a standing rule against — to remove a confusion that, unlike the Name bug, was
// never disguised in the first place. Full per-field reasoning: docs/decisions/2790ce05-*.md.
//
// Every assertion below is on `input.value`, for the same reason the Name spec above gives.
test("host and credentials PERSIST across a preset switch — the decided behaviour of card 2790ce05", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`preset-creds-${Date.now()}`);
  await openNewConnectionForm(page, loomDaemon.baseURL, project.id);

  // --- clientId / clientSecret: Google Analytics ⇄ Custom+oauth2 ---------------------------------
  // Both presets mean the same thing by these: one OAuth app the user registered themselves. Carrying
  // them over is help, not a bug.
  await field(page, "Client ID").fill("1234.apps.googleusercontent.com");
  await field(page, "Client secret").fill("GOCSPX-preset-persistence");

  await pickPreset(page, "Custom");
  // `clientId`/`clientSecret` only render under Custom once the scheme is oauth2.
  await field(page, "Auth scheme").selectOption("oauth2");
  await expect(field(page, "Client ID"), "a typed Client ID survives Google Analytics → Custom")
    .toHaveValue("1234.apps.googleusercontent.com");
  await expect(field(page, "Client secret"), "a typed Client secret survives Google Analytics → Custom")
    .toHaveValue("GOCSPX-preset-persistence");

  // --- host + secret: SonarQube ⇄ Custom ---------------------------------------------------------
  // Both presets mean "a bare hostname" and "an opaque bearer credential for that host" — the same
  // argument, so the same answer. (Google Analytics never renders Host at all: it submits the fixed
  // GA_PRESET_HOST literal, so `host` is only ever visible across these two.)
  await pickPreset(page, "SonarQube");
  await field(page, "Host").fill("sonarqube.mycompany.com");
  await field(page, "User token").fill("squ_preset_persistence_token");

  await pickPreset(page, "Custom");
  await expect(field(page, "Host"), "a typed Host survives SonarQube → Custom")
    .toHaveValue("sonarqube.mycompany.com");
  // The scheme is still oauth2 from above; `secret` renders under api-key/bearer, where it is labelled
  // "Secret" rather than SonarQube's "User token" — one state field behind two labels.
  await field(page, "Auth scheme").selectOption("api-key");
  await expect(field(page, "Secret"), "a typed token survives SonarQube → Custom, relabelled 'Secret'")
    .toHaveValue("squ_preset_persistence_token");

  // And switching back is lossless too — nothing was consumed or cleared on the way out.
  await pickPreset(page, "SonarQube");
  await expect(field(page, "Host"), "Host is still intact back on SonarQube").toHaveValue("sonarqube.mycompany.com");
  await expect(field(page, "User token"), "the token is still intact back on SonarQube")
    .toHaveValue("squ_preset_persistence_token");
});

// Setup-wizard header at phone width (card 999b12a7): the centered step rail must not draw over the
// "loom" wordmark or the close button. At 390px the compact rail (~230px) is wider than the gap between the
// absolutely-positioned brand (left) and close (right), so step 1's marker used to land on the wordmark.
// The fix drops the rail onto its own row on a narrow viewport; desktop keeps the single-row header.
//
// The assertion is a bounding-box intersection test, which needs both boxes to be real (non-zero) first,
// otherwise a missing element would read as "no overlap".
import { expect, test, type Locator, type Page } from "./fixtures/daemon";

type Box = { x: number; y: number; width: number; height: number };

async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  expect(b, "element must be rendered").not.toBeNull();
  expect(b!.width).toBeGreaterThan(0);
  expect(b!.height).toBeGreaterThan(0);
  return b!;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function openWizard(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/platform`);
  await page.getByRole("button", { name: /Start guided setup/ }).click();
  await expect(page.getByRole("heading", { name: "Choose your team" })).toBeVisible();
}

// 390 = phone (compact rail); 640 = tablet (full-size 552px rail: step 1 lands on the wordmark below ~680px).
for (const width of [390, 640]) test(`at ${width}px the step rail clears the wordmark and the close button`, async ({ page, loomDaemon }) => {
  await page.setViewportSize({ width, height: 844 });
  await openWizard(page, loomDaemon.baseURL);

  const dialog = page.getByRole("dialog", { name: "Set up a new project" });
  const brand = await box(dialog.getByTestId("setup-wizard-brand"));
  const close = await box(dialog.getByRole("button", { name: "Close setup" }));
  const rail = dialog.getByTestId("setup-wizard-stepper");
  const railBox = await box(rail);
  // Step 1's marker is the first step column's bubble, the element the bug report names.
  const firstMarker = await box(rail.getByText("1", { exact: true }));

  expect(intersects(firstMarker, brand), `step 1 marker ${JSON.stringify(firstMarker)} overlaps brand ${JSON.stringify(brand)}`).toBe(false);
  expect(intersects(railBox, brand), `step rail ${JSON.stringify(railBox)} overlaps brand ${JSON.stringify(brand)}`).toBe(false);
  expect(intersects(railBox, close), `step rail ${JSON.stringify(railBox)} overlaps close ${JSON.stringify(close)}`).toBe(false);
  // The rail still fits the viewport (no sideways scroll introduced by the fix).
  expect(railBox.x).toBeGreaterThanOrEqual(0);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(width);
});

test("at desktop width the header stays one row: the step rail sits level with the wordmark", async ({ page, loomDaemon }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWizard(page, loomDaemon.baseURL);

  const dialog = page.getByRole("dialog", { name: "Set up a new project" });
  const brand = await box(dialog.getByTestId("setup-wizard-brand"));
  const railBox = await box(dialog.getByTestId("setup-wizard-stepper"));

  expect(intersects(railBox, brand)).toBe(false);
  // Same row: the rail's vertical span covers the brand's vertical centre.
  const brandMid = brand.y + brand.height / 2;
  expect(railBox.y).toBeLessThanOrEqual(brandMid);
  expect(railBox.y + railBox.height).toBeGreaterThanOrEqual(brandMid);
});

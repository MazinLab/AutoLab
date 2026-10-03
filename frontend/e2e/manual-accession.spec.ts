import { expect, test, createApiEntity } from "./fixtures";

test("opens an API-created entity from manual accession entry", async ({
  page,
  request,
}) => {
  const deviceName = `Playwright scan device ${Date.now()}`;
  const device = await createApiEntity(request, "device", { name: deviceName });

  await page.goto("/scan");
  await page.getByLabel("Accession or AutoLab link").fill(device.accession);
  await page.getByRole("button", { name: "Open record" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/entity/${device.id}\\?type=device$`),
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(deviceName);
  await expect(
    page.locator(".entity-identity").getByText(device.accession, { exact: true }),
  ).toBeVisible();
});

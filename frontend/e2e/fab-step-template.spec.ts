import { expect, test, createApiEntity } from "./fixtures";

test("logs a fab step from its template", async ({ page, request }) => {
  const fabRunName = `Playwright fab run ${Date.now()}`;
  const fabRun = await createApiEntity(request, "fab_run", { name: fabRunName });

  await page.goto("/new");
  await page.getByRole("button", { name: "Fab Step", exact: true }).click();

  const form = page.getByRole("form", { name: "Fab Step form" });
  await form.getByLabel("Fab Run").fill(fabRunName);
  await form
    .getByRole("button", { name: new RegExp(fabRun.accession) })
    .click();
  await form.getByLabel("Step Index").fill("7");
  await form.getByLabel("Recipe").fill("Playwright smoke recipe");

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/fab_step",
  );
  await form.getByRole("button", { name: "Create fab step" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as CreatedEntity;

  await expect(page.getByText(`Created ${created.accession}`)).toBeVisible();
});

interface CreatedEntity {
  accession: string;
}

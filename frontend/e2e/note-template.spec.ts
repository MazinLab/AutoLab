import { expect, test } from "./fixtures";

test("creates a note from a template and finds it in search", async ({ page }) => {
  const noteTitle = `Playwright template note ${Date.now()}`;

  await page.goto("/new");
  await page.getByRole("button", { name: "Experiment", exact: true }).click();

  const form = page.getByRole("form", { name: "Experiment form" });
  await form.getByLabel("Procedure").fill("Record the smoke-test procedure");
  await form
    .getByLabel("Markdown note")
    .fill(`${noteTitle}\nThe template smoke flow completed.`);
  await form.getByRole("button", { name: "Create experiment" }).click();

  await expect(page.getByText(/^Created NOTE-\d{4}-\d+$/)).toBeVisible();

  await page.goto("/");
  await page.getByLabel("Search names and descriptions").fill(noteTitle);
  await expect(
    page.getByRole("link").filter({ hasText: noteTitle }),
  ).toBeVisible();
});

import { expect, test } from "@playwright/test";

test("preview fits a phone screen without horizontal scrolling", async ({ page }) => {
  await page.goto("/preview");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  await page.getByRole("button", { name: "Generate sample draft" }).click();
  await expect(page.locator("article")).toHaveCount(9);
  for (const path of ["/preview", "/preview/articles", "/preview/archive", "/preview/audience", "/preview/settings", "/"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

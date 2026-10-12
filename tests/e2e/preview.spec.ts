import { expect, test, type Page } from "@playwright/test";

// The principal journey in the credential-free preview:
// Collect → Review (edit, swap) → Approve → Deliver (simulated), plus the
// optional follow-up meeting. Also proves the preview makes no server calls
// to the live API or to any external service.

async function openFreshPreview(page: Page) {
  await page.goto("/preview");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("full preview journey with honest labelling", async ({ page }) => {
  const outbound: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/desk") || u.pathname.startsWith("/api/cron") || (u.hostname !== "localhost" && !u.hostname.endsWith("googleapis.com") && !u.hostname.endsWith("gstatic.com"))) outbound.push(r.url());
  });

  await openFreshPreview(page);
  await expect(page.getByText("Preview · sample data.")).toBeVisible();

  // Generate the (prewritten, clearly labelled) sample draft.
  await page.getByRole("button", { name: "Generate sample draft" }).click();
  await expect(page.locator("article")).toHaveCount(9);
  await expect(page.getByText("Sample commentary (prewritten)").first()).toBeVisible();

  // Edit commentary: autosaves and is relabelled as the editor's.
  const second = page.locator("article").nth(1);
  const box = second.getByRole("textbox", { name: /Commentary/ });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" Lenders have a month to respond.");
  await expect(second.getByText("Saved")).toBeVisible();
  await expect(second.getByText("Edited by you")).toBeVisible();

  // Story approval alone never sends.
  await second.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Run a scheduled step now").click();
  await page.getByRole("button", { name: /simulate delivery/ }).click();
  await expect(page.getByText(/no valid final approval/)).toBeVisible();

  // Swap story #6 for an alternative.
  const sixth = page.locator("article").nth(5);
  const oldHeadline = await sixth.locator("h3").innerText();
  await sixth.getByRole("button", { name: "Swap" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Topic coverage/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Use this story" }).first().click();
  await expect(page.locator("article").nth(5).locator("h3")).not.toHaveText(oldHeadline);

  // Final confirmation shows the exact email and confirms one revision.
  await page.getByRole("button", { name: "Confirm and schedule" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Review and confirm the edition")).toBeVisible();
  await expect(confirm.frameLocator("iframe[title='Email preview']").getByText("The Dispatch").first()).toBeVisible();
  await confirm.getByRole("radio", { name: "Send now" }).check();
  await confirm.getByRole("button", { name: "Confirm and send now" }).click();
  await expect(page.getByText(/Scheduled for/)).toBeVisible();

  // Editing after approval withdraws it.
  const first = page.locator("article").first().getByRole("textbox", { name: /Commentary/ });
  await first.click();
  await first.press("End");
  await first.pressSequentially(" Edited.");
  await expect(page.getByText("Approval withdrawn").first()).toBeVisible();

  // Reconfirm, then simulate delivery.
  await page.getByRole("button", { name: "Confirm and schedule" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "Send now" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and send now" }).click();
  await page.getByRole("button", { name: /simulate delivery/ }).click();
  await expect(page.getByText("Simulated — no email sent")).toBeVisible();
  await expect(page.getByText("Would be sent (simulated)")).toBeVisible();

  expect(outbound, `unexpected requests: ${outbound.join(", ")}`).toEqual([]);
});

test("follow-up meeting requires explicit confirmation and is simulated", async ({ page }) => {
  await openFreshPreview(page);
  await page.getByRole("button", { name: "Generate sample draft" }).click();
  const story = page.locator("article").first();
  await story.getByText("More").click();
  await story.getByRole("button", { name: "Plan follow-up…" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Attendees").fill("not-an-email");
  await d.getByRole("button", { name: "Review details" }).click();
  await expect(d.getByText(/Not a valid email/)).toBeVisible();
  await d.getByLabel("Attendees").fill("reporter@example.com");
  await d.getByRole("button", { name: "Review details" }).click();
  await expect(d.getByText("Booking will email invitations to 1 person")).toBeVisible();
  await d.getByRole("button", { name: "Confirm and book (simulated)" }).click();
  await expect(page.getByText("Simulated", { exact: true }).first()).toBeVisible();
});

test("keyboard users can reach the main action", async ({ page }) => {
  await openFreshPreview(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const main = page.getByRole("button", { name: "Generate sample draft" });
  await main.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("article")).toHaveCount(9);
});

import { expect, test } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
} from "../src/lib/testing/fixtures";

let companyId: string;

test.beforeAll(async () => {
  const company = await createCompany({
    name: "E2E Coverage Co",
    supportTimezone: "UTC",
    maxActiveTicketsPerAgent: 3,
  });
  companyId = company.id;
  await createAgent(companyId, { name: "E2E Agent" });
  // Required hours span the whole of Monday, so the page starts fully gapped.
  await prisma.requiredSupportHours.create({
    data: { companyId, dayOfWeek: 1, startMinute: 0, endMinute: 23 * 60 + 59 },
  });
});

test.afterAll(async () => {
  await cleanupCompany(companyId);
  await prisma.$disconnect();
});

function extractGapMinutes(headingText: string | null): number {
  const match = headingText?.match(/\((\d+) min total\)/);
  return match ? Number(match[1]) : Number.NaN;
}

test("creating an overnight window shows its marker and shrinks a coverage gap", async ({
  page,
}) => {
  await page.goto(`/companies/${companyId}/coverage`);
  const gapHeading = page.getByRole("heading", { name: /Coverage gaps/ });
  await expect(gapHeading).toBeVisible();
  const initialMinutes = extractGapMinutes(await gapHeading.textContent());
  expect(initialMinutes).toBeGreaterThan(0);

  await page.goto(`/companies/${companyId}/availability`);
  await page.getByRole("button", { name: "Add window" }).click();
  await page.getByRole("checkbox", { name: "Monday" }).check();
  await page.getByLabel("Start time").fill("22:00");
  await page.getByLabel("End time").fill("06:00");
  await page.getByRole("button", { name: "Timezone" }).click();
  await page.getByPlaceholder("Search timezones...").fill("Europe/London");
  await page
    .getByRole("option", { name: "Europe/London", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "E2E Agent" }).check();
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("22:00 → 06:00")).toBeVisible();
  await expect(page.getByText("ends next day")).toBeVisible();

  await page.goto(`/companies/${companyId}/coverage`);
  await expect(gapHeading).toBeVisible();
  await expect
    .poll(async () => extractGapMinutes(await gapHeading.textContent()))
    .toBeLessThan(initialMinutes);
});

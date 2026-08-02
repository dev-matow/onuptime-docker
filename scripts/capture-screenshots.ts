import "dotenv/config";

import { and, eq, ne } from "drizzle-orm";

import { chromium } from "@playwright/test";

import { db } from "@/db";
import { incidents, monitors, organization } from "@/db/schema";
import { DEMO_ORG, DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";

/**
 * Captures the four marketing screenshots (1440×900) used by the README
 * and the landing page. Requires a running app (`npm run dev` or a
 * production build) seeded with `npm run db:seed`.
 *
 *   npm run screenshots
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";

async function resolveIds() {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, DEMO_ORG.slug),
    columns: { id: true },
  });
  if (!org) throw new Error("Demo org not found, run `npm run db:seed` first.");

  const gateway = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.organizationId, org.id),
      eq(monitors.name, "API Gateway"),
    ),
    columns: { id: true },
  });
  const ongoing = await db.query.incidents.findFirst({
    where: and(
      eq(incidents.organizationId, org.id),
      ne(incidents.status, "resolved"),
    ),
    columns: { id: true },
  });
  if (!gateway || !ongoing) {
    throw new Error("Demo data incomplete, re-run `npm run db:seed`.");
  }
  return { monitorId: gateway.id, incidentId: ongoing.id };
}

async function main() {
  const { monitorId, incidentId } = await resolveIds();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill(DEMO_USERS.owner.email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20_000 });

  const shots: [string, string][] = [
    ["/dashboard", "dashboard.png"],
    [`/monitors/${monitorId}`, "monitor-detail.png"],
    [`/incidents/${incidentId}`, "incident-detail.png"],
    [`/status/${DEMO_ORG.slug}`, "status-page.png"],
  ];

  for (const [path, file] of shots) {
    await page.goto(`${BASE}${path}`);
    await page.waitForSelector("h1", { timeout: 20_000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${file}` });
    console.log(`captured ${file}`);
  }

  await browser.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { sql } from "drizzle-orm";

import { db } from "@/db";

// Never statically optimized — every probe must hit the database.
export const dynamic = "force-dynamic";

/**
 * Readiness probe for load balancers and container orchestrators:
 * 200 when the app can reach Postgres, 503 otherwise. Body is
 * intentionally minimal — no version or topology disclosure.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

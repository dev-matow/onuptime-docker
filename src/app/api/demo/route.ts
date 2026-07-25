import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * One-click demo entry: signs the visitor in as the seeded read-only
 * viewer and drops them on the dashboard. 404s unless DEMO_MODE is on,
 * so the route is inert on real deployments.
 */
export async function GET() {
  if (!env.DEMO_MODE) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const signIn = await auth.api.signInEmail({
      body: { email: DEMO_USERS.viewer.email, password: DEMO_PASSWORD },
      asResponse: true,
    });

    const redirect = NextResponse.redirect(new URL("/dashboard", env.APP_URL), {
      status: 303,
    });
    for (const cookie of signIn.headers.getSetCookie()) {
      redirect.headers.append("set-cookie", cookie);
    }
    return redirect;
  } catch (error) {
    logger.error({ err: error }, "demo sign-in failed — is the demo seeded?");
    return new NextResponse("Demo is not seeded yet.", { status: 503 });
  }
}

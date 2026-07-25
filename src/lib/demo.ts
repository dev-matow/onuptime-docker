import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * Demo-mode support. The same identities are used by scripts/seed-demo.ts
 * (which creates them) and /api/demo (which signs the viewer in), so the
 * demo deployment has no credentials to configure.
 */
export const DEMO_PASSWORD = "vigil-demo-2026";

export const DEMO_ORG = {
  name: "Altitude Systems",
  slug: "altitude",
} as const;

export const DEMO_USERS = {
  owner: { name: "Amelia Chen", email: "amelia@altitude.demo", role: "owner" },
  admin: { name: "Marcus Webb", email: "marcus@altitude.demo", role: "admin" },
  responder: {
    name: "Priya Sharma",
    email: "priya@altitude.demo",
    role: "responder",
  },
  viewer: { name: "Demo Visitor", email: "demo@altitude.demo", role: "viewer" },
} as const;

export class DemoModeError extends AppError {
  constructor() {
    super("Action disabled in live demo.");
  }
}

/** Chokepoint called by every mutating server action. */
export function assertNotDemo(): void {
  if (env.DEMO_MODE) throw new DemoModeError();
}

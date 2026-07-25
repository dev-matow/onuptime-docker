"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, roles } from "@/lib/permissions";

export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles })],
});

export const { signIn, signUp, signOut, useSession } = authClient;

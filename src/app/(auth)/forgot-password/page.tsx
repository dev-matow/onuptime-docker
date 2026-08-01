import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/lib/env";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password — Vigil" };

export default function ForgotPasswordPage() {
  // The demo signs every visitor in as the same seeded account, so a
  // reset there is a way to lock everyone else out. `src/lib/auth.ts`
  // refuses the route; this is the same refusal said in advance,
  // instead of a form that only fails once it is filled in.
  if (env.DEMO_MODE) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password reset is off</CardTitle>
          <CardDescription>
            This is a shared read-only demo — the accounts are seeded and their
            passwords are published.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            <Link href="/sign-in" className="text-foreground underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          We&apos;ll email you a link to set a new one
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm />
        <p className="text-muted-foreground mt-4 text-center text-sm">
          Remembered it?{" "}
          <Link href="/sign-in" className="text-foreground underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

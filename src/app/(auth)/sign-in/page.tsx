import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/lib/env";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in · Vigil" };

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your account</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense>
          <SignInForm />
        </Suspense>
        {env.DEMO_MODE ? (
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href="/api/demo">Explore the live demo</a>
          </Button>
        ) : (
          <p className="text-muted-foreground mt-4 text-center text-sm">
            Don&apos;t have an account?{" "}
            <Link href="/sign-up" className="text-foreground underline">
              Sign up
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

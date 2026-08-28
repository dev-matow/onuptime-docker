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
    <Card className="border-border/80 shadow-[0_12px_32px_rgba(16,24,40,0.08)]">
      <CardHeader className="gap-1.5 px-6 pt-1">
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to continue to your workspace.</CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-1">
        <Suspense>
          <SignInForm />
        </Suspense>
        {env.DEMO_MODE ? (
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href="/api/demo">Explore the live demo</a>
          </Button>
        ) : (
          <p className="text-muted-foreground mt-5 border-t pt-5 text-center text-sm">
            Don&apos;t have an account?{" "}
            <Link href="/sign-up" className="text-primary font-medium hover:underline">
              Sign up
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

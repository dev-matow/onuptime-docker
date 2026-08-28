import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Sign up · Vigil" };

export default function SignUpPage() {
  return (
    <Card className="border-border/80 shadow-[0_12px_32px_rgba(16,24,40,0.08)]">
      <CardHeader className="gap-1.5 px-6 pt-1">
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          Start monitoring your services in minutes
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-1">
        <SignUpForm />
        <p className="text-muted-foreground mt-5 border-t pt-5 text-center text-sm">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-primary font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

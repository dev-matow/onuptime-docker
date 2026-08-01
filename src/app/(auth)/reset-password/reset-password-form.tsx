"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

const MIN_PASSWORD_LENGTH = 10;

export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The link goes to better-auth's callback, which checks the token
  // before it redirects here — so arriving with `error` means the token
  // was already spent or has expired, and arriving with neither means
  // the page was opened by hand.
  const token = searchParams.get("token");
  const callbackError = searchParams.get("error");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));

    // Checked here rather than only by the server: a typo in a password
    // you cannot see, on the one screen that exists because you already
    // lost the last one, is worth catching before it is committed.
    if (password !== String(form.get("confirm"))) {
      setError("Those two passwords are different.");
      return;
    }

    setPending(true);
    setError(null);

    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token: token ?? "",
    });
    setPending(false);

    if (resetError) {
      setError(resetError.message ?? "Unable to set the password.");
      return;
    }
    setDone(true);
  }

  if (!token || callbackError) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="alert" className="text-destructive">
          This reset link is no longer valid.
        </p>
        <p className="text-muted-foreground">
          Links work once and expire an hour after they are sent.{" "}
          <Link href="/forgot-password" className="text-foreground underline">
            Ask for a new one
          </Link>
          .
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="status">Your password is set.</p>
        <p className="text-muted-foreground">
          Every other session was signed out. A browser that already had one
          open can take up to five minutes to notice.{" "}
          <Link href="/sign-in" className="text-foreground underline">
            Sign in
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate={false}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder="••••••••"
            required
          />
          <FieldDescription>At least 10 characters.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm">Repeat it</FieldLabel>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder="••••••••"
            required
          />
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Spinner />}
          Set password
        </Button>
      </FieldGroup>
    </form>
  );
}

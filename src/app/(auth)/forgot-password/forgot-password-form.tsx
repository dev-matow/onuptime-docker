"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

/**
 * Where the reset link lands once the token has been validated. Relative
 * on purpose — better-auth origin-checks this value, and a relative path
 * cannot be pointed at somebody else's host.
 */
const RESET_PATH = "/reset-password";

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    setPending(true);
    setError(null);

    const { error: resetError } = await authClient.requestPasswordReset({
      email,
      redirectTo: RESET_PATH,
    });
    setPending(false);

    if (resetError) {
      setError(
        resetError.message ?? "Unable to send the email. Please try again.",
      );
      return;
    }
    setSentTo(email);
  }

  // Claimed only after the server has confirmed a send, and true whether
  // or not the address has an account: an address with none is emailed
  // to say so. Both halves of that matter — the first is the difference
  // between reporting delivery and assuming it, and the second is why
  // this sentence does not have to hedge about who has an account.
  if (sentTo) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="status">
          We emailed <strong className="font-medium">{sentTo}</strong>.
        </p>
        <p className="text-muted-foreground">
          If an account uses that address, the email holds a link to set a new
          password. It works once and expires in an hour. If no account uses
          it, the email says that instead.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate={false}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
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
          Email me a reset link
        </Button>
      </FieldGroup>
    </form>
  );
}

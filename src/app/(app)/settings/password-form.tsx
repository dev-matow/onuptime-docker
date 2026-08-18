"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

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

/**
 * Calls better-auth over HTTP rather than through a server action.
 *
 * A server action would reach `auth.api.changePassword` directly, and
 * `auth.api` does not pass through the rate limiter — that runs in the
 * HTTP router. Since the endpoint verifies the current password, taking
 * it off the rate-limited path would turn the one authenticated
 * password oracle in the product into an unlimited one.
 */
export function PasswordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("new-password"));

    if (newPassword !== String(form.get("confirm-password"))) {
      toast.error("Those two passwords are different.");
      return;
    }

    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get("current-password")),
      newPassword,
      // Changing a password you still know is usually hygiene, but it
      // is also what someone does the moment they suspect a session
      // they did not open. Only one of those two readings survives
      // leaving the other sessions alive.
      revokeOtherSessions: true,
    });
    setPending(false);

    if (error) {
      toast.error(error.message ?? "Unable to change the password.");
      return;
    }
    formRef.current?.reset();
    toast.success("Password changed, other sessions signed out");
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="current-password">Current password</FieldLabel>
          <Input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            className="max-w-xs"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-password">New password</FieldLabel>
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="max-w-xs"
            required
          />
          <FieldDescription>
            At least 10 characters. Every other session is signed out, a browser
            that already had one open can take up to five minutes to notice.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm-password">
            Repeat the new password
          </FieldLabel>
          <Input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="max-w-xs"
            required
          />
        </Field>
        {/* Outline, not a second black primary in the same viewport: the
            page keeps one filled action, the profile card's Save. */}
        <Button
          type="submit"
          variant="outline"
          disabled={pending}
          className="self-start"
        >
          {pending && <Spinner />}
          Change password
        </Button>
      </FieldGroup>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

import { updateProfileAction } from "./actions";

export function ProfileForm({ phone }: { phone: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await updateProfileAction({
      phone: String(form.get("phone")),
    });
    setPending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Profile updated");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="profile-phone">Phone number</FieldLabel>
          <Input
            id="profile-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={phone}
            placeholder="+15551234567"
            className="max-w-xs"
          />
          <FieldDescription>
            Used for SMS and voice escalation steps that page you. Leave empty
            to opt out. International format, e.g.{" "}
            <code className="font-mono">+15551234567</code>.
          </FieldDescription>
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending && <Spinner />}
          Save
        </Button>
      </FieldGroup>
    </form>
  );
}

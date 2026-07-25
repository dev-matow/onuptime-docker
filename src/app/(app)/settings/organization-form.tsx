"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { updateOrganizationAction } from "./actions";

export function OrganizationForm({
  name,
  canEdit,
}: {
  name: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await updateOrganizationAction({
      name: String(form.get("name")),
    });
    setPending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Organization updated");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="org-name">Name</FieldLabel>
          <Input
            id="org-name"
            name="name"
            defaultValue={name}
            disabled={!canEdit}
            required
          />
        </Field>
        {canEdit && (
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Spinner />}
            Save
          </Button>
        )}
      </FieldGroup>
    </form>
  );
}

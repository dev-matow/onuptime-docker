"use client";

import { useRouter } from "next/navigation";
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

export function CreateOrganizationForm() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    setPending(true);
    setError(null);

    const { data, error: createError } = await authClient.organization.create({
      name,
      slug,
    });

    if (createError || !data) {
      setError(createError?.message ?? "Unable to create the organization.");
      setPending(false);
      return;
    }

    await authClient.organization.setActive({ organizationId: data.id });
    router.push("/dashboard");
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Organization name</FieldLabel>
          <Input
            id="name"
            name="name"
            placeholder="Acme Inc."
            required
            onChange={(event) => {
              if (!slugEdited) setSlug(slugify(event.target.value));
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="slug">Slug</FieldLabel>
          <Input
            id="slug"
            name="slug"
            value={slug}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            required
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(slugify(event.target.value));
            }}
          />
          <FieldDescription>
            Used in URLs — lowercase letters, numbers and dashes.
          </FieldDescription>
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Spinner />}
          Create organization
        </Button>
      </FieldGroup>
    </form>
  );
}

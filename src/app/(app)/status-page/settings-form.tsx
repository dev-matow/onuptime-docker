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
import { Switch } from "@/components/ui/switch";

import { updateStatusPageAction } from "./actions";

export function StatusPageSettingsForm({
  defaults,
  canEdit,
}: {
  defaults: {
    name: string;
    slug: string;
    published: boolean;
  };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [published, setPublished] = useState(defaults.published);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);

    const result = await updateStatusPageAction({
      name: String(form.get("name")),
      slug: String(form.get("slug")),
      published,
    });
    setPending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Status page updated");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="status-page-name">Page name</FieldLabel>
          <Input
            id="status-page-name"
            name="name"
            defaultValue={defaults.name}
            disabled={!canEdit}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="status-page-slug">Slug</FieldLabel>
          <Input
            id="status-page-slug"
            name="slug"
            defaultValue={defaults.slug}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            disabled={!canEdit}
            required
          />
          <FieldDescription>
            Changing the slug changes the public URL — old links will break.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch
            id="status-page-published"
            checked={published}
            onCheckedChange={setPublished}
            disabled={!canEdit}
            aria-describedby="status-page-published-hint"
          />
          <div>
            <FieldLabel htmlFor="status-page-published">Published</FieldLabel>
            <FieldDescription id="status-page-published-hint">
              Unpublished pages return 404 to visitors.
            </FieldDescription>
          </div>
        </Field>
        {canEdit && (
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Spinner />}
            Save settings
          </Button>
        )}
      </FieldGroup>
    </form>
  );
}

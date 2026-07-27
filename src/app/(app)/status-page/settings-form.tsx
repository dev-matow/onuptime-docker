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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

import { updateStatusPageAction } from "./actions";

type Visibility = "public" | "private" | "password";

export function StatusPageSettingsForm({
  statusPageId,
  defaults,
  canEdit,
}: {
  statusPageId: string;
  defaults: {
    name: string;
    slug: string;
    published: boolean;
    showBranding: boolean;
    visibility: Visibility;
    hasPassword: boolean;
  };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [published, setPublished] = useState(defaults.published);
  const [showBranding, setShowBranding] = useState(defaults.showBranding);
  const [visibility, setVisibility] = useState<Visibility>(defaults.visibility);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);

    const result = await updateStatusPageAction({
      statusPageId,
      name: String(form.get("name")),
      slug: String(form.get("slug")),
      published,
      showBranding,
      visibility,
      password: String(form.get("password") ?? ""),
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
        <Field orientation="horizontal">
          <Switch
            id="status-page-branding"
            checked={showBranding}
            onCheckedChange={setShowBranding}
            disabled={!canEdit}
            aria-describedby="status-page-branding-hint"
          />
          <div>
            <FieldLabel htmlFor="status-page-branding">
              Show &ldquo;Powered by Vigil&rdquo;
            </FieldLabel>
            <FieldDescription id="status-page-branding-hint">
              Turn it off for a white-label page. Free in both editions.
            </FieldDescription>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="status-page-visibility">Visibility</FieldLabel>
          <Select
            value={visibility}
            onValueChange={(value) => setVisibility(value as Visibility)}
            disabled={!canEdit}
          >
            <SelectTrigger id="status-page-visibility" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public — anyone can view</SelectItem>
              <SelectItem value="private">
                Private — signed-in members only
              </SelectItem>
              <SelectItem value="password">
                Password — anyone with the shared password
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {visibility === "password" && (
          <Field>
            <FieldLabel htmlFor="status-page-password">
              Shared password
            </FieldLabel>
            <Input
              id="status-page-password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={
                defaults.hasPassword
                  ? "Leave blank to keep the current password"
                  : "Set a password"
              }
              maxLength={200}
              disabled={!canEdit}
            />
            <FieldDescription>
              Viewers enter this once; it&apos;s remembered for 12 hours.
            </FieldDescription>
          </Field>
        )}
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

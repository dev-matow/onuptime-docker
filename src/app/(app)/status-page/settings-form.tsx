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

  // One organization owns many status pages and the settings page renders
  // this form once per page, so a fixed `id` is not unique in the
  // document. `htmlFor` resolves to the FIRST element with the id, which
  // means the second page's "Published" label toggles the first page's
  // switch — an operator publishes a page they never opened. Every id
  // here is therefore scoped to the page it belongs to.
  const field = (name: string) => `status-page-${statusPageId}-${name}`;

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
          <FieldLabel htmlFor={field("name")}>Page name</FieldLabel>
          <Input
            id={field("name")}
            name="name"
            defaultValue={defaults.name}
            disabled={!canEdit}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={field("slug")}>Slug</FieldLabel>
          <Input
            id={field("slug")}
            name="slug"
            defaultValue={defaults.slug}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            disabled={!canEdit}
            required
          />
          <FieldDescription>
            Changing the slug changes the public URL. Old links will break.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch
            id={field("published")}
            checked={published}
            onCheckedChange={setPublished}
            disabled={!canEdit}
            aria-describedby={field("published-hint")}
          />
          <div>
            <FieldLabel htmlFor={field("published")}>Published</FieldLabel>
            <FieldDescription id={field("published-hint")}>
              Unpublished pages return 404 to visitors.
            </FieldDescription>
          </div>
        </Field>
        <Field orientation="horizontal">
          <Switch
            id={field("branding")}
            checked={showBranding}
            onCheckedChange={setShowBranding}
            disabled={!canEdit}
            aria-describedby={field("branding-hint")}
          />
          <div>
            <FieldLabel htmlFor={field("branding")}>
              Show &ldquo;Powered by Vigil&rdquo;
            </FieldLabel>
            <FieldDescription id={field("branding-hint")}>
              Turn it off for a white-label page. Free in both editions.
            </FieldDescription>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor={field("visibility")}>Visibility</FieldLabel>
          <Select
            value={visibility}
            onValueChange={(value) => setVisibility(value as Visibility)}
            disabled={!canEdit}
          >
            <SelectTrigger id={field("visibility")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public. Anyone can view</SelectItem>
              <SelectItem value="private">
                Private, signed-in members only
              </SelectItem>
              <SelectItem value="password">
                Password, anyone with the shared password
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {visibility === "password" && (
          <Field>
            <FieldLabel htmlFor={field("password")}>Shared password</FieldLabel>
            <Input
              id={field("password")}
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import { createStatusPageAction } from "./actions";

/**
 * One organization owns as many status pages as it likes — one per
 * client, per product, per audience. The slug is the public URL, so it is
 * unique across the whole install and a clash may be with someone else's
 * page; the error says "taken" and never whose.
 */
export function CreateStatusPageDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await createStatusPageAction({
      name: String(form.get("name")),
      slug: String(form.get("slug")),
    });
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setOpen(false);
    toast.success("Status page created");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New status page</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New status page</DialogTitle>
            <DialogDescription>
              A separate public page with its own components and subscribers.
              Pages start unpublished.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="new-page-name">Name</FieldLabel>
              <Input id="new-page-name" name="name" required maxLength={100} />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-page-slug">Slug</FieldLabel>
              <Input
                id="new-page-slug"
                name="slug"
                required
                minLength={3}
                maxLength={63}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
              />
              <FieldDescription>
                Served at /status/&lt;slug&gt;. Lowercase letters, numbers and
                dashes.
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

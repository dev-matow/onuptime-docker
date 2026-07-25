"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PlusIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  INCIDENT_SEVERITIES,
  type IncidentSeverity,
} from "@/modules/incidents/lifecycle";

import { createIncidentAction } from "./actions";

export function CreateIncidentDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<IncidentSeverity>("major");
  const [pending, setPending] = useState(false);

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) setSeverity("major");
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const message = String(form.get("message") ?? "").trim();

    setPending(true);
    const result = await createIncidentAction({
      title,
      severity,
      message: message.length > 0 ? message : undefined,
    });
    if (!result.ok) {
      toast.error(result.error);
      setPending(false);
      return;
    }
    toast.success("Incident reported.");
    setOpen(false);
    setPending(false);
    router.push(`/incidents/${result.data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          Report incident
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report an incident</DialogTitle>
          <DialogDescription>
            Open an incident to coordinate the response and keep a timeline of
            what happened.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="incident-title">Title</FieldLabel>
              <Input
                id="incident-title"
                name="title"
                placeholder="API latency spike in eu-west"
                maxLength={150}
                required
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="incident-severity">Severity</FieldLabel>
              <Select
                value={severity}
                onValueChange={(value) =>
                  setSeverity(value as IncidentSeverity)
                }
              >
                <SelectTrigger
                  id="incident-severity"
                  className="w-full capitalize"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_SEVERITIES.map((value) => (
                    <SelectItem
                      key={value}
                      value={value}
                      className="capitalize"
                    >
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="incident-message">
                Initial update{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </FieldLabel>
              <Textarea
                id="incident-message"
                name="message"
                placeholder="What do we know so far?"
                maxLength={2000}
                rows={3}
              />
              <FieldDescription>
                Posted as the first entry on the incident timeline.
              </FieldDescription>
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}
                Report incident
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

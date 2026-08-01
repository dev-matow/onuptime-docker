"use client";

import { PlusIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { createMonitorAction } from "./actions";
import {
  MONITOR_FORM_DEFAULTS,
  MonitorForm,
  type MonitorFormValues,
} from "./monitor-form";

export function CreateMonitorDialog(
  // Marked as a whole parameter, not member by member like the sibling
  // dialogs. They keep props the free edition needs; this one does not,
  // and a props type whose every member is commercial strips to `{}` —
  // the "empty object" type, which allows any non-nullish value and
  // which eslint rightly refuses. So the free edition takes no props at
  // all, which is also what its two call sites pass it.
) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(values: MonitorFormValues) {
    setPending(true);
    const result = await createMonitorAction(values);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Monitor created. The first check runs within a minute.");
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          Create monitor
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create monitor</DialogTitle>
          <DialogDescription>
            Vigil probes the URL on the chosen interval and opens an incident
            when it goes down.
          </DialogDescription>
        </DialogHeader>
        <MonitorForm
          initial={MONITOR_FORM_DEFAULTS}
          submitLabel="Create monitor"
          pending={pending}
          onSubmit={handleSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

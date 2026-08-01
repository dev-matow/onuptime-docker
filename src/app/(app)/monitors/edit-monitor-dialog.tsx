"use client";

import { PencilSimpleIcon } from "@phosphor-icons/react";
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

import { updateMonitorAction } from "./actions";
import { MonitorForm, type MonitorFormValues } from "./monitor-form";

export function EditMonitorDialog({
  monitor,
}: {
  monitor: MonitorFormValues & { id: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(values: MonitorFormValues) {
    setPending(true);
    const result = await updateMonitorAction(monitor.id, values);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Monitor updated.");
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilSimpleIcon aria-hidden />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit monitor</DialogTitle>
          <DialogDescription>
            Changes take effect from the next scheduled check.
          </DialogDescription>
        </DialogHeader>
        <MonitorForm
          initial={monitor}
          monitorId={monitor.id}
          submitLabel="Save changes"
          pending={pending}
          onSubmit={handleSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

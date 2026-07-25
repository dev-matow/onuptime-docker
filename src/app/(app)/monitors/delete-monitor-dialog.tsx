"use client";

import { useState } from "react";
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
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import { deleteMonitorAction } from "./actions";

/**
 * Confirmation dialog shared by the table row actions and the detail
 * header. Controlled from outside so it can be triggered from a
 * dropdown menu item without unmounting issues.
 */
export function DeleteMonitorDialog({
  monitorId,
  monitorName,
  open,
  onOpenChange,
  onDeleted,
}: {
  monitorId: string;
  monitorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    setPending(true);
    const result = await deleteMonitorAction(monitorId);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Monitor deleted.");
    onOpenChange(false);
    onDeleted();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete monitor</DialogTitle>
          <DialogDescription>
            This permanently deletes{" "}
            <span className="text-foreground font-medium">{monitorName}</span>{" "}
            along with its entire check history. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void handleDelete()}
          >
            {pending && <Spinner />}
            Delete monitor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

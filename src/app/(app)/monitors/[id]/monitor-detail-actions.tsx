"use client";

import { PauseIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { setMonitorPausedAction } from "../actions";
import { DeleteMonitorDialog } from "../delete-monitor-dialog";
import { EditMonitorDialog } from "../edit-monitor-dialog";
import type { MonitorFormValues } from "../monitor-form";

export function MonitorDetailActions({
  monitor,
  canUpdate,
  canDelete,
}: {
  monitor: MonitorFormValues & { id: string; paused: boolean };
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [pausePending, setPausePending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleTogglePause() {
    setPausePending(true);
    const result = await setMonitorPausedAction(monitor.id, !monitor.paused);
    setPausePending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(monitor.paused ? "Monitor resumed." : "Monitor paused.");
    router.refresh();
  }

  if (!canUpdate && !canDelete) return null;

  return (
    <div className="flex items-center gap-2">
      {canUpdate && (
        <Button
          variant="outline"
          size="sm"
          disabled={pausePending}
          onClick={() => void handleTogglePause()}
        >
          {pausePending ? (
            <Spinner />
          ) : monitor.paused ? (
            <PlayIcon aria-hidden />
          ) : (
            <PauseIcon aria-hidden />
          )}
          {monitor.paused ? "Resume" : "Pause"}
        </Button>
      )}
      {canUpdate && (
        <EditMonitorDialog
          monitor={monitor}
        />
      )}
      {canDelete && (
        <>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon aria-hidden />
            Delete
          </Button>
          <DeleteMonitorDialog
            monitorId={monitor.id}
            monitorName={monitor.name}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDeleted={() => {
              router.push("/monitors");
              router.refresh();
            }}
          />
        </>
      )}
    </div>
  );
}

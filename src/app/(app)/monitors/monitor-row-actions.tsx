"use client";

import {
  DotsThreeIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { setMonitorPausedAction } from "./actions";
import { DeleteMonitorDialog } from "./delete-monitor-dialog";

export function MonitorRowActions({
  monitorId,
  monitorName,
  paused,
  canUpdate,
  canDelete,
}: {
  monitorId: string;
  monitorName: string;
  paused: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleTogglePause() {
    const result = await setMonitorPausedAction(monitorId, !paused);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(paused ? "Monitor resumed." : "Monitor paused.");
    router.refresh();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${monitorName}`}
          >
            <DotsThreeIcon weight="bold" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {canUpdate && (
            <DropdownMenuItem onSelect={() => void handleTogglePause()}>
              {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              {paused ? "Resume checks" : "Pause checks"}
            </DropdownMenuItem>
          )}
          {canUpdate && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              <TrashIcon aria-hidden />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteMonitorDialog
        monitorId={monitorId}
        monitorName={monitorName}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.refresh()}
      />
    </>
  );
}

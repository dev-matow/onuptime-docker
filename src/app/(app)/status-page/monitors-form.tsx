"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

import { setStatusPageMonitorsAction } from "./actions";

interface ComponentRow {
  monitorId: string;
  displayName: string | null;
}

export function StatusPageMonitorsForm({
  statusPageId,
  monitors,
  selected,
  canEdit,
}: {
  statusPageId: string;
  monitors: { id: string; name: string }[];
  selected: ComponentRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<ComponentRow[]>(selected);
  const [pending, setPending] = useState(false);

  function toggle(monitorId: string, checked: boolean) {
    setRows((current) =>
      checked
        ? [...current, { monitorId, displayName: null }]
        : current.filter((row) => row.monitorId !== monitorId),
    );
  }

  function rename(monitorId: string, displayName: string) {
    setRows((current) =>
      current.map((row) =>
        row.monitorId === monitorId
          ? { ...row, displayName: displayName || null }
          : row,
      ),
    );
  }

  async function save() {
    setPending(true);
    const result = await setStatusPageMonitorsAction({
      statusPageId,
      monitors: rows,
    });
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Components updated");
    router.refresh();
  }

  if (monitors.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Create a monitor first — components on the status page mirror your
        monitors.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {monitors.map((monitor) => {
          const row = rows.find((r) => r.monitorId === monitor.id);
          return (
            <li key={monitor.id} className="flex items-center gap-3">
              <Checkbox
                id={`component-${statusPageId}-${monitor.id}`}
                checked={Boolean(row)}
                onCheckedChange={(checked) =>
                  toggle(monitor.id, checked === true)
                }
                disabled={!canEdit}
              />
              <Label
                htmlFor={`component-${statusPageId}-${monitor.id}`}
                className="w-40 truncate"
              >
                {monitor.name}
              </Label>
              <Input
                value={row?.displayName ?? ""}
                onChange={(event) => rename(monitor.id, event.target.value)}
                placeholder={`Public name (default: ${monitor.name})`}
                disabled={!canEdit || !row}
                aria-label={`Public display name for ${monitor.name}`}
                className="flex-1"
              />
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <Button onClick={save} disabled={pending} className="self-start">
          {pending && <Spinner />}
          Save components
        </Button>
      )}
    </div>
  );
}

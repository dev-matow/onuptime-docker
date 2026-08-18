"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BellSlashIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  allowedTransitions,
  INCIDENT_SEVERITIES,
  type IncidentSeverity,
  type IncidentStatus,
} from "@/modules/incidents/lifecycle";

import {
  acknowledgeIncidentAction,
  changeIncidentSeverityAction,
  changeIncidentStatusAction,
} from "../actions";

interface StatusControlsProps {
  incidentId: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  acknowledged: boolean;
  canUpdate: boolean;
  canResolve: boolean;
}

export function StatusControls({
  incidentId,
  status,
  severity,
  acknowledged,
  canUpdate,
  canResolve,
}: StatusControlsProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<IncidentStatus>(status);
  const [message, setMessage] = useState("");
  const [statusPending, setStatusPending] = useState(false);
  const [severityPending, setSeverityPending] = useState(false);
  const [ackPending, setAckPending] = useState(false);

  async function handleAcknowledge() {
    setAckPending(true);
    const result = await acknowledgeIncidentAction(incidentId);
    setAckPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Acknowledged, escalation stopped.");
    router.refresh();
  }

  const resolved = status === "resolved";
  const transitions = allowedTransitions(status).filter((next) =>
    next === "resolved" ? canResolve : canUpdate,
  );
  const nonResolveTransitions = transitions.filter(
    (next) => next !== "resolved",
  );
  const resolving = targetStatus === "resolved";

  function openDialog(next: IncidentStatus) {
    setTargetStatus(next);
    setMessage("");
    setDialogOpen(true);
  }

  function handleDialogOpenChange(next: boolean) {
    if (statusPending) return;
    setDialogOpen(next);
  }

  async function handleStatusSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length === 0) return;

    setStatusPending(true);
    const result = await changeIncidentStatusAction(incidentId, {
      status: targetStatus,
      message: trimmed,
    });
    setStatusPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      targetStatus === "resolved"
        ? "Incident resolved."
        : `Status set to ${targetStatus}.`,
    );
    setDialogOpen(false);
    setMessage("");
    router.refresh();
  }

  async function handleSeverityChange(value: string) {
    setSeverityPending(true);
    const result = await changeIncidentSeverityAction(incidentId, {
      severity: value as IncidentSeverity,
    });
    setSeverityPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(`Severity set to ${value}.`);
    router.refresh();
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {resolved ? (
          <p className="text-muted-foreground text-xs">
            This incident is resolved. The timeline is closed and severity is
            locked.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {/* The filled weight follows the incident's state: on an
                unacknowledged incident the next correct act is to
                acknowledge, so that is the primary; once acknowledged,
                resolving takes the weight. */}
            {canUpdate &&
              (acknowledged ? (
                <p className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
                  <BellSlashIcon aria-hidden className="size-3.5" />
                  Acknowledged, escalation stopped
                </p>
              ) : (
                <Button
                  className="w-full"
                  onClick={handleAcknowledge}
                  disabled={ackPending}
                >
                  {ackPending ? <Spinner /> : <BellSlashIcon aria-hidden />}
                  Acknowledge
                </Button>
              ))}
            {canResolve && (
              <Button
                variant={acknowledged || !canUpdate ? "default" : "outline"}
                className="w-full"
                onClick={() => openDialog("resolved")}
              >
                <CheckCircleIcon aria-hidden />
                Resolve incident
              </Button>
            )}
            {nonResolveTransitions.length > 0 && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => openDialog(nonResolveTransitions[0] ?? status)}
              >
                Update status
              </Button>
            )}
          </div>
        )}

        {canUpdate && (
          <Field>
            <FieldLabel htmlFor="incident-severity-select">Severity</FieldLabel>
            <Select
              value={severity}
              onValueChange={handleSeverityChange}
              disabled={resolved || severityPending}
            >
              <SelectTrigger
                id="incident-severity-select"
                className="w-full capitalize"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCIDENT_SEVERITIES.map((value) => (
                  <SelectItem key={value} value={value} className="capitalize">
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {resolving ? "Resolve incident" : "Update status"}
            </DialogTitle>
            <DialogDescription>
              {resolving
                ? "Resolving is final, the timeline closes and a regression gets a new incident."
                : "Explain the change; the message lands on the incident timeline."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleStatusSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="status-target">New status</FieldLabel>
                <Select
                  value={targetStatus}
                  onValueChange={(value) =>
                    setTargetStatus(value as IncidentStatus)
                  }
                >
                  <SelectTrigger
                    id="status-target"
                    className="w-full capitalize"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {transitions.map((value) => (
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
                <FieldLabel htmlFor="status-message">Message</FieldLabel>
                <Textarea
                  id="status-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={
                    resolving
                      ? "What fixed it, and how was the fix verified?"
                      : "What changed since the last update?"
                  }
                  maxLength={2000}
                  rows={4}
                  required
                />
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={statusPending}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={statusPending || message.trim().length === 0}
                >
                  {statusPending && <Spinner />}
                  {resolving ? "Resolve incident" : "Update status"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

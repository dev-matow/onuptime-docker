"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type {
  DeliveryHistoryEntry,
  DeliveryHistoryPage,
} from "@/modules/notifications/channel-service";
import type { QueueHealth } from "@/modules/notifications/outbox";

import { deliveryAttemptsAction, replayDeliveriesAction } from "./actions";
import type { AttemptView } from "./actions";

/**
 * The delivery ledger, which until 1.18.0 was a function nothing
 * called.
 *
 * The question this answers is the one an operator has at 3am and could
 * not previously ask anywhere: "was anybody actually told, and if not,
 * what is happening about it". Every column here exists because the
 * answer needs it - not the attempt count for its own sake but because
 * seeing 7 of 20 tells you the queue is working, and seeing `expired`
 * tells you it stopped for a reason that is not the same reason as
 * `failed`.
 *
 * Nothing here renders a payload. A delivery's payload is the rendered
 * message and can carry a monitor name, a URL and an incident title;
 * the ledger's job is the fate of the message, not its contents.
 */

/** Terminal states an operator is allowed to replay. */
const REPLAYABLE = new Set(["delivered", "failed", "expired", "dead_letter"]);

const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  delivered: "Delivered",
  failed: "Rejected",
  expired: "Expired",
  dead_letter: "Dead letter",
};

function StateBadge({ state }: { state: string }) {
  const label = STATE_LABEL[state] ?? state;
  if (state === "delivered") return <Badge>{label}</Badge>;
  if (state === "queued" || state === "sending") {
    return <Badge variant="secondary">{label}</Badge>;
  }
  return <Badge variant="destructive">{label}</Badge>;
}

/** Compact relative age: the number an operator scans a column for. */
function age(from: Date | string, to: Date = new Date()): string {
  const ms = to.getTime() - new Date(from).getTime();
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function when(value: Date | string | null): string {
  if (!value) return "-";
  const at = new Date(value);
  const ms = at.getTime() - Date.now();
  return ms > 0 ? `in ${age(new Date(), at)}` : `${age(at)} ago`;
}

/**
 * The queue at a glance.
 *
 * Six numbers rather than a chart, and `oldestQueuedAt` is the one that
 * matters: it is the delay an actual page is suffering right now, which
 * no per-row status can show. `unknownAttempts` is second - it is the
 * only honest surface for "a message may have gone twice", and it is
 * normally zero, so a non-zero value is worth seeing without hunting.
 *
 * Pending dispatch intents are counted in the queue rather than beside
 * it. To anyone waiting to be told, a transition whose messages have not
 * been written yet and a message that has not been sent are the same
 * thing, and showing them apart would let a queue stuck at the expansion
 * step read as empty.
 */
function QueueHealthCard({ health }: { health: QueueHealth }) {
  const pressure = health.queued + health.sending + health.pendingIntents;
  const unhappy =
    health.failed + health.expired + health.deadLettered + health.failedIntents;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div>
        <p className="text-2xl font-medium tabular-nums">{pressure}</p>
        <p className="text-muted-foreground text-xs">
          In the queue
          {health.sending > 0 ? ` · ${health.sending} sending` : ""}
          {health.pendingIntents > 0
            ? ` · ${health.pendingIntents} not yet expanded`
            : ""}
        </p>
      </div>
      <div>
        <p className="text-2xl font-medium tabular-nums">
          {health.oldestQueuedAt ? age(health.oldestQueuedAt) : "-"}
        </p>
        <p className="text-muted-foreground text-xs">Oldest waiting</p>
      </div>
      <div>
        <p className="text-2xl font-medium tabular-nums">{unhappy}</p>
        <p className="text-muted-foreground text-xs">
          Not delivered · {health.windowHours}h
        </p>
      </div>
      <div>
        <p
          className={`text-2xl font-medium tabular-nums ${
            health.unknownAttempts > 0 ? "text-amber-500" : ""
          }`}
        >
          {health.unknownAttempts}
        </p>
        <p className="text-muted-foreground text-xs">Attempts with no answer</p>
      </div>
    </div>
  );
}

export function DeliveryLedger({
  page,
  health,
  pageNumber,
  pageSize,
  providers,
  filters,
  canReplay,
}: {
  page: DeliveryHistoryPage;
  health: QueueHealth;
  pageNumber: number;
  pageSize: number;
  providers: { id: string; label: string }[];
  filters: { state: string; provider: string };
  canReplay: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pendingNav, startNav] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<DeliveryHistoryEntry | null>(null);
  const [attempts, setAttempts] = useState<AttemptView[] | null>(null);

  const totalPages = Math.max(Math.ceil(page.total / pageSize), 1);
  const providerLabel = new Map(providers.map((p) => [p.id, p.label]));

  function navigate(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("dpage" in patch)) next.delete("dpage");
    startNav(() => router.push(`/settings/notifications?${next.toString()}`));
  }

  async function open(row: DeliveryHistoryEntry) {
    setDetail(row);
    setAttempts(null);
    const result = await deliveryAttemptsAction({ id: row.id });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setAttempts(result.data);
  }

  async function replay(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    const result = await replayDeliveriesAction({ ids });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `${result.data.replayed} queued again${
        result.data.skipped > 0
          ? `, ${result.data.skipped} skipped (still in progress)`
          : ""
      }.`,
    );
    setSelected(new Set());
    setDetail(null);
    router.refresh();
  }

  const replayable = page.rows.filter((row) => REPLAYABLE.has(row.state));
  const allSelected =
    replayable.length > 0 && replayable.every((row) => selected.has(row.id));

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>Deliveries</CardTitle>
            <span className="text-muted-foreground text-xs">
              {page.total} in this view
            </span>
          </div>
          <CardDescription>
            What actually happened to each notification: how many attempts it
            spent, when the next one is due, and why it stopped. Messages are
            retried for hours, not seconds; one that runs out of attempts is a
            dead letter, one that runs out of time is expired, and one a
            provider rejected outright is neither.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueueHealthCard health={health} />

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={filters.state || "all"}
              onValueChange={(v) => navigate({ dstate: v === "all" ? "" : v })}
            >
              <SelectTrigger className="w-44" aria-label="Filter by state">
                <SelectValue placeholder="Any state" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any state</SelectItem>
                <SelectItem value="unhappy">Anything not delivered</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="sending">Sending</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="failed">Rejected</SelectItem>
                <SelectItem value="dead_letter">Dead letter</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.provider || "all"}
              onValueChange={(v) =>
                navigate({ dprovider: v === "all" ? "" : v })
              }
            >
              <SelectTrigger className="w-44" aria-label="Filter by provider">
                <SelectValue placeholder="Any provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any provider</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canReplay && selected.size > 0 && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void replay([...selected])}
              >
                {busy && <Spinner />}
                Replay {selected.size}
              </Button>
            )}
          </div>

          {page.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing here yet. Every notification Vigil decides to send appears
              in this list with what happened to it.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {canReplay && replayable.length > 0 && (
                <li className="flex items-center gap-2 px-1 pb-1">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(next) =>
                      setSelected((prev) => {
                        const copy = new Set(prev);
                        for (const row of replayable) {
                          if (next) copy.add(row.id);
                          else copy.delete(row.id);
                        }
                        return copy;
                      })
                    }
                    aria-label="Select every finished delivery on this page"
                  />
                  <span className="text-muted-foreground text-xs">
                    Select finished deliveries on this page
                  </span>
                </li>
              )}
              {page.rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3"
                >
                  {canReplay && (
                    <Checkbox
                      checked={selected.has(row.id)}
                      disabled={!REPLAYABLE.has(row.state)}
                      onCheckedChange={(next) =>
                        setSelected((prev) => {
                          const copy = new Set(prev);
                          if (next) copy.add(row.id);
                          else copy.delete(row.id);
                          return copy;
                        })
                      }
                      aria-label={`Select delivery to ${row.destination}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateBadge state={row.state} />
                      <span className="text-sm font-medium">
                        {providerLabel.get(row.provider) ?? row.provider}
                      </span>
                      {row.event && (
                        <span className="text-muted-foreground font-mono text-xs">
                          {row.event}
                        </span>
                      )}
                      {row.replayOf && <Badge variant="outline">Replay</Badge>}
                      {row.unknownAttempts > 0 && (
                        <Badge variant="outline" className="text-amber-500">
                          {row.unknownAttempts} with no answer
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground truncate text-xs">
                      {row.destination}
                      {" · "}
                      {row.attempts === 0
                        ? "not yet attempted"
                        : `${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`}
                      {" · "}
                      {age(row.createdAt)} old
                      {row.nextAttemptAt
                        ? ` · next ${when(row.nextAttemptAt)}`
                        : ""}
                    </p>
                    {row.lastError && (
                      <p
                        className="text-muted-foreground mt-0.5 truncate text-xs"
                        title={row.lastError}
                      >
                        {row.lastError}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void open(row)}
                  >
                    Attempts
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                Page {pageNumber} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageNumber <= 1 || pendingNav}
                  onClick={() => navigate({ dpage: String(pageNumber - 1) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageNumber >= totalPages || pendingNav}
                  onClick={() => navigate({ dpage: String(pageNumber + 1) })}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Attempts</DialogTitle>
            <DialogDescription>
              {detail?.destination} · {detail?.event ?? "notification"}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StateBadge state={detail.state} />
                <span className="text-muted-foreground text-xs">
                  decided {age(detail.createdAt)} ago
                  {detail.expiresAt
                    ? ` · expires ${when(detail.expiresAt)}`
                    : ""}
                </span>
              </div>

              {attempts === null ? (
                <p className="text-muted-foreground text-sm">Loading…</p>
              ) : attempts.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No attempt has started yet.
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {attempts.map((attempt) => (
                    <li
                      key={attempt.attempt}
                      className="rounded-md border p-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">
                          #{attempt.attempt}
                        </span>
                        <Badge
                          variant={
                            attempt.outcome === "delivered"
                              ? "default"
                              : attempt.outcome === "unknown" ||
                                  attempt.outcome === "claimed"
                                ? "outline"
                                : "secondary"
                          }
                        >
                          {attempt.outcome}
                        </Badge>
                        {attempt.httpStatus && (
                          <span className="text-muted-foreground font-mono text-xs">
                            HTTP {attempt.httpStatus}
                          </span>
                        )}
                        <span className="text-muted-foreground ml-auto text-xs">
                          {age(attempt.startedAt)} ago
                        </span>
                      </div>
                      {attempt.error && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {attempt.error}
                        </p>
                      )}
                      {attempt.providerMessageId && (
                        <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
                          {attempt.providerMessageId}
                        </p>
                      )}
                      {attempt.retryAfterMs && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          Provider asked for{" "}
                          {Math.round(attempt.retryAfterMs / 1000)}s
                        </p>
                      )}
                      {attempt.outcome === "unknown" && (
                        <p className="mt-1 text-xs text-amber-500">
                          This attempt never reported an outcome, so a duplicate
                          at the other end cannot be ruled out.
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {canReplay && REPLAYABLE.has(detail.state) && (
                <div>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void replay([detail.id])}
                  >
                    {busy && <Spinner />}
                    Send again
                  </Button>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Queues a new delivery. This record keeps its own history.
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

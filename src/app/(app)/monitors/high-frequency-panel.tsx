"use client";

import { WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  highFrequencyCapability,
  HF_MAX_INTERVAL_MS,
  HF_MIN_INTERVAL_MS,
} from "@/modules/monitors/highfreq/capabilities";

import {
  cadenceReportAction,
  setHighFrequencyAction,
  type CadenceReport,
} from "./high-frequency-actions";

/**
 * The high-frequency toggle: the cost, the request, and the result.
 *
 * Three things have to be on screen at once, and each of them is here
 * because leaving it out is a specific dishonesty:
 *
 * 1. **The cost, before the switch is flipped.** Sub-second monitoring
 *    is not free and is not free in a way the operator can discover
 *    afterwards — it is CPU on the worker, rows in Postgres and requests
 *    at the target, and the person enabling it is usually not the person
 *    who gets paged about the disk.
 * 2. **The configured cadence and the achieved cadence, separately.**
 *    Never one number. Until this release the product showed only what
 *    the operator typed, and what it delivered was roughly four times
 *    that at the shortest setting the form would accept.
 * 3. **That neither number is a detection time.** The panel says so in
 *    the one sentence there is room for and links to the document that
 *    sets out the five terms detection is actually made of.
 *
 * It writes through its own server action rather than the form's submit,
 * like the push-endpoint controls above it: enabling is refusable for
 * reasons that have nothing to do with the rest of the form (the check
 * type's cost, the organization's quota), and an operator who renamed a
 * monitor should not be told about a quota.
 */
export function HighFrequencyPanel({
  monitorId,
  checkType,
}: {
  /** Absent while creating: there is nothing to enable it on yet. */
  monitorId?: string;
  checkType: string;
}) {
  const id = useId();
  const capability = highFrequencyCapability(checkType);
  const [enabled, setEnabled] = useState(false);
  const [intervalMs, setIntervalMs] = useState(String(HF_MIN_INTERVAL_MS));
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<CadenceReport | null>(null);

  // The panel reads its own state rather than taking it as a prop. The
  // alternative is threading two more fields through `MonitorFormValues`
  // and both dialogs that build one, for a control that already has to
  // talk to the server for the achieved figure anyway.
  /**
   * Applies a report, unless the caller has since lost interest.
   *
   * `alive` is not ceremony: the fetch outlives the render that started
   * it, so a panel unmounted mid-flight — or one whose monitor changed —
   * would otherwise set state for a monitor nobody is looking at, and
   * briefly show the previous monitor's cadence against the new one.
   */
  const applyReport = useCallback(
    (data: CadenceReport, alive: () => boolean) => {
      if (!alive()) return;
      setReport(data);
      setEnabled(data.configuredIntervalMs !== null);
      if (data.configuredIntervalMs !== null) {
        setIntervalMs(String(data.configuredIntervalMs));
      }
    },
    [],
  );

  const refresh = useCallback(
    async (alive: () => boolean = () => true) => {
      if (!monitorId) return;
      const result = await cadenceReportAction(monitorId);
      if (!result.ok) return;
      applyReport(result.data, alive);
    },
    [monitorId, applyReport],
  );

  // Fetching on mount, which is what an effect is for. The rule below
  // cannot see that every `setState` here happens after an `await` and
  // so is not synchronous — it only sees that a setter is reachable from
  // the effect. The cascading render it warns about is real when the
  // setter runs during the effect body; this one runs a network
  // round-trip later, and `live` is what stops it running at all if the
  // panel has gone away by then.
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(() => live);
    return () => {
      live = false;
    };
  }, [refresh]);

  if (!capability.supportsHighFrequency) {
    // Rendered as an explanation rather than hidden. A control that is
    // simply absent for this type reads as "not built yet", and the
    // operator goes looking for it in the documentation; the reason is
    // short and it is the answer to their next question.
    return (
      <FieldSet>
        <FieldLegend variant="label">High-frequency checks</FieldLegend>
        <FieldDescription>
          Not available for this check type. {capability.excludedBecause} It is
          checked on the ordinary schedule instead.
        </FieldDescription>
      </FieldSet>
    );
  }

  async function apply(nextEnabled: boolean) {
    if (!monitorId) return;
    setPending(true);
    const result = await setHighFrequencyAction(monitorId, {
      enabled: nextEnabled,
      ...(nextEnabled ? { intervalMs: Number(intervalMs) } : {}),
    });
    setPending(false);
    if (!result.ok) {
      // The switch snaps back: the server refused, so the stored state
      // is the old one, and leaving the control showing the new one
      // would be the UI telling the operator something that is not true.
      setEnabled(!nextEnabled);
      toast.error(result.error);
      return;
    }
    setEnabled(nextEnabled);
    toast.success(
      nextEnabled
        ? `Now checked every ${intervalMs}ms. Watch the achieved figure below.`
        : "Back on the ordinary schedule.",
    );
    await refresh();
  }

  return (
    <FieldSet>
      <FieldLegend variant="label">High-frequency checks</FieldLegend>
      <FieldDescription>
        Probe this monitor several times a second on a separate scheduler,
        instead of on the ordinary queue.
      </FieldDescription>

      {/* The cost, above the switch, not below it. */}
      <div className="border-muted-foreground/30 text-muted-foreground flex gap-3 rounded-md border border-dashed p-3 text-sm">
        <WarningIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p>
            At {HF_MIN_INTERVAL_MS}ms this monitor issues{" "}
            <strong>
              {Math.round(1000 / HF_MIN_INTERVAL_MS)} requests a second
            </strong>{" "}
            at your target, around the clock — about{" "}
            {Math.round((86_400 * 1000) / HF_MIN_INTERVAL_MS / 1000)} thousand a
            day. Each one costs CPU on the worker and a row in Postgres.
          </p>
          <p>
            Raw samples are kept for two hours and then aggregated into minute,
            hour and day buckets. Your worker and your database carry this, not
            a hosted service.
          </p>
          <p>
            <strong>This is a cadence, not a detection time.</strong> How long
            it takes to find out about an outage also depends on the
            probe&apos;s own duration, your failure window, and how fast the
            notification goes out. See <code>docs/HIGH-FREQUENCY.md</code>.
          </p>
        </div>
      </div>

      {monitorId === undefined ? (
        <FieldDescription>
          Create the monitor first, then open it to turn this on.
        </FieldDescription>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              disabled={pending}
              onCheckedChange={(next) => {
                setEnabled(next);
                void apply(next);
              }}
            />
            <FieldLabel htmlFor={`${id}-enabled`}>
              Check at high frequency
            </FieldLabel>
            {pending && <Spinner />}
          </div>

          {enabled && (
            <div className="grid grid-cols-[auto_1fr] items-end gap-4">
              <Field>
                <FieldLabel htmlFor={`${id}-interval`}>
                  Configured interval (ms)
                </FieldLabel>
                <Input
                  id={`${id}-interval`}
                  type="number"
                  min={HF_MIN_INTERVAL_MS}
                  max={HF_MAX_INTERVAL_MS}
                  step={50}
                  className="w-36"
                  value={intervalMs}
                  onChange={(event) => setIntervalMs(event.target.value)}
                />
                <FieldDescription>
                  {HF_MIN_INTERVAL_MS}–{HF_MAX_INTERVAL_MS}ms. What you are
                  asking for.
                </FieldDescription>
              </Field>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void apply(true)}
              >
                Apply interval
              </Button>
            </div>
          )}

          <AchievedCadenceReadout report={report} />
        </>
      )}
    </FieldSet>
  );
}

/**
 * What actually happened, measured from the samples.
 *
 * Deliberately shows p50 *and* p95 *and* the missed-slot count rather
 * than a single "actual interval". A p50 on target with a p95 at four
 * times the configured interval is a monitor that is mostly fine and
 * occasionally blind, and one number cannot say that.
 */
function AchievedCadenceReadout({ report }: { report: CadenceReport | null }) {
  if (report === null) {
    return <FieldDescription>Measuring the achieved cadence…</FieldDescription>;
  }
  const { achieved, configuredIntervalMs } = report;
  if (achieved.samples === 0) {
    return (
      <FieldDescription>
        No samples in the last {achieved.windowMinutes} minutes. If this monitor
        was only just enabled, the worker picks it up within a few seconds; if
        it stays empty, no worker is running the high-frequency plane and the
        monitor is being checked on the ordinary schedule instead.
      </FieldDescription>
    );
  }
  return (
    <div className="text-muted-foreground space-y-1 text-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <Figure label="Configured" value={ms(configuredIntervalMs)} />
        <Figure label="Achieved p50" value={ms(achieved.p50Ms)} />
        <Figure label="Achieved p95" value={ms(achieved.p95Ms)} />
        <Figure label="Achieved p99" value={ms(achieved.p99Ms)} />
      </div>
      <p>
        {achieved.samples.toLocaleString()} samples over the last{" "}
        {achieved.windowMinutes} minutes, longest gap {ms(achieved.maxMs)},{" "}
        {achieved.missedSlots.toLocaleString()} slots missed. A missed slot is a
        gap of at least twice the configured interval — the scheduler skips them
        rather than firing a burst to catch up.
      </p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase">{label}</div>
      <div className="text-foreground font-mono">{value}</div>
    </div>
  );
}

function ms(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString()} ms`;
}

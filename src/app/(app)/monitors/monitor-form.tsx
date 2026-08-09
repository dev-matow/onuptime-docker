"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import {
  CHECK_TYPE_DESCRIPTORS,
  DEFAULT_HEARTBEAT_GRACE_SECONDS,
  describeCheckType,
  DNS_RECORD_TYPES,
} from "@/modules/monitors/types/catalog";
import { MIN_INTERVAL_SECONDS } from "@/modules/monitors/schemas";
import type { FormSection } from "@/modules/monitors/types/contract";
import { MANUAL_STATUSES } from "@/modules/monitors/types/specs/manual";

import {
  listGroupOptionsAction,
  pushEndpointAction,
  regeneratePushTokenAction,
} from "./actions";
import { HighFrequencyPanel } from "./high-frequency-panel";

/** Editable subset of a monitor, shared by the create and edit dialogs. */
export interface MonitorFormValues {
  name: string;
  checkType: string;
  url: string;
  /** The group this monitor belongs to, or null. */
  parentId: string | null;
  port: number | null;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  bodyKeyword: string | null;
  keywordAbsent: boolean;
  tlsCheck: boolean;
  tlsWarnDays: number;
  failureWindowSeconds: number;
  /** Type-specific settings; shape is decided by the check type. */
  config: Record<string, unknown> | null;
}

export const MONITOR_FORM_DEFAULTS: MonitorFormValues = {
  name: "",
  checkType: "http",
  url: "",
  parentId: null,
  port: null,
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10_000,
  degradedThresholdMs: 3_000,
  expectedStatusCode: null,
  bodyKeyword: null,
  keywordAbsent: false,
  tlsCheck: false,
  tlsWarnDays: 14,
  failureWindowSeconds: 120,
  config: null,
};

/**
 * Suggestions, not the menu. Until 1.10.0 this was a six-value dropdown
 * and the number could be nothing else; now the scheduler tightens and
 * relaxes around whatever baseline the operator picks, so restricting
 * it to six values would only stop them expressing the one they want.
 */
const INTERVAL_SUGGESTIONS = [10, 30, 60, 120, 300, 600, 1800, 3600];
const FAILURE_WINDOW_SUGGESTIONS = [0, 30, 60, 120, 300, 600];

function humanSeconds(seconds: number): string {
  if (seconds === 0) return "immediately";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = seconds / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  }
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function readNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The sentinel a Radix select needs, because "" is not a legal value. */
const NO_GROUP = "none";

export function MonitorForm({
  initial,
  monitorId,
  submitLabel,
  pending,
  onSubmit,
}: {
  initial: MonitorFormValues;
  /** Present when editing. The push endpoint can only be asked for by id. */
  monitorId?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: MonitorFormValues) => void | Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [checkType, setCheckType] = useState(initial.checkType);
  const [url, setUrl] = useState(initial.url);
  const [parentId, setParentId] = useState(initial.parentId ?? NO_GROUP);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [port, setPort] = useState(
    initial.port === null ? "" : String(initial.port),
  );
  const [tlsCheck, setTlsCheck] = useState(initial.tlsCheck);
  const [method, setMethod] = useState<MonitorFormValues["method"]>(
    initial.method,
  );
  const [intervalSeconds, setIntervalSeconds] = useState(
    String(initial.intervalSeconds),
  );
  const [timeoutMs, setTimeoutMs] = useState(String(initial.timeoutMs));
  const [degradedThresholdMs, setDegradedThresholdMs] = useState(
    String(initial.degradedThresholdMs),
  );
  const [expectedStatusCode, setExpectedStatusCode] = useState(
    initial.expectedStatusCode === null
      ? ""
      : String(initial.expectedStatusCode),
  );
  const [bodyKeyword, setBodyKeyword] = useState(initial.bodyKeyword ?? "");
  const [keywordAbsent, setKeywordAbsent] = useState(
    initial.keywordAbsent ? "absent" : "present",
  );
  const [failureWindowSeconds, setFailureWindowSeconds] = useState(
    String(initial.failureWindowSeconds),
  );
  const [recordType, setRecordType] = useState(
    String(initial.config?.recordType ?? "A"),
  );
  const [expectedValue, setExpectedValue] = useState(
    String(initial.config?.expectedValue ?? ""),
  );
  const [warnDays, setWarnDays] = useState(
    String(
      initial.config?.warnDays ?? (checkType === "domain-expiry" ? 30 : 14),
    ),
  );
  const [graceSeconds, setGraceSeconds] = useState(
    String(initial.config?.graceSeconds ?? DEFAULT_HEARTBEAT_GRACE_SECONDS),
  );
  const [manualStatus, setManualStatus] = useState(
    String(initial.config?.status ?? "up"),
  );
  const [manualNote, setManualNote] = useState(
    String(initial.config?.note ?? ""),
  );
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [endpointPending, setEndpointPending] = useState(false);

  const descriptor = describeCheckType(checkType);
  const shows = (section: FormSection) => descriptor.form.includes(section);
  const takesPort = descriptor.port !== null;
  // What the operator is being asked for changes with the kind, and the
  // fields that stop applying have to disappear rather than sit there
  // inert: a "Timeout" on a group is a promise that something will be
  // dialled, and a "Check interval" on a manual monitor implies Vigil
  // will look again on its own. It will not.
  const measuresLatency =
    descriptor.kind !== "aggregate" && descriptor.kind !== "manual";
  const dials = descriptor.kind === "active";
  const scheduled =
    descriptor.kind === "active" || descriptor.kind === "passive";

  // Group membership is not a property of the check type — anything can
  // belong to a group — so the picker is fetched once by the form
  // instead of being threaded as a prop through every dialog that
  // renders one.
  useEffect(() => {
    let live = true;
    void listGroupOptionsAction(monitorId).then((result) => {
      if (live && result.ok) setGroups(result.data);
    });
    return () => {
      live = false;
    };
  }, [monitorId]);

  async function revealEndpoint(regenerate: boolean) {
    if (!monitorId) return;
    setEndpointPending(true);
    const result = regenerate
      ? await regeneratePushTokenAction(monitorId)
      : await pushEndpointAction(monitorId);
    setEndpointPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEndpoint(result.data.url);
    if (regenerate)
      toast.success("New token issued. The old one no longer works.");
  }

  function buildConfig(): Record<string, unknown> | null {
    if (shows("dnsRecord")) {
      const expected = expectedValue.trim();
      return { recordType, expectedValue: expected === "" ? null : expected };
    }
    if (shows("expiryWarning")) {
      return { warnDays: readNumber(warnDays, 14) };
    }
    if (shows("heartbeatGrace")) {
      // Deliberately no `token`: the form has never been given the real
      // one, and a field absent from the patch means "keep what is
      // stored" — which on create means "generate one".
      return {
        graceSeconds: readNumber(graceSeconds, DEFAULT_HEARTBEAT_GRACE_SECONDS),
      };
    }
    if (shows("manualStatus")) {
      const note = manualNote.trim();
      return { status: manualStatus, note: note === "" ? null : note };
    }
    return null;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Only send what this type actually has. The server normalises the
    // same way from the same descriptor, so the two cannot disagree —
    // but sending a stale keyword for a DNS monitor would still be a
    // confusing thing to put on the wire.
    const keyword =
      shows("keyword") && method === "GET" ? bodyKeyword.trim() : "";
    void onSubmit({
      name: name.trim(),
      checkType,
      url: url.trim(),
      parentId: parentId === NO_GROUP ? null : parentId,
      port: takesPort && port.trim() !== "" ? Number(port) : null,
      method: shows("method") ? method : "GET",
      intervalSeconds: readNumber(intervalSeconds, 60),
      timeoutMs: readNumber(timeoutMs, 10_000),
      degradedThresholdMs: readNumber(degradedThresholdMs, 3_000),
      expectedStatusCode:
        shows("expectedStatusCode") && expectedStatusCode.trim() !== ""
          ? Number(expectedStatusCode)
          : null,
      bodyKeyword: keyword === "" ? null : keyword,
      keywordAbsent: keywordAbsent === "absent",
      tlsCheck:
        shows("tlsWarning") && url.trim().toLowerCase().startsWith("https:")
          ? tlsCheck
          : false,
      tlsWarnDays: initial.tlsWarnDays,
      failureWindowSeconds: readNumber(failureWindowSeconds, 120),
      config: buildConfig(),
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Marketing site"
            maxLength={100}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-check-type`}>Check type</FieldLabel>
          <Select value={checkType} onValueChange={setCheckType}>
            <SelectTrigger id={`${id}-check-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECK_TYPE_DESCRIPTORS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{descriptor.description}</FieldDescription>
        </Field>
        <div className={takesPort ? "grid grid-cols-[1fr_auto] gap-4" : ""}>
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>
              {descriptor.target.label}
            </FieldLabel>
            <Input
              id={`${id}-url`}
              type={descriptor.target.kind === "url" ? "url" : "text"}
              inputMode={descriptor.target.kind === "url" ? "url" : "text"}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={descriptor.target.placeholder}
              className="font-mono"
              required
            />
            <FieldDescription>{descriptor.target.help}</FieldDescription>
          </Field>
          {takesPort && (
            <Field>
              <FieldLabel htmlFor={`${id}-port`}>Port</FieldLabel>
              <Input
                id={`${id}-port`}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder={
                  descriptor.port?.default === null
                    ? "5432"
                    : String(descriptor.port?.default)
                }
                className="w-28"
                required={descriptor.port?.required ?? false}
              />
            </Field>
          )}
        </div>
        {groups.length > 0 && (
          <Field>
            <FieldLabel htmlFor={`${id}-group`}>Group</FieldLabel>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id={`${id}-group`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>No group</SelectItem>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              A group is down when any of its members is. Membership changes the
              group&apos;s state immediately.
            </FieldDescription>
          </Field>
        )}
        {shows("heartbeatGrace") &&
          // Only when the monitor exists: there is no endpoint to show
          // before it has been created, and a labelled field with
          // nothing behind it is a control that promises something.
          (monitorId ? (
            <Field>
              <FieldLabel htmlFor={`${id}-endpoint`}>Push endpoint</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-endpoint`}
                  readOnly
                  value={endpoint ?? "••••••••••••••••••••••••••••••••"}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={endpointPending}
                  onClick={() => void revealEndpoint(false)}
                >
                  {endpointPending && <Spinner />}
                  Show
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={endpointPending}
                  onClick={() => void revealEndpoint(true)}
                >
                  Regenerate
                </Button>
              </div>
              <FieldDescription>
                Have your job call this URL when it finishes. Add{" "}
                <code>?status=down&amp;msg=what+broke</code> to report a
                failure, or <code>?ping=1234</code> to record how long the job
                took. Anyone holding this URL can say this monitor is fine,
                treat it like a password.
              </FieldDescription>
            </Field>
          ) : (
            <FieldDescription>
              Vigil generates a secret push URL when you create this monitor.
              Open the monitor afterwards to copy it into your job.
            </FieldDescription>
          ))}
        {shows("manualStatus") && (
          <div className="grid grid-cols-[auto_1fr] gap-4">
            <Field>
              <FieldLabel htmlFor={`${id}-manual-status`}>Status</FieldLabel>
              <Select value={manualStatus} onValueChange={setManualStatus}>
                <SelectTrigger id={`${id}-manual-status`} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status === "up"
                        ? "Operational"
                        : status === "degraded"
                          ? "Degraded"
                          : "Down"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Stays until you change it.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-manual-note`}>Note</FieldLabel>
              <Input
                id={`${id}-manual-note`}
                value={manualNote}
                onChange={(event) => setManualNote(event.target.value)}
                placeholder="e.g. vendor reports elevated error rates"
                maxLength={500}
              />
              <FieldDescription>
                Shown on the timeline and in the incident this opens.
              </FieldDescription>
            </Field>
          </div>
        )}
        {descriptor.requiresCapability === "icmp" && (
          <FieldDescription>
            ICMP needs a raw socket. If the worker cannot open one, this monitor
            reports <strong>unknown</strong> with an explanation, never a false
            outage.
          </FieldDescription>
        )}
        {shows("dnsRecord") && (
          <div className="grid grid-cols-[auto_1fr] gap-4">
            <Field>
              <FieldLabel htmlFor={`${id}-record-type`}>Record type</FieldLabel>
              <Select value={recordType} onValueChange={setRecordType}>
                <SelectTrigger id={`${id}-record-type`} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNS_RECORD_TYPES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-expected-value`}>
                Expected value
              </FieldLabel>
              <Input
                id={`${id}-expected-value`}
                value={expectedValue}
                onChange={(event) => setExpectedValue(event.target.value)}
                placeholder="leave empty to only require an answer"
                maxLength={255}
                className="font-mono"
              />
              <FieldDescription>
                At least one record must contain this text.
              </FieldDescription>
            </Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          {shows("method") && (
            <Field>
              <FieldLabel htmlFor={`${id}-method`}>Method</FieldLabel>
              <Select
                value={method}
                onValueChange={(value) =>
                  setMethod(value as MonitorFormValues["method"])
                }
              >
                <SelectTrigger id={`${id}-method`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="HEAD">HEAD</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {scheduled && (
            <Field>
              <FieldLabel htmlFor={`${id}-interval`}>
                {dials
                  ? "Check interval (seconds)"
                  : "Expected heartbeat interval (seconds)"}
              </FieldLabel>
              <Input
                id={`${id}-interval`}
                type="number"
                min={MIN_INTERVAL_SECONDS}
                max={86_400}
                step={1}
                list={`${id}-interval-options`}
                value={intervalSeconds}
                onChange={(event) => setIntervalSeconds(event.target.value)}
                required
              />
              <datalist id={`${id}-interval-options`}>
                {INTERVAL_SUGGESTIONS.map((seconds) => (
                  <option key={seconds} value={seconds} />
                ))}
              </datalist>
              <FieldDescription>
                {dials ? (
                  <>
                    {humanSeconds(readNumber(intervalSeconds, 60))}, a baseline,
                    not a fixed rate. Vigil checks more often when a target
                    looks suspicious and backs off when it has been steady.
                  </>
                ) : (
                  <>
                    How often the job is supposed to check in. Go this long
                    without a heartbeat (plus the grace below) and the monitor
                    is down.
                  </>
                )}
              </FieldDescription>
            </Field>
          )}
        </div>
        <FieldSet>
          <FieldLegend variant="label">Advanced</FieldLegend>
          <FieldDescription>
            Tune when a check counts as degraded or failed.
          </FieldDescription>
          <div className="grid grid-cols-2 gap-4">
            {dials && (
              <Field>
                <FieldLabel htmlFor={`${id}-timeout`}>Timeout (ms)</FieldLabel>
                <Input
                  id={`${id}-timeout`}
                  type="number"
                  min={1000}
                  max={30_000}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                  required
                />
              </Field>
            )}
            {measuresLatency && (
              <Field>
                <FieldLabel htmlFor={`${id}-degraded`}>
                  Degraded above (ms)
                </FieldLabel>
                <Input
                  id={`${id}-degraded`}
                  type="number"
                  min={100}
                  max={30_000}
                  value={degradedThresholdMs}
                  onChange={(event) =>
                    setDegradedThresholdMs(event.target.value)
                  }
                  required
                />
                {shows("heartbeatGrace") && (
                  <FieldDescription>
                    Applied to the duration a job reports with{" "}
                    <code>?ping=</code>, not to a round trip Vigil measured.
                  </FieldDescription>
                )}
              </Field>
            )}
            {shows("heartbeatGrace") && (
              <Field>
                <FieldLabel htmlFor={`${id}-grace`}>
                  Heartbeat grace (seconds)
                </FieldLabel>
                <Input
                  id={`${id}-grace`}
                  type="number"
                  min={0}
                  max={86_400}
                  value={graceSeconds}
                  onChange={(event) => setGraceSeconds(event.target.value)}
                  required
                />
                <FieldDescription>
                  How late a heartbeat may be before the silence counts. A cron
                  on a 60s timer does not deliver every 60.000s.
                </FieldDescription>
              </Field>
            )}
            {shows("expectedStatusCode") && (
              <Field>
                <FieldLabel htmlFor={`${id}-expected-status`}>
                  Expected status code
                </FieldLabel>
                <Input
                  id={`${id}-expected-status`}
                  type="number"
                  min={100}
                  max={599}
                  value={expectedStatusCode}
                  onChange={(event) =>
                    setExpectedStatusCode(event.target.value)
                  }
                  placeholder="any 2xx/3xx"
                />
              </Field>
            )}
            {shows("expiryWarning") && (
              <Field>
                <FieldLabel htmlFor={`${id}-warn-days`}>
                  Warn when fewer than (days)
                </FieldLabel>
                <Input
                  id={`${id}-warn-days`}
                  type="number"
                  min={1}
                  max={365}
                  value={warnDays}
                  onChange={(event) => setWarnDays(event.target.value)}
                  required
                />
                <FieldDescription>
                  Reported as degraded. Already expired is an outage.
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-failure-window`}>
                Down for (seconds)
              </FieldLabel>
              <Input
                id={`${id}-failure-window`}
                type="number"
                min={0}
                max={86_400}
                step={1}
                list={`${id}-failure-window-options`}
                value={failureWindowSeconds}
                onChange={(event) =>
                  setFailureWindowSeconds(event.target.value)
                }
                required
              />
              <datalist id={`${id}-failure-window-options`}>
                {FAILURE_WINDOW_SUGGESTIONS.map((seconds) => (
                  <option key={seconds} value={seconds} />
                ))}
              </datalist>
              <FieldDescription>
                How long it must keep failing before an incident opens:{" "}
                {humanSeconds(readNumber(failureWindowSeconds, 120))}. Counting
                failures instead stops meaning anything once the interval
                adapts.
              </FieldDescription>
            </Field>
          </div>
          {shows("tlsWarning") &&
            url.trim().toLowerCase().startsWith("https:") && (
              <label className="text-muted-foreground flex items-center gap-2 text-sm select-none">
                <input
                  type="checkbox"
                  checked={tlsCheck}
                  onChange={(event) => setTlsCheck(event.target.checked)}
                  className="accent-primary size-4"
                />
                Warn when the TLS certificate is within {initial.tlsWarnDays}{" "}
                days of expiry
              </label>
            )}
          {shows("keyword") && method === "GET" && (
            <div className="grid grid-cols-[1fr_auto] gap-4">
              <Field>
                <FieldLabel htmlFor={`${id}-keyword`}>Keyword check</FieldLabel>
                <Input
                  id={`${id}-keyword`}
                  value={bodyKeyword}
                  onChange={(event) => setBodyKeyword(event.target.value)}
                  placeholder='e.g. "ok" or "healthy"'
                  maxLength={200}
                  className="font-mono"
                />
                <FieldDescription>
                  Assert the response body contains (or doesn&apos;t) this text,
                  catches a 200 that serves an error page. Leave empty to skip.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-keyword-mode`}>
                  Body must
                </FieldLabel>
                <Select value={keywordAbsent} onValueChange={setKeywordAbsent}>
                  <SelectTrigger id={`${id}-keyword-mode`} className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="present">contain it</SelectItem>
                    <SelectItem value="absent">not contain it</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
        </FieldSet>
        {/* Only for the kinds that dial something: there is no cadence to
            raise for a heartbeat, a group or a manual monitor, and
            offering one would promise a probe that never happens. */}
        {dials && (
          <HighFrequencyPanel monitorId={monitorId} checkType={checkType} />
        )}
      </FieldGroup>
      {/* Sticky so the primary action stays reachable while the fields
          above it scroll — this form is the tallest in the product and
          grows every time a check type adds a setting. */}
      <DialogFooter className="bg-popover sticky bottom-0 mt-6 py-2">
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

"use client";

import { useId, useState } from "react";

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
  describeCheckType,
  DNS_RECORD_TYPES,
} from "@/modules/monitors/types/catalog";
import { MIN_INTERVAL_SECONDS } from "@/modules/monitors/schemas";
import type { FormSection } from "@/modules/monitors/types/contract";

/** Editable subset of a monitor, shared by the create and edit dialogs. */
export interface MonitorFormValues {
  name: string;
  checkType: string;
  url: string;
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

export function MonitorForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  initial: MonitorFormValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: MonitorFormValues) => void | Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [checkType, setCheckType] = useState(initial.checkType);
  const [url, setUrl] = useState(initial.url);
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

  const descriptor = describeCheckType(checkType);
  const shows = (section: FormSection) => descriptor.form.includes(section);
  const takesPort = descriptor.port !== null;

  function buildConfig(): Record<string, unknown> | null {
    if (shows("dnsRecord")) {
      const expected = expectedValue.trim();
      return { recordType, expectedValue: expected === "" ? null : expected };
    }
    if (shows("expiryWarning")) {
      return { warnDays: readNumber(warnDays, 14) };
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
        {descriptor.requiresCapability === "icmp" && (
          <FieldDescription>
            ICMP needs a raw socket. If the worker cannot open one, this monitor
            reports <strong>unknown</strong> with an explanation — never a false
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
          <Field>
            <FieldLabel htmlFor={`${id}-interval`}>
              Check interval (seconds)
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
              {humanSeconds(readNumber(intervalSeconds, 60))} — a baseline, not
              a fixed rate. Vigil checks more often when a target looks
              suspicious and backs off when it has been steady.
            </FieldDescription>
          </Field>
        </div>
        <FieldSet>
          <FieldLegend variant="label">Advanced</FieldLegend>
          <FieldDescription>
            Tune when a check counts as degraded or failed.
          </FieldDescription>
          <div className="grid grid-cols-2 gap-4">
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
                onChange={(event) => setDegradedThresholdMs(event.target.value)}
                required
              />
            </Field>
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
                How long it must keep failing before an incident opens —{" "}
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
                  Assert the response body contains (or doesn&apos;t) this text
                  — catches a 200 that serves an error page. Leave empty to
                  skip.
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

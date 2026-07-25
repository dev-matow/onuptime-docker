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
import { MONITOR_INTERVALS_SECONDS } from "@/modules/monitors/schemas";

/** Editable subset of a monitor, shared by the create and edit dialogs. */
export interface MonitorFormValues {
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  bodyKeyword: string | null;
  keywordAbsent: boolean;
  failureThreshold: number;
}

export const MONITOR_FORM_DEFAULTS: MonitorFormValues = {
  name: "",
  url: "",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10_000,
  degradedThresholdMs: 3_000,
  expectedStatusCode: null,
  bodyKeyword: null,
  keywordAbsent: false,
  failureThreshold: 3,
};

const INTERVAL_LABELS: Record<
  (typeof MONITOR_INTERVALS_SECONDS)[number],
  string
> = {
  60: "1 minute",
  120: "2 minutes",
  300: "5 minutes",
  600: "10 minutes",
  1800: "30 minutes",
  3600: "1 hour",
};

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
  const [url, setUrl] = useState(initial.url);
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
  const [failureThreshold, setFailureThreshold] = useState(
    String(initial.failureThreshold),
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Keyword checks read the body, so they only apply to GET.
    const keyword = method === "GET" ? bodyKeyword.trim() : "";
    void onSubmit({
      name: name.trim(),
      url: url.trim(),
      method,
      intervalSeconds: Number(intervalSeconds),
      timeoutMs: Number(timeoutMs),
      degradedThresholdMs: Number(degradedThresholdMs),
      expectedStatusCode:
        expectedStatusCode.trim() !== "" ? Number(expectedStatusCode) : null,
      bodyKeyword: keyword === "" ? null : keyword,
      keywordAbsent: keywordAbsent === "absent",
      failureThreshold: Number(failureThreshold),
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
          <FieldLabel htmlFor={`${id}-url`}>URL</FieldLabel>
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/health"
            className="font-mono"
            required
          />
          <FieldDescription>
            Publicly reachable endpoint. Private hosts and raw IP addresses are
            rejected.
          </FieldDescription>
        </Field>
        <div className="grid grid-cols-2 gap-4">
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
          <Field>
            <FieldLabel htmlFor={`${id}-interval`}>Check interval</FieldLabel>
            <Select value={intervalSeconds} onValueChange={setIntervalSeconds}>
              <SelectTrigger id={`${id}-interval`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONITOR_INTERVALS_SECONDS.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {INTERVAL_LABELS[seconds]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                onChange={(event) => setExpectedStatusCode(event.target.value)}
                placeholder="any 2xx/3xx"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-failure-threshold`}>
                Failure threshold
              </FieldLabel>
              <Input
                id={`${id}-failure-threshold`}
                type="number"
                min={1}
                max={10}
                value={failureThreshold}
                onChange={(event) => setFailureThreshold(event.target.value)}
                required
              />
              <FieldDescription>
                Consecutive failures before an incident opens.
              </FieldDescription>
            </Field>
          </div>
          {method === "GET" && (
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
      <DialogFooter className="mt-6">
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

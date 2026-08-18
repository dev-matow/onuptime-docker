"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import {
  previewProviderImportAction,
  runProviderImportAction,
  type ProviderImportResult,
} from "./provider-actions";
import { ReportBody } from "./report-view";

/**
 * Credentials, analyse, preview, import, report.
 *
 * The credential fields are `type="password"` and nothing ever reads
 * them back out: they live in this component's state for as long as the
 * two clicks take and are posted to the action each time. There is no
 * "saved connection" here on purpose. A stored token is a stored token,
 * and this feature runs once.
 */

export interface ProviderSummary {
  id: string;
  label: string;
  docs: string;
  access: string;
  limitations: readonly string[];
  credentials: readonly {
    name: string;
    label: string;
    help: string;
    secret: boolean;
    required: boolean;
    choices?: readonly { value: string; label: string }[];
  }[];
}

export function ProviderWizard({
  provider,
  canImport,
}: {
  provider: ProviderSummary;
  canImport: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ProviderImportResult | null>(null);
  const [result, setResult] = useState<ProviderImportResult | null>(null);
  const [pending, setPending] = useState<"preview" | "import" | null>(null);

  function body(): FormData {
    const form = new FormData();
    form.set("provider", provider.id);
    for (const field of provider.credentials) {
      form.set(field.name, values[field.name] ?? "");
    }
    return form;
  }

  function reset(): void {
    setPreview(null);
    setResult(null);
  }

  async function analyse(): Promise<void> {
    setPending("preview");
    const outcome = await previewProviderImportAction(body());
    setPending(null);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    setPreview(outcome.data);
  }

  async function confirm(): Promise<void> {
    setPending("import");
    const outcome = await runProviderImportAction(body());
    setPending(null);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    setResult(outcome.data);
    setPreview(null);
    toast.success(
      `Imported ${outcome.data.report.totals.monitorsCreated} monitor(s).`,
    );
  }

  if (result) {
    return (
      <div className="flex flex-col gap-6">
        <Facts facts={result.report.facts} />
        <ReportBody
          status={result.report.status}
          totals={result.report.totals}
          entries={result.report.entries}
        />
        <div>
          <Button variant="outline" onClick={reset}>
            Import again
          </Button>
        </div>
      </div>
    );
  }

  if (preview) {
    const blocked = preview.report.totals.monitorsCreated === 0;
    return (
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-sm">
          This is what a real import did before it was rolled back, not an
          estimate. Importing reads {provider.label} again, so anything created
          there since this summary appears in the final report.
        </p>
        <Facts facts={preview.report.facts} />
        <ReportBody
          status={preview.report.status}
          totals={preview.report.totals}
          entries={preview.report.entries}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void confirm()}
            disabled={pending !== null || blocked}
          >
            {pending === "import" && <Spinner />}
            Import {preview.report.totals.monitorsCreated} monitor
            {preview.report.totals.monitorsCreated === 1 ? "" : "s"}
          </Button>
          <Button variant="outline" onClick={reset} disabled={pending !== null}>
            Start over
          </Button>
        </div>
      </div>
    );
  }

  const ready = provider.credentials
    .filter((field) => field.required)
    .every((field) => (values[field.name] ?? "").trim().length > 0);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void analyse();
      }}
    >
      <div className="text-muted-foreground flex flex-col gap-2 text-sm">
        <p>{provider.access}</p>
        <p>
          Written against{" "}
          <a
            className="underline"
            href={provider.docs}
            target="_blank"
            rel="noreferrer noopener"
          >
            {provider.label}&rsquo;s own API documentation
          </a>
          . The credential below is used for this read and is never stored.
        </p>
      </div>

      <FieldGroup>
        {provider.credentials.map((field) => (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${provider.id}-${field.name}`}>
              {field.label}
              {field.required ? "" : " (optional)"}
            </FieldLabel>
            {field.choices === undefined ? (
              <Input
                id={`${provider.id}-${field.name}`}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                disabled={!canImport}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
            ) : (
              <select
                id={`${provider.id}-${field.name}`}
                className="border-input bg-background h-9 border px-3 text-sm"
                disabled={!canImport}
                value={values[field.name] ?? field.choices[0]?.value ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              >
                {field.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            )}
            <FieldDescription>{field.help}</FieldDescription>
          </Field>
        ))}
        <Field orientation="horizontal">
          <Button
            type="submit"
            disabled={!canImport || !ready || pending !== null}
          >
            {pending === "preview" && <Spinner />}
            Check what will be imported
          </Button>
        </Field>
      </FieldGroup>

      {provider.limitations.length > 0 && (
        <details className="border-border border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            What this migration cannot bring
          </summary>
          <ul className="text-muted-foreground mt-3 flex list-disc flex-col gap-2 pl-5 text-sm">
            {provider.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}

function Facts({ facts }: { facts: readonly string[] }) {
  if (facts.length === 0) return null;
  return (
    <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}

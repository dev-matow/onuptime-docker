"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { ImportWizard } from "./import-wizard";
import { ProviderWizard, type ProviderSummary } from "./provider-wizard";

/**
 * Choose where you are coming from.
 *
 * Uptime Kuma is first and separate because it is the only source that
 * arrives as a file rather than as an account, and because it is the one
 * most people on this page are leaving.
 *
 * The sources that will never be supported are on the same screen as the
 * ones that are, which is deliberate. "Not in the list" is not an answer
 * a customer can act on: it does not say whether the work is unfinished
 * or impossible. Each of these says which, and why.
 */

export interface UnsupportedSummary {
  id: string;
  label: string;
  docs: string;
  reason: string;
}

const KUMA = "kuma";

export function ImportSources({
  canImport,
  kumaDescription,
  providers,
  unsupported,
}: {
  canImport: boolean;
  kumaDescription: string;
  providers: readonly ProviderSummary[];
  unsupported: readonly UnsupportedSummary[];
}) {
  const [selected, setSelected] = useState<string>(KUMA);
  const provider = providers.find((entry) => entry.id === selected);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={selected === KUMA ? "default" : "outline"}
          onClick={() => setSelected(KUMA)}
        >
          Uptime Kuma
        </Button>
        {providers.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={selected === entry.id ? "default" : "outline"}
            onClick={() => setSelected(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {selected === KUMA ? (
        <div className="flex flex-col gap-6">
          <p className="text-muted-foreground text-sm">{kumaDescription}</p>
          <ImportWizard canImport={canImport} />
        </div>
      ) : provider === undefined ? null : (
        <ProviderWizard provider={provider} canImport={canImport} />
      )}

      {unsupported.length > 0 && (
        <details className="border-border border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Sources Vigil will not claim to support
          </summary>
          <ul className="mt-3 flex flex-col gap-3 text-sm">
            {unsupported.map((entry) => (
              <li key={entry.id}>
                <a
                  className="font-medium underline"
                  href={entry.docs}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {entry.label}
                </a>
                <p className="text-muted-foreground mt-0.5">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

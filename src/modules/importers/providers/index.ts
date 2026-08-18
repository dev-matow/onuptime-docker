import { betterStackAdapter } from "./betterstack";
import { checklyAdapter } from "./checkly";
import type { ProviderAdapter } from "./contract";
import { cronitorAdapter } from "./cronitor";
import { datadogAdapter } from "./datadog";
import { grafanaAdapter } from "./grafana";
import { healthchecksAdapter } from "./healthchecks";
import { hyperpingAdapter } from "./hyperping";
import { newRelicAdapter } from "./newrelic";
import { ohDearAdapter } from "./ohdear";
import { pingdomAdapter } from "./pingdom";
import { statusCakeAdapter } from "./statuscake";
import { updownAdapter } from "./updown";
import { uptimeComAdapter } from "./uptimecom";
import { uptimeRobotAdapter } from "./uptimerobot";

export type {
  CredentialField,
  ProviderAdapter,
  ProviderCapability,
  ReadContext,
} from "./contract";

/**
 * Every source Vigil can migrate from, and every one it deliberately
 * cannot.
 *
 * Two lists rather than one, because the second is the more useful half
 * of an honest answer. A customer evaluating this feature wants to know
 * whether their system is supported, and "not on the list" is an answer
 * they cannot act on: it does not say whether the work is unfinished or
 * impossible. `UNSUPPORTED_SOURCES` says which, in the vendor's own
 * terms, and `docs/MIGRATION.md` is generated from both.
 *
 * Uptime Kuma is not here. It is a SQLite file rather than an API, with
 * a pinned schema and a hundred and eleven classified columns, and it
 * keeps its own module and its own page. The two paths share the report
 * vocabulary and nothing else, which is the right amount.
 */
export const PROVIDERS: readonly ProviderAdapter[] = [
  betterStackAdapter,
  checklyAdapter,
  cronitorAdapter,
  datadogAdapter,
  grafanaAdapter,
  healthchecksAdapter,
  hyperpingAdapter,
  newRelicAdapter,
  ohDearAdapter,
  pingdomAdapter,
  statusCakeAdapter,
  updownAdapter,
  uptimeComAdapter,
  uptimeRobotAdapter,
];

export function findProvider(id: string): ProviderAdapter | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function requireProvider(id: string): ProviderAdapter {
  const provider = findProvider(id);
  if (provider === undefined) {
    throw new Error(`Unknown migration source "${id}".`);
  }
  return provider;
}

export interface UnsupportedSource {
  id: string;
  label: string;
  /** The vendor documentation the judgement was made against. */
  docs: string;
  /** Why a faithful migration is not possible. Never a placeholder. */
  reason: string;
}

/**
 * Sources this product will not claim to support, and the exact reason
 * for each.
 *
 * A row here is a decision, not a backlog item. Every one of them was
 * reached by reading the vendor's own published API, and each says what
 * would have to change on their side for the answer to change on ours.
 */
export const UNSUPPORTED_SOURCES: readonly UnsupportedSource[] = [
  {
    id: "sematext",
    label: "Sematext Synthetics",
    docs: "https://sematext.com/docs/synthetics/monitor-overview-api/",
    reason:
      "The read API does not return the check's request definition. Sematext documents exactly thirteen fields on a monitor response, and `url`, `method`, `headers`, `params`, `cookies`, `body` and `script` are none of them: they are writable and not readable. An importer cannot reconstruct even the target of an HTTP monitor, so any adapter would have to ask the customer to retype every URL, which is not a migration. Sematext publishes no OpenAPI document for Synthetics and its Terraform provider covers apps rather than monitors, so there is no second route.",
  },
  {
    id: "statuspage",
    label: "Atlassian Statuspage",
    docs: "https://developer.statuspage.io/",
    reason:
      "Statuspage is not a monitoring system. Its API holds pages, components, incidents and subscribers, and it never probes anything, so there are no checks to migrate. Recreate the page as a Vigil status page and add monitors to it.",
  },
  {
    id: "freshping",
    label: "Freshping",
    docs: "https://support.freshping.io/support/solutions/articles/50000003709",
    reason:
      "Freshworks retired Freshping and deletes account data after the sunset date, so there is no live account left for an importer to read. If yours is still reachable, export what you can from the console before it closes.",
  },
  {
    id: "monitis",
    label: "Monitis",
    docs: "https://www.monitis.com/",
    reason:
      "The service and its API host no longer resolve. There is nothing for an adapter to connect to.",
  },
];

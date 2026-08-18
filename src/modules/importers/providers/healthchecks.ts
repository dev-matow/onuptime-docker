import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";

import {
  baseUrlFor,
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { arr, num, obj, str, type Json } from "./json";

/**
 * Healthchecks.io, hosted or self-hosted, through the v3 API.
 *
 * Everything here is a heartbeat: Healthchecks never probes anything, it
 * waits to be pinged and complains when it is not. So every check maps
 * onto exactly one Vigil type, `push`, and the interesting work is not
 * the mapping but the two shapes of schedule.
 *
 * A *simple* check has `timeout` and `grace`, both seconds, which is
 * precisely Vigil's interval and grace. A *cron* check has `schedule`
 * and `tz` instead, and its `schedule` may be either a cron expression
 * or a systemd OnCalendar expression with nothing in the response to
 * say which. Vigil expects a heartbeat every interval plus a grace
 * period, which is not the same claim as "at 05:15 every day": a job
 * that runs on weekdays reads as overdue all weekend. So a cron check
 * imports with its grace period and a report line that says exactly
 * that, and the interval it gets is the one the operator must check.
 *
 * The self-hosted case is why this adapter takes a base URL. It is
 * guarded rather than free: https only, and refused for any host the
 * egress classifier considers unreachable, which is the same predicate
 * the monitor targets are validated against.
 */

const HOSTED = "https://healthchecks.io";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "simple check (period and grace)",
    becomes: "push",
    note: "The period becomes the monitor's interval and the grace period carries unchanged, so the deadline Vigil enforces is the deadline Healthchecks enforced. A new token is generated, because a token authenticates one caller to one monitor, so every job has to be pointed at its new endpoint.",
  },
  {
    sourceType: "cron or OnCalendar check",
    becomes: "push",
    note: "The grace period carries and the schedule does not: Vigil expects a heartbeat every interval plus a grace period rather than at the times an expression names, so a job that runs on weekdays only will read as overdue at the weekend. The expression is quoted on the report so the interval can be set to the longest gap between runs.",
  },
];

/** Seconds, floored at what Vigil's interval column accepts. */
function periodOf(row: Record<string, Json>): number | undefined {
  return num(row.timeout);
}

function toCheck(row: Record<string, Json>): SourceCheck {
  // A read-only key omits `uuid` and substitutes `unique_key`, which is
  // the identity this adapter should use anyway: it is stable and it is
  // not the ping token.
  const sourceId =
    str(row.unique_key) ?? str(row.uuid) ?? str(row.slug) ?? "unknown";
  const name =
    str(row.name) ?? str(row.slug) ?? `Healthchecks check ${sourceId}`;
  const schedule = str(row.schedule);
  const description = str(row.desc);

  const losses: string[] = [];
  if (description !== undefined) {
    losses.push(
      `The check's description was not carried: Vigil's monitor has no description field. It read: "${description.slice(0, 200)}"`,
    );
  }
  const keywords = [
    str(row.start_kw) === undefined ? null : "start",
    str(row.success_kw) === undefined ? null : "success",
    str(row.failure_kw) === undefined ? null : "failure",
  ].filter((entry): entry is string => entry !== null);
  if (keywords.length > 0) {
    losses.push(
      `Healthchecks classified incoming pings by looking for ${keywords.join(", ")} keywords in the request body. Vigil's heartbeat endpoint takes the status in the request itself, so point the job at /api/push/<token>?status=down to report a failure.`,
    );
  }
  if (str(row.methods) === "POST") {
    losses.push(
      "The check only accepted POST pings. Vigil's heartbeat endpoint accepts GET and POST alike.",
    );
  }

  return {
    sourceId,
    name,
    sourceType: schedule === undefined ? "simple" : "cron",
    kind: "heartbeat",
    paused: str(row.status)?.toLowerCase() === "paused",
    target: { label: name },
    intervalSeconds: periodOf(row),
    heartbeat: {
      periodSeconds: periodOf(row),
      graceSeconds: num(row.grace),
      cron:
        schedule === undefined
          ? undefined
          : `${schedule}${str(row.tz) === undefined ? "" : ` in ${str(row.tz)}`}`,
    },
    // Healthchecks stores tags as one space-delimited string rather than
    // a list, which is the sort of thing that quietly becomes a single
    // tag named "backup fs".
    tags: (str(row.tags) ?? "").split(/\s+/).filter((tag) => tag.length > 0),
    losses,
  };
}

export const healthchecksAdapter: ProviderAdapter = {
  id: "healthchecks",
  label: "Healthchecks.io",
  input: "api",
  docs: "https://healthchecks.io/docs/api/",
  access:
    "A project API key from Project Settings, API Access. Keys are per project, so an account with several projects needs one import per project. A read-only key is enough for this importer and is the safer choice.",
  credentials: [
    {
      name: "apiKey",
      label: "Project API key",
      help: "Sent in the X-Api-Key header. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
    {
      name: "baseUrl",
      label: "Self-hosted URL",
      help: "Leave empty for healthchecks.io. For a self-hosted install, the site root, like https://checks.example.com.",
      secret: false,
      required: false,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Every Healthchecks check becomes a Vigil heartbeat monitor with a new token, because a token authenticates one caller to one monitor. Every job, cron entry and device that pings Healthchecks has to be pointed at its new Vigil endpoint; nothing can do that for you.",
    "A cron or OnCalendar schedule is not carried. Vigil expects a heartbeat every interval plus a grace period, so a job that runs on weekdays would read as overdue at the weekend. The expression is quoted on the report.",
    "Integration configuration is unreadable: the channels endpoint returns a name and a kind and never the address, webhook URL or template, so alert routing has to be rebuilt from Vigil's notification channels.",
    "Healthchecks has no pagination and asks for no more than 100 requests a minute. This importer reads the whole project in one request.",
    "There is no official export of check configuration, in either the hosted or the self-hosted edition.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const apiKey = requireCredential(context, "apiKey", "The project API key");
    const configured = (context.credentials.baseUrl ?? "").trim();
    const root =
      configured.length === 0
        ? HOSTED
        : baseUrlFor(configured, "The self-hosted URL");
    const transport = transportFor(
      context,
      `${root}/api/v3`,
      { "X-Api-Key": apiKey, Accept: "application/json" },
      // The host may be the operator's own install, so every request
      // goes through the egress guard rather than straight to fetch.
      { guarded: true },
    );

    const response = await transport.json<{ checks?: Json }>("/checks/");
    const checks = arr(response.checks).map((row) => toCheck(obj(row)));

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "channels",
        label: "Integrations",
        detail:
          "Healthchecks returns an integration's name and kind and never its address, webhook URL or template, so no importer can copy alert routing out of an account. Recreate the channels under Settings, Notifications; the imported monitors will use them without being attached to them.",
      },
      {
        kind: "account",
        sourceId: "ping-history",
        label: "Ping history and flips",
        detail:
          "Vigil's uptime is duration-weighted over observations it made itself and hashed into its own ledger, so importing another system's ping history would put unverifiable rows in a chain whose whole purpose is that every row is verifiable. The history stays in Healthchecks.",
      },
    ];

    return {
      provider: "healthchecks",
      facts: [
        `Healthchecks API v3 at ${root}, ${checks.length} check(s) in one request.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};

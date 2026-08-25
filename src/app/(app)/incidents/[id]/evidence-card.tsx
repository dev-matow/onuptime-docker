import Link from "next/link";

import {
  ArrowRightIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type {
  BurstRecord,
  CorrelatedFailure,
  CorrelationSignal,
  EvidenceChange,
  EvidenceStage,
  IncidentEvidenceSnapshot,
  StoredIncidentEvidence,
} from "@/modules/incidents/evidence";

/**
 * What was known when this incident opened.
 *
 * Written to be read at 3am by somebody who has just been paged, which
 * decides the order: the observed failure first, then which layer it was
 * and how we know, then what changed since the last time this worked,
 * then whether anything else is broken for the same reason.
 *
 * Every section renders the absence as clearly as the presence. A
 * snapshot with no diagnostic burst says why there is none; a monitor
 * with no retained successful check says that rather than showing an
 * empty comparison; an incident opened before this feature existed
 * renders nothing at all rather than an empty shell. Partial evidence
 * is the normal case, not the error case - a monitoring product that
 * only looks complete when everything was captured teaches its
 * operators to distrust the parts that were.
 */

const STAGE_LABELS: Record<EvidenceStage, string> = {
  dns: "Name resolution",
  tcp: "Connection",
  tls: "TLS handshake",
  http: "HTTP response",
  application: "Application",
  browser: "Browser journey",
  unknown: "Not established",
};

const BASIS_LABELS = {
  measured: "measured at onset",
  reported: "named by the failure",
  assertion: "proven by the check",
  unknown: "not established",
} as const;

const SIGNAL_LABELS: Record<CorrelationSignal["kind"], string> = {
  "same-host": "same host",
  "same-domain": "same domain",
  "same-address": "same address",
  "same-signature": "same failure",
  "same-probe-location": "same probe location",
  "same-stage": "same stage",
  "same-check-type": "same check type",
};

const CHANGE_LABELS: Record<EvidenceChange["note"], string> = {
  changed: "changed",
  appeared: "first reported",
  disappeared: "no longer reported",
  slower: "slower",
  faster: "faster",
};

const BURST_SKIP_TEXT: Record<string, string> = {
  disabled: "Onset diagnostics are switched off for this installation.",
  shadow:
    "This incident was opened in shadow mode, so nothing extra was dialled.",
  concurrency:
    "Too many diagnostic bursts were already running; this one was skipped rather than adding load to a failing target.",
  "no-target": "This check type has no host and port to re-probe.",
  "high-frequency":
    "This monitor is on the high-frequency plane, which cannot pause for diagnostics. Its own samples are the evidence here.",
  refused:
    "Egress policy refused the target: it no longer resolves to an address Vigil may dial.",
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function value(entry: EvidenceChange["before"]): string {
  if (entry === null) return "-";
  if (Array.isArray(entry)) {
    return entry.length === 0 ? "(none)" : entry.join(", ");
  }
  return String(entry);
}

function StageLine({ snapshot }: { snapshot: IncidentEvidenceSnapshot }) {
  const { stage } = snapshot;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={stage.stage === "unknown" ? "outline" : "destructive"}>
          {STAGE_LABELS[stage.stage]}
        </Badge>
        {/*
          The basis, always, and beside the stage rather than buried in a
          tooltip. "TLS handshake" and "TLS handshake, measured at onset"
          are different claims, and an operator acting on the first
          deserves to know which one they were given.
        */}
        <span className="text-muted-foreground text-xs">
          {BASIS_LABELS[stage.basis]}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{stage.reason}</p>
    </div>
  );
}

function Changes({ changes }: { changes: EvidenceChange[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {changes.map((change) => (
        <li
          key={change.key}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span className="text-muted-foreground">{change.label}</span>
          <span className="font-mono">{value(change.before)}</span>
          <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
          <span className="font-mono">{value(change.after)}</span>
          {change.unit && (
            <span className="text-muted-foreground">{change.unit}</span>
          )}
          <span className="text-muted-foreground">
            ({CHANGE_LABELS[change.note]})
          </span>
        </li>
      ))}
    </ul>
  );
}

function Burst({ burst }: { burst: BurstRecord }) {
  // The skip reason is rendered whenever there is one, not only when
  // `steps` is empty. An egress refusal keeps its resolve step - what
  // the name resolved to IS the finding - and reading the reason only on
  // the empty branch showed that case as a green step that simply
  // stopped, with nothing saying why nothing else was dialled.
  const reason =
    burst.skipped === undefined
      ? null
      : (BURST_SKIP_TEXT[burst.skipped] ?? null);

  if (burst.steps.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {reason ?? "No onset diagnostics were recorded."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5 text-xs">
        {burst.steps.map((step) => (
          <li key={step.kind} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-2">
              {step.ok ? (
                <CheckCircleIcon
                  className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5"
                  aria-hidden
                />
              ) : (
                <WarningCircleIcon
                  className="text-destructive size-3.5 shrink-0 translate-y-0.5"
                  aria-hidden
                />
              )}
              <span className="font-medium">{STAGE_LABELS[step.kind]}</span>
              <span className="text-muted-foreground font-mono">
                {step.durationMs}ms
              </span>
            </div>
            {step.error !== null && (
              <p className="text-destructive ml-5.5 break-words">
                {step.error}
              </p>
            )}
            {Object.keys(step.detail).length > 0 && (
              <p className="text-muted-foreground ml-5.5 font-mono break-words">
                {Object.entries(step.detail)
                  .map(([key, entry]) => `${key}=${value(entry ?? null)}`)
                  .join("  ")}
              </p>
            )}
          </li>
        ))}
      </ul>
      {reason !== null && (
        <p className="text-muted-foreground text-xs">{reason}</p>
      )}
      <p className="text-muted-foreground text-xs">
        {burst.steps.length} of at most {burst.maxSteps} read-only probes,{" "}
        {burst.spentMs}ms of a {burst.budgetMs}ms budget. These probes changed
        nothing: they do not affect this monitor&rsquo;s health, this incident,
        paging or any status page.
      </p>
    </div>
  );
}

function Related({ related }: { related: CorrelatedFailure[] }) {
  return (
    <ul className="flex flex-col gap-2.5 text-xs">
      {related.map((row) => (
        <li key={row.monitorId} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <Link
              href={`/monitors/${row.monitorId}`}
              className="truncate underline-offset-4 hover:underline"
            >
              {row.monitorName}
            </Link>
            {row.incidentId !== null && (
              <Link
                href={`/incidents/${row.incidentId}`}
                className="text-muted-foreground shrink-0 underline-offset-4 hover:underline"
              >
                incident
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {row.signals.map((signal) => (
              <Badge
                key={signal.kind}
                variant="outline"
                className="font-normal"
                title={signal.detail}
              >
                {SIGNAL_LABELS[signal.kind]}: {signal.detail}
              </Badge>
            ))}
          </div>
          {row.firstFailureAt !== null && (
            <p className="text-muted-foreground">
              Failing since {formatDateTime(new Date(row.firstFailureAt))}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function IncidentEvidenceCard({
  evidence,
}: {
  evidence: StoredIncidentEvidence | null;
}) {
  if (evidence === null) return null;
  const { snapshot } = evidence;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>What was seen when this opened</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <StageLine snapshot={snapshot} />

        <dl className="flex flex-col gap-2 text-xs">
          <Row label="Target">
            <span className="font-mono">{snapshot.monitor.target}</span>
          </Row>
          {snapshot.failure.error !== null && (
            <Row label="Reported">
              <span className="break-words whitespace-normal">
                {snapshot.failure.error}
              </span>
            </Row>
          )}
          {snapshot.failure.statusCode !== null && (
            <Row label="Status code">
              <span className="font-mono">{snapshot.failure.statusCode}</span>
            </Row>
          )}
          {snapshot.failure.responseTimeMs !== null && (
            <Row label="Response time">
              <span className="font-mono">
                {snapshot.failure.responseTimeMs}ms
              </span>
            </Row>
          )}
          {snapshot.failure.failedAssertions.length > 0 && (
            <Row label="Failed checks">
              <span className="font-mono">
                {snapshot.failure.failedAssertions.join(", ")}
              </span>
            </Row>
          )}
          {snapshot.firstFailureAt !== null && (
            <Row label="First failure">
              {formatDateTime(new Date(snapshot.firstFailureAt))}
            </Row>
          )}
          <Row label="Last success">
            {snapshot.lastSuccess === null || snapshot.lastSuccess.at === null
              ? "none retained"
              : `${formatDateTime(new Date(snapshot.lastSuccess.at))}${
                  snapshot.lastSuccess.verdict === "degraded"
                    ? " (degraded)"
                    : ""
                }`}
          </Row>
        </dl>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Since the last success</h3>
          {snapshot.changes.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {snapshot.truncated === true
                ? "Trimmed to fit the storage limit, so this list is not a statement that nothing changed."
                : snapshot.lastSuccess === null
                  ? "No successful check is retained for this monitor, so there is nothing to compare against."
                  : "Nothing measurable changed between the last successful check and this one."}
            </p>
          ) : (
            <Changes changes={snapshot.changes} />
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Onset diagnostics</h3>
          {snapshot.burst === null ? (
            <p className="text-muted-foreground text-xs">
              No onset diagnostics were recorded.
            </p>
          ) : (
            <Burst burst={snapshot.burst} />
          )}
        </section>


        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Related failures</h3>
          {snapshot.correlations.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {snapshot.correlationsNote === "high-frequency"
                ? "Not looked for. This monitor is on the high-frequency plane, which cannot pause to query the rest of the fleet, so this is not a statement that nothing else was failing."
                : snapshot.truncated === true
                  ? "Trimmed to fit the storage limit; related failures were dropped first and this is not a statement that there were none."
                  : "Nothing else was failing nearby with a signal in common. Time alone is not one."}
            </p>
          ) : (
            <Related related={snapshot.correlations} />
          )}
        </section>

        <p className="text-muted-foreground text-xs">
          Captured {formatDateTime(evidence.capturedAt)}
          {snapshot.truncated === true
            ? ". Trimmed to fit the storage limit."
            : "."}
        </p>
      </CardContent>
    </Card>
  );
}

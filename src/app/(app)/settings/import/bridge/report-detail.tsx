import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import type { ComparisonReport } from "@/modules/importers/bridge/compare";

/**
 * One stored cutover report, rendered exactly from its frozen body.
 *
 * Server-rendered and read-only: this is the artifact an operator cites
 * when they flip the switch, so it renders what was stored, never a
 * fresher recomputation - the page has a button for a new report.
 */

const KIND_LABEL: Record<string, string> = {
  matched: "Matched",
  missed: "Missed by Vigil",
  extra: "Only in Vigil",
  unprovable: "Unprovable",
  "below-window": "Below the failure window",
};

const KIND_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  matched: "default",
  missed: "destructive",
  extra: "secondary",
  unprovable: "outline",
  "below-window": "outline",
};

function deltaCell(seconds: number | null): string {
  if (seconds === null) return "-";
  const magnitude = Math.abs(seconds);
  const spelled =
    magnitude < 120 ? `${magnitude}s` : `${Math.round(magnitude / 60)}m`;
  return seconds > 0 ? `+${spelled}` : seconds < 0 ? `-${spelled}` : "0s";
}

export function ReportDetail({
  report,
}: {
  report: {
    id: string;
    createdAt: Date;
    verdict: string;
    reasons: string[];
    body: ComparisonReport;
  };
}) {
  const body = report.body;
  const safe = report.verdict === "safe";
  return (
    <Card id="report">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Cutover report
          <Badge variant={safe ? "default" : "destructive"}>
            {safe ? "SAFE" : "NOT SAFE"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Generated {formatDateTime(report.createdAt)}, over {body.coveredHours}
          h of covered evidence. Frozen: this is what the decision was made on.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            {safe ? "Why it is safe" : "Why it is not safe yet"}
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.reasons.map((reason, index) => (
              <li key={index} className="border-l-2 pl-3">
                {reason}
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Totals</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Source records</dt>
              <dd className="font-mono">{body.totals.sourceRecords}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Imported / transformed</dt>
              <dd className="font-mono">
                {body.totals.imported} / {body.totals.transformed}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Skipped / unsupported</dt>
              <dd className="font-mono">
                {body.totals.skipped} / {body.totals.unsupported}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Compared pairs</dt>
              <dd className="font-mono">{body.totals.comparedPairs}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Incidents matched</dt>
              <dd className="font-mono">{body.totals.matched}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Missed by Vigil</dt>
              <dd className="font-mono">{body.totals.missed}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Only in Vigil</dt>
              <dd className="font-mono">
                {body.totals.extra}
                {body.totals.openExtra > 0
                  ? ` (${body.totals.openExtra} open now)`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                Unprovable / below window
              </dt>
              <dd className="font-mono">
                {body.totals.unprovable} / {body.totals.belowWindow}
              </dd>
            </div>
          </dl>
        </section>

        {body.timing.samples > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              Timing, across matched incidents
            </h3>
            <p className="text-muted-foreground text-sm">
              Positive means Vigil was later than Better Stack; negative,
              earlier. Detection deltas include Vigil&rsquo;s configured failure
              window, which the import carried from the source&rsquo;s own
              confirmation period.
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Detection, median</dt>
                <dd className="font-mono">
                  {deltaCell(body.timing.detectionMedianSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Detection, worst</dt>
                <dd className="font-mono">
                  {deltaCell(body.timing.detectionWorstSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Recovery, median</dt>
                <dd className="font-mono">
                  {deltaCell(body.timing.recoveryMedianSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Recovery, worst</dt>
                <dd className="font-mono">
                  {deltaCell(body.timing.recoveryWorstSeconds)}
                </dd>
              </div>
            </dl>
          </section>
        )}

        {body.findings.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Incident findings</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {body.findings.map((finding, index) => (
                <li key={index} className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Badge variant={KIND_VARIANT[finding.kind] ?? "outline"}>
                      {KIND_LABEL[finding.kind] ?? finding.kind}
                    </Badge>
                    <span className="font-medium">{finding.monitorName}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {finding.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Per-monitor comparison</h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source record</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Checks</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Missed</TableHead>
                  <TableHead className="text-right">Extra</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {body.pairs.map((pair) => (
                  <TableRow key={pair.sourceId}>
                    <TableCell className="font-medium">
                      {pair.sourceName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {pair.sourceType}
                    </TableCell>
                    <TableCell>
                      {pair.compared ? (
                        pair.outcome
                      ) : (
                        <span className="text-muted-foreground">
                          {pair.outcome}, not compared
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {pair.monitorId === null ? "-" : pair.vigilChecks}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {pair.compared ? pair.matched : "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {pair.compared ? pair.missed : "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {pair.compared ? pair.extra : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        {body.manualWork.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              Manual work before or at cutover
            </h3>
            <ul className="flex flex-col gap-2 text-sm">
              {body.manualWork.map((item, index) => (
                <li key={index} className="border-l-2 pl-3">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

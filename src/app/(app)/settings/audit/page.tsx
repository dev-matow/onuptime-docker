import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import { auditLogs, user } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { requireOrgContext } from "@/lib/session";

export const metadata: Metadata = { title: "Audit log — Vigil" };

const MAX_ROWS = 100;

export default async function AuditLogPage() {
  const ctx = await requireOrgContext();

  const rows = await db
    .select({ entry: auditLogs, actorName: user.name })
    .from(auditLogs)
    .leftJoin(user, eq(auditLogs.actorId, user.id))
    .where(eq(auditLogs.organizationId, ctx.organizationId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(MAX_ROWS);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Privileged actions across the organization. Showing the last {MAX_ROWS}{" "}
        entries.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-muted-foreground text-center"
              >
                Nothing here yet.
              </TableCell>
            </TableRow>
          )}
          {rows.map(({ entry, actorName }) => (
            <TableRow key={entry.id}>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatDateTime(entry.createdAt)}
              </TableCell>
              <TableCell>{actorName ?? "System"}</TableCell>
              <TableCell>
                <code className="font-mono text-xs">{entry.action}</code>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {describeTarget(entry.targetType, entry.metadata)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function describeTarget(
  targetType: string,
  metadata: Record<string, unknown> | null,
): string {
  const name =
    metadata &&
    (typeof metadata.name === "string"
      ? metadata.name
      : typeof metadata.email === "string"
        ? metadata.email
        : typeof metadata.title === "string"
          ? metadata.title
          : null);
  return name ? `${targetType} · ${name}` : targetType;
}

import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";

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
import { db } from "@/db";
import { isEmailEnabled } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import {
  deliveryHistory,
  listChannels,
} from "@/modules/notifications/channel-service";
import { providerDescriptors } from "@/modules/notifications/providers";

import { ChannelManager } from "./channels";

export const metadata: Metadata = { title: "Notifications · Vigil" };

const STATE_BADGE: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "outline" | "destructive";
  }
> = {
  delivered: { label: "Delivered", variant: "default" },
  queued: { label: "Queued", variant: "secondary" },
  sending: { label: "Sending", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

export default async function NotificationsSettingsPage() {
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { notification: ["update"] });
  const [channels, history] = await Promise.all([
    listChannels(db, ctx.organizationId),
    deliveryHistory(db, ctx.organizationId),
  ]);
  const providers = providerDescriptors();
  const providerLabels = new Map(providers.map((p) => [p.id, p.label]));
  providerLabels.set("email", "Email");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Member email</CardTitle>
          <CardDescription>
            Sent to organization owners, admins and responders when a
            monitor-driven incident opens or resolves. For email to other
            addresses, add an SMTP or Resend channel below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          {isEmailEnabled ? (
            <>
              <CheckCircleIcon
                className="size-4 text-emerald-500"
                aria-hidden
              />
              <span>Delivering via Resend.</span>
            </>
          ) : (
            <>
              <XCircleIcon
                className="text-muted-foreground size-4"
                aria-hidden
              />
              <span className="text-muted-foreground">
                Not configured, set{" "}
                <code className="font-mono">RESEND_API_KEY</code> to enable
                delivery. Notifications are written to the logs until then.
              </span>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            Where alerts go beyond member email. Each channel picks its provider
            and which event classes it receives; deliveries are queued durably,
            retried with backoff, and recorded below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChannelManager
            channels={channels}
            providers={providers}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delivery history</CardTitle>
          <CardDescription>
            The most recent deliveries: what was sent, where, how many attempts
            it took, and what the provider said. Errors are stored with
            credentials removed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing sent yet. Deliveries appear here as soon as an alert or
              incident email goes out.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((entry) => {
                    const badge = STATE_BADGE[entry.state] ?? {
                      label: entry.state,
                      variant: "outline" as const,
                    };
                    return (
                      <TableRow key={entry.id}>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {entry.createdAt
                            .toISOString()
                            .slice(0, 16)
                            .replace("T", " ")}
                        </TableCell>
                        <TableCell>
                          {providerLabels.get(entry.provider) ?? entry.provider}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {entry.event ?? "·"}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-xs">
                          {entry.destination}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {entry.attempts}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            {entry.lastError && (
                              <span
                                className="text-muted-foreground max-w-56 truncate text-xs"
                                title={entry.lastError}
                              >
                                {entry.lastError}
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

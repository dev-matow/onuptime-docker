import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db } from "@/db";
import { isEmailEnabled } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { listMonitors } from "@/modules/monitors/service";
import { listChannels } from "@/modules/notifications/channel-service";
import { providerDescriptors } from "@/modules/notifications/providers";

import { ChannelManager } from "./channels";

export const metadata: Metadata = { title: "Notifications · Vigil" };

/**
 * The page reads the FIRST page of channels only. It used to read every
 * channel an organization owned and decrypt each one to draw a row,
 * which was survivable at the old cap of twenty and is the thing that
 * had to change before the cap could go.
 */
export default async function NotificationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { notification: ["update"] });

  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };
  const page = Math.max(Number(one("page") ?? "1") || 1, 1);
  const pageSize = 25;

  const [channels, monitors] = await Promise.all([
    listChannels(db, ctx.organizationId, {
      search: one("q"),
      provider: one("provider"),
      status: one("status"),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    listMonitors(db, ctx.organizationId),
  ]);

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

      <ChannelManager
        page={channels}
        pageNumber={page}
        pageSize={pageSize}
        providers={providerDescriptors()}
        monitors={monitors.map((m) => ({ id: m.id, name: m.name }))}
        filters={{
          search: one("q") ?? "",
          provider: one("provider") ?? "",
          status: one("status") ?? "",
        }}
        canEdit={canEdit}
      />
    </div>
  );
}

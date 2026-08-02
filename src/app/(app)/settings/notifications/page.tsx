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
import { db } from "@/db";
import { isEmailEnabled } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { getOrCreateWebhook } from "@/modules/notifications/webhook-service";
import { WEBHOOK_EVENTS } from "@/modules/notifications/webhook";

import { WebhookForm } from "./webhook-form";

export const metadata: Metadata = { title: "Notifications · Vigil" };

export default async function NotificationsSettingsPage() {
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { notification: ["update"] });
  const webhook = await getOrCreateWebhook(db, ctx.organizationId);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>
            Sent to organization owners, admins and responders when a
            monitor-driven incident opens or resolves.
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
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>Webhook</CardTitle>
            <Badge variant={webhook.enabled ? "default" : "secondary"}>
              {webhook.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <CardDescription>
            Vigil POSTs a signed JSON payload to your endpoint for every event
            below. Verify the{" "}
            <code className="font-mono text-xs">X-Vigil-Signature</code> header
            (HMAC-SHA-256 of the raw body, keyed by your secret). Slack and
            Discord webhook URLs are detected automatically and receive a
            readable message instead of the raw payload.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-1.5">
            {WEBHOOK_EVENTS.map((event) => (
              <code
                key={event}
                className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs"
              >
                {event}
              </code>
            ))}
          </div>
          <WebhookForm
            defaults={{ url: webhook.url, enabled: webhook.enabled }}
            // Editing-level credential: withhold it from read-only roles
            // so it can't be read from page source and used to forge a
            // signed delivery. Mirrors the recovery signing secret.
            secret={canEdit ? webhook.secret : ""}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>
    </div>
  );
}

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr";
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
import { env } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { listMonitors } from "@/modules/monitors/service";
import {
  getOrCreateStatusPage,
  listStatusPageMonitors,
} from "@/modules/status-pages/service";

import { StatusPageSettingsForm } from "./settings-form";
import { StatusPageMonitorsForm } from "./monitors-form";

export const metadata: Metadata = { title: "Status page — Vigil" };

export default async function StatusPageSettings() {
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { statusPage: ["update"] });

  const [page, selected, monitors] = await Promise.all([
    getOrCreateStatusPage(db, ctx.organizationId),
    listStatusPageMonitors(db, ctx.organizationId),
    listMonitors(db, ctx.organizationId),
  ]);
  // Subscriptions are only offered on public pages.

  const publicUrl = `${env.APP_URL}/status/${page.slug}`;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Status page</h1>
          <Badge variant={page.published ? "default" : "secondary"}>
            {page.published ? "Published" : "Draft"}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          A public page your customers can check during incidents.{" "}
          {page.published && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="text-foreground inline-flex items-center gap-1 underline"
            >
              View live page
              <ArrowSquareOutIcon className="size-3.5" aria-hidden />
            </a>
          )}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            The page is served at{" "}
            <code className="font-mono text-xs">{publicUrl}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusPageSettingsForm
            defaults={{
              name: page.name,
              slug: page.slug,
              published: page.published,
            }}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
          <CardDescription>
            Choose which monitors appear publicly. Give them customer-facing
            names — visitors see the display name, never the URL.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusPageMonitorsForm
            monitors={monitors.map((monitor) => ({
              id: monitor.id,
              name: monitor.name,
            }))}
            selected={selected.map((component) => ({
              monitorId: component.monitorId,
              displayName: component.displayName,
            }))}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>
    </div>
  );
}

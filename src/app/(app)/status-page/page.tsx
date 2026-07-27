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
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { db } from "@/db";
import { env } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { listMonitors } from "@/modules/monitors/service";
import {
  listStatusPageMonitors,
  listStatusPages,
} from "@/modules/status-pages/service";
import { countStatusPageSubscribers } from "@/modules/status-pages/subscribers";

import { CreateStatusPageDialog } from "./create-status-page";
import { DeleteStatusPageButton } from "./delete-status-page";
import { StatusPageSettingsForm } from "./settings-form";
import { StatusPageMonitorsForm } from "./monitors-form";

export const metadata: Metadata = { title: "Status pages — Vigil" };

export default async function StatusPageSettings() {
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { statusPage: ["update"] });

  const [pages, monitors] = await Promise.all([
    listStatusPages(db, ctx.organizationId),
    listMonitors(db, ctx.organizationId),
  ]);

  // Per page: its components, and its subscriber counts when it is public
  // (private and password pages have no public subscribers).
  const detail = await Promise.all(
    pages.map(async (page) => ({
      page,
      selected: await listStatusPageMonitors(db, ctx.organizationId, page.id),
      subscribers:
        page.visibility === "public"
          ? await countStatusPageSubscribers(db, page.id)
          : null,
    })),
  );

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Status pages
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Public pages your customers can check during incidents. Each has its
            own URL, components and subscribers.
          </p>
        </div>
        {canEdit && <CreateStatusPageDialog />}
      </header>

      {detail.length === 0 && (
        <Empty>
          <EmptyTitle>No status pages yet</EmptyTitle>
          <EmptyDescription>
            Create one to publish uptime and incidents to your customers.
          </EmptyDescription>
        </Empty>
      )}

      {detail.map(({ page, selected, subscribers }) => {
        const publicUrl = `${env.APP_URL}/status/${page.slug}`;
        return (
          <section key={page.id} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-medium tracking-tight">
                {page.name}
              </h2>
              <Badge variant={page.published ? "default" : "secondary"}>
                {page.published ? "Published" : "Draft"}
              </Badge>
              {page.published && (
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground inline-flex items-center gap-1 text-sm underline"
                >
                  View live page
                  <ArrowSquareOutIcon className="size-3.5" aria-hidden />
                </a>
              )}
              {canEdit && (
                <DeleteStatusPageButton
                  statusPageId={page.id}
                  name={page.name}
                />
              )}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
                <CardDescription>
                  Served at{" "}
                  <code className="font-mono text-xs">{publicUrl}</code>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatusPageSettingsForm
                  statusPageId={page.id}
                  defaults={{
                    name: page.name,
                    slug: page.slug,
                    published: page.published,
                    showBranding: page.showBranding,
                    visibility: page.visibility,
                    hasPassword: page.passwordHash !== null,
                  }}
                  canEdit={canEdit}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Components</CardTitle>
                <CardDescription>
                  Choose which monitors appear on this page. Give them
                  customer-facing names — visitors see the display name, never
                  the URL.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatusPageMonitorsForm
                  statusPageId={page.id}
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

            {subscribers && (
              <Card>
                <CardHeader>
                  <CardTitle>Subscribers</CardTitle>
                  <CardDescription>
                    Visitors can subscribe from this page to be emailed when an
                    incident opens, updates or resolves (double opt-in).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">
                    <span className="font-medium tabular-nums">
                      {subscribers.confirmed}
                    </span>{" "}
                    confirmed
                    {subscribers.pending > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {subscribers.pending} awaiting confirmation
                      </span>
                    )}
                  </p>
                </CardContent>
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}

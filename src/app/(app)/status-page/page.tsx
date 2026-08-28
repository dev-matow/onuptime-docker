import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";

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
import { cn } from "@/lib/utils";
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

export const metadata: Metadata = { title: "Status pages · Vigil" };

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "components", label: "Components" },
  { id: "subscribers", label: "Subscribers" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function managementHref(pageId: string, section: SectionId) {
  return `/status-page?page=${encodeURIComponent(pageId)}&section=${section}`;
}

function visibilityLabel(visibility: "public" | "private" | "password") {
  if (visibility === "private") return "Members only";
  if (visibility === "password") return "Password protected";
  return "Public";
}

export default async function StatusPageSettings(
  props: PageProps<"/status-page">,
) {
  const searchParams = await props.searchParams;
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, { statusPage: ["update"] });

  const pages = await listStatusPages(db, ctx.organizationId);
  const requestedPageId =
    typeof searchParams.page === "string" ? searchParams.page : null;
  const page =
    pages.find((candidate) => candidate.id === requestedPageId) ??
    pages[0] ??
    null;
  const requestedSection =
    typeof searchParams.section === "string" ? searchParams.section : null;
  const section: SectionId = SECTIONS.some(
    (candidate) => candidate.id === requestedSection,
  )
    ? (requestedSection as SectionId)
    : "general";

  const pageDetail = page
    ? await Promise.all([
        listMonitors(db, ctx.organizationId),
        listStatusPageMonitors(db, ctx.organizationId, page.id),
        page.visibility === "public"
          ? countStatusPageSubscribers(db, page.id)
          : Promise.resolve(null),
      ])
    : null;
  const monitors = pageDetail?.[0] ?? [];
  const selected = pageDetail?.[1] ?? [];
  const subscribers = pageDetail?.[2] ?? null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
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

      {pages.length === 0 && (
        <Empty>
          <EmptyTitle>No status pages yet</EmptyTitle>
          <EmptyDescription>
            Create one to publish uptime and incidents to your customers.
          </EmptyDescription>
        </Empty>
      )}

      {page && (
        <div className="grid items-start gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="min-w-0">
            <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
              Your pages
            </p>
            <nav
              aria-label="Status pages"
              className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] lg:overflow-visible [&::-webkit-scrollbar]:hidden"
            >
              <ul className="flex w-max gap-2 lg:w-auto lg:flex-col">
                {pages.map((candidate) => {
                  const active = candidate.id === page.id;
                  return (
                    <li key={candidate.id} className="w-52 lg:w-auto">
                      <Link
                        href={managementHref(candidate.id, section)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block rounded-lg border px-3 py-2.5 transition-colors",
                          active
                            ? "border-border bg-card shadow-xs"
                            : "border-transparent hover:border-border hover:bg-card/60",
                        )}
                      >
                        <span
                          className={cn(
                            "block truncate text-sm",
                            active ? "font-medium" : "text-muted-foreground",
                          )}
                        >
                          {candidate.name}
                        </span>
                        <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
                          <span
                            aria-hidden
                            className={cn(
                              "size-1.5 rounded-full",
                              candidate.published
                                ? "bg-ok-dot"
                                : "border-line-tag border",
                            )}
                          />
                          {candidate.published ? "Published" : "Draft"} ·{" "}
                          {visibilityLabel(candidate.visibility)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </aside>

          <main className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-xl font-semibold tracking-tight">
                    {page.name}
                  </h2>
                  <Badge variant={page.published ? "default" : "secondary"}>
                    {page.published ? "Published" : "Draft"}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-1 font-mono text-xs">
                  /status/{page.slug}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {page.published && (
                  <a
                    href={`${env.APP_URL}/status/${page.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm underline"
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
            </div>

            <dl className="grid grid-cols-2 rounded-lg border sm:grid-cols-4">
              <div className="px-3 py-3">
                <dt className="text-muted-foreground text-[11px]">State</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {page.published ? "Live" : "Draft"}
                </dd>
              </div>
              <div className="border-l px-3 py-3">
                <dt className="text-muted-foreground text-[11px]">Access</dt>
                <dd className="mt-0.5 truncate text-sm font-medium">
                  {visibilityLabel(page.visibility)}
                </dd>
              </div>
              <div className="border-t px-3 py-3 sm:border-t-0 sm:border-l">
                <dt className="text-muted-foreground text-[11px]">
                  Components
                </dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">
                  {selected.length}
                </dd>
              </div>
              <div className="border-t border-l px-3 py-3 sm:border-t-0">
                <dt className="text-muted-foreground text-[11px]">
                  Subscribers
                </dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">
                  {subscribers?.confirmed ?? "—"}
                </dd>
              </div>
            </dl>

            <nav
              aria-label="Status page sections"
              className="bg-muted/60 overflow-x-auto rounded-lg border p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <ul className="flex w-max gap-1">
                {SECTIONS.map((item) => {
                  const active = item.id === section;
                  return (
                    <li key={item.id}>
                      <Link
                        href={managementHref(page.id, item.id)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-block rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
                          active
                            ? "bg-card text-primary border-border font-semibold shadow-xs"
                            : "text-muted-foreground hover:bg-card/60 hover:text-foreground border-transparent",
                        )}
                      >
                        {item.label}
                        {item.id === "components" && (
                          <span className="ml-1.5 font-mono text-xs">
                            {selected.length}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {section === "general" && (
              <Card>
                <CardHeader>
                  <CardTitle>General settings</CardTitle>
                  <CardDescription>
                    Identity, public URL, visibility and branding for this page.
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
            )}

            {section === "components" && (
              <Card>
                <CardHeader>
                  <CardTitle>Published components</CardTitle>
                  <CardDescription>
                    Select monitors and give them customer-facing names. Target
                    URLs are never shown publicly.
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
            )}

            {section === "subscribers" && (
              <Card>
                <CardHeader>
                  <CardTitle>Subscribers</CardTitle>
                  <CardDescription>
                    People receiving incident lifecycle updates from this status
                    page.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {subscribers ? (
                    <dl className="grid max-w-md grid-cols-2 gap-3">
                      <div className="rounded-lg border p-4">
                        <dt className="text-muted-foreground text-xs">
                          Confirmed
                        </dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">
                          {subscribers.confirmed}
                        </dd>
                      </div>
                      <div className="rounded-lg border p-4">
                        <dt className="text-muted-foreground text-xs">
                          Awaiting confirmation
                        </dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">
                          {subscribers.pending}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      Subscriber sign-up is available only when this page is
                      public. Change access under General settings to enable it.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

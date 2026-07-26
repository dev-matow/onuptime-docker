import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";

import { AutoRefresh } from "@/components/auto-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import { db } from "@/db";
import { formatDateTime, formatRelativeTime, formatUptime } from "@/lib/format";
import {
  getPublicStatusPage,
  type PublicIncident,
  type PublicStatusPage,
} from "@/modules/status-pages/service";
import { cn } from "@/lib/utils";

import { UptimeBars } from "./uptime-bars";

/**
 * The public status surface. The expensive page query is cached for 60s
 * per slug, so an outage traffic spike still doesn't hit the database on
 * every view.
 */
/**
 * `unstable_cache` JSON-serializes its result, so on a cache hit every
 * `Date` comes back as a string. Revive the incident timestamps the
 * template calls `Date` methods on — `new Date` is a no-op on a real Date
 * (cache miss) and a parse on the string (cache hit).
 */
function reviveIncidentDates(incident: PublicIncident): PublicIncident {
  return {
    ...incident,
    startedAt: new Date(incident.startedAt),
    resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt) : null,
    events: incident.events.map((event) => ({
      ...event,
      createdAt: new Date(event.createdAt),
    })),
  };
}

/**
 * The slug MUST travel as an argument, not as a closure capture. Next
 * derives the cache key from the callback's source text, the key parts
 * and `JSON.stringify(arguments)` — a captured slug appears in none of
 * them, so every status page would share one cache entry. Core is
 * single-organization, so only one page can exist and the collision is
 * unreachable here; the argument form keeps it that way by construction.
 */
async function cachedPublicStatusPage(
  slug: string,
): Promise<PublicStatusPage | null> {
  const page = await unstable_cache(
    (pageSlug: string) => getPublicStatusPage(db, pageSlug),
    ["public-status-page"],
    { revalidate: 60, tags: [`status-page-${slug}`] },
  )(slug);
  if (!page) return null;
  return {
    ...page,
    activeIncidents: page.activeIncidents.map(reviveIncidentDates),
    recentIncidents: page.recentIncidents.map(reviveIncidentDates),
  };
}

export async function generateMetadata(
  props: PageProps<"/status/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const page = await cachedPublicStatusPage(slug);
  if (!page) return { title: "Status page", robots: { index: false } };
  return {
    title: page ? `${page.name} — status` : "Status page",
    description: page
      ? `Live service status and incident history for ${page.organizationName}.`
      : undefined,
  };
}

const OVERALL_BANNER: Record<
  PublicStatusPage["overall"],
  { text: string; className: string }
> = {
  operational: {
    text: "All systems operational",
    className: "bg-emerald-500",
  },
  degraded: { text: "Degraded performance", className: "bg-amber-500" },
  outage: { text: "Ongoing outage", className: "bg-red-500" },
};

const COMPONENT_STATUS: Record<
  PublicStatusPage["components"][number]["status"],
  { label: string; className: string }
> = {
  up: {
    label: "Operational",
    className: "text-emerald-600 dark:text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    className: "text-amber-600 dark:text-amber-400",
  },
  down: { label: "Down", className: "text-red-600 dark:text-red-400" },
  unknown: { label: "No data", className: "text-muted-foreground" },
};

export default async function PublicStatusPage(
  props: PageProps<"/status/[slug]">,
) {
  const { slug } = await props.params;
  const page = await cachedPublicStatusPage(slug);
  if (!page) notFound();

  const banner = OVERALL_BANNER[page.overall];

  return (
    <div className="bg-background min-h-svh">
      <AutoRefresh />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12">
        <header className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-sm">
              {page.organizationName}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              {page.name}
            </h1>
          </div>
          <ThemeToggle />
        </header>

        <div
          className={cn(
            "flex items-center gap-3 rounded-lg px-4 py-3 text-white",
            banner.className,
          )}
        >
          <span className="text-lg font-medium">{banner.text}</span>
        </div>

        {page.activeIncidents.length > 0 && (
          <section
            className="flex flex-col gap-4"
            aria-label="Active incidents"
          >
            <h2 className="text-lg font-semibold">Active incidents</h2>
            {page.activeIncidents.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))}
          </section>
        )}

        <section className="flex flex-col gap-3" aria-label="Components">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Components</h2>
            <span className="text-muted-foreground text-xs">
              90-day history
            </span>
          </div>
          <div className="divide-y rounded-lg border">
            {page.components.length === 0 && (
              <p className="text-muted-foreground p-4 text-sm">
                No components are published yet.
              </p>
            )}
            {page.components.map((component) => {
              const status = COMPONENT_STATUS[component.status];
              return (
                <div key={component.name} className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium">{component.name}</span>
                    <span className={cn("text-sm", status.className)}>
                      {status.label}
                    </span>
                  </div>
                  <UptimeBars dailyUptime={component.dailyUptime} />
                  <p className="text-muted-foreground text-xs">
                    {component.uptime90dPct === null
                      ? "No uptime data yet"
                      : `${formatUptime(component.uptime90dPct)} uptime over 90 days`}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-label="Incident history">
          <h2 className="text-lg font-semibold">Past incidents</h2>
          {page.recentIncidents.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No incidents in the last 14 days.
            </p>
          ) : (
            page.recentIncidents.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))
          )}
        </section>

        <footer className="text-muted-foreground border-t pt-6 text-center text-xs">
          <a
            href="https://github.com/artaspervyj-dotcom/vigil-core"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            Powered by Vigil Core
          </a>
        </footer>
      </div>
    </div>
  );
}

const SEVERITY_LABEL: Record<PublicIncident["severity"], string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};

function IncidentCard({ incident }: { incident: PublicIncident }) {
  return (
    <article className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="font-medium">{incident.title}</h3>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 font-mono uppercase",
              incident.severity === "critical" && "border-red-300 text-red-600",
              incident.severity === "major" &&
                "border-orange-300 text-orange-600",
              incident.severity === "minor" &&
                "border-yellow-300 text-yellow-600",
            )}
          >
            {SEVERITY_LABEL[incident.severity]}
          </span>
          <time dateTime={incident.startedAt.toISOString()}>
            {formatDateTime(incident.startedAt)}
          </time>
        </div>
      </div>
      <ol className="flex flex-col gap-3 px-4 py-3">
        {incident.events.map((event, index) => (
          <li key={index} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs">
              {event.status && (
                <span className="font-medium capitalize">{event.status}</span>
              )}
              <span
                className="text-muted-foreground"
                title={formatDateTime(event.createdAt)}
              >
                {formatRelativeTime(event.createdAt)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{event.message}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

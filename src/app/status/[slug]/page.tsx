import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr";

import { AutoRefresh } from "@/components/auto-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import { VigilMark } from "@/components/vigil-mark";
import { db } from "@/db";
import { member, organization } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { formatDuration, formatRelativeTime, formatUptime } from "@/lib/format";
import { getSession } from "@/lib/session";
import {
  statusPageUnlockCookie,
  verifyStatusPageUnlock,
} from "@/modules/status-pages/access";
import {
  getPublicStatusPage,
  getPublicComponentDayTimeline,
  getStatusPageAccess,
  type PublicComponentDayTimeline,
  type PublicIncident,
  type PublicStatusPage,
  type StatusPageAccess,
} from "@/modules/status-pages/service";
import { cn } from "@/lib/utils";

import { PasswordGate, PrivateSignInGate } from "./gate";
import { SubscribeForm } from "./subscribe-form";
import { UptimeBars } from "./uptime-bars";

/**
 * The public status surface. Access is gated per request (private pages
 * need a session; password pages need an unlock cookie), so the route is
 * dynamic — but the expensive page query is cached for 60s per slug, so
 * an outage traffic spike still doesn't hit the database on every view.
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
 * them, so every status page in the deployment would share one entry
 * and serve whichever page was requested first.
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

/** Members of the owning org may view a `private` page. */
async function canViewPrivate(access: StatusPageAccess): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  const membership = await db.query.member.findFirst({
    where: and(
      eq(member.userId, session.user.id),
      eq(member.organizationId, access.organizationId),
    ),
    columns: { id: true },
  });
  return Boolean(membership);
}

export async function generateMetadata(
  props: PageProps<"/status/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const access = await getStatusPageAccess(db, slug);
  // Private/password pages get a generic title — no name leak.
  if (!access || access.visibility !== "public") {
    return { title: "Status page", robots: { index: false } };
  }
  const page = await cachedPublicStatusPage(slug);
  return {
    title: page ? `${page.name}, status` : "Status page",
    description: page
      ? `Live service status and incident history for ${page.organizationName}.`
      : undefined,
  };
}

const OVERALL_BANNER: Record<
  PublicStatusPage["overall"],
  { text: string; className: string }
> = {
  // A filled banner carries the page colour as its text, which is the
  // same inverse block a solid button uses. Each fill states its own
  // foreground: "degraded" is the ink itself, and white on it would be
  // white on white.
  operational: {
    text: "All systems operational",
    className: "border border-ok-dot/25 bg-ok-dot/10 text-ok",
  },
  degraded: {
    text: "Degraded performance",
    className: "border border-warn-dot/30 bg-warn-dot/10 text-warn",
  },
  outage: {
    text: "Ongoing outage",
    className:
      "border border-destructive/30 bg-destructive/10 text-destructive",
  },
};

const COMPONENT_STATUS: Record<
  PublicStatusPage["components"][number]["status"],
  { label: string; className: string; dotClassName: string }
> = {
  up: {
    label: "Operational",
    className: "text-ok",
    dotClassName: "bg-ok-dot",
  },
  degraded: {
    label: "Degraded",
    className: "text-warn",
    dotClassName: "bg-warn-dot",
  },
  down: {
    label: "Down",
    className: "text-destructive",
    dotClassName: "bg-destructive",
  },
  unknown: {
    label: "No data",
    className: "text-muted-foreground",
    dotClassName: "border-line-quiet border bg-transparent",
  },
};

const publicCheckTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});

const publicDayFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "Asia/Bangkok",
});

const publicSlotTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Bangkok",
});

function publicCheckTime(value: string): string {
  return `${publicCheckTimeFormatter.format(new Date(value))} UTC+7`;
}

function issueDot(verdict: "up" | "down" | "degraded" | "indeterminate") {
  if (verdict === "down") return "bg-destructive";
  if (verdict === "degraded") return "bg-warn-dot";
  if (verdict === "indeterminate") return "border-line-quiet border";
  return "bg-ok-dot";
}

export default async function PublicStatusPage(
  props: PageProps<"/status/[slug]">,
) {
  const { slug } = await props.params;
  const searchParams = await props.searchParams;
  const selectedComponent =
    typeof searchParams.component === "string"
      ? Number.parseInt(searchParams.component, 10)
      : Number.NaN;
  const selectedDay =
    typeof searchParams.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(searchParams.day)
      ? searchParams.day
      : null;
  const selectedSlot =
    typeof searchParams.slot === "string"
      ? Number.parseInt(searchParams.slot, 10)
      : Number.NaN;
  const access = await getStatusPageAccess(db, slug);
  if (!access) notFound();

  // Gate by visibility before rendering anything.
  if (access.visibility === "private") {
    if (!(await canViewPrivate(access))) {
      const org = await db.query.organization.findFirst({
        where: eq(organization.id, access.organizationId),
        columns: { name: true },
      });
      return <PrivateSignInGate orgName={org?.name ?? null} />;
    }
  } else if (access.visibility === "password") {
    const cookieStore = await cookies();
    const token = cookieStore.get(statusPageUnlockCookie(access.id))?.value;
    if (!verifyStatusPageUnlock(access.id, token)) {
      return <PasswordGate slug={slug} error={searchParams.e === "1"} />;
    }
  }

  const page = await cachedPublicStatusPage(slug);
  if (!page) notFound();

  const selectedTimeline =
    Number.isInteger(selectedComponent) && selectedDay
      ? await getPublicComponentDayTimeline(
          db,
          slug,
          selectedComponent,
          selectedDay,
        )
      : null;

  const banner = OVERALL_BANNER[page.overall];
  const incidentHistory = groupIncidentsByDay(page.recentIncidents);

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
            "flex items-center gap-3 rounded-xl px-4 py-3",
            banner.className,
          )}
        >
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full bg-current"
          />
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
              <span className="sm:hidden">60-day history</span>
              <span className="hidden sm:inline">90-day history</span>
            </span>
          </div>
          <div className="divide-y rounded-lg border">
            {page.components.length === 0 && (
              <p className="text-muted-foreground p-4 text-sm">
                No components are published yet.
              </p>
            )}
            {page.components.map((component, componentIndex) => {
              const status = component.paused
                ? {
                    label: "Paused",
                    className: "text-muted-foreground",
                    dotClassName: "border-line-quiet border bg-transparent",
                  }
                : COMPONENT_STATUS[component.status];
              return (
                <div
                  key={`${component.name}-${componentIndex}`}
                  id={`component-${componentIndex}`}
                  className="scroll-mt-6"
                >
                  <div className="flex items-center justify-between gap-4 p-4">
                    <span className="font-medium">{component.name}</span>
                    <span
                      className={cn(
                        "flex items-center gap-2 text-sm font-medium",
                        status.className,
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          status.dotClassName,
                        )}
                      />
                      {status.label}
                    </span>
                  </div>

                  <div className="border-t p-4">
                    <UptimeBars
                      dailyUptime={component.dailyUptime}
                      slug={slug}
                      componentIndex={componentIndex}
                      selectedDay={
                        selectedComponent === componentIndex
                          ? (selectedDay ?? undefined)
                          : undefined
                      }
                    />
                    <p className="text-muted-foreground mt-2 text-xs">
                      {component.uptime90dPct === null
                        ? "No uptime data yet"
                        : `${formatUptime(component.uptime90dPct)} uptime over 90 days`}
                    </p>
                    {selectedTimeline?.componentIndex === componentIndex && (
                      <ComponentDayTimeline
                        timeline={selectedTimeline}
                        slug={slug}
                        selectedSlot={selectedSlot}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-5" aria-label="Incident history">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold">Incident history</h2>
            <span className="text-muted-foreground text-xs">Last 14 days</span>
          </div>
          {page.recentIncidents.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
              <span
                aria-hidden
                className="bg-ok-dot size-2 shrink-0 rounded-full"
              />
              <span>No incidents reported in the last 14 days.</span>
            </div>
          ) : (
            incidentHistory.map((group) => (
              <div
                key={group.label}
                className="grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4"
              >
                <p className="text-muted-foreground pt-1 text-sm font-medium">
                  {group.label}
                </p>
                <div className="divide-y rounded-xl border">
                  {group.incidents.map((incident) => (
                    <IncidentCard
                      key={incident.id}
                      incident={incident}
                      variant="history"
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </section>

        {access.visibility === "public" && (
          <section className="border-t pt-6" aria-label="Subscribe to updates">
            <h2 className="text-sm font-medium">Get status updates</h2>
            <p className="text-muted-foreground mt-1 mb-3 text-xs">
              Subscribe to be emailed when an incident opens, updates or
              resolves.
            </p>
            <SubscribeForm slug={slug} />
          </section>
        )}

        {/* Vigil's own mark, and only here. Everything above this line is
            the customer's page: their name, their logo, their colour. The
            footer appears at all only when they left branding on. */}
        {page.showBranding && (
          <footer className="text-muted-foreground border-t pt-6 text-center text-xs">
            <span className="inline-flex items-center gap-1.5">
              <VigilMark className="h-[16px]" />
              Powered by Vigil
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}

function slotColor(
  status: PublicComponentDayTimeline["slots"][number]["status"],
) {
  if (status === "down") return "bg-destructive";
  if (status === "degraded") return "bg-warn-dot";
  if (status === "up") return "bg-ok-dot";
  if (status === "indeterminate") {
    return "border-line-quiet border bg-transparent";
  }
  return "bg-muted";
}

function slotStatusMeta(
  status: PublicComponentDayTimeline["slots"][number]["status"],
) {
  if (status === "down") {
    return { label: "Down", className: "text-destructive" };
  }
  if (status === "degraded") {
    return { label: "Degraded", className: "text-warn" };
  }
  if (status === "up") return { label: "Operational", className: "text-ok" };
  if (status === "indeterminate") {
    return { label: "Could not measure", className: "text-muted-foreground" };
  }
  return { label: "No data", className: "text-muted-foreground" };
}

function ComponentDayTimeline({
  timeline,
  slug,
  selectedSlot,
}: {
  timeline: PublicComponentDayTimeline;
  slug: string;
  selectedSlot: number;
}) {
  const recentIssues = timeline.slots
    .flatMap((slot) => slot.issues)
    .sort(
      (left, right) =>
        new Date(right.checkedAt).getTime() -
        new Date(left.checkedAt).getTime(),
    )
    .slice(0, 2);
  const hasChecks = timeline.slots.some((slot) => slot.checkCount > 0);
  const isRolling = timeline.windowKind === "rolling";
  const selectedSlotIndex =
    Number.isInteger(selectedSlot) &&
    selectedSlot >= 0 &&
    selectedSlot < timeline.slots.length
      ? selectedSlot
      : null;
  const selectedInterval =
    selectedSlotIndex === null ? null : timeline.slots[selectedSlotIndex]!;

  return (
    <section
      className="bg-muted/25 mt-4 rounded-lg border p-4"
      aria-label={
        isRolling
          ? "30-minute uptime for the last 24 hours"
          : `30-minute uptime for ${timeline.day}`
      }
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            {isRolling
              ? "Last 24 hours"
              : publicDayFormatter.format(
                  new Date(`${timeline.day}T00:00:00+07:00`),
                )}
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            30-minute intervals · Thailand time (UTC+7)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {hasChecks
              ? isRolling
                ? "Live detail"
                : "Daily detail"
              : "No checks recorded"}
          </span>
          <Link
            href={`/status/${encodeURIComponent(slug)}#component-${timeline.componentIndex}`}
            className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            Close details
          </Link>
        </div>
      </div>

      <div className="flex h-10 items-stretch gap-px" role="list">
        {timeline.slots.map((slot, index) => {
          const isSelected = selectedSlotIndex === index;
          const start = publicSlotTimeFormatter.format(new Date(slot.start));
          const end = publicSlotTimeFormatter.format(new Date(slot.end));
          const description = [
            `${start}–${end} UTC+7`,
            slot.uptimePct === null
              ? "No uptime data"
              : `${slot.uptimePct.toFixed(2)}% uptime · ${slot.checkCount} ${
                  slot.checkCount === 1 ? "check" : "checks"
                }`,
            ...slot.issues.map((issue) => issue.summary),
          ].join("\n");

          return (
            <Link
              key={slot.start}
              role="listitem"
              href={
                isSelected
                  ? `/status/${encodeURIComponent(slug)}?component=${timeline.componentIndex}&day=${timeline.day}#component-${timeline.componentIndex}`
                  : `/status/${encodeURIComponent(slug)}?component=${timeline.componentIndex}&day=${timeline.day}&slot=${index}#component-${timeline.componentIndex}`
              }
              title={description}
              aria-label={`${description.replaceAll("\n", ". ")}. ${
                isSelected ? "Hide interval details." : "View interval details."
              }`}
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "group/slot focus-visible:ring-ring relative min-w-0 flex-1 rounded-[2px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-offset-1",
                isSelected &&
                  "ring-primary z-10 ring-2 ring-offset-1 ring-offset-background",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "block size-full rounded-[2px]",
                  slotColor(slot.status),
                )}
              />
              <span
                role="tooltip"
                className={cn(
                  "bg-foreground text-background pointer-events-none absolute bottom-[calc(100%+8px)] z-30 hidden w-52 rounded-lg px-3 py-2 text-left text-xs leading-5 shadow-xl group-hover/slot:block group-focus-visible/slot:block",
                  index < 7
                    ? "left-0"
                    : index > timeline.slots.length - 8
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2",
                )}
              >
                <strong className="block font-semibold">
                  {start}–{end} UTC+7
                </strong>
                <span className="block opacity-80">
                  {slot.uptimePct === null
                    ? "No uptime data"
                    : `${slot.uptimePct.toFixed(2)}% uptime · ${slot.checkCount} ${
                        slot.checkCount === 1 ? "check" : "checks"
                      }`}
                </span>
                {slot.issues.map((issue) => (
                  <span
                    key={issue.checkedAt}
                    className="border-background/20 mt-1 block border-t pt-1"
                  >
                    {publicSlotTimeFormatter.format(new Date(issue.checkedAt))}
                    {" UTC+7 · "}
                    {issue.summary}
                  </span>
                ))}
              </span>
            </Link>
          );
        })}
      </div>

      {isRolling ? (
        <div className="text-muted-foreground mt-2 grid grid-cols-5 text-[10px]">
          <span>24h ago</span>
          <span className="text-center">18h ago</span>
          <span className="text-center">12h ago</span>
          <span className="text-center">6h ago</span>
          <span className="text-right font-medium">Now</span>
        </div>
      ) : (
        <div className="text-muted-foreground mt-2 grid grid-cols-5 text-[10px]">
          <span>00:00</span>
          <span className="text-center">06:00</span>
          <span className="text-center">12:00</span>
          <span className="text-center">18:00</span>
          <span className="text-right">24:00</span>
        </div>
      )}

      <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {[
          ["Operational", "bg-ok-dot"],
          ["Degraded", "bg-warn-dot"],
          ["Down", "bg-destructive"],
          ["No data", "bg-muted border"],
        ].map(([label, color]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-[2px]", color)} />
            {label}
          </span>
        ))}
      </div>

      {selectedInterval ? (
        <IntervalDetails
          slot={selectedInterval}
          slug={slug}
          timeline={timeline}
        />
      ) : recentIssues.length > 0 ? (
        <div className="mt-4 border-t pt-3">
          <h4 className="text-xs font-medium">
            Latest errors {isRolling ? "in the last 24 hours" : "on this day"}
          </h4>
          <ol className="mt-2 flex flex-col gap-2">
            {recentIssues.map((issue) => (
              <li
                key={issue.checkedAt}
                className="flex items-start gap-2 text-xs"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-2 shrink-0 rounded-full",
                    issueDot(issue.verdict),
                  )}
                />
                <span className="min-w-0 flex-1">{issue.summary}</span>
                <time
                  dateTime={issue.checkedAt}
                  className="text-muted-foreground shrink-0 font-mono"
                >
                  {publicSlotTimeFormatter.format(new Date(issue.checkedAt))}{" "}
                  UTC+7
                </time>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-muted-foreground mt-4 border-t pt-3 text-xs">
          {hasChecks
            ? isRolling
              ? "No errors were recorded in the last 24 hours."
              : "No errors were recorded on this day."
            : isRolling
              ? "No checks were recorded in the last 24 hours."
              : "No checks were recorded on this day."}
        </p>
      )}
    </section>
  );
}

function IntervalDetails({
  slot,
  slug,
  timeline,
}: {
  slot: PublicComponentDayTimeline["slots"][number];
  slug: string;
  timeline: PublicComponentDayTimeline;
}) {
  const status = slotStatusMeta(slot.status);
  const start = publicSlotTimeFormatter.format(new Date(slot.start));
  const end = publicSlotTimeFormatter.format(new Date(slot.end));

  return (
    <section className="mt-4 border-t pt-3" aria-label="Selected interval">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">
            {start}–{end} UTC+7
          </h4>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Selected 30-minute interval
          </p>
        </div>
        <Link
          href={`/status/${encodeURIComponent(slug)}?component=${timeline.componentIndex}&day=${timeline.day}#component-${timeline.componentIndex}`}
          className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          Close interval
        </Link>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground text-[11px]">Status</dt>
          <dd
            className={cn(
              "mt-1 flex items-center gap-1.5 text-xs font-medium",
              status.className,
            )}
          >
            <span
              aria-hidden
              className={cn("size-2 rounded-full", slotColor(slot.status))}
            />
            {status.label}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-[11px]">Uptime</dt>
          <dd className="mt-1 font-mono text-xs">
            {slot.uptimePct === null ? "—" : `${slot.uptimePct.toFixed(2)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-[11px]">Checks</dt>
          <dd className="mt-1 font-mono text-xs">{slot.checkCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-[11px]">Last response</dt>
          <dd className="mt-1 font-mono text-xs">
            {slot.lastCheck?.responseTimeMs === null ||
            slot.lastCheck?.responseTimeMs === undefined
              ? "—"
              : formatDuration(slot.lastCheck.responseTimeMs)}
          </dd>
        </div>
      </dl>

      {slot.lastCheck ? (
        <div className="bg-card mt-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium">{slot.lastCheck.summary}</p>
            <time
              dateTime={slot.lastCheck.checkedAt}
              className="text-muted-foreground text-[11px]"
            >
              {publicCheckTime(slot.lastCheck.checkedAt)}
            </time>
          </div>
          {(slot.lastCheck.statusCode !== null ||
            slot.lastCheck.responseTimeMs !== null) && (
            <p className="text-muted-foreground mt-1 font-mono text-[11px]">
              {slot.lastCheck.statusCode !== null &&
                `HTTP ${slot.lastCheck.statusCode}`}
              {slot.lastCheck.statusCode !== null &&
                slot.lastCheck.responseTimeMs !== null &&
                " · "}
              {slot.lastCheck.responseTimeMs !== null &&
                formatDuration(slot.lastCheck.responseTimeMs)}
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">
          No checks were recorded in this interval.
        </p>
      )}

      {slot.issues.length > 0 && (
        <ol className="mt-3 flex flex-col gap-2 border-t pt-3">
          {slot.issues.map((issue) => (
            <li
              key={issue.checkedAt}
              className="flex items-start gap-2 text-xs"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-2 shrink-0 rounded-full",
                  issueDot(issue.verdict),
                )}
              />
              <span className="min-w-0 flex-1">{issue.summary}</span>
              <time
                dateTime={issue.checkedAt}
                className="text-muted-foreground shrink-0 font-mono"
              >
                {publicSlotTimeFormatter.format(new Date(issue.checkedAt))}{" "}
                UTC+7
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const SEVERITY_LABEL: Record<PublicIncident["severity"], string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};

const INCIDENT_STATUS: Record<
  PublicIncident["status"],
  { label: string; className: string; dotClassName: string }
> = {
  investigating: {
    label: "Investigating",
    className: "text-destructive",
    dotClassName: "bg-destructive",
  },
  identified: {
    label: "Identified",
    className: "text-destructive",
    dotClassName: "bg-destructive",
  },
  monitoring: {
    label: "Monitoring",
    className: "text-warn",
    dotClassName: "bg-warn-dot",
  },
  resolved: {
    label: "Resolved",
    className: "text-ok",
    dotClassName: "bg-ok-dot",
  },
};

const SEVERITY_DOT: Record<PublicIncident["severity"], string> = {
  critical: "bg-destructive",
  major: "bg-warn-dot",
  minor: "border-line-tag border bg-transparent",
};

function groupIncidentsByDay(incidents: PublicIncident[]) {
  const groups = new Map<string, PublicIncident[]>();
  for (const incident of incidents) {
    const label = publicDayFormatter.format(incident.startedAt);
    const group = groups.get(label);
    if (group) group.push(incident);
    else groups.set(label, [incident]);
  }
  return [...groups].map(([label, groupedIncidents]) => ({
    label,
    incidents: groupedIncidents,
  }));
}

function incidentDuration(incident: PublicIncident) {
  if (!incident.resolvedAt) return null;
  const durationMs = Math.max(
    0,
    incident.resolvedAt.getTime() - incident.startedAt.getTime(),
  );
  return durationMs < 60_000 ? "<1m" : formatDuration(durationMs);
}

function incidentEventMessage(event: PublicIncident["events"][number] | null) {
  const message = event?.message.trim();
  if (!message || /^[-–—]$/.test(message)) {
    return "No additional details were provided.";
  }
  return message;
}

function HistoryIncidentCard({ incident }: { incident: PublicIncident }) {
  const latestEvent = incident.events[0] ?? null;
  const status = INCIDENT_STATUS[incident.status];
  const duration = incidentDuration(incident);
  const startTime = publicSlotTimeFormatter.format(incident.startedAt);
  const endTime = incident.resolvedAt
    ? publicSlotTimeFormatter.format(incident.resolvedAt)
    : null;

  return (
    <details className="group/incident">
      <summary className="focus-visible:ring-ring flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-4 outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-medium">{incident.title}</h3>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                status.className,
              )}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", status.dotClassName)}
              />
              {status.label}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
            {incidentEventMessage(latestEvent)}
          </p>
        </div>
        <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
          <time
            dateTime={
              incident.resolvedAt?.toISOString() ??
              incident.startedAt.toISOString()
            }
            title={publicCheckTime(
              (incident.resolvedAt ?? incident.startedAt).toISOString(),
            )}
            className="font-mono tabular-nums"
          >
            {endTime ?? startTime} UTC+7
          </time>
          <CaretDownIcon
            aria-hidden
            className="size-4 transition-transform group-open/incident:rotate-180"
          />
        </div>
      </summary>

      <div className="border-t bg-muted/15 px-4 py-4">
        <section
          className={cn(
            "rounded-lg border p-4",
            incident.status === "resolved" && "border-ok-dot/25 bg-ok-dot/5",
            incident.status === "monitoring" &&
              "border-warn-dot/30 bg-warn-dot/5",
            (incident.status === "investigating" ||
              incident.status === "identified") &&
              "border-destructive/25 bg-destructive/5",
          )}
          aria-label="Incident summary"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn("font-medium", status.className)}>
              {status.label}
            </span>
            <span className="text-muted-foreground">·</span>
            <span>{SEVERITY_LABEL[incident.severity]} impact</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed">
            {incidentEventMessage(latestEvent)}
          </p>
          <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="font-mono tabular-nums">
              {startTime}
              {endTime ? `–${endTime}` : ""} UTC+7
            </span>
            {duration && <span>{duration} duration</span>}
          </div>
        </section>

        <section className="mt-5" aria-label="Incident updates">
          <h4 className="mb-4 text-sm font-medium">Updates</h4>
          {incident.events.length > 0 ? (
            <ol>
              {incident.events.map((event, index) => (
                <IncidentEventRow
                  key={`${event.createdAt.toISOString()}-${index}`}
                  event={event}
                  timeline
                />
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground text-sm">
              No public updates yet.
            </p>
          )}
        </section>
      </div>
    </details>
  );
}

function IncidentCard({
  incident,
  variant = "active",
}: {
  incident: PublicIncident;
  variant?: "active" | "history";
}) {
  const [latestEvent, ...earlierEvents] = incident.events;
  const status = INCIDENT_STATUS[incident.status];
  const duration = incidentDuration(incident);
  const startTime = publicSlotTimeFormatter.format(incident.startedAt);
  const endTime = incident.resolvedAt
    ? publicSlotTimeFormatter.format(incident.resolvedAt)
    : null;

  if (variant === "history") {
    return <HistoryIncidentCard incident={incident} />;
  }

  return (
    <article className="rounded-xl border">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-medium">{incident.title}</h3>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-medium",
                status.className,
              )}
            >
              <span
                aria-hidden
                className={cn("size-2 rounded-full", status.dotClassName)}
              />
              {status.label}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  SEVERITY_DOT[incident.severity],
                )}
              />
              {SEVERITY_LABEL[incident.severity]} impact
            </span>
          </div>
        </div>
        <div className="text-muted-foreground flex shrink-0 flex-col items-end text-xs">
          <span
            className="font-mono tabular-nums"
            title={`Started ${publicCheckTime(incident.startedAt.toISOString())}`}
          >
            {startTime}
            {endTime ? `–${endTime}` : ""} UTC+7
          </span>
          {duration && <span>{duration} duration</span>}
        </div>
      </div>
      {latestEvent ? (
        <ol className="mx-4 mt-3 mb-3">
          <IncidentEventRow event={latestEvent} latest />
        </ol>
      ) : (
        <p className="text-muted-foreground mx-4 mt-3 mb-3 text-sm">
          No public updates yet.
        </p>
      )}

      {earlierEvents.length > 0 && (
        <details className="group/updates border-t">
          <summary className="focus-visible:ring-ring text-muted-foreground flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
            <span className="group-open/updates:hidden">
              Show incident timeline · {incident.events.length}{" "}
              {incident.events.length === 1 ? "update" : "updates"}
            </span>
            <span className="hidden group-open/updates:inline">
              Hide incident timeline
            </span>
            <CaretDownIcon
              aria-hidden
              className="size-4 shrink-0 transition-transform group-open/updates:rotate-180"
            />
          </summary>
          <ol className="flex flex-col gap-4 border-t px-4 py-3">
            {earlierEvents.map((event, index) => (
              <IncidentEventRow
                key={`${event.createdAt.toISOString()}-${index}`}
                event={event}
              />
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

function IncidentEventRow({
  event,
  latest = false,
  timeline = false,
}: {
  event: PublicIncident["events"][number];
  latest?: boolean;
  timeline?: boolean;
}) {
  const eventTone =
    event.status === "resolved"
      ? { dot: "bg-ok-dot", line: "border-ok-dot/35" }
      : event.status === "monitoring"
        ? { dot: "bg-warn-dot", line: "border-warn-dot/40" }
        : event.status === "investigating" || event.status === "identified"
          ? { dot: "bg-destructive", line: "border-destructive/35" }
          : { dot: "bg-muted-foreground", line: "border-line-tag" };

  return (
    <li
      className={cn(
        "relative flex flex-col gap-1 pl-4",
        latest && "bg-muted/35 rounded-lg px-3 py-2.5",
        timeline && "border-l pb-5 pl-5 last:border-transparent last:pb-0",
        timeline && eventTone.line,
      )}
    >
      {!latest && !timeline && (
        <span
          aria-hidden
          className="border-line-tag bg-background absolute top-1.5 left-0 size-2 rounded-full border-2"
        />
      )}
      {timeline && (
        <span
          aria-hidden
          className={cn(
            "ring-background absolute top-1.5 -left-[5px] size-2 rounded-full ring-4",
            eventTone.dot,
          )}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {event.status && (
          <span className="font-medium capitalize">
            {event.status.replaceAll("_", " ")}
          </span>
        )}
        <time
          dateTime={event.createdAt.toISOString()}
          className="text-muted-foreground"
          title={publicCheckTime(event.createdAt.toISOString())}
        >
          {publicSlotTimeFormatter.format(event.createdAt)} UTC+7 ·{" "}
          {formatRelativeTime(event.createdAt)}
        </time>
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">
        {incidentEventMessage(event)}
      </p>
    </li>
  );
}

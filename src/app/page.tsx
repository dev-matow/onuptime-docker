import {
  BroadcastIcon,
  PulseIcon,
  SirenIcon,
  SparkleIcon,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";

const FEATURES = [
  {
    icon: PulseIcon,
    title: "Uptime monitoring",
    description:
      "HTTP, TCP and TLS-expiry checks from every minute to every hour, with response-time tracking and degradation thresholds.",
  },
  {
    icon: SirenIcon,
    title: "Incident management",
    description:
      "Incidents open automatically when checks fail, then page the right people through on-call rotations and escalation policies.",
  },
  {
    icon: BroadcastIcon,
    title: "Public status pages",
    description:
      "Keep customers informed with a clean public page, live component health, 90 days of history, and email subscriptions.",
  },
  {
    icon: SparkleIcon,
    title: "AI postmortems",
    description:
      "Draft blameless postmortems and public updates from the incident timeline, ready for human review.",
  },
];

export default async function LandingPage() {
  const session = await getSession();

  return (
    <div className="relative flex min-h-svh flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(circle_at_50%_-15%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_62%)]"
      />
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-2">
          {session ? (
            <Button asChild>
              <Link href="/dashboard">Open dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild>
                <Link href="/sign-up">Get started</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-5 pt-20 pb-20 text-center sm:px-8 sm:pt-28">
          <span className="border-primary/15 bg-primary/5 text-primary rounded-full border px-3 py-1.5 text-xs font-semibold">
            uptime · incidents · status pages
          </span>
          <h1 className="max-w-3xl text-4xl leading-[1.08] font-semibold tracking-[-0.045em] text-balance sm:text-6xl">
            Know it&apos;s down before your customers do.
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base leading-7 text-balance sm:text-lg">
            Vigil watches your endpoints, opens incidents when they fail, and
            keeps everyone informed, from the on-call engineer to the customer
            refreshing your status page.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            {env.DEMO_MODE ? (
              <Button asChild size="lg">
                <a href="/api/demo">Explore the live demo</a>
              </Button>
            ) : (
              <>
                <Button asChild size="lg">
                  <Link href="/sign-up">Start monitoring</Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
              </>
            )}
          </div>
        </section>

        <section
          className="mx-auto grid w-full max-w-6xl gap-4 px-5 pb-24 sm:grid-cols-2 sm:px-8 lg:grid-cols-4"
          aria-label="Features"
        >
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="bg-card group rounded-xl border p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-md"
            >
              <feature.icon
                className="text-primary bg-primary/8 mb-4 size-9 rounded-lg p-2"
                aria-hidden
              />
              <h2 className="font-semibold">{feature.title}</h2>
              <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                {feature.description}
              </p>
            </div>
          ))}
        </section>
      </main>

      <footer className="text-muted-foreground border-t py-6 text-center text-xs">
        Vigil, self-hosted incident management.
      </footer>
    </div>
  );
}

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
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
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
        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-6 pt-20 pb-16 text-center">
          <span className="text-muted-foreground rounded-full border px-3 py-1 font-mono text-xs">
            uptime · incidents · status pages
          </span>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Know it&apos;s down before your customers do.
          </h1>
          <p className="text-muted-foreground max-w-xl text-lg text-balance">
            Vigil watches your endpoints, opens incidents when they fail, and
            keeps everyone informed, from the on-call engineer to the customer
            refreshing your status page.
          </p>
          <div className="flex items-center gap-3">
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
          className="mx-auto grid w-full max-w-5xl gap-6 px-6 pb-24 sm:grid-cols-2"
          aria-label="Features"
        >
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-lg border p-6">
              <feature.icon
                className="text-muted-foreground mb-3 size-6"
                aria-hidden
              />
              <h2 className="font-medium">{feature.title}</h2>
              <p className="text-muted-foreground mt-1 text-sm">
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

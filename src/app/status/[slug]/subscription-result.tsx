import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

/** Centered result screen shared by the confirm and unsubscribe pages. */
export function SubscriptionResult({
  title,
  message,
  backHref,
}: {
  title: string;
  message: string;
  backHref?: string;
}) {
  return (
    <div className="bg-background flex min-h-svh flex-col">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">{message}</p>
        </div>
        {backHref && (
          <Button asChild variant="outline" className="self-center">
            <Link href={backHref}>Back to status page</Link>
          </Button>
        )}
      </div>
      <div className="fixed top-4 right-4">
        <ThemeToggle />
      </div>
    </div>
  );
}

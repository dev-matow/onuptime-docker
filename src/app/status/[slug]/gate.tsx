import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { unlockStatusPageAction } from "./actions";

function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background flex min-h-svh flex-col">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
        {children}
      </div>
      <div className="fixed top-4 right-4">
        <ThemeToggle />
      </div>
    </div>
  );
}

/** Password prompt for a `password`-protected status page. */
export function PasswordGate({
  slug,
  error,
}: {
  slug: string;
  error: boolean;
}) {
  const action = unlockStatusPageAction.bind(null, slug);
  return (
    <GateShell>
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          This status page is protected
        </h1>
        <p className="text-muted-foreground text-sm">
          Enter the password you were given to view service status.
        </p>
      </div>
      <form action={action} className="flex flex-col gap-3">
        <Input
          type="password"
          name="password"
          placeholder="Password"
          aria-label="Status page password"
          autoFocus
          required
        />
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            That password didn&apos;t match. Try again.
          </p>
        )}
        <Button type="submit">View status</Button>
      </form>
    </GateShell>
  );
}

/** Shown when a `private` status page is viewed without a session. */
export function PrivateSignInGate({ orgName }: { orgName: string | null }) {
  return (
    <GateShell>
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          This status page is private
        </h1>
        <p className="text-muted-foreground text-sm">
          {orgName
            ? `Only members of ${orgName} can view it.`
            : "Only members of the organization can view it."}{" "}
          Sign in to continue.
        </p>
      </div>
      <Button asChild className="w-full">
        <Link href="/sign-in">Sign in</Link>
      </Button>
    </GateShell>
  );
}

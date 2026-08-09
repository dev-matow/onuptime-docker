"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { subscribeToStatusPageAction } from "./actions";

/**
 * Email subscription box for a public status page. Double opt-in: on
 * submit the server records a pending row and emails a confirmation
 * link; this form only ever shows the neutral "check your inbox" state.
 */
export function SubscribeForm({ slug }: { slug: string }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await subscribeToStatusPageAction(slug, { email });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Almost there, check your inbox for a link to confirm your subscription.
      </p>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 sm:flex-row"
      aria-label="Subscribe to status updates"
    >
      <Input
        type="email"
        name="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        aria-label="Email address"
        className="sm:max-w-xs"
      />
      <Button type="submit" disabled={pending}>
        {pending && <Spinner />}
        Subscribe
      </Button>
      {error && (
        <p className="text-destructive text-sm sm:self-center" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

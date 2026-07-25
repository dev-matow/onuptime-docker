"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side details are already in the server logs keyed by digest.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="text-muted-foreground max-w-md text-sm">
        An unexpected error occurred.
        {error.digest && (
          <>
            {" "}
            Reference: <code className="font-mono">{error.digest}</code>
          </>
        )}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}

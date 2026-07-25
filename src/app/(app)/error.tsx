"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <h2 className="text-lg font-semibold">This page failed to load</h2>
      <p className="text-muted-foreground max-w-md text-sm">
        The rest of the app is still working.
        {error.digest && (
          <>
            {" "}
            Reference: <code className="font-mono">{error.digest}</code>
          </>
        )}
      </p>
      <Button onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}

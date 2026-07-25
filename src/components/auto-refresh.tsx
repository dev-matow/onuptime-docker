"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Silently re-fetches the current route on an interval. Used by the
 * public status page so visitors watching an outage see updates as the
 * ISR cache turns over, without reloading the page themselves.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}

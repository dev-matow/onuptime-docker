import Link from "next/link";

import { VigilMark } from "@/components/vigil-mark";
import { cn } from "@/lib/utils";

/**
 * The application's brand lockup, once per page: sign-in, onboarding, the
 * invitation page, the marketing root and 404. One mark and a widely
 * tracked wordmark, the way the identity board sets them.
 */
export function Logo({
  className,
  href = "/",
}: {
  className?: string;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("flex items-center gap-2.5 font-semibold", className)}
    >
      <VigilMark className="h-[20px]" />
      <span className="text-base tracking-[0.18em]">VIGIL</span>
    </Link>
  );
}

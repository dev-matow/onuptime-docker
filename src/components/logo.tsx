import Link from "next/link";

import { BlinkingVigilMark } from "@/components/vigil-mark-blink";
import { cn } from "@/lib/utils";

/**
 * The application's brand mark, once per page: sign-in, onboarding, the
 * invitation page, the marketing root and 404. It is the one place the
 * eye is allowed to blink, because a page with two of them blinking on
 * their own schedules looks broken rather than alive.
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
      <BlinkingVigilMark />
      <span className="text-lg tracking-tight">Vigil</span>
    </Link>
  );
}

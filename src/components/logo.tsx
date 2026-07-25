import { PulseIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { cn } from "@/lib/utils";

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
      className={cn("flex items-center gap-2 font-semibold", className)}
    >
      <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
        <PulseIcon weight="bold" className="size-4.5" aria-hidden />
      </span>
      <span className="text-lg tracking-tight">Vigil</span>
    </Link>
  );
}

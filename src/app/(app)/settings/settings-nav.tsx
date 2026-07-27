"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { title: "General", href: "/settings", exact: true },
  { title: "Members", href: "/settings/members", exact: false },
  { title: "Notifications", href: "/settings/notifications", exact: false },
  { title: "Escalation", href: "/settings/escalation", exact: false },
  { title: "Audit log", href: "/settings/audit", exact: false },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="border-b">
      <ul className="-mb-px flex gap-4">
        {TABS.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-1 pb-2 text-sm transition-colors",
                  active
                    ? "border-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {tab.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

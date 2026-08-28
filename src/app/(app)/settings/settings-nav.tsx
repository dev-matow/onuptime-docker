"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { title: "General", href: "/settings", exact: true },
  { title: "Members", href: "/settings/members", exact: false },
  { title: "Notifications", href: "/settings/notifications", exact: false },
  { title: "Escalation", href: "/settings/escalation", exact: false },
  { title: "Import", href: "/settings/import", exact: false },
  { title: "Audit log", href: "/settings/audit", exact: false },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    // Six tabs do not fit across a phone. Without somewhere to put the
    // overflow they pushed the whole document wider than the viewport,
    // so every settings page scrolled sideways and the content moved
    // out from under the reader. The strip scrolls instead: the tabs
    // stay on one row, the page does not move, and a tab reached by
    // keyboard is scrolled into view by the browser.
    <nav
      aria-label="Settings sections"
      className="bg-muted/60 rounded-lg border p-1 [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max gap-1">
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
                  "inline-block rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
                  active
                    ? "bg-card text-primary border-border font-semibold shadow-xs"
                    : "text-muted-foreground hover:bg-card/60 hover:text-foreground border-transparent",
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

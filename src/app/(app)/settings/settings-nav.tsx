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
      className="[scrollbar-width:none] overflow-x-auto border-b [&::-webkit-scrollbar]:hidden"
    >
      <ul className="-mb-px flex w-max gap-3">
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
                  "inline-block border-b-2 px-1 pb-2 text-[13.5px] whitespace-nowrap transition-colors",
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

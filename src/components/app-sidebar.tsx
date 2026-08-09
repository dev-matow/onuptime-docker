"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { RoleName } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * No icons. A gauge, a pulse and a siren next to the words Dashboard,
 * Monitors and Incidents say nothing the words did not already say, and
 * seven of them is most of the decoration in the console.
 *
 * The marker in their place is the ladder's square: filled where you
 * are, hollow where you are not. It is one mark doing two jobs, and it
 * still occupies the rail when the sidebar collapses to it.
 */
const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard" },
  { title: "Monitors", href: "/monitors" },
  { title: "Incidents", href: "/incidents" },
  { title: "Status page", href: "/status-page" },
  { title: "Settings", href: "/settings" },
] as const;

export function AppSidebar({
  user,
  organizationName,
  role,
}: {
  user: { name: string; email: string; image: string | null };
  organizationName: string;
  role: RoleName;
}) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <span
                          aria-hidden
                          className={cn(
                            "inline-block size-1.5 shrink-0 border",
                            active
                              ? "border-foreground bg-foreground"
                              : "border-faint",
                          )}
                        />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

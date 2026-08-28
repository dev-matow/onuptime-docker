"use client";

import {
  BroadcastIcon,
  GearSixIcon,
  PulseIcon,
  SirenIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavUser } from "@/components/nav-user";
import { VigilMark } from "@/components/vigil-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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
 * The marker in their place is a small disc, the same round mark the
 * status vocabulary uses: filled where you are, a hollow ring where you
 * are not. It is one mark doing two jobs, and it still occupies the
 * rail when the sidebar collapses to it.
 */
const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard", icon: SquaresFourIcon },
  { title: "Monitors", href: "/monitors", icon: PulseIcon },
  { title: "Incidents", href: "/incidents", icon: SirenIcon },
  { title: "Status page", href: "/status-page", icon: BroadcastIcon },
  { title: "Settings", href: "/settings", icon: GearSixIcon },
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
      <SidebarHeader className="border-sidebar-border border-b p-3">
        {/* The brand lockup, the same one the public site wears: the mark
            and a widely tracked wordmark. The wordmark yields when the
            sidebar collapses to its rail. */}
        <div className="flex h-9 items-center gap-2.5 px-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg shadow-sm">
            <VigilMark className="h-[17px] shrink-0" />
          </span>
          <span className="text-[13px] font-semibold tracking-[0.2em] group-data-[collapsible=icon]:hidden">
            VIGIL
          </span>
        </div>
        <div className="border-sidebar-border mx-1.5 mt-2 rounded-lg border bg-background/60 px-3 py-2 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-xs font-semibold text-foreground">
            {organizationName}
          </p>
          <p className="text-muted-foreground mt-0.5 text-[11px] capitalize">
            {role} workspace
          </p>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-3 py-4 group-data-[collapsible=icon]:px-2">
          <SidebarGroupLabel className="h-7 px-2 text-[10px] font-semibold tracking-[0.1em] uppercase">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <Icon
                          aria-hidden
                          weight={active ? "fill" : "regular"}
                          className={cn(active && "text-primary")}
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
      <SidebarFooter className="border-sidebar-border border-t p-3">
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

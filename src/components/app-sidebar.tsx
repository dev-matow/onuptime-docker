"use client";

import {
  BroadcastIcon,
  GaugeIcon,
  GearIcon,
  PulseIcon,
  SirenIcon,
} from "@phosphor-icons/react";
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

const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard", icon: GaugeIcon },
  { title: "Monitors", href: "/monitors", icon: PulseIcon },
  { title: "Incidents", href: "/incidents", icon: SirenIcon },
  { title: "Status page", href: "/status-page", icon: BroadcastIcon },
  { title: "Settings", href: "/settings", icon: GearIcon },
] as const;

export function AppSidebar({
  user,
  organizationName,
}: {
  user: { name: string; email: string; image: string | null };
  organizationName: string;
}) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={organizationName}>
              <Link href="/dashboard">
                <div className="bg-primary/10 text-primary flex aspect-square size-8 items-center justify-center rounded-md">
                  <PulseIcon aria-hidden className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">
                    {organizationName}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    Vigil Core
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname.startsWith(item.href)}
                    tooltip={item.title}
                  >
                    <Link href={item.href}>
                      <item.icon aria-hidden />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
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

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
import type { RoleName } from "@/lib/permissions";

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

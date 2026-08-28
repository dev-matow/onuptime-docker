import { eq } from "drizzle-orm";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { requireOrgContext, requireSession } from "@/lib/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const ctx = await requireOrgContext();

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, ctx.organizationId),
    columns: { name: true, slug: true },
  });

  return (
    // The console follows the operating system: porcelain in daylight,
    // the graphite night scheme under a dark preference. Same ground,
    // same ink, same hairlines as the public site at the same hour. The
    // terminal black this system replaced retired with the pixel eye.
    <SidebarProvider className="bg-background text-foreground">
      <a
        href="#main-content"
        className="focus:bg-background focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:text-sm focus:ring-2"
      >
        Skip to content
      </a>
      <AppSidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? null,
        }}
        organizationName={org?.name ?? "Organization"}
        role={ctx.role}
      />
      <SidebarInset className="min-w-0">
        <header className="bg-background/90 sticky top-0 z-10 flex h-16 items-center gap-3 border-b px-5 backdrop-blur-md lg:px-8">
          <SidebarTrigger className="-ml-1" />
          {/* The organization's name lives in the sidebar's switcher; the
              bar repeats it only on phones, where the sidebar is closed
              and the context would otherwise be invisible. */}
          <span className="text-sm font-semibold md:hidden">{org?.name}</span>
          <span className="text-muted-foreground ml-auto hidden text-xs md:block">
            {org?.name}
          </span>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1180px] flex-1 p-5 sm:p-6 lg:p-8"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

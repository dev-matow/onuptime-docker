import { eq } from "drizzle-orm";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
    // The console is dark-only: this is the screen somebody opens at 3am,
    // and it is the one surface that never leaves the building. The theme
    // toggle lives on the public status page instead, where the reader is
    // the customer's audience rather than the operator.
    <SidebarProvider className="dark bg-background text-foreground">
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
        <header className="bg-background sticky top-0 z-10 flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-[12.5px] font-medium">{org?.name}</span>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1104px] flex-1 p-6"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

import type { Metadata } from "next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { compatibilityCounts } from "@/modules/importers/kuma/compatibility";
import { KUMA_PIN } from "@/modules/importers/kuma";

import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import · Vigil" };

export default async function ImportSettingsPage() {
  const ctx = await requireOrgContext();
  // Both, because an import creates monitors *and* the status pages
  // they appear on. Asked here so the page can say so, and asked again
  // in the action, which is where it is enforced.
  const canImport =
    hasPermission(ctx.role, { monitor: ["create"] }) &&
    hasPermission(ctx.role, { statusPage: ["update"] });
  const counts = compatibilityCounts();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Import from Uptime Kuma</CardTitle>
          <CardDescription>
            All {counts.types.total} of Uptime Kuma {KUMA_PIN.release}&rsquo;s
            monitor types have a Vigil equivalent, and all{" "}
            {counts.columns.total} columns of its <code>monitor</code> table are
            classified. A type having an equivalent is not a promise that every
            monitor of that type imports. Vigil&rsquo;s own rules refuse
            individual rows, and every one of them is named below before
            anything is written. See{" "}
            <code className="font-mono">docs/KUMA-IMPORT.md</code> for the full
            table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canImport ? (
            <ImportWizard canImport={canImport} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Importing creates monitors and status pages, so it needs an owner
              or admin role.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

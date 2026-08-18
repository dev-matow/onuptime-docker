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
import { PROVIDERS, UNSUPPORTED_SOURCES } from "@/modules/importers/providers";

import { ImportSources } from "./import-sources";

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

  // Flattened to plain data on the way to the client: an adapter is a
  // closure over a network call and cannot cross that boundary, and
  // nothing on the other side needs it to.
  const providers = PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    docs: provider.docs,
    access: provider.access,
    limitations: provider.limitations,
    credentials: provider.credentials.map((field) => ({
      name: field.name,
      label: field.label,
      help: field.help,
      secret: field.secret,
      required: field.required,
      choices: field.choices,
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Import from your current monitoring</CardTitle>
          <CardDescription>
            {PROVIDERS.length + 1} sources import here. Every one of them shows
            you the result of a real import, rolled back, before anything is
            written, and every record that does not come across is named with
            the reason. See <code className="font-mono">docs/MIGRATION.md</code>{" "}
            for the full tables, and{" "}
            <code className="font-mono">docs/KUMA-IMPORT.md</code> for Uptime
            Kuma&rsquo;s column-by-column one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canImport ? (
            <ImportSources
              canImport={canImport}
              kumaDescription={`All ${counts.types.total} of Uptime Kuma ${KUMA_PIN.release}'s monitor types have a Vigil equivalent, and all ${counts.columns.total} columns of its monitor table are classified. A type having an equivalent is not a promise that every monitor of that type imports: Vigil's own rules refuse individual rows, and every one of them is named below before anything is written.`}
              providers={providers}
              unsupported={UNSUPPORTED_SOURCES}
            />
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

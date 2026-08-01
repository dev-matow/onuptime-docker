import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  getMonitorDetail,
  updateMonitor,
} from "@/modules/monitors/service";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import type { AnyCheckTypeSpec } from "@/modules/monitors/types/contract";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";
import { ftpSpec } from "@/modules/monitors/types/specs/ftp";
import { imapSpec } from "@/modules/monitors/types/specs/imap";

import { createTestOrg, db } from "../helpers";

/**
 * `imap` and `ftp` against a real database: create, edit, export,
 * import, and the credential that must survive all four without ever
 * being one of the things that travels.
 *
 * The generated suites in `monitor-config-preservation` and
 * `monitor-portability` cover both types too, from the registry. This
 * file covers what a generated case cannot: the specific shapes these
 * two protocols have — an FTP account, an IMAP capability requirement —
 * and the exact messages an operator sees when they get one wrong.
 */

/**
 * Both specs, registered if the registry does not have them yet.
 *
 * `specs/index.ts` is wired centrally while several types are being
 * added at once, so this file must not depend on when that lands. The
 * insert is conditional and therefore a no-op the moment it does: the
 * registered spec wins, and this suite goes on testing the real one.
 */
const registry = CHECK_TYPE_SPECS as Record<string, AnyCheckTypeSpec>;
for (const spec of [imapSpec, ftpSpec]) {
  if (!(spec.descriptor.id in registry)) {
    registry[spec.descriptor.id] = spec as unknown as AnyCheckTypeSpec;
  }
}

const IMAP_CONFIG = { requiredCapability: "STARTTLS" };
const FTP_CONFIG = { username: "backups", password: "sup3r-s3cret-ftp" };

function inputFor(
  checkType: "imap" | "ftp",
  config: Record<string, unknown> | null,
): CreateMonitorInput {
  return {
    name: `${checkType}-${randomUUID().slice(0, 8)}`,
    url: checkType === "imap" ? "imap.example.com" : "files.example.com",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config,
  } as CreateMonitorInput;
}

async function storedRow(monitorId: string) {
  const [row] = await db
    .select()
    .from(monitors)
    .where(eq(monitors.id, monitorId));
  return row ?? null;
}

describe("creating an imap or ftp monitor", () => {
  it("stores the protocol's default port when the operator leaves it blank", async () => {
    // The descriptor carries the default, so an operator who never
    // touches the port field still gets a monitor that dials 143 or 21
    // rather than one that dials nothing.
    const actor = await createTestOrg();

    const imap = await createMonitor(db, actor, inputFor("imap", IMAP_CONFIG));
    const ftp = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    expect((await storedRow(imap.id))?.port).toBe(143);
    expect((await storedRow(ftp.id))?.port).toBe(21);
  });

  it("keeps the settings the operator submitted", async () => {
    const actor = await createTestOrg();

    const imap = await createMonitor(db, actor, inputFor("imap", IMAP_CONFIG));
    const ftp = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    expect((await storedRow(imap.id))?.config).toEqual(IMAP_CONFIG);
    expect((await storedRow(ftp.id))?.config).toEqual(FTP_CONFIG);
  });

  it("refuses a target that is a URL, with the message the field shows", () => {
    for (const checkType of ["imap", "ftp"] as const) {
      const parsed = createMonitorSchema.safeParse(
        inputFor(checkType, null) as unknown as Record<string, unknown>,
      );
      expect({ checkType, ok: parsed.success }).toEqual({
        checkType,
        ok: true,
      });

      const withScheme = createMonitorSchema.safeParse({
        ...inputFor(checkType, null),
        url: "imaps://mail.example.com",
      });
      expect(withScheme.success).toBe(false);
      expect(withScheme.error?.issues[0]?.message).toBe(
        "Enter a hostname (no scheme, no port).",
      );
    }
  });

  it("refuses settings the type cannot mean, and says which", () => {
    // The error the dialog puts under the field: `refineTarget` hands
    // the first issue from the type's own stored schema straight to the
    // form.
    const capability = createMonitorSchema.safeParse({
      ...inputFor("imap", { requiredCapability: "STARTTLS IDLE" }),
    });
    expect(capability.success).toBe(false);
    expect(capability.error?.issues[0]?.message).toBe(
      "A capability is one word, like STARTTLS.",
    );

    const account = createMonitorSchema.safeParse({
      ...inputFor("ftp", { password: "orphan" }),
    });
    expect(account.success).toBe(false);
    expect(account.error?.issues[0]?.message).toBe(
      "A password needs a username.",
    );
  });
});

describe("editing an imap or ftp monitor", () => {
  it("leaves the capability requirement alone when the edit never mentions it", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      inputFor("imap", IMAP_CONFIG),
    );

    // Exactly what the monitor form sends for a type whose fields it does
    // not render: `config: null`. This was the 1.13.0 data-loss path.
    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect((await storedRow(monitor.id))?.config).toEqual(IMAP_CONFIG);
  });

  it("keeps the FTP password through an edit that renames the monitor", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect((await storedRow(monitor.id))?.config).toEqual(FTP_CONFIG);
  });

  it("changes the username without being told the password again", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    await updateMonitor(db, actor, monitor.id, {
      config: { username: "renamed", password: SECRET_MASK },
    });

    const config = (await storedRow(monitor.id))?.config as Record<
      string,
      unknown
    >;
    expect(config).toEqual({
      username: "renamed",
      password: "sup3r-s3cret-ftp",
    });
    expect(JSON.stringify(config)).not.toContain(SECRET_MASK);
  });

  it("clears the password when the operator empties the field", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    await updateMonitor(db, actor, monitor.id, {
      config: { username: "backups", password: null },
    });

    const config = (await storedRow(monitor.id))?.config as Record<
      string,
      unknown
    >;
    expect(config.password).toBeNull();
  });

  it("replaces the password when the operator rotates it", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    await updateMonitor(db, actor, monitor.id, {
      config: { username: "backups", password: "rotated" },
    });

    const config = (await storedRow(monitor.id))?.config as Record<
      string,
      unknown
    >;
    expect(config.password).toBe("rotated");
  });

  it("drops the FTP account when the monitor is switched to imap", async () => {
    // A config belongs to the type that wrote it, and a password left
    // lying under an IMAP monitor would come back if the operator ever
    // switched the type back.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    await updateMonitor(db, actor, monitor.id, {
      checkType: "imap",
      url: "imap.example.com",
      config: IMAP_CONFIG,
    });

    const config = (await storedRow(monitor.id))?.config as Record<
      string,
      unknown
    >;
    expect(config).toEqual(IMAP_CONFIG);
    expect(JSON.stringify(config)).not.toContain("sup3r-s3cret-ftp");
  });
});

describe("the FTP password never reaches a browser or a file", () => {
  it("masks it on the way out to the edit dialog", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("ftp", FTP_CONFIG));

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    const redacted = redactConfig(ftpSpec, detail.monitor.config) as Record<
      string,
      unknown
    >;

    expect(redacted).toEqual({ username: "backups", password: SECRET_MASK });
    expect(JSON.stringify(redacted)).not.toContain("sup3r-s3cret-ftp");
  });

  it("masks it in an export and refuses to import the mask as a password", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      inputFor("ftp", FTP_CONFIG),
    );

    const file = await exportMonitors(db, source.organizationId, [monitor.id]);
    expect(JSON.stringify(file)).not.toContain("sup3r-s3cret-ftp");

    // Imported into a different organization, which is the real use: a
    // template moved between tenants.
    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });

    const copyId = report.outcomes[0]?.monitorId ?? "";
    const copy = await storedRow(copyId);
    const config = copy?.config as Record<string, unknown>;

    expect(config.username).toBe("backups");
    expect(config.password).toBeNull();
    expect(copy?.port).toBe(21);
    // And the operator is told what they have to re-enter, rather than
    // discovering it the next time the check runs.
    expect(report.outcomes[0]?.secretsToReenter).toEqual(["password"]);
  });

  it("carries an imap monitor across whole, because it holds no secret", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      inputFor("imap", IMAP_CONFIG),
    );
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    const copy = await storedRow(report.outcomes[0]?.monitorId ?? "");

    expect(copy?.config).toEqual(IMAP_CONFIG);
    expect(copy?.port).toBe(143);
    expect(report.outcomes[0]?.secretsToReenter ?? []).toEqual([]);
  });
});

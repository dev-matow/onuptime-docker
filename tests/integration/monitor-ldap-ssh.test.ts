import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { MONITOR_FORM_DEFAULTS } from "@/app/(app)/monitors/monitor-form";
import { monitors } from "@/db/schema";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import {
  createMonitor,
  getMonitorDetail,
  updateMonitor,
} from "@/modules/monitors/service";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import { requireSpec } from "@/modules/monitors/types/specs";

import { createTestOrg, db } from "../helpers";

/**
 * The two protocol checks added in this release, through the layers an
 * operator actually goes through: the form's payload, the action
 * schema, the service, the database, an export and an import back.
 *
 * The unit suites prove that each type speaks its protocol. This one
 * proves the other half of the Definition of Done — that a monitor of
 * that type can be created, edited without losing what it was given,
 * carried to another tenant, and never carries its credential with it.
 */

/** Exactly what the create dialog submits, with this type's fields on it. */
function submit(overrides: Record<string, unknown>) {
  return {
    ...MONITOR_FORM_DEFAULTS,
    name: `Test ${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
}

function parseCreate(overrides: Record<string, unknown>) {
  return createMonitorSchema.safeParse(submit(overrides));
}

function ldapInput(overrides: Record<string, unknown> = {}) {
  return createMonitorSchema.parse(
    submit({
      checkType: "ldap",
      url: "ldap.example.com",
      port: 389,
      config: {
        bindDn: "cn=vigil,ou=service,dc=example,dc=com",
        bindPassword: "directory-secret",
      },
      ...overrides,
    }),
  );
}

function sshInput(overrides: Record<string, unknown> = {}) {
  return createMonitorSchema.parse(
    submit({
      checkType: "ssh",
      url: "bastion.example.com",
      port: 22,
      config: { expectedBanner: "OpenSSH_9" },
      ...overrides,
    }),
  );
}

async function storedConfig(monitorId: string): Promise<unknown> {
  const [row] = await db
    .select({ config: monitors.config })
    .from(monitors)
    .where(eq(monitors.id, monitorId));
  return row?.config ?? null;
}

describe("creating an ldap monitor through the action layer", () => {
  it("accepts a hostname and defaults the port to 389", async () => {
    // The form leaves the port empty when the operator does not type
    // one; the writer fills it from the descriptor. A monitor stored
    // with a null port would be dialled on port 0.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      ldapInput({ port: null, config: null }),
    );

    expect(monitor.checkType).toBe("ldap");
    expect(monitor.port).toBe(389);
  });

  it("refuses a URL where a hostname belongs, and says which field", () => {
    const parsed = parseCreate({
      checkType: "ldap",
      url: "ldaps://ldap.example.com",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
    expect(parsed.error?.issues[0]?.message).toContain("hostname");
  });

  it("refuses a password with no DN, on the config field", () => {
    // The error has to arrive on `config`, because that is where the
    // dialog renders it. A credential with no name to carry is compared
    // by the directory against an anonymous bind, which succeeds — a
    // green monitor whose password is being ignored.
    const parsed = parseCreate({
      checkType: "ldap",
      url: "ldap.example.com",
      config: { bindDn: null, bindPassword: "orphaned" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A bind password needs a bind DN.",
    );
  });

  it("accepts the credential-less shape an import lands in", () => {
    // An export masks the password and the importer strips the mask, so
    // this shape has to be creatable or the importer drops the monitor
    // rather than reporting a credential to re-enter.
    expect(
      parseCreate({
        checkType: "ldap",
        url: "ldap.example.com",
        config: { bindDn: "cn=vigil,dc=example,dc=com", bindPassword: null },
      }).success,
    ).toBe(true);
  });

  it("accepts an anonymous bind, which is the common case", () => {
    expect(
      parseCreate({
        checkType: "ldap",
        url: "ldap.example.com",
        config: { bindDn: null, bindPassword: null },
      }).success,
    ).toBe(true);
  });

  it("still refuses the metadata endpoint", () => {
    expect(
      parseCreate({ checkType: "ldap", url: "metadata.google.internal" })
        .success,
    ).toBe(false);
  });
});

describe("editing an ldap monitor", () => {
  it("keeps the bind password when the edit says nothing about config", async () => {
    // The data-loss path: the form sends `config: null` for a type whose
    // fields it does not render, and the monitor silently loses the
    // credential it was authenticating with.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, ldapInput());
    const afterCreate = await storedConfig(monitor.id);

    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect(await storedConfig(monitor.id)).toEqual(afterCreate);
  });

  it("changes the DN while keeping the password the client never saw", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, ldapInput());

    await updateMonitor(db, actor, monitor.id, {
      config: {
        bindDn: "cn=rotated,ou=service,dc=example,dc=com",
        bindPassword: SECRET_MASK,
      },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.bindDn).toBe("cn=rotated,ou=service,dc=example,dc=com");
    expect(stored.bindPassword).toBe("directory-secret");
    expect(JSON.stringify(stored)).not.toContain(SECRET_MASK);
  });

  it("rotates the password when a new one is sent", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, ldapInput());

    await updateMonitor(db, actor, monitor.id, {
      config: {
        bindDn: "cn=vigil,ou=service,dc=example,dc=com",
        bindPassword: "rotated-secret",
      },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.bindPassword).toBe("rotated-secret");
  });

  it("masks the password on the way to a browser", async () => {
    // Everything that hands a monitor to a client component goes through
    // `redactConfig`. Without it the credential is in the page source of
    // anyone who can open the edit dialog — including a viewer who
    // cannot edit the monitor at all.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, ldapInput());
    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);

    const redacted = redactConfig(
      requireSpec("ldap"),
      detail.monitor.config,
    ) as Record<string, unknown>;

    expect(redacted.bindPassword).toBe(SECRET_MASK);
    expect(JSON.stringify(redacted)).not.toContain("directory-secret");
    // The DN is not a secret: an operator has to be able to see which
    // account the check binds as without re-typing it.
    expect(redacted.bindDn).toBe("cn=vigil,ou=service,dc=example,dc=com");
  });
});

describe("exporting and importing an ldap monitor", () => {
  it("carries the DN across and leaves the password behind", async () => {
    const source = await createTestOrg();
    const original = await createMonitor(db, source, ldapInput());

    const file = await exportMonitors(db, source.organizationId, [original.id]);
    expect(JSON.stringify(file)).not.toContain("directory-secret");

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));
    const config = copy?.config as Record<string, unknown>;

    expect(copy?.port).toBe(389);
    expect(config.bindDn).toBe("cn=vigil,ou=service,dc=example,dc=com");
    // Absent rather than the sentinel: a monitor that authenticated with
    // the literal string `__vigil_unchanged_secret__` would fail in a way
    // that looks like a wrong password rather than like a bug.
    expect(config.bindPassword).toBeNull();
    expect(report.outcomes[0]?.secretsToReenter).toEqual(["bindPassword"]);
  });
});

describe("creating and editing an ssh monitor", () => {
  it("accepts a hostname and defaults the port to 22", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      sshInput({ port: null, config: null }),
    );

    expect(monitor.checkType).toBe("ssh");
    expect(monitor.port).toBe(22);
  });

  it("refuses a hostname with a port glued to it", () => {
    const parsed = parseCreate({
      checkType: "ssh",
      url: "bastion.example.com:2222",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("keeps the expected banner across an edit that renames the monitor", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, sshInput());

    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect(await storedConfig(monitor.id)).toEqual({
      expectedBanner: "OpenSSH_9",
    });
  });

  it("clears the expectation when the operator empties the field", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, sshInput());

    await updateMonitor(db, actor, monitor.id, {
      config: { expectedBanner: null },
    });

    expect(await storedConfig(monitor.id)).toEqual({ expectedBanner: null });
  });

  it("round-trips through an export with nothing withheld", async () => {
    // An ssh monitor holds no credential at all — it never authenticates
    // — so unlike every other type with a config, this one arrives in
    // another tenant complete and immediately working.
    const source = await createTestOrg();
    const original = await createMonitor(db, source, sshInput());
    const file = await exportMonitors(db, source.organizationId, [original.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));

    expect(copy?.checkType).toBe("ssh");
    expect(copy?.port).toBe(22);
    expect(copy?.config).toEqual({ expectedBanner: "OpenSSH_9" });
    expect(report.outcomes[0]?.secretsToReenter).toEqual([]);
  });
});

describe("switching a monitor between the two", () => {
  it("drops the bind credentials rather than carrying them into an ssh monitor", async () => {
    // A config belongs to the type that wrote it. Carrying one across a
    // type change either fails validation or, where the shapes overlap,
    // leaves a stale setting in a type that never asked for it — and a
    // switch back would resurrect a password the operator thought was
    // gone.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, ldapInput());

    await updateMonitor(db, actor, monitor.id, {
      checkType: "ssh",
      url: "bastion.example.com",
      config: { expectedBanner: "OpenSSH_9" },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.bindPassword).toBeUndefined();
    expect(stored.expectedBanner).toBe("OpenSSH_9");
    expect(JSON.stringify(stored)).not.toContain("directory-secret");
  });
});

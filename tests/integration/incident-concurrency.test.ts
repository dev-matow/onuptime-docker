import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, incidentEvents, incidents, monitors } from "@/db/schema";
import { ConflictError } from "@/lib/errors";
import {
  acknowledgeIncident,
  changeIncidentSeverity,
  changeIncidentStatus,
  claimIncidentNotification,
  createIncident,
  findUnhandledAutoIncident,
  listIncidents,
  openMonitorIncident,
  postIncidentUpdate,
  recordSystemEvent,
  resolveMonitorIncidents,
} from "@/modules/incidents/service";
import { createMonitor, deleteMonitor } from "@/modules/monitors/service";

import { createTestOrg, db, withRowLocked, type TestActor } from "../helpers";

/**
 * What a failing concurrency assertion has to print.
 *
 * A bare "expected 2 to be 1" from a race sends the next reader to
 * rerun it and guess. This names the competing operations, what each
 * one did, and the rows that resulted.
 */
function describeRace(
  outcomes: PromiseSettledResult<unknown>[],
  events: { status?: string | null }[],
  finalStatus?: string | null,
): string {
  const calls = outcomes
    .map((o, i) =>
      o.status === "fulfilled"
        ? `  call ${i + 1}: committed`
        : `  call ${i + 1}: rejected ${(o.reason as Error)?.constructor?.name ?? "?"} - ${(o.reason as Error)?.message ?? ""}`,
    )
    .join("\n");
  const timeline = events.map((e) => e.status ?? "?").join(" -> ") || "(none)";
  return [
    "competing operations:",
    calls,
    `  timeline events: ${timeline}`,
    `  incident row status: ${finalStatus ?? "(missing)"}`,
  ].join("\n");
}

/**
 * Incident invariants under real concurrency.
 *
 * Every case here fails against the pre-1.13.0 code. They run genuinely
 * concurrent statements against the same Postgres — `Promise.all` over
 * separate service calls, each opening its own transaction — because a
 * sequential test cannot observe a lost update, and a mocked one cannot
 * observe what READ COMMITTED actually permits.
 */

async function monitorFor(actor: TestActor, name = "Checkout") {
  return createMonitor(db, actor, {
    name: `${name} ${randomUUID().slice(0, 8)}`,
    url: "https://concurrency.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http",
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
  });
}

describe("one active automatic incident per monitor", () => {
  it("survives two workers opening at the same instant", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    const results = await Promise.all([
      openMonitorIncident(db, monitor, "connection refused"),
      openMonitorIncident(db, monitor, "connection refused"),
      openMonitorIncident(db, monitor, "connection refused"),
    ]);

    const opened = results.filter((r) => r !== null);
    expect(opened).toHaveLength(1);

    const live = await db.query.incidents.findMany({
      where: and(
        eq(incidents.monitorId, monitor.id),
        ne(incidents.status, "resolved"),
      ),
    });
    expect(live).toHaveLength(1);
  });

  it("leaves no timeline or audit trace from the losing worker", async () => {
    // The loser's whole transaction rolls back, so it must not have
    // written a "created" event or an audit row for an incident it never
    // opened. Without that, an operator reading the audit log sees two
    // incidents opening for one outage.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    await Promise.all([
      openMonitorIncident(db, monitor, "boom"),
      openMonitorIncident(db, monitor, "boom"),
    ]);

    const created = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .innerJoin(incidents, eq(incidentEvents.incidentId, incidents.id))
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          eq(incidentEvents.type, "created"),
        ),
      );
    expect(created).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.auto_opened"),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it("lets a monitor open a new incident once the old one is resolved", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    const first = await openMonitorIncident(db, monitor, "down");
    expect(first).not.toBeNull();
    await resolveMonitorIncidents(db, monitor);

    const second = await openMonitorIncident(db, monitor, "down again");
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
  });

  it("is enforced by the database, not only by the service", async () => {
    // A direct insert bypassing every service guard must still be
    // refused. This is the constraint proof: if this test passes because
    // the service is careful, the invariant is not actually enforced.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    // Drizzle wraps driver errors, so the constraint name is on the
    // cause, not the thrown error.
    const rejection = await db
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: "Smuggled duplicate",
        source: "monitor",
        monitorId: monitor.id,
        createdBy: null,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).not.toBeNull();
    const cause = (
      rejection as { cause?: { code?: string; constraint?: string } }
    ).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint).toBe("incidents_one_active_per_monitor");
  });

  it("does not constrain manual incidents on the same monitor", async () => {
    // The invariant is about automatic incidents. An operator must stay
    // able to raise a manual incident against a monitor that already has
    // one open — they are describing something the prober cannot see.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    // Inserted directly with the monitor attached: `createIncident`
    // never links one, so going through it would prove nothing about the
    // partial index — the row would have a NULL monitor_id and fall
    // outside the invariant for the wrong reason.
    const [manual] = await db
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: "Customer-reported checkout failure",
        severity: "major",
        source: "manual",
        monitorId: monitor.id,
        createdBy: actor.userId,
      })
      .returning();
    // The claim is about the INDEX, not about the row echoing back the
    // literals it was inserted with. Two active incidents now exist on
    // one monitor, which the partial index permits precisely because
    // one of them is manual.
    expect(manual).toBeTruthy();
    const active = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          ne(incidents.status, "resolved"),
        ),
      );
    expect(active).toHaveLength(2);
  });
});

describe("incident status transitions under concurrency", () => {
  it("does not let a late transition reopen a resolved incident", async () => {
    // The lost update this replaced: both callers read `investigating`,
    // one commits `resolved`, the other then commits `identified` over
    // it — reopening an incident the public status page had closed.
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Payments degraded",
      severity: "major",
      message: "Investigating.",
    });

    // Forced. Unforced, this passed only because the FIRST-issued
    // operation happened to make the second illegal - swap the two
    // lines and a serialised run has both succeed, because
    // `identified -> resolved` is legal. That is not a property of the
    // code under test, it is the order the arguments were typed in.
    const outcomes = await withRowLocked("incidents", incident.id, 2, () =>
      Promise.allSettled([
        changeIncidentStatus(db, actor, incident.id, {
          status: "resolved",
          message: "Fixed.",
        }),
        changeIncidentStatus(db, actor, incident.id, {
          status: "identified",
          message: "Found it.",
        }),
      ]),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );

    const [final] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    // Whichever won, the incident is in exactly one coherent state — and
    // if `resolved` won it stayed resolved.
    expect(["resolved", "identified"]).toContain(final?.status);
    if (final?.status === "resolved") expect(final.resolvedAt).not.toBeNull();
  });

  it("keeps resolved terminal against a sequential late writer", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Search outage",
      severity: "minor",
      message: "Investigating.",
    });
    await changeIncidentStatus(db, actor, incident.id, {
      status: "resolved",
      message: "Done.",
    });

    await expect(
      changeIncidentStatus(db, actor, incident.id, {
        status: "monitoring",
        message: "Actually still bad.",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes exactly one timeline event when two transitions truly overlap", async () => {
    // Deterministic, and it did not used to be. This test fired both
    // calls with `Promise.allSettled` and asserted ONE event - but
    // `investigating -> identified -> monitoring` are two legal
    // sequential transitions, so when the two calls happened to
    // serialise both correctly succeeded and wrote two events.
    // Measured: they overlapped in 29 of 30 warm runs and serialised in
    // the 30th, and serialised consistently on a cold process. The test
    // passed in the full suite and failed when run alone, which reads
    // as flakiness in the product and was not.
    //
    // `withRowLocked` makes the overlap the thing that happens rather
    // than the thing that is hoped for: both callers read the same
    // status before either may write.
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Queue backlog",
      severity: "minor",
      message: "Investigating.",
    });

    const outcomes = await withRowLocked("incidents", incident.id, 2, () =>
      Promise.allSettled([
        changeIncidentStatus(db, actor, incident.id, {
          status: "identified",
          message: "A.",
        }),
        changeIncidentStatus(db, actor, incident.id, {
          status: "monitoring",
          message: "B.",
        }),
      ]),
    );

    const changes = await db
      .select({
        id: incidentEvents.id,
        status: incidentEvents.status,
        message: incidentEvents.message,
      })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "status_change"),
        ),
      );
    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));

    // A failure has to say what actually happened, or the next person
    // reruns it and guesses.
    expect(changes, describeRace(outcomes, changes, row?.status)).toHaveLength(
      1,
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );
    // The winner's transition is the one on the timeline and on the row.
    expect(row?.status).toBe(changes[0]?.status);
    // A generous ceiling, because the barrier waits for a real lock
    // rather than sleeping a guess - it returns as soon as both writers
    // are blocked, and only a genuinely stuck writer reaches this.
  }, 30_000);

  it("writes one timeline event per winning transition, however they interleave", async () => {
    // The invariant the name of the test above promises, stated so it
    // holds under BOTH interleavings: the timeline records exactly the
    // transitions that won, whether that is one or two. Serialised, two
    // legal transitions are two events and that is correct; overlapped,
    // one wins and there is one event.
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Queue backlog",
      severity: "minor",
      message: "Investigating.",
    });

    const outcomes = await Promise.allSettled([
      changeIncidentStatus(db, actor, incident.id, {
        status: "identified",
        message: "A.",
      }),
      changeIncidentStatus(db, actor, incident.id, {
        status: "monitoring",
        message: "B.",
      }),
    ]);

    const changes = await db
      .select({ id: incidentEvents.id, status: incidentEvents.status })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "status_change"),
        ),
      )
      // Ordered, because the last assertion reads it as ordered. Not by
      // `created_at`: that is the transaction START time, so two
      // concurrent writers can appear in the reverse of commit order.
      .orderBy(incidentEvents.id);
    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    const won = outcomes.filter((o) => o.status === "fulfilled").length;

    expect(changes, describeRace(outcomes, changes, row?.status)).toHaveLength(
      won,
    );
    // And every rejection is a conflict, never a crash.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ConflictError);
      }
    }
    // The row agrees with the last event that won.
    expect(row?.status).toBe(changes.at(-1)?.status);
  });
});

describe("acknowledgement is idempotent under concurrency", () => {
  it("records one acknowledgement when two operators race", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Paging storm",
      severity: "critical",
      message: "Investigating.",
    });

    // Forced, because serialised this proves nothing: the second call
    // returns early at `if (incident.acknowledgedAt) return incident`
    // and never reaches the guarded UPDATE. Deleting the
    // `acknowledged_at is null` predicate left this test green.
    const both = await withRowLocked("incidents", incident.id, 2, () =>
      Promise.all([
        acknowledgeIncident(db, actor, incident.id),
        acknowledgeIncident(db, actor, incident.id),
      ]),
    );
    // Both callers get an acknowledged incident back — that is what they
    // asked for — but only one act was recorded.
    expect(both.every((i) => i.acknowledgedAt !== null)).toBe(true);

    const events = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "system"),
        ),
      );
    expect(events).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.acknowledged"),
        ),
      );
    expect(audited).toHaveLength(1);
  });
});

describe("auto-resolution does not double-resolve", () => {
  it("resolves once when two recovery paths observe the same recovery", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    // Forced for the same reason: serialised, the second call's
    // `findMany` returns nothing and it never reaches the guarded
    // UPDATE, so deleting `status <> 'resolved'` left this green. Both
    // callers now take the monitor row lock first, so the barrier is on
    // `monitors` - which is also what proves the lock exists.
    const [a, b] = await withRowLocked("monitors", monitor.id, 2, () =>
      Promise.all([
        resolveMonitorIncidents(db, monitor),
        resolveMonitorIncidents(db, monitor),
      ]),
    );
    expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(1);

    const resolvedEvents = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .innerJoin(incidents, eq(incidentEvents.incidentId, incidents.id))
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          eq(incidentEvents.status, "resolved"),
        ),
      );
    expect(resolvedEvents).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.auto_resolved"),
        ),
      );
    expect(audited).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The consequences of an incident, not just the row                   */
/* ------------------------------------------------------------------ */

describe("an incident whose worker died before paging anyone", () => {
  it("is picked up and paged by the next check", async () => {
    // The failure this exists for: every consequence of an incident -
    // the page, the recovery job, the escalation ladder - used to hang
    // off "I am the transaction that inserted the row".
    // `openMonitorIncident` returns null once the row exists, so a
    // worker that committed the insert and then died left an incident
    // open with nobody notified, and every later check skipped the
    // block. Nobody was ever paged.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    // Exactly what a crashed worker leaves behind: the row, and nothing
    // else that follows from it.
    const opened = await openMonitorIncident(db, monitor, "connection refused");
    expect(opened).not.toBeNull();
    expect(opened!.notifiedAt).toBeNull();

    // A later check finds it unhandled...
    const found = await findUnhandledAutoIncident(db, monitor.id);
    expect(found?.id).toBe(opened!.id);

    // ...claims it exactly once, and a second worker doing the same
    // gets nothing, so the page cannot go twice.
    const [first, second] = await Promise.all([
      claimIncidentNotification(db, opened!.id),
      claimIncidentNotification(db, opened!.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // Once claimed it is no longer unhandled, so the repair does not
    // loop forever on an incident somebody already paged for.
    expect(await findUnhandledAutoIncident(db, monitor.id)).toBeNull();
  });

  it("leaves a held incident alone, because a handler already decided", async () => {
    // A held incident (recovery is handling it, the page is
    // deliberately deferred) is NOT unhandled. Without this the repair
    // would re-run the handlers on every check and schedule the
    // recovery job again each time.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    const opened = await openMonitorIncident(db, monitor, "down");
    await recordSystemEvent(
      db,
      opened!.id,
      "Automatic recovery is handling this incident.",
    );

    expect(await findUnhandledAutoIncident(db, monitor.id)).toBeNull();
  });
});

describe("a monitor going down while it is recovering", () => {
  it("does not open an incident for a monitor the database says is up", async () => {
    // Proved reproducible before the fix: the check that decided to
    // open commits, a recovery check resolves the incident and marks
    // the monitor up, and the open then inserts a BRAND NEW incident
    // for a monitor that is currently fine - one page-resolve-page flap
    // per race. The decision now re-reads the monitor's status under a
    // row lock and refuses on `up`.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await db
      .update(monitors)
      .set({ currentStatus: "up" })
      .where(eq(monitors.id, monitor.id));

    expect(
      await openMonitorIncident(db, monitor, "stale down verdict"),
    ).toBeNull();
    const live = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          ne(incidents.status, "resolved"),
        ),
      );
    expect(live).toHaveLength(0);
  });

  it("still opens one for a monitor that is actually down", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await db
      .update(monitors)
      .set({ currentStatus: "down" })
      .where(eq(monitors.id, monitor.id));
    expect(
      await openMonitorIncident(db, monitor, "really down"),
    ).not.toBeNull();
  });
});

describe("a resolved incident is closed to every writer", () => {
  /**
   * Resolves the incident from a THIRD connection while the caller is
   * blocked between its read and its write.
   *
   * This is the interleaving the predicates exist for, and the reason a
   * sequential test is not enough: resolve-then-act is caught by the
   * guard ABOVE the predicate, so it proves the old code just as well
   * as the new. Only a caller that has already passed that guard, and
   * then finds the world changed, exercises the predicate. Verified by
   * mutation: removing the predicate turns each of these red and leaves
   * a sequential version green.
   */
  function resolveMidRace(actor: TestActor, incidentId: string) {
    return (act: () => Promise<unknown>) =>
      withRowLocked("incidents", incidentId, 1, act, async (client) => {
        await client.query(
          "update incidents set status = 'resolved', resolved_at = now() where id = $1",
          [incidentId],
        );
      });
  }

  it("refuses an acknowledgement that raced the resolution", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Racing",
      severity: "minor",
      message: "Investigating.",
    });
    const race = resolveMidRace(actor, incident.id);

    await expect(
      race(() => acknowledgeIncident(db, actor, incident.id)),
    ).rejects.toBeInstanceOf(ConflictError);

    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    expect(row?.status).toBe("resolved");
    expect(row?.acknowledgedAt).toBeNull();
    // And nothing was appended to a closed timeline.
    const events = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "system"),
        ),
      );
    expect(events).toHaveLength(0);
  }, 30_000);

  it("refuses a severity change that raced the resolution", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Racing",
      severity: "minor",
      message: "Investigating.",
    });
    const race = resolveMidRace(actor, incident.id);

    await expect(
      race(() => changeIncidentSeverity(db, actor, incident.id, "critical")),
    ).rejects.toBeInstanceOf(ConflictError);

    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    expect(row?.severity).toBe("minor");
  }, 30_000);

  it("refuses a public update that raced the resolution", async () => {
    // The worst of the three: `type: 'update', internal: false` passes
    // the public status page's filter, so a customer-facing line could
    // appear after the incident was closed. `postIncidentUpdate` has no
    // column to compare-and-swap on, so it takes the row lock instead -
    // which means its READ blocks here, and it sees `resolved`.
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Racing",
      severity: "minor",
      message: "Investigating.",
    });
    const race = resolveMidRace(actor, incident.id);

    await expect(
      race(() =>
        postIncidentUpdate(db, actor, incident.id, "Still broken?", false),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const updates = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "update"),
        ),
      );
    expect(updates).toHaveLength(0);
  }, 30_000);

  it("cannot be acted on across a tenant boundary", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const incident = await createIncident(db, theirs, {
      title: "Theirs",
      severity: "minor",
      message: "Investigating.",
    });
    for (const act of [
      () => acknowledgeIncident(db, mine, incident.id),
      () => changeIncidentSeverity(db, mine, incident.id, "critical"),
      () => postIncidentUpdate(db, mine, incident.id, "hello", false),
      () =>
        changeIncidentStatus(db, mine, incident.id, {
          status: "identified",
          message: "hello",
        }),
    ]) {
      await expect(act()).rejects.toThrow();
    }
    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    expect(row?.severity).toBe("minor");
    expect(row?.acknowledgedAt).toBeNull();
  });
});

describe("deleting a monitor mid-outage", () => {
  it("closes its open incident instead of orphaning it", async () => {
    // `incidents.monitor_id` is ON DELETE SET NULL, so the incident
    // survived with nothing pointing at it: `resolveMonitorIncidents`
    // selects by monitor id and could never reach it again, and it sat
    // in the active list and the dashboard count forever.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    const opened = await openMonitorIncident(db, monitor, "down");
    expect(opened).not.toBeNull();

    await deleteMonitor(db, actor, monitor.id);

    const [row] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, opened!.id));
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedAt).not.toBeNull();
    // And it says why, on the timeline, rather than closing silently.
    const events = await db
      .select({ message: incidentEvents.message })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, opened!.id),
          eq(incidentEvents.type, "system"),
        ),
      );
    expect(events.map((e) => e.message).join(" ")).toContain("was deleted");

    const active = await listIncidents(db, actor.organizationId, {
      activeOnly: true,
    });
    expect(active.map((i) => i.id)).not.toContain(opened!.id);
  });
});

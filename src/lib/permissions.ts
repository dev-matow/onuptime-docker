import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

import { CHECK_TYPE_DESCRIPTORS } from "@/modules/monitors/types/catalog";

/**
 * Single source of truth for RBAC. Imported by the server auth config,
 * the browser auth client and the authorization helpers, so a permission
 * added here is enforced everywhere at once.
 *
 * Role model:
 * - owner:     full control, including deleting the organization
 * - admin:     manages people, monitors and the status page
 * - responder: on-call engineer — runs incidents, cannot change setup
 * - viewer:    read-only access to the dashboard
 */
const baseStatement = {
  ...defaultStatements,
  monitor: ["create", "update", "delete"],
  incident: ["create", "update", "resolve", "postmortem"],
  statusPage: ["update"],
  notification: ["update"],
} as const;

/**
 * The permission matrix, assembled from the base plus whatever the check
 * type registry contributes.
 *
 * Today no type contributes anything and the matrix is byte-identical to
 * the literal this replaced. The seam is the point: gating a check type
 * — a commercial-only one, or one an operator should not be able to
 * point at internal infrastructure — becomes a property declared on the
 * type, next to its probe and its assertions, instead of an edit to a
 * central object that has no idea the type exists.
 *
 * Imported by the browser auth client, so this file and everything it
 * reaches must stay free of `node:` imports. `catalog.ts` is plain data
 * for exactly that reason.
 */
function assembleStatement() {
  const merged: Record<string, string[]> = Object.fromEntries(
    Object.entries(baseStatement).map(([resource, actions]) => [
      resource,
      [...actions],
    ]),
  );

  for (const descriptor of CHECK_TYPE_DESCRIPTORS) {
    for (const [resource, actions] of Object.entries(
      descriptor.permissions ?? {},
    )) {
      merged[resource] = [
        ...new Set([...(merged[resource] ?? []), ...actions]),
      ];
    }
  }

  return merged as unknown as typeof baseStatement;
}

const statement = assembleStatement();

export const ac = createAccessControl(statement);

/**
 * Versioned role definitions.
 *
 * The version is not decoration. A decision record cites the policy it
 * was made under, and "the responder role" is not a stable referent —
 * it means something different after the matrix changes. Bumping this
 * whenever a role's statements change is what keeps an audit entry
 * written last March interpretable today.
 *
 * Bump on any change to `statements` below.
 */
export const ROLE_DEFINITIONS_VERSION = 1;

export const roleDefinitions = {
  owner: {
    version: ROLE_DEFINITIONS_VERSION,
    statements: {
      organization: ["update", "delete"],
      member: ["create", "update", "delete"],
      invitation: ["create", "cancel"],
      monitor: ["create", "update", "delete"],
      incident: ["create", "update", "resolve", "postmortem"],
      statusPage: ["update"],
      notification: ["update"],
    },
  },
  admin: {
    version: ROLE_DEFINITIONS_VERSION,
    statements: {
      organization: ["update"],
      member: ["create", "update", "delete"],
      invitation: ["create", "cancel"],
      monitor: ["create", "update", "delete"],
      incident: ["create", "update", "resolve", "postmortem"],
      statusPage: ["update"],
      notification: ["update"],
    },
  },
  responder: {
    version: ROLE_DEFINITIONS_VERSION,
    statements: {
      incident: ["create", "update", "resolve", "postmortem"],
    },
  },
  viewer: {
    version: ROLE_DEFINITIONS_VERSION,
    statements: {},
  },
} as const;

export const ownerRole = ac.newRole(roleDefinitions.owner.statements);
export const adminRole = ac.newRole(roleDefinitions.admin.statements);
export const responderRole = ac.newRole(roleDefinitions.responder.statements);
export const viewerRole = ac.newRole(roleDefinitions.viewer.statements);

export const roles = {
  owner: ownerRole,
  admin: adminRole,
  responder: responderRole,
  viewer: viewerRole,
};

export const ROLE_NAMES = ["owner", "admin", "responder", "viewer"] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export type Permission = {
  [
    Resource in keyof typeof baseStatement
  ]?: (typeof baseStatement)[Resource][number][];
};

/** Non-throwing check for conditional UI (hide buttons a role can't use). */
export function hasPermission(role: RoleName, permission: Permission): boolean {
  const definition = roles[role];
  if (!definition) return false;
  return definition.authorize(
    permission as Parameters<(typeof roles)["owner"]["authorize"]>[0],
  ).success;
}

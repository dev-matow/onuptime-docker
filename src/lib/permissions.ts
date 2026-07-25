import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

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
const statement = {
  ...defaultStatements,
  monitor: ["create", "update", "delete"],
  incident: ["create", "update", "resolve", "postmortem"],
  statusPage: ["update"],
  notification: ["update"],
} as const;

export const ac = createAccessControl(statement);

export const ownerRole = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  monitor: ["create", "update", "delete"],
  incident: ["create", "update", "resolve", "postmortem"],
  statusPage: ["update"],
  notification: ["update"],
});

export const adminRole = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  monitor: ["create", "update", "delete"],
  incident: ["create", "update", "resolve", "postmortem"],
  statusPage: ["update"],
  notification: ["update"],
});

export const responderRole = ac.newRole({
  incident: ["create", "update", "resolve", "postmortem"],
});

export const viewerRole = ac.newRole({});

export const roles = {
  owner: ownerRole,
  admin: adminRole,
  responder: responderRole,
  viewer: viewerRole,
};

export const ROLE_NAMES = ["owner", "admin", "responder", "viewer"] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export type Permission = {
  [Resource in keyof typeof statement]?: (typeof statement)[Resource][number][];
};

/** Non-throwing check for conditional UI (hide buttons a role can't use). */
export function hasPermission(role: RoleName, permission: Permission): boolean {
  const definition = roles[role];
  if (!definition) return false;
  return definition.authorize(
    permission as Parameters<(typeof roles)["owner"]["authorize"]>[0],
  ).success;
}

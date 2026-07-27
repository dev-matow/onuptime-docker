/**
 * The one edition difference that deleting code cannot express.
 *
 * Multi-tenancy needs no schema and no commercial file: `organizationId`
 * is already on every table and every query is already scoped by it.
 * Commercial runs many client organizations because
 * `allowUserToCreateOrganization` says yes. Strip the commercial code
 * and that stays true — so Core needs a positive default of its own
 * rather than the absence of something.
 *
 * Hence the assignment rather than a marked declaration: `strip-ee` only
 * deletes, so the value has to exist in Core and be raised by a line the
 * commercial build keeps.
 */
let multiOrg = false;

/** Whether this build may hold more than one organization. */
export const MULTI_ORG = multiOrg;

export interface OrganizationCreationContext {
  /** Read-only demo deployments never create anything. */
  demoMode: boolean;
  multiOrg: boolean;
  /** Whether this install already holds an organization. */
  hasAnyOrganization: boolean;
}

/**
 * Pure so it can be tested in both editions from one file — the whole
 * point is the *difference*, and a test that only runs in the edition it
 * describes proves the smaller half of it.
 */
export function mayCreateOrganization({
  demoMode,
  multiOrg: many,
  hasAnyOrganization,
}: OrganizationCreationContext): boolean {
  if (demoMode) return false;
  if (many) return true;
  return !hasAnyOrganization;
}

/**
 * A resolver for tests that are not testing the resolver.
 *
 * The egress guard resolves before every outbound request — that is the
 * whole point of it — so a probe test that injects a transport still
 * performs a real DNS lookup unless it says otherwise. A suite of nearly
 * a thousand such tests then fails whenever a resolver is slow, in a
 * different test each run, for reasons that have nothing to do with what
 * is being asserted. That is what this exists to stop.
 *
 * It answers with a public address, so the guard's decision is "allowed"
 * and the test exercises the path it meant to. A test that wants the
 * guard to refuse passes its own.
 */
export const publicLookup = async (
  _hostname: string,
): Promise<{ address: string; family: number }[]> => [
  { address: "93.184.216.34", family: 4 },
];

/** Answers with a private address, for tests that want a refusal. */
export const privateLookup = async (
  _hostname: string,
): Promise<{ address: string; family: number }[]> => [
  { address: "10.0.0.5", family: 4 },
];

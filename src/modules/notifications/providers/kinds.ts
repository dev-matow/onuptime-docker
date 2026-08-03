/**
 * Provider kinds and their group headings.
 *
 * A file of its own, containing no logic and importing nothing, because
 * both sides of the app need it: the registry groups by kind on the
 * server, and the channel editor renders the headings in the browser.
 * `providers/types.ts` reaches `egressFetch` and therefore `node:dns`,
 * so a client component cannot import a value from it - only types,
 * which are erased. This is the value.
 */

export type ProviderKind =
  "chat" | "incident" | "push" | "sms" | "email" | "webhook" | "bridge";

/** In picker order: how likely an operator is to want the group. */
export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "chat",
  "incident",
  "push",
  "sms",
  "email",
  "webhook",
  "bridge",
];

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  chat: "Chat",
  incident: "On-call and tickets",
  push: "Push",
  sms: "SMS and messaging",
  email: "Email",
  webhook: "Webhooks and buses",
  bridge: "Bridges",
};

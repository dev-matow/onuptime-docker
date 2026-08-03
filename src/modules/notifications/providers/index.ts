import { appriseProvider } from "./apprise";
import { barkProvider } from "./bark";
import { discordProvider } from "./discord";
import { googleChatProvider } from "./googlechat";
import { gotifyProvider } from "./gotify";
import { homeassistantProvider } from "./homeassistant";
import { jiraProvider } from "./jira";
import { lineProvider } from "./line";
import { matrixProvider } from "./matrix";
import { mattermostProvider } from "./mattermost";
import { ntfyProvider } from "./ntfy";
import { pagerdutyProvider } from "./pagerduty";
import { pushbulletProvider } from "./pushbullet";
import { pushoverProvider } from "./pushover";
import { resendProvider } from "./resend";
import { rocketchatProvider } from "./rocketchat";
import { slackProvider } from "./slack";
import { smtpProvider } from "./smtp";
import { snsProvider } from "./sns";
import { teamsProvider } from "./teams";
import { telegramProvider } from "./telegram";
import { twilioProvider } from "./twilio";
import { twilioWhatsappProvider } from "./twilio-whatsapp";
import { webhookProvider } from "./webhook";
import { webpushProvider } from "./webpush";
import { zulipProvider } from "./zulip";
import type { ChannelProvider, ProviderDescriptor } from "./types";

export * from "./kinds";
export * from "./types";

/**
 * The registry. Everything that lists providers - the channel editor,
 * the docs generator, the public provider list - reads this array, so
 * a provider that is not here does not exist anywhere, and no surface
 * can claim one that is not shipped.
 *
 * Twenty-six entries, twenty-five of them native. The one that is not
 * is the Apprise bridge, and the split is machine-readable
 * (`capabilities.native`) rather than a convention someone has to
 * remember: `nativeProviders()` is what the public count is generated
 * from, so no page can quietly count the bridge as a twenty-sixth
 * integration.
 *
 * Ordered by kind and then by how likely an operator is to want it,
 * because this array is also the order of the picker.
 */
export const CHANNEL_PROVIDERS: readonly ChannelProvider[] = [
  // Chat
  slackProvider,
  discordProvider,
  teamsProvider,
  telegramProvider,
  googleChatProvider,
  mattermostProvider,
  rocketchatProvider,
  matrixProvider,
  zulipProvider,
  lineProvider,
  // On-call and tickets
  pagerdutyProvider,
  jiraProvider,
  // Push
  pushoverProvider,
  gotifyProvider,
  ntfyProvider,
  pushbulletProvider,
  barkProvider,
  webpushProvider,
  homeassistantProvider,
  // SMS
  twilioProvider,
  twilioWhatsappProvider,
  // Email
  smtpProvider,
  resendProvider,
  // Webhooks and buses
  webhookProvider,
  snsProvider,
  // Bridges - not a Vigil integration with anything behind it
  appriseProvider,
];

const BY_ID = new Map(CHANNEL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ChannelProvider | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The providers Vigil implements against a service's own API.
 *
 * The public claim is about THIS list, never about the registry's
 * length: `docs/NOTIFICATIONS.md`, the landing page and the editor all
 * quote it, and `npm run facts` regenerates it from here. A bridge
 * counted as a native provider would be the exact overstatement this
 * function exists to make impossible.
 */
export function nativeProviders(): ChannelProvider[] {
  return CHANNEL_PROVIDERS.filter((p) => p.capabilities.native);
}

/** The serializable slice the client-side editor renders from. */
export function providerDescriptors(): ProviderDescriptor[] {
  return CHANNEL_PROVIDERS.map(
    ({
      id,
      label,
      kind,
      blurb,
      docsUrl,
      apiVersion,
      prerequisite,
      capabilities,
      fields,
    }) => ({
      id,
      label,
      kind,
      blurb,
      docsUrl,
      apiVersion,
      prerequisite,
      capabilities,
      fields,
    }),
  );
}

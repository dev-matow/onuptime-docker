import { discordProvider } from "./discord";
import { googleChatProvider } from "./googlechat";
import { gotifyProvider } from "./gotify";
import { ntfyProvider } from "./ntfy";
import { resendProvider } from "./resend";
import { slackProvider } from "./slack";
import { smtpProvider } from "./smtp";
import { teamsProvider } from "./teams";
import { telegramProvider } from "./telegram";
import { webhookProvider } from "./webhook";
import type { ChannelProvider, ProviderDescriptor } from "./types";

export * from "./types";

/**
 * The registry. Everything that lists providers - the channel editor,
 * the docs generator, the public provider list - reads this array, so
 * a provider that is not here does not exist anywhere, and no surface
 * can claim one that is not shipped.
 */
export const CHANNEL_PROVIDERS: readonly ChannelProvider[] = [
  slackProvider,
  discordProvider,
  teamsProvider,
  telegramProvider,
  googleChatProvider,
  gotifyProvider,
  ntfyProvider,
  webhookProvider,
  smtpProvider,
  resendProvider,
];

const BY_ID = new Map(CHANNEL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ChannelProvider | null {
  return BY_ID.get(id) ?? null;
}

/** The serializable slice the client-side editor renders from. */
export function providerDescriptors(): ProviderDescriptor[] {
  return CHANNEL_PROVIDERS.map(
    ({ id, label, kind, blurb, docsUrl, fields }) => ({
      id,
      label,
      kind,
      blurb,
      docsUrl,
      fields,
    }),
  );
}

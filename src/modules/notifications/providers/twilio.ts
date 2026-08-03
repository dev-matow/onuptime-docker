import {
  httpDeliver,
  parseJsonBody,
  plainTextBody,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
  type DeliverInput,
} from "./types";

/**
 * Twilio Programmable Messaging - the SMS half. The WhatsApp half is a
 * separate provider (`twilio-whatsapp.ts`) because it is a separate
 * setup with separate rules, and folding them into one entry with a
 * radio button would hide the difference that matters most: WhatsApp
 * will not deliver free-form text outside a 24-hour service window.
 *
 * Everything shared lives here and is imported there, so there is one
 * implementation of the Twilio request and one place where its auth,
 * addressing and receipt handling can be wrong.
 *
 * The `sid` in the 201 body is Twilio's delivery ID; it goes in the
 * ledger, and it is what an operator quotes to Twilio support. Note
 * what it does NOT mean: `status` comes back `queued` or `accepted`, so
 * a receipt here is Twilio accepting the message, not a handset getting
 * it. The outbox says "a provider accepted it" and that is exactly what
 * this is.
 */

export const TWILIO_API_VERSION = "2010-04-01";

/** E.164, which is what Twilio requires for both ends. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Account SIDs start AC; API key SIDs start SK and are also valid as
 * the Basic username, with the account SID still in the path. */
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const AUTH_SID_PATTERN = /^(AC|SK)[0-9a-fA-F]{32}$/;
const MESSAGING_SERVICE_PATTERN = /^MG[0-9a-fA-F]{32}$/;

export interface TwilioAddressing {
  /** `+15551234567`, or `whatsapp:+15551234567` for the WhatsApp entry. */
  to: string;
  from?: string;
  messagingServiceSid?: string;
}

/**
 * Validates the credential and addressing fields both Twilio providers
 * share. `channelPrefix` is `""` for SMS and `whatsapp:` for WhatsApp;
 * it is applied by the caller, so this checks the bare numbers.
 */
export function checkTwilioCommon(
  config: Record<string, string>,
  secrets: Record<string, string>,
): string | null {
  if (!ACCOUNT_SID_PATTERN.test(config.accountSid ?? "")) {
    return "The Account SID must start with AC followed by 32 hex characters.";
  }
  if (!AUTH_SID_PATTERN.test(secrets.authSid || config.accountSid || "")) {
    return "The API key SID must start with AC or SK followed by 32 hex characters.";
  }
  if (!secrets.authToken) return "An auth token or API key secret is required.";
  if (!E164_PATTERN.test(config.to ?? "")) {
    return "The recipient must be in E.164 form, for example +15551234567.";
  }
  const hasFrom = Boolean(config.from);
  const hasService = Boolean(config.messagingServiceSid);
  if (!hasFrom && !hasService) {
    return "Give a sender number or a Messaging Service SID.";
  }
  if (hasFrom && !E164_PATTERN.test(config.from ?? "")) {
    return "The sender number must be in E.164 form, for example +15551234567.";
  }
  if (
    hasService &&
    !MESSAGING_SERVICE_PATTERN.test(config.messagingServiceSid ?? "")
  ) {
    return "A Messaging Service SID starts with MG followed by 32 hex characters.";
  }
  return null;
}

/** The Twilio message body, capped at the documented 1,600 characters. */
export function twilioMessageText(message: ChannelMessage): string {
  return truncate(plainTextBody(message), 1_600);
}

/**
 * One Twilio send. `extra` carries whatever the calling provider adds -
 * the WhatsApp template parameters, for instance - so the request shape
 * itself is written once.
 */
export async function twilioDeliver(
  input: DeliverInput,
  addressing: TwilioAddressing,
  extra: Record<string, string> = {},
) {
  const { config, secrets, net } = input;
  const form = new URLSearchParams({ To: addressing.to });
  if (addressing.messagingServiceSid) {
    form.set("MessagingServiceSid", addressing.messagingServiceSid);
  } else if (addressing.from) {
    form.set("From", addressing.from);
  }
  for (const [key, value] of Object.entries(extra)) form.set(key, value);

  const username = secrets.authSid || config.accountSid || "";
  const basic = Buffer.from(
    `${username}:${secrets.authToken ?? ""}`,
    "utf8",
  ).toString("base64");

  return httpDeliver({
    url: `https://api.twilio.com/${TWILIO_API_VERSION}/Accounts/${encodeURIComponent(
      config.accountSid ?? "",
    )}/Messages.json`,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: form.toString(),
    secrets,
    net,
    messageId: (raw) => {
      const parsed = parseJsonBody<{ sid?: unknown }>(raw);
      return typeof parsed?.sid === "string" ? parsed.sid : null;
    },
  });
}

/** The credential and sender fields both Twilio providers show. */
export function twilioFields(channel: "sms" | "whatsapp") {
  const whatsapp = channel === "whatsapp";
  return [
    {
      key: "accountSid",
      label: "Account SID",
      type: "text" as const,
      required: true,
      placeholder: "AC…",
      help: "Twilio Console home. Identifies the account whose Messages resource is used.",
    },
    {
      key: "to",
      label: whatsapp ? "Recipient WhatsApp number" : "Recipient number",
      type: "text" as const,
      required: true,
      placeholder: "+15551234567",
      help: whatsapp
        ? "E.164, without the whatsapp: prefix - Vigil adds it."
        : "E.164, including the country code.",
    },
    {
      key: "from",
      label: whatsapp ? "WhatsApp sender number" : "Sender number",
      type: "text" as const,
      placeholder: "+15557654321",
      help: whatsapp
        ? "Your WhatsApp-enabled Twilio number, or the sandbox number. Leave blank to use a Messaging Service."
        : "A Twilio number you own. Leave blank to use a Messaging Service.",
    },
    {
      key: "messagingServiceSid",
      label: "Messaging Service SID",
      type: "text" as const,
      placeholder: "MG… (optional)",
      help: "Used instead of a sender number when set.",
    },
    {
      key: "authSid",
      label: "API key SID",
      type: "password" as const,
      secret: true,
      placeholder: "SK… - leave blank to use the Account SID",
      help: "An API key is safer than the account's own credentials, and can be revoked on its own.",
    },
    {
      key: "authToken",
      label: "Auth token or API key secret",
      type: "password" as const,
      secret: true,
      required: true,
      help: "The account Auth Token, or the secret of the API key above.",
    },
  ];
}

export const twilioProvider: ChannelProvider = {
  id: "twilio",
  label: "Twilio SMS",
  kind: "sms",
  blurb: "Send an SMS through your own Twilio account.",
  docsUrl: "https://www.twilio.com/docs/messaging/api/message-resource",
  // A literal for the same reason the SNS one is: this string is
  // read out of the source by the docs generator.
  apiVersion: "Programmable Messaging 2010-04-01",
  prerequisite:
    "A Twilio account, a number or Messaging Service that can send SMS to the destination country, and its credentials.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: twilioFields("sms"),
  check(config, secrets) {
    return checkTwilioCommon(config, secrets);
  },
  destinationSummary(config) {
    return `SMS to ${config.to ?? ""}`.trim();
  },
  async deliver(input) {
    return twilioDeliver(
      input,
      {
        to: input.config.to ?? "",
        ...(input.config.from ? { from: input.config.from } : {}),
        ...(input.config.messagingServiceSid
          ? { messagingServiceSid: input.config.messagingServiceSid }
          : {}),
      },
      { Body: twilioMessageText(input.message) },
    );
  },
};

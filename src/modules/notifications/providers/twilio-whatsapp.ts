import {
  checkTwilioCommon,
  twilioDeliver,
  twilioFields,
  twilioMessageText,
} from "./twilio";
import { truncate, type ChannelProvider } from "./types";

/**
 * Twilio WhatsApp. Separate from the SMS provider on purpose.
 *
 * WhatsApp is not "SMS with a different prefix", and a single Twilio
 * entry with a channel dropdown would bury the one rule that decides
 * whether alerts arrive at all: **outside a 24-hour service window,
 * WhatsApp will not deliver free-form text.** A monitor that fails at
 * 3am, to a number nobody has messaged that day, is exactly the case
 * that falls outside the window. Twilio accepts the request, returns a
 * `sid`, and the message is then dropped by WhatsApp with an
 * undelivered status.
 *
 * So this provider offers the template path as a first-class field. Set
 * a Content SID for an approved template and Vigil sends `ContentSid`
 * with `ContentVariables` instead of `Body`; leave it blank and it
 * sends `Body`, which is correct inside the window and honestly
 * documented as insufficient outside it.
 *
 * Addressing is the `whatsapp:` prefix on both ends, added here so the
 * operator types plain E.164 and cannot get the prefix half right.
 */

/** The three template variables Vigil fills, in a fixed order so an
 * approved template can be written against them once. */
const TEMPLATE_VARIABLES = ["1", "2", "3"] as const;

const CONTENT_SID_PATTERN = /^HX[0-9a-fA-F]{32}$/;

export const twilioWhatsappProvider: ChannelProvider = {
  id: "twilio-whatsapp",
  label: "Twilio WhatsApp",
  kind: "sms",
  blurb: "Send a WhatsApp message through your own Twilio account.",
  docsUrl: "https://www.twilio.com/docs/whatsapp/api",
  apiVersion: "Programmable Messaging 2010-04-01 (WhatsApp)",
  prerequisite:
    "A WhatsApp-enabled Twilio sender, and - for alerts outside a 24-hour service window - an approved message template.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    ...twilioFields("whatsapp"),
    {
      key: "contentSid",
      label: "Template Content SID",
      type: "text",
      placeholder: "HX… (strongly recommended)",
      help: "An approved template from Twilio Content Editor. Without one, WhatsApp drops messages sent outside a 24-hour service window. Vigil fills {{1}} with the title, {{2}} with the detail and {{3}} with the link.",
    },
  ],
  check(config, secrets) {
    const common = checkTwilioCommon(config, secrets);
    if (common) return common;
    if (config.contentSid && !CONTENT_SID_PATTERN.test(config.contentSid)) {
      return "A Content SID starts with HX followed by 32 hex characters.";
    }
    return null;
  },
  destinationSummary(config) {
    return `WhatsApp to ${config.to ?? ""}`.trim();
  },
  async deliver(input) {
    const { config, message } = input;
    const addressing = {
      to: `whatsapp:${config.to ?? ""}`,
      ...(config.from ? { from: `whatsapp:${config.from}` } : {}),
      ...(config.messagingServiceSid
        ? { messagingServiceSid: config.messagingServiceSid }
        : {}),
    };

    if (config.contentSid) {
      const values = [
        truncate(message.title, 1_000),
        truncate(message.text || "-", 1_000),
        message.url ?? "-",
      ];
      return twilioDeliver(input, addressing, {
        ContentSid: config.contentSid,
        ContentVariables: JSON.stringify(
          Object.fromEntries(
            TEMPLATE_VARIABLES.map((key, index) => [key, values[index] ?? "-"]),
          ),
        ),
      });
    }

    return twilioDeliver(input, addressing, {
      Body: twilioMessageText(message),
    });
  },
};

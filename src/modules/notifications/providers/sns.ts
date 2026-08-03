import { createHash, createHmac } from "node:crypto";

import {
  alertKey,
  httpDeliver,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Amazon SNS, through the Query API signed with Signature Version 4.
 *
 * Signed here rather than through the AWS SDK, and that is a deliberate
 * trade. The SDK is ~40 packages and does its own HTTP, which would put
 * one outbound path outside `egressFetch` - no address policy, no
 * redirect refusal, its own retry loop competing with the outbox's. The
 * signing algorithm is a page of HMAC-SHA-256 and it is fully specified,
 * so implementing it keeps every delivery on one pipeline. What is
 * given up is the SDK's credential chain: an operator pastes an access
 * key rather than getting an instance role. That is stated in the docs
 * rather than hidden, and the key is sealed like every other credential.
 *
 * The request is `Action=Publish&Version=2010-03-31` form-encoded to
 * `sns.<region>.amazonaws.com`, so the host is CONSTRUCTED from a
 * validated region rather than typed - there is no URL field here and
 * therefore no SSRF surface.
 *
 * FIFO topics get real semantics: `MessageGroupId` is the alert key, so
 * everything about one outage stays ordered, and `MessageDeduplicationId`
 * is the outbox row id, so the at-least-once retry collapses inside
 * SNS's five-minute deduplication window.
 */

const SNS_API_VERSION = "2010-03-31";
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const TOPIC_ARN_PATTERN =
  /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+(\.fifo)?$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export interface SigV4Input {
  method: "POST";
  host: string;
  path: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Injected so the signature is reproducible in a test. */
  now: Date;
}

/**
 * The Authorization header together with every header it signs over.
 *
 * Returned as one map rather than as a signature string, because a
 * SigV4 signature is only valid against the exact header set it names -
 * handing back the string and letting the caller assemble the headers
 * is how signatures silently stop matching.
 *
 * `host` is signed and then removed from the result. It has to be in
 * the canonical request (AWS rejects a signature that omits it), and it
 * must NOT be sent explicitly: the transport sets `Host` itself from the
 * URL, and it is the same value, because `egressFetch` pins the IP
 * through a custom resolver and leaves the hostname in the URL intact.
 */
export function signSigV4(input: SigV4Input): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region),
      input.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return headers;
}

/**
 * SNS subjects are UTF-8, under 100 characters, and may contain no line
 * breaks or control characters, so this strips rather than trusts. The
 * class is written in escapes because a literal control character in a
 * source file is invisible to whoever reads it next - and makes the file
 * binary to grep, which is how this comment came to exist.
 */
export function snsSubject(message: ChannelMessage): string {
  const clean = message.title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean || "Vigil alert", 99);
}

/** SNS's XML response, read for the one element worth keeping. */
export function snsMessageId(body: string): string | null {
  return /<MessageId>([^<]+)<\/MessageId>/.exec(body)?.[1] ?? null;
}

export const snsProvider: ChannelProvider = {
  id: "sns",
  label: "Amazon SNS",
  kind: "webhook",
  blurb: "Publish to an SNS topic in your own AWS account.",
  docsUrl: "https://docs.aws.amazon.com/sns/latest/api/API_Publish.html",
  // A literal, not `${SNS_API_VERSION}`: the docs generator and the
  // facts guard read this file as text, and an interpolation reaches
  // them as the word "${SNS_API_VERSION}" on a published page.
  apiVersion: "Query API 2010-03-31, Signature Version 4",
  prerequisite:
    "An SNS topic and an IAM identity allowed to sns:Publish to it. Vigil uses a static access key, not an instance role.",
  capabilities: {
    native: true,
    lifecycle: false,
    // False, because it is only true on `.fifo` topics and this flag is
    // a property of the PROVIDER, not of one operator's configuration.
    // A standard topic gets no `MessageDeduplicationId` at all, and a
    // badge in the editor cannot know which kind of ARN is about to be
    // typed into the field below it. The FIFO behaviour is real and is
    // documented in `docs/NOTIFICATIONS.md`; it is just not a promise
    // this provider can make in general.
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "region",
      label: "Region",
      type: "text",
      required: true,
      placeholder: "eu-west-1",
      help: "The region the topic is in. The endpoint host is built from this; there is no URL to type.",
    },
    {
      key: "topicArn",
      label: "Topic ARN",
      type: "text",
      required: true,
      placeholder: "arn:aws:sns:eu-west-1:123456789012:alerts",
      help: "A .fifo topic also gets a message group and deduplication id.",
    },
    {
      key: "accessKeyId",
      label: "Access key ID",
      type: "password",
      secret: true,
      required: true,
      placeholder: "AKIA…",
      help: "An IAM user or role key whose only permission needs to be sns:Publish on this topic.",
    },
    {
      key: "secretAccessKey",
      label: "Secret access key",
      type: "password",
      secret: true,
      required: true,
    },
    {
      key: "sessionToken",
      label: "Session token",
      type: "password",
      secret: true,
      placeholder: "optional - only for temporary credentials",
      help: "Temporary credentials expire; deliveries fail with an auth error when they do.",
    },
  ],
  check(config, secrets) {
    if (!REGION_PATTERN.test(config.region ?? "")) {
      return "The region must look like eu-west-1.";
    }
    if (!TOPIC_ARN_PATTERN.test(config.topicArn ?? "")) {
      return "The topic ARN must look like arn:aws:sns:region:account:name.";
    }
    if (!config.topicArn?.includes(`:${config.region}:`)) {
      return "The topic ARN's region must match the region field.";
    }
    if (!secrets.accessKeyId) return "An access key ID is required.";
    if (!secrets.secretAccessKey) return "A secret access key is required.";
    return null;
  },
  destinationSummary(config) {
    const name = (config.topicArn ?? "").split(":").pop() ?? "";
    return `SNS topic ${name} in ${config.region ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, rowId, net }) {
    const region = config.region ?? "";
    const host = `sns.${region}.amazonaws.com`;
    const form = new URLSearchParams({
      Action: "Publish",
      Version: SNS_API_VERSION,
      TopicArn: config.topicArn ?? "",
      Subject: snsSubject(message),
      Message: truncate(
        [message.title, message.text, message.url].filter(Boolean).join("\n"),
        250_000,
      ),
    });
    if (config.topicArn?.endsWith(".fifo")) {
      form.set("MessageGroupId", truncate(alertKey(message, rowId), 128));
      form.set("MessageDeduplicationId", truncate(rowId, 128));
    }
    const body = form.toString();

    return httpDeliver({
      url: `https://${host}/`,
      headers: signSigV4({
        method: "POST",
        host,
        path: "/",
        body,
        region,
        service: "sns",
        accessKeyId: secrets.accessKeyId ?? "",
        secretAccessKey: secrets.secretAccessKey ?? "",
        ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
        now: new Date(),
      }),
      body,
      secrets,
      net,
      messageId: snsMessageId,
    });
  },
};

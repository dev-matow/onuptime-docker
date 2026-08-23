import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as signWith,
} from "node:crypto";

import {
  httpDeliver,
  requireHttpsUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Web Push - RFC 8291 message encryption with RFC 8292 VAPID auth,
 * straight to whatever push service the browser's subscription names.
 *
 * Implemented rather than delegated to the `web-push` package, and the
 * reason is the same one that governs every other provider here: that
 * package does its own HTTP. A dependency that opens its own sockets is
 * a delivery path outside `egressFetch` - no address policy, no
 * refusal of metadata space, no redirect ban, its own retry loop
 * arguing with the outbox's. The crypto is two HKDF derivations, one
 * AES-128-GCM record and an ES256 JWT, all of which `node:crypto`
 * already implements; what would be imported is the HTTP, and the HTTP
 * is the part that must not be imported.
 *
 * Everything the browser produced - endpoint, `p256dh`, `auth` - is one
 * pasted subscription object, because that is the shape the browser
 * hands the operator and re-typing its fields into three boxes is how
 * base64url gets mangled. It is a secret field: `auth` is the key that
 * lets anyone encrypt to that device.
 *
 * A subscription expires. Push services answer 404 or 410 when it does,
 * which the shared classifier already treats as permanent, so a dead
 * subscription shows in the ledger as a failed delivery naming the
 * channel rather than as a retry loop that never converges.
 */

/** One record, one message. Big enough for any alert Vigil renders and
 * inside the 4096-byte floor every push service accepts. */
const RECORD_SIZE = 4_096;
/**
 * Longest payload the record can carry.
 *
 * The subtraction is the padding delimiter (1) plus the GCM tag (16)
 * plus the RFC 8188 content-coding header, which is salt (16) + record
 * size (4) + key id length (1) + the uncompressed P-256 key (65) = 86.
 * Leaving the header out put the BODY over 4096 bytes for a payload
 * that fitted the record, and RFC 8030 only obliges a push service to
 * accept 4096 octets of body - so the tail of that range could 413.
 */
const MAX_PAYLOAD = RECORD_SIZE - 17 - 86;
/** Twelve hours - inside VAPID's 24-hour ceiling with room for clock skew. */
const JWT_TTL_SECONDS = 43_200;
/** How long the push service should hold an undelivered alert. */
const PUSH_TTL_SECONDS = 3_600;

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Parses and validates a browser subscription. Returns the reason it is
 * unusable rather than throwing, because this runs in `check` where the
 * operator is waiting for a sentence.
 */
export function parseSubscription(
  raw: string,
): { subscription: PushSubscription } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "The subscription is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { error: "The subscription must be a JSON object." };
  }
  const value = parsed as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (typeof value.endpoint !== "string") {
    return { error: "The subscription has no endpoint." };
  }
  const urlError = requireHttpsUrl(value.endpoint, "The push endpoint");
  if (urlError) return { error: urlError };
  const p256dh = value.keys?.p256dh;
  const auth = value.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") {
    return { error: "The subscription is missing keys.p256dh or keys.auth." };
  }
  if (fromB64url(p256dh).length !== 65) {
    return { error: "keys.p256dh must be a 65-byte uncompressed P-256 point." };
  }
  if (fromB64url(auth).length !== 16) {
    return { error: "keys.auth must be a 16-byte authentication secret." };
  }
  return { subscription: { endpoint: value.endpoint, keys: { p256dh, auth } } };
}

/**
 * RFC 8291 aes128gcm encryption of one payload for one subscription.
 *
 * The derivation, in the order the RFC states it:
 *
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   IKM   = HKDF(salt = auth_secret, ikm = ecdh_secret,
 *                info = "WebPush: info" || 0x00 || ua_public || as_public, 32)
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, 16)
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce"     || 0x00, 12)
 *
 * `hkdfSync` is full HKDF - extract then expand - which is exactly the
 * two-stage shape the RFC describes, so each line above is one call.
 *
 * The record is the RFC 8188 header (salt, record size, key id length,
 * key id) followed by the ciphertext; the key id is the application
 * server's public key, which is how the user agent finds the other half
 * of the exchange. The plaintext carries a single 0x02 delimiter - the
 * last-record marker - and no padding, because hiding the length of an
 * alert nobody is measuring is not worth the bytes.
 *
 * `ephemeralPrivate` is injectable so a test can pin the whole
 * ciphertext against a known vector instead of asserting it merely
 * decrypts.
 */
export function encryptWebPush(
  payload: string,
  subscription: PushSubscription,
  options: { salt?: Buffer; ephemeralPrivate?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);

  const ecdh = createECDH("prime256v1");
  if (options.ephemeralPrivate) ecdh.setPrivateKey(options.ephemeralPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32),
  );

  const salt = options.salt ?? randomBytes(16);
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: nonce\0", "utf8"),
      12,
    ),
  );

  const plaintext = Buffer.concat([
    Buffer.from(payload, "utf8"),
    Buffer.from([0x02]),
  ]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
  ]);
}

/**
 * The VAPID Authorization header for one push endpoint.
 *
 * `aud` is the endpoint's ORIGIN, not the endpoint - a token scoped to
 * the full URL is rejected by every push service. The signature is
 * ES256 in the raw r||s form JWS requires, which is what
 * `dsaEncoding: "ieee-p1363"` produces; Node's default is DER, and a
 * DER signature in a JWT fails verification with no useful message.
 */
/**
 * Whether a VAPID public key is the one this private key produces.
 *
 * Derived rather than asserted: `setPrivateKey` computes the public
 * point from the scalar, so the comparison is against what the private
 * key actually is rather than against what the operator pasted beside
 * it. Cheap enough for the settings page and deliberately NOT on the
 * signing path, which runs per message.
 */
export function vapidPairMatches(
  publicKey: string,
  privateKey: string,
): boolean {
  try {
    const claimed = fromB64url(publicKey);
    if (claimed.length !== 65) return false;
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(fromB64url(privateKey));
    return curve.getPublicKey().equals(claimed);
  } catch {
    // A scalar outside the curve order, or a key that is not base64url.
    // Both are "these do not go together" as far as the operator is
    // concerned, and the field-length checks above name the commoner
    // shapes of wrong.
    return false;
  }
}

export function vapidAuthorization(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string,
  nowSeconds: number,
): string {
  const audience = new URL(endpoint).origin;
  const header = b64url(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"),
  );
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: nowSeconds + JWT_TTL_SECONDS,
        sub: subject,
      }),
      "utf8",
    ),
  );
  const signingInput = `${header}.${claims}`;

  const raw = fromB64url(publicKey);
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: b64url(raw.subarray(1, 33)),
      y: b64url(raw.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signature = signWith("sha256", Buffer.from(signingInput, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${publicKey}`;
}

/**
 * What a browser shows in a notification: title, body, and where to go.
 *
 * The fields are truncated BEFORE serialising, never the JSON after -
 * cutting a JSON string at a byte offset produces something the service
 * worker cannot parse, which fails silently on the device where nobody
 * can see it. The bound is checked afterwards anyway, and an
 * over-length payload degrades to the title rather than to garbage.
 */
export function webPushPayload(message: ChannelMessage): string {
  const full = JSON.stringify({
    title: truncate(message.title, 200),
    body: truncate(message.text || message.title, 1_000),
    ...(message.url ? { url: message.url } : {}),
    severity: message.severity,
  });
  if (Buffer.byteLength(full, "utf8") <= MAX_PAYLOAD) return full;
  return JSON.stringify({
    title: truncate(message.title, 200),
    body: "",
    severity: message.severity,
  });
}

/** Browsers show a critical alert differently from a recovery notice. */
const URGENCY: Record<ChannelMessage["severity"], string> = {
  critical: "high",
  warning: "normal",
  ok: "low",
  info: "normal",
};

export const webpushProvider: ChannelProvider = {
  id: "webpush",
  label: "Web Push",
  kind: "push",
  blurb: "Push to a browser that has subscribed, using your own VAPID keys.",
  docsUrl: "https://datatracker.ietf.org/doc/html/rfc8291",
  apiVersion: "RFC 8291 aes128gcm, RFC 8292 VAPID",
  prerequisite:
    "A VAPID key pair you generated, and one PushSubscription object copied from the subscribed browser.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "subscription",
      label: "Push subscription",
      type: "textarea",
      secret: true,
      required: true,
      placeholder: '{"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}}',
      help: "The whole PushSubscription object from the browser, pasted as it came. keys.auth is a credential, so it is stored encrypted like any other.",
    },
    {
      key: "vapidSubject",
      label: "VAPID subject",
      type: "text",
      required: true,
      placeholder: "mailto:ops@example.com",
      help: "How a push service contacts you about your traffic. A mailto: or https: URL.",
    },
    {
      key: "vapidPublicKey",
      label: "VAPID public key",
      type: "text",
      required: true,
      placeholder: "base64url, 65 bytes decoded",
      help: "The same key the page used when it subscribed. A different key means the push service rejects the token.",
    },
    {
      key: "vapidPrivateKey",
      label: "VAPID private key",
      type: "password",
      secret: true,
      required: true,
      placeholder: "base64url, 32 bytes decoded",
    },
  ],
  check(config, secrets) {
    const parsed = parseSubscription(secrets.subscription ?? "");
    if ("error" in parsed) return parsed.error;
    const subject = config.vapidSubject ?? "";
    if (!/^mailto:\S+@\S+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) {
      return "The VAPID subject must be a mailto: address or an https URL.";
    }
    if (fromB64url(config.vapidPublicKey ?? "").length !== 65) {
      return "The VAPID public key must decode to 65 bytes.";
    }
    if (fromB64url(secrets.vapidPrivateKey ?? "").length !== 32) {
      return "The VAPID private key must decode to 32 bytes.";
    }
    // Proves the two halves belong to each other before the operator
    // waits for a failed delivery to find out they pasted keys from two
    // different pairs.
    //
    // A DERIVATION, not a try/catch around the import. `createPrivateKey`
    // takes a JWK whose `x` and `y` do not lie on the curve point `d`
    // produces and accepts it without complaint on Node 24, so the
    // "import the pair and see whether it throws" test that stood here
    // returned null for every mismatched pair - the check reported
    // nothing wrong, and the test asserting it failed. Which Node
    // versions validate on import is not a thing this check should
    // depend on.
    if (
      !vapidPairMatches(
        config.vapidPublicKey ?? "",
        secrets.vapidPrivateKey ?? "",
      )
    ) {
      return "The VAPID key pair does not match; the public key must be the one derived from this private key.";
    }
    try {
      vapidAuthorization(
        parsed.subscription.endpoint,
        config.vapidPublicKey ?? "",
        secrets.vapidPrivateKey ?? "",
        subject,
        0,
      );
    } catch {
      return "The VAPID key pair does not match; the public key must be the one derived from this private key.";
    }
    return null;
  },
  destinationSummary(_config, secrets) {
    const parsed = parseSubscription(secrets.subscription ?? "");
    if ("error" in parsed) return "Web Push";
    try {
      return `Web Push via ${new URL(parsed.subscription.endpoint).hostname}`;
    } catch {
      return "Web Push";
    }
  },
  async deliver({ config, secrets, message, net }) {
    const parsed = parseSubscription(secrets.subscription ?? "");
    if ("error" in parsed) {
      return { status: "permanent", error: parsed.error };
    }
    const { subscription } = parsed;
    const body = encryptWebPush(webPushPayload(message), subscription);
    return httpDeliver({
      url: subscription.endpoint,
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: String(PUSH_TTL_SECONDS),
        urgency: URGENCY[message.severity],
        authorization: vapidAuthorization(
          subscription.endpoint,
          config.vapidPublicKey ?? "",
          secrets.vapidPrivateKey ?? "",
          config.vapidSubject ?? "",
          Math.floor(Date.now() / 1_000),
        ),
      },
      body,
      secrets,
      net,
    });
  },
};

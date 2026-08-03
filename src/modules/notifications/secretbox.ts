import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { env } from "@/lib/env";

/**
 * At-rest encryption for notification channel credentials.
 *
 * Channel secrets are retrievable by design - the worker must present
 * them to a provider on every delivery - so hashing is out and the only
 * honest options are plaintext or reversible encryption under a key the
 * application already holds. Plaintext is what `webhook_endpoints`
 * shipped with, and it meant a database dump was a credential dump.
 *
 * The key is derived (HKDF-SHA-256) from BETTER_AUTH_SECRET rather than
 * a new environment variable: that secret is already required, already
 * at least 32 characters, and already something a deployment must keep
 * stable. The derivation info string scopes the key so this module can
 * never be used to decrypt anything auth produces, or vice versa.
 *
 * Consequence, stated in docs/NOTIFICATIONS.md: rotating
 * BETTER_AUTH_SECRET orphans stored channel secrets. Deliveries then
 * fail with a clear "credentials cannot be decrypted" error rather than
 * a silent wrong-key garbage payload, and the operator re-enters them.
 *
 * Envelope format: `enc1:<base64(iv || tag || ciphertext)>`. The `enc1`
 * prefix is the version; a future algorithm change adds `enc2` and reads
 * both. The migration that moved `webhook_endpoints` rows in could not
 * encrypt from SQL (the key lives in the process environment), so it
 * writes `plain:<json>` and the worker seals those rows at boot - see
 * `sealPlainChannelSecrets`.
 */

const VERSION_PREFIX = "enc1:";
const PLAIN_PREFIX = "plain:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(env.BETTER_AUTH_SECRET, "utf8"),
        Buffer.from("vigil", "utf8"),
        Buffer.from("notification-channel-secrets", "utf8"),
        32,
      ),
    );
  }
  return cachedKey;
}

/** Test hook: forget the derived key so a changed secret takes effect. */
export function resetSecretboxKey(): void {
  cachedKey = null;
}

export class SecretboxError extends Error {}

export type SecretValues = Record<string, string>;

/** Encrypts a secret map into a storable envelope. `{}` becomes `""`. */
export function sealSecrets(secrets: SecretValues): string {
  const entries = Object.entries(secrets).filter(([, v]) => v !== "");
  if (entries.length === 0) return "";
  const plaintext = Buffer.from(
    JSON.stringify(Object.fromEntries(entries)),
    "utf8",
  );
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    VERSION_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64")
  );
}

/**
 * Decrypts an envelope back into the secret map. Accepts the migration's
 * `plain:` form so a channel migrated from `webhook_endpoints` delivers
 * before the boot pass has re-sealed it.
 */
export function openSecrets(envelope: string): SecretValues {
  if (envelope === "") return {};
  if (envelope.startsWith(PLAIN_PREFIX)) {
    return parseSecretJson(envelope.slice(PLAIN_PREFIX.length));
  }
  if (!envelope.startsWith(VERSION_PREFIX)) {
    throw new SecretboxError("Stored channel secrets have an unknown format.");
  }
  const raw = Buffer.from(envelope.slice(VERSION_PREFIX.length), "base64");
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new SecretboxError("Stored channel secrets are truncated.");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A failed auth tag means the key changed (rotated
    // BETTER_AUTH_SECRET) or the row was tampered with. Either way the
    // credentials are gone and the operator has to re-enter them.
    throw new SecretboxError(
      "Channel credentials cannot be decrypted. If BETTER_AUTH_SECRET was rotated, re-enter this channel's credentials.",
    );
  }
  return parseSecretJson(plaintext.toString("utf8"));
}

/** Whether an envelope still needs sealing (migration leftover). */
export function isPlainEnvelope(envelope: string): boolean {
  return envelope.startsWith(PLAIN_PREFIX);
}

function parseSecretJson(json: string): SecretValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SecretboxError("Stored channel secrets are not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretboxError("Stored channel secrets are not an object.");
  }
  const out: SecretValues = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

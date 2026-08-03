import { createHash } from "node:crypto";

import {
  httpDeliver,
  parseJsonBody,
  plainTextBody,
  requireHttpUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Matrix, through the client-server API on the operator's homeserver -
 * matrix.org or their own, which is why http is allowed here and the
 * egress policy is what keeps it honest.
 *
 * The transaction id is the point of this provider. Matrix specifies
 * that a repeated PUT to the same path with the same `txnId` is a
 * retransmission, and the homeserver returns the original response
 * rather than sending a second message. Deriving the id from the outbox
 * row means the at-least-once retry - the one after a crash between the
 * provider accepting and the row recording it - collapses on the
 * server. That is real duplicate suppression, not a claim.
 *
 * Plain text only. Matrix supports `org.matrix.custom.html`, and using
 * it would mean escaping monitor names correctly on every path forever;
 * a monitor called `<b>prod` must not be able to change how an alert
 * renders. Same reasoning as Telegram here.
 */

/** Matrix wants a room ID (`!abc:server`), not an alias: the send
 * endpoint does not resolve aliases, and a channel saved with one would
 * fail on every delivery with a 404 nobody can read. */
const ROOM_ID_PATTERN = /^![\x21-\x7e]+:[A-Za-z0-9.-]+(?::\d+)?$/;

/**
 * A URL-safe transaction id from the outbox row id.
 *
 * Hashed rather than used raw because the row id goes in a path segment
 * and a transaction id is compared byte for byte by the homeserver;
 * hashing gives a fixed, safe alphabet without losing the one property
 * that matters, which is that the same row always produces the same id.
 */
export function matrixTxnId(rowId: string): string {
  return `vigil-${createHash("sha256").update(rowId).digest("hex").slice(0, 32)}`;
}

export const matrixProvider: ChannelProvider = {
  id: "matrix",
  label: "Matrix",
  kind: "chat",
  blurb: "Send to a Matrix room from your own homeserver account.",
  docsUrl:
    "https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid",
  apiVersion: "Client-Server API v3",
  prerequisite:
    "A Matrix account or bot on your homeserver, its access token, and the internal room ID of a room it has joined.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: true,
    receipt: true,
  },
  fields: [
    {
      key: "homeserverUrl",
      label: "Homeserver URL",
      type: "url",
      required: true,
      placeholder: "https://matrix.example.org",
      help: "The client API base URL, without /_matrix.",
    },
    {
      key: "roomId",
      label: "Room ID",
      type: "text",
      required: true,
      placeholder: "!AbCdEf:example.org",
      help: "The internal room ID from room settings - Advanced. A #alias will not work here.",
    },
    {
      key: "accessToken",
      label: "Access token",
      type: "password",
      secret: true,
      required: true,
      help: "The token of an account that has already joined the room. It cannot join on its own.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(
      config.homeserverUrl ?? "",
      "The homeserver URL",
    );
    if (urlError) return urlError;
    if (!ROOM_ID_PATTERN.test(config.roomId ?? "")) {
      return "The room ID must look like !AbCdEf:example.org, not a #alias.";
    }
    if (!secrets.accessToken) return "An access token is required.";
    return null;
  },
  destinationSummary(config) {
    return `Matrix room ${config.roomId ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, rowId, net }) {
    const base = (config.homeserverUrl ?? "").replace(/\/+$/, "");
    const room = encodeURIComponent(config.roomId ?? "");
    const txn = encodeURIComponent(matrixTxnId(rowId));
    return httpDeliver({
      url: `${base}/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`,
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.accessToken}`,
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: truncate(plainTextBody(message), 8_000),
      }),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ event_id?: unknown }>(raw);
        return typeof parsed?.event_id === "string" ? parsed.event_id : null;
      },
      // Matrix carries its rate limit in the body as well as the header,
      // and only the body form is specified.
      retryAfterFromBody: (raw) => {
        const parsed = parseJsonBody<{ retry_after_ms?: unknown }>(raw);
        const ms = parsed?.retry_after_ms;
        return typeof ms === "number" && ms >= 0
          ? Math.min(ms, 3_600_000)
          : undefined;
      },
    });
  },
};

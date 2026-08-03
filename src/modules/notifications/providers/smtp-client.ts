import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

import { classifyAddress, isNeverReachable } from "@/modules/monitors/net";
import type { EgressLookup } from "@/modules/monitors/egress";

/**
 * A minimal SMTP submission client: EHLO, optional STARTTLS, optional
 * AUTH, MAIL FROM, RCPT TO, DATA, QUIT. Hand-rolled over node:net and
 * node:tls like every other wire protocol in this repository - the
 * small image is part of the product, and a mail-sending library would
 * be the largest dependency in it.
 *
 * Choices that keep it small and safe:
 *
 *  - The body is base64 (RFC 2045), always. No 8BITMIME negotiation, no
 *    dot-stuffing pass: the base64 alphabet cannot produce a line
 *    starting with ".", so the DATA terminator cannot be forged by
 *    message content.
 *  - Certificate verification is always on. There is no "ignore TLS
 *    errors" option on purpose; a mail server with a broken certificate
 *    gets fixed, not trusted.
 *  - The target host's addresses are classified with the same rules as
 *    HTTP egress before a socket opens: metadata and link-local space
 *    is refused however the DNS answers, and the connection is pinned
 *    to the address that was checked. Private space is allowed - a
 *    relay on your own network is the normal deployment.
 */

export class SmtpError extends Error {
  constructor(
    message: string,
    /** 5xx or a protocol violation: retrying cannot help. */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export interface SmtpSendOptions {
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  username?: string;
  password?: string;
  timeoutMs?: number;
  lookup?: EgressLookup;
  /** Test seam: skips DNS and TCP entirely. */
  connect?: (host: string, port: number) => Promise<SmtpSocket>;
}

export interface SmtpMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** Becomes the Message-ID local part; the outbox row id in practice. */
  messageId: string;
}

/** The slice of a socket the conversation needs; tests fake this. */
export interface SmtpSocket {
  write(data: string): void;
  onData(handler: (chunk: Buffer) => void): void;
  onError(handler: (error: Error) => void): void;
  destroy(): void;
  /** STARTTLS upgrade; null when the transport cannot (fakes). */
  upgradeToTls?: (servername: string) => Promise<SmtpSocket>;
}

const CRLF = "\r\n";

/** Extracts the angle-addr from "Display Name <user@host>" or returns
 * the input trimmed - what MAIL FROM/RCPT TO must carry. Control
 * characters are stripped: they can only be a header-injection attempt,
 * and one reaching the command line would forge a second SMTP verb. The
 * provider's validation refuses them earlier; this is the sink's own
 * guard, so no future caller can smuggle one past it. */
export function envelopeAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value);
  return (match?.[1] ?? value).replace(/[\p{Cc}]/gu, "").trim();
}

/** RFC 2047 encoded-word for non-ASCII subjects (emoji, mostly). */
export function encodeSubject(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildMime(mail: SmtpMail, date: Date = new Date()): string {
  const body = Buffer.from(mail.text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, `$1${CRLF}`);
  return [
    `From: ${mail.from}`,
    `To: ${mail.to.join(", ")}`,
    `Subject: ${encodeSubject(mail.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${mail.messageId}@vigil>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join(CRLF);
}

interface Reply {
  code: number;
  text: string;
}

class Conversation {
  private buffer = "";
  private waiter: ((reply: Reply) => void) | null = null;
  private failure: ((error: Error) => void) | null = null;
  private pending: Reply[] = [];

  constructor(
    private socket: SmtpSocket,
    private timeoutMs: number,
  ) {
    this.attach(socket);
  }

  attach(socket: SmtpSocket): void {
    this.socket = socket;
    this.buffer = "";
    socket.onData((chunk) => this.consume(chunk.toString("utf8")));
    socket.onError((error) => {
      const fail = this.failure;
      this.failure = null;
      this.waiter = null;
      fail?.(error);
    });
  }

  private consume(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf(CRLF)) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      // "250-..." is a continuation; "250 ..." (or bare "250") is final.
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) continue;
      if (match[2] === "-") continue;
      const reply = { code: Number(match[1]), text: line };
      const wake = this.waiter;
      if (wake) {
        this.waiter = null;
        this.failure = null;
        wake(reply);
      } else {
        this.pending.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.failure = null;
        reject(new SmtpError("SMTP server timed out", false));
      }, this.timeoutMs);
      this.waiter = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failure = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  async command(line: string, expect: number[]): Promise<Reply> {
    this.socket.write(line + CRLF);
    return this.expect(expect);
  }

  async expect(codes: number[]): Promise<Reply> {
    const reply = await this.read();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(`SMTP: ${reply.text}`, reply.code >= 500);
    }
    return reply;
  }

  write(data: string): void {
    this.socket.write(data);
  }
}

async function guardedConnect(
  options: SmtpSendOptions,
): Promise<{ socket: net.Socket | tls.TLSSocket }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const literal = classifyAddress(options.host);
  let address = options.host;
  if (literal === null) {
    const resolved = options.lookup
      ? await options.lookup(options.host)
      : await dnsLookup(options.host, { all: true, verbatim: true });
    if (resolved.length === 0) {
      throw new SmtpError(`${options.host} did not resolve`, false);
    }
    for (const entry of resolved) {
      const classification = classifyAddress(entry.address) ?? "reserved";
      if (isNeverReachable(classification)) {
        throw new SmtpError(
          "The mail server resolves to a forbidden address range.",
          true,
        );
      }
    }
    address = resolved[0]?.address ?? options.host;
  } else if (isNeverReachable(literal)) {
    throw new SmtpError(
      "The mail server address is in a forbidden range.",
      true,
    );
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new SmtpError(error.message, false));
    if (options.security === "tls") {
      const socket = tls.connect(
        // Pinned to the checked address; SNI and verification use the name.
        { host: address, port: options.port, servername: options.host },
        () => resolve({ socket }),
      );
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
      socket.once("error", onError);
    } else {
      const socket = net.connect({ host: address, port: options.port }, () =>
        resolve({ socket }),
      );
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
      socket.once("error", onError);
    }
  });
}

function wrap(socket: net.Socket | tls.TLSSocket, host: string): SmtpSocket {
  return {
    write: (data) => socket.write(data),
    onData: (handler) => {
      socket.removeAllListeners("data");
      socket.on("data", handler);
    },
    onError: (handler) => {
      socket.removeAllListeners("error");
      socket.on("error", handler);
    },
    destroy: () => socket.destroy(),
    upgradeToTls: (servername) =>
      new Promise((resolve, reject) => {
        socket.removeAllListeners("data");
        const upgraded = tls.connect({ socket, servername }, () =>
          resolve(wrap(upgraded, host)),
        );
        upgraded.once("error", (error) =>
          reject(new SmtpError(`TLS: ${error.message}`, false)),
        );
      }),
  };
}

/**
 * Sends one message. Resolves with the server's final DATA reply (the
 * receipt); throws SmtpError with `permanent` set for 5xx.
 */
export async function smtpSend(
  options: SmtpSendOptions,
  mail: SmtpMail,
): Promise<{ reply: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let socket: SmtpSocket;
  if (options.connect) {
    socket = await options.connect(options.host, options.port);
  } else {
    const raw = await guardedConnect(options);
    socket = wrap(raw.socket, options.host);
  }

  const chat = new Conversation(socket, timeoutMs);
  try {
    await chat.expect([220]);
    await chat.command("EHLO vigil.invalid", [250]);

    if (options.security === "starttls") {
      await chat.command("STARTTLS", [220]);
      if (!socket.upgradeToTls) {
        throw new SmtpError("This transport cannot upgrade to TLS.", true);
      }
      socket = await socket.upgradeToTls(options.host);
      chat.attach(socket);
      await chat.command("EHLO vigil.invalid", [250]);
    }

    if (options.username) {
      // Credentials never cross an unencrypted socket; the provider's
      // validation enforces the same rule at save time.
      if (options.security === "none") {
        throw new SmtpError(
          "Refusing to authenticate without TLS. Use STARTTLS or TLS.",
          true,
        );
      }
      // AUTH PLAIN is NUL || authcid || NUL || passwd (RFC 4616).
      // Written as escapes: a literal NUL in a source file is
      // invisible to whoever reads it next and makes the whole file
      // binary to grep, which is a real cost for one saved character.
      const token = Buffer.from(
        `\0${options.username}\0${options.password ?? ""}`,
        "utf8",
      ).toString("base64");
      await chat.command(`AUTH PLAIN ${token}`, [235]);
    }

    await chat.command(`MAIL FROM:<${envelopeAddress(mail.from)}>`, [250]);
    for (const recipient of mail.to) {
      await chat.command(`RCPT TO:<${envelopeAddress(recipient)}>`, [250, 251]);
    }
    await chat.command("DATA", [354]);
    chat.write(buildMime(mail) + CRLF + "." + CRLF);
    const accepted = await chat.expect([250]);
    // QUIT is a courtesy; its reply is not worth waiting on.
    chat.write("QUIT" + CRLF);
    return { reply: accepted.text };
  } finally {
    socket.destroy();
  }
}

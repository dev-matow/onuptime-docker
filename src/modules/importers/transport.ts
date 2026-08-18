/**
 * The one HTTP client every provider adapter reads through.
 *
 * Fourteen adapters each calling `fetch` is fourteen chances to forget
 * the 429, to loop forever on a cursor that never advances, and to put a
 * bearer token in an error message that ends up in a support ticket. So
 * none of them calls `fetch`: they are handed one of these, and it is
 * the only thing that knows the credential exists.
 *
 * ── the credential never leaves this file ────────────────────────────
 *
 * Authorisation headers are held in a private field, applied at the
 * moment of the request, and never returned, logged or interpolated into
 * an error. Every error this module throws is built from the method, the
 * redacted URL and the status, which is everything an operator needs and
 * nothing an attacker does. `redactUrl` exists because two of the
 * supported providers take their key as a query parameter, and a URL in
 * an error message is the classic way a key escapes.
 *
 * ── the base URL is chosen, not typed ────────────────────────────────
 *
 * Several providers are regional, so an adapter has to let the customer
 * say which region. It does that by offering a fixed set of hosts and
 * taking a choice, never by accepting a URL. This client runs inside the
 * application server, so a free-text base URL is a request forgery
 * primitive wearing a settings form.
 *
 * Two adapters genuinely cannot use a constant, and they pay for it:
 * `guarded: true` sends their requests through the same egress guard the
 * monitor probes use, which resolves the name, refuses the never-
 * reachable classes, and pins the socket to the address it approved.
 * `baseUrlFor` in `providers/contract.ts` is the early, legible refusal;
 * this is the boundary. `ProviderTransport` also refuses anything that is
 * not https, which is the backstop for an adapter that gets it wrong.
 */

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

/** Injected so tests can answer without a network. */
export type Fetcher = (request: HttpRequest) => Promise<HttpResponse>;

/** Injected so tests do not wait out a rate limit in real time. */
export type Sleeper = (milliseconds: number) => Promise<void>;

export interface TransportOptions {
  fetcher?: Fetcher;
  sleep?: Sleeper;
  /**
   * A ceiling on requests for one read, so a paginator that never
   * terminates fails loudly instead of hammering a customer's vendor
   * account until their token is throttled.
   *
   * Reaching it throws. It does not truncate: a partial read that says
   * "42 checks" when the account has 4000 is exactly the silent loss
   * this whole feature exists to prevent.
   */
  maxRequests?: number;
  /** How many times a 429 or a 5xx is retried before giving up. */
  maxRetries?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /**
   * Send through the egress guard, for a host the operator typed rather
   * than one the adapter holds in a constant. See `guardedFetcher`.
   *
   * Ignored when `fetcher` is set, which is how the tests answer without
   * a network and without a resolver.
   */
  guarded?: boolean;
}

export class ProviderApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

const SECRET_QUERY_KEYS =
  /^(api[-_]?key|key|token|access[-_]?token|secret|password|auth|signature)$/i;

/** A URL with anything that looks like a credential replaced. */
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.test(key)) url.searchParams.set(key, "REDACTED");
  }
  return url.toString();
}

/**
 * How long to wait before retrying, from whatever the provider said.
 *
 * `Retry-After` is either seconds or an HTTP date (RFC 9110), and the
 * three rate-limit header spellings in use across the supported
 * providers all mean "epoch seconds at which the window resets". A
 * provider that says nothing gets exponential backoff, which is the only
 * safe default when the limit is undocumented, and one of the supported
 * providers documents no limit at all.
 */
export function retryDelayMs(
  headers: Readonly<Record<string, string>>,
  attempt: number,
  now: number,
): number {
  const read = (name: string): string | undefined =>
    headers[name.toLowerCase()];
  const retryAfter = read("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - now, 0), 60_000);
  }
  const reset =
    read("x-ratelimit-reset") ??
    read("ratelimit-reset") ??
    read("x-rate-limit-reset");
  if (reset !== undefined) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      // Epoch seconds on some providers, seconds-until-reset on others.
      // Both are handled by treating anything smaller than a year as a
      // duration, which no epoch timestamp ever is.
      const waitMs =
        epochSeconds < 31_536_000
          ? epochSeconds * 1000
          : epochSeconds * 1000 - now;
      if (waitMs > 0) return Math.min(waitMs, 60_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/** The default fetcher: the platform's, with a timeout and no redirects. */
function platformFetcher(timeoutMs: number): Fetcher {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: request.headers as Record<string, string> | undefined,
      body: request.body,
      // A provider API answering with a redirect is a misconfiguration or
      // a hijack, and following it would send the customer's token to
      // wherever it pointed.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      headers: headersOf(response),
      body: await response.text(),
    };
  };
}

/**
 * The fetcher for a host the operator typed.
 *
 * Twelve of the fourteen adapters dial a hostname out of a constant in
 * their own file. Two cannot: Healthchecks and Grafana Cloud Synthetic
 * Monitoring are, respectively, self-hostable and regional with no
 * published mapping from a stack to its API host, so the operator says
 * where their install is.
 *
 * A name check is not enough for that. `internal.example.com` is a
 * perfectly ordinary hostname that resolves to 10.0.0.5, and
 * `evil.example.com` can resolve to 169.254.169.254 on the second
 * lookup. So these requests go through the same guard the monitor probes
 * use: every resolved address is classified, the refused classes are
 * refused before policy is even consulted, and the socket is pinned to
 * the address that was approved rather than resolving a second time.
 *
 * The channel is `webhook` rather than `monitor` because that is the
 * posture this is: an administrator naming an endpoint they run, exactly
 * like a webhook target, and a self-hosted Healthchecks on a private
 * address is the normal case rather than the attack. The classes that
 * make this a security boundary, metadata and link-local, are refused
 * under every policy.
 */
function guardedFetcher(timeoutMs: number): Fetcher {
  return async (request) => {
    // Imported here rather than at the top of the file because the
    // egress guard reads the validated environment, and this module is
    // also loaded by the documentation generator and by the import page,
    // neither of which has a database URL to offer. A dynamic import
    // keeps the dependency where it is used.
    const { egressFetch, egressPolicyFor } =
      await import("@/modules/monitors/egress");
    const { response } = await egressFetch(
      request.url,
      {
        method: request.method ?? "GET",
        headers: request.headers as Record<string, string> | undefined,
        body: request.body ?? null,
        signal: AbortSignal.timeout(timeoutMs),
      },
      // 0 hops: a redirect from an API is a misconfiguration or a hijack,
      // and following it would send the customer's token onward.
      { policy: egressPolicyFor("webhook"), maxRedirects: 0 },
    );
    return {
      status: response.status,
      headers: headersOf(response),
      body: await response.text(),
    };
  };
}

export class ProviderTransport {
  readonly #base: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetcher: Fetcher;
  readonly #sleep: Sleeper;
  readonly #maxRequests: number;
  readonly #maxRetries: number;
  #requests = 0;

  /**
   * @param base    an https origin plus path prefix, chosen by the adapter
   * @param headers the authorisation headers; never read back out
   */
  constructor(
    base: string,
    headers: Readonly<Record<string, string>>,
    options: TransportOptions = {},
  ) {
    if (!base.startsWith("https://")) {
      throw new Error(
        "A provider API base URL must be https. This is a guard against an adapter accepting one from a form.",
      );
    }
    this.#base = base.replace(/\/+$/, "");
    this.#headers = headers;
    const timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetcher =
      options.fetcher ??
      (options.guarded === true
        ? guardedFetcher(timeoutMs)
        : platformFetcher(timeoutMs));
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#maxRequests = options.maxRequests ?? 5_000;
    this.#maxRetries = options.maxRetries ?? 4;
  }

  /** How many requests this read has cost, for the report's facts. */
  get requestCount(): number {
    return this.#requests;
  }

  /** An absolute URL for a path and query, against this transport's base. */
  url(
    path: string,
    query: Readonly<Record<string, string | number>> = {},
  ): string {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${this.#base}${path.startsWith("/") ? path : `/${path}`}`,
    );
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One request, retried on the statuses that are worth retrying, with
   * the body decoded as JSON.
   *
   * A 4xx other than 429 is not retried: a 401 will still be a 401 in
   * eight seconds, and retrying a 403 is how an integration gets an
   * account locked.
   */
  async json<T>(
    path: string,
    query: Readonly<Record<string, string | number>> = {},
  ): Promise<T> {
    const url = this.url(path, query);
    return this.#decode(url, await this.#send(url));
  }

  /**
   * One POST, for the providers whose read is a query rather than a
   * path. GraphQL is the only reason this exists, and it is still a
   * read: nothing in this module ever sends a mutation.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.url(path);
    return this.#decode(
      url,
      await this.#send(url, {
        method: "POST",
        body: JSON.stringify(body),
        contentType: "application/json",
      }),
    );
  }

  #decode<T>(url: string, body: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new ProviderApiError(
        200,
        `${redactUrl(url)} answered with something that is not JSON. The first bytes were: ${body.slice(0, 120).replace(/\s+/g, " ")}`,
      );
    }
  }

  async #send(
    url: string,
    send?: { method: "POST"; body: string; contentType: string },
  ): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      this.#requests += 1;
      if (this.#requests > this.#maxRequests) {
        throw new ProviderApiError(
          0,
          `This read needed more than ${this.#maxRequests} requests, which is the ceiling this importer applies. Nothing was imported, because a partial read that looks complete is worse than a refusal. Narrow the import or raise the ceiling.`,
        );
      }
      const response = await this.#fetcher(
        send === undefined
          ? { url, headers: this.#headers }
          : {
              url,
              method: "POST",
              headers: { ...this.#headers, "Content-Type": send.contentType },
              body: send.body,
            },
      );

      if (response.status >= 200 && response.status < 300) return response.body;

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.#maxRetries) {
        await this.#sleep(retryDelayMs(response.headers, attempt, Date.now()));
        continue;
      }
      throw new ProviderApiError(response.status, describe(url, response));
    }
  }
}

/**
 * What went wrong, in a sentence an operator can act on.
 *
 * The provider's own body is quoted because a good API says why, and
 * truncated because a bad one returns an HTML error page. Never the
 * request headers, which is where the credential is.
 */
function describe(url: string, response: HttpResponse): string {
  const detail = response.body.replace(/\s+/g, " ").trim().slice(0, 200);
  const advice =
    response.status === 401 || response.status === 403
      ? " The token was rejected. Check that it is valid and that it carries the read permission this importer documents."
      : response.status === 429
        ? " The account is rate limited and the wait was longer than this importer will hold a request open. Try again shortly."
        : response.status >= 300 && response.status < 400
          ? // New Relic's Synthetics API answers an unauthenticated
            // request with a redirect to its interactive login page
            // rather than a 401, on both its hosts. Reported plainly,
            // because "answered 302" reads like a routing problem and
            // sends an operator looking in the wrong place. The redirect
            // is deliberately not followed: the request carries the
            // customer's token, and following would hand it to whatever
            // host the redirect named.
            " The provider redirected the request instead of answering it, which usually means the token was not accepted. This importer does not follow a redirect, because the request carries your credential and following would send it somewhere else."
          : "";
  return `${redactUrl(url)} answered ${response.status}.${advice}${detail.length > 0 ? ` The provider said: ${detail}` : ""}`;
}

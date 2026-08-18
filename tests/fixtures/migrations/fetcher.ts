import type { Fetcher, HttpRequest } from "@/modules/importers/transport";

/**
 * A vendor API that answers from a table instead of a network.
 *
 * Every adapter takes its transport options from the caller precisely so
 * this can exist: the tests exercise the real pagination loop, the real
 * field mapping and the real error handling against bodies shaped like
 * the vendor's own, and no test ever reaches the internet.
 *
 * Requests are recorded so a test can assert on the shape of the read
 * itself: that a paginated adapter stopped, that an N+1 adapter asked
 * for every id once, that a credential was sent in the header the vendor
 * documents. `requests` holds the URL and the header names, never the
 * header values, so a fixture cannot become the place a token is
 * printed.
 */

export interface Route {
  /** Matched against the request's pathname, exactly. */
  path: string;
  /** When present, every entry must match the request's query. */
  query?: Readonly<Record<string, string>>;
  status?: number;
  headers?: Readonly<Record<string, string>>;
  /** An object is serialised; a string is sent as-is. */
  body: unknown;
}

export interface RecordedRequest {
  url: string;
  path: string;
  query: Record<string, string>;
  headerNames: string[];
}

export interface FakeApi {
  fetcher: Fetcher;
  requests: RecordedRequest[];
  /** How many times a path was asked for, whatever the query. */
  countOf(path: string): number;
}

function matches(route: Route, url: URL): boolean {
  if (route.path !== url.pathname) return false;
  for (const [key, value] of Object.entries(route.query ?? {})) {
    if (url.searchParams.get(key) !== value) return false;
  }
  return true;
}

export function fakeApi(routes: readonly Route[]): FakeApi {
  const requests: RecordedRequest[] = [];

  const fetcher: Fetcher = async (request: HttpRequest) => {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    requests.push({
      url: request.url,
      path: url.pathname,
      query,
      headerNames: Object.keys(request.headers ?? {}),
    });

    // Most specific first: a route that pins a query wins over the one
    // that does not, whatever order the caller declared them in.
    const candidates = routes.filter((route) => matches(route, url));
    const route = candidates.sort(
      (a, b) =>
        Object.keys(b.query ?? {}).length - Object.keys(a.query ?? {}).length,
    )[0];

    if (route === undefined) {
      return {
        status: 404,
        headers: {},
        body: JSON.stringify({ error: `no fixture for ${url.pathname}` }),
      };
    }
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body:
        typeof route.body === "string"
          ? route.body
          : JSON.stringify(route.body),
    };
  };

  return {
    fetcher,
    requests,
    countOf(path: string): number {
      return requests.filter((entry) => entry.path === path).length;
    },
  };
}

/** Transport options that answer from `routes` and never sleep. */
export function fakeTransport(routes: readonly Route[]): {
  api: FakeApi;
  options: { fetcher: Fetcher; sleep: () => Promise<void> };
} {
  const api = fakeApi(routes);
  return {
    api,
    options: { fetcher: api.fetcher, sleep: async () => undefined },
  };
}

# `memcached`: a cache says which version it is and how full its connection table is

Opens a TCP connection, asks `version`, then `stats` and `stats
settings`, and stops. Nothing is ever written to the cache.

|          |                                                        |
| -------- | ------------------------------------------------------ |
| Kind     | `active`: Vigil dials it on the monitor's interval     |
| Target   | a bare hostname, e.g. `cache.example.com`              |
| Port     | required, defaults to **11211**                        |
| Settings | `username`, `password`, `maxConnectionUsagePercent`    |
| Secrets  | `password`                                             |
| Recovery | supported. The target can be re-probed to verify a fix |

## What it observes

| Fact                     | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `version`                | what the `VERSION` reply said                                    |
| `uptimeSeconds`          | `stats uptime`: how long this process has been running           |
| `currentConnections`     | `stats curr_connections`                                         |
| `maxConnections`         | `stats settings maxconns`: the limit the server was started with |
| `connectionUsagePercent` | the first as a percentage of the second                          |
| `serverError`            | the server's own words when it refused a command                 |
| `responseTimeMs`         | connect to the last reply                                        |

## What makes it fail

| Verdict                       | When                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| down                          | whatever answered on the port did not send a `VERSION` line                       |
| degraded                      | `connectionUsagePercent` is over the configured threshold                         |
| degraded                      | the exchange took longer than the monitor's degraded threshold                    |
| down (transport)              | the connection failed, timed out, or was closed before a reply                    |
| indeterminate (misconfigured) | the server wants a credential this monitor has not got, or refuses the one it has |

Two of those are the reason this type exists rather than a `tcp` monitor
on port 11211:

- **Something else on the port.** A proxy, a TLS terminator, or the wrong
  service after a compose file was edited all complete the TCP handshake.
  Only a `VERSION` reply says which service answered.
- **Connection exhaustion.** When `maxconns` is reached memcached stops
  accepting, and by then a socket check already has its connection. The
  ratio is the one saturation signal `stats` exposes that means something
  on a single reading, every other counter there is cumulative since the
  process started, and a probe has no previous observation to compare a
  cumulative counter against.

`uptimeSeconds` is recorded and never asserted on. A memcached that
restarted lost every key it held, which is worth seeing on the timeline;
it is not worth paging for, because by the time anyone reads the page the
cache has already refilled.

## Authentication

memcached has two unrelated authentication mechanisms, and this type
supports exactly one of them.

**ASCII authentication** (`-Y` / `--auth-file`, memcached 1.5.16 and
later) is what `username` and `password` configure. The client
authenticates by sending a `set` whose key is the user name and whose
data block is the password, and the server answers `STORED`.

**SASL over the binary protocol** is not supported. It is a different
framing and a different handshake, and a server built for it does not
speak the text protocol this check is made of at all.

The order of commands matters and is not an accident. **The credential
is only ever offered after the server has asked for one**, which it does
by refusing `version` with `CLIENT_ERROR authentication required`. On a
server that was _not_ started with an auth file, memcached's
authentication command is not special in any way. It is an ordinary
store, and sending it speculatively would write the password into the
cache under a key named after the user, where any client can `get` it.

A rejected credential reports **misconfigured**, never down. The server
is up, answering, and refusing _us_; an operator error that reads as an
outage is the one failure a monitoring product may not have.

## Limitations

- **No SASL**, as above. Point a `tcp` monitor at a SASL-only server, or
  give it an auth file.
- **The cache is never written to.** There is no `set`/`get` round trip,
  so this check does not prove the cache can store anything, only that
  the server is the one that was expected, is answering, and has room to
  accept connections. Writing to a production cache every interval is not
  something a monitor should do uninvited.
- **`stats settings` is optional in practice.** Some hosted memcacheds
  restrict it. When it is refused the check still passes on `version` and
  `stats`; `maxConnections` and `connectionUsagePercent` are then simply
  absent, and the saturation assertion says nothing rather than reporting
  a missing counter as saturation.
- **The connection threshold defaults to 90%** and can be turned off by
  setting `maxConnectionUsagePercent` to `null`. It is degraded-only: it
  colors the monitor amber and opens no incident.
- **The credentials and the threshold cannot be set from the monitor
  dialog yet.** They travel through the API, an import, or an
  export/edit/import round trip. They are stored and masked like every
  other monitor secret.
- **A user name may not contain a space, a colon or a control
  character.** The protocol is line- and space-delimited, so a space
  would be parsed as an argument separator; a colon cannot appear in a
  real user name because the auth file is `user:password` per line.
- **The whole conversation is bounded by the monitor's timeout**, and
  the reply is capped at 64 kB. Neither limit is one a real server
  approaches.

## Where it lives

|            |                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Descriptor | `src/modules/monitors/types/catalog.ts` (`memcachedDescriptor`)                                   |
| Spec       | `src/modules/monitors/types/specs/memcached.ts`                                                   |
| Probe      | `src/modules/monitors/types/probes/memcached.ts`                                                  |
| Tests      | `tests/unit/check-memcached.test.ts`, `tests/integration/monitor-memcached-elasticsearch.test.ts` |

The unit suite dials a real memcached-speaking server on loopback, a
scripted `net.createServer`, not a stubbed probe. It frames lines on
CRLF, reads the length-prefixed data block of a `set` by count, and can
be told to demand a credential, to split every reply across two packets
mid-line, or to answer something that is not memcached at all. One of
its cases asserts that a monitor holding a credential sends no `set` to a
server that never asked for one.

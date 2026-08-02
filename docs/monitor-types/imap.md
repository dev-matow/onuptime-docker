# `imap`: a mail store answers and still offers what its clients need

Opens a TCP connection to an IMAP server, reads the greeting, sends one
`CAPABILITY` command and reads the answer. Nothing else: no mailbox is
selected, no message is fetched, no login is attempted.

|          |                                                         |
| -------- | ------------------------------------------------------- |
| Kind     | `active`: Vigil dials it on the monitor's interval     |
| Target   | a bare hostname, e.g. `imap.example.com`                |
| Port     | required, defaults to **143**                           |
| Settings | `requiredCapability` (optional)                         |
| Secrets  | none                                                    |
| Recovery | supported. The target can be re-probed to verify a fix |

## What it observes

| Fact                 | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| `greetingStatus`     | `OK`, `PREAUTH` or `BYE`: what the server opened with |
| `banner`             | the greeting line, truncated to 200 characters         |
| `capabilityAccepted` | the server completed `CAPABILITY` with a tagged `OK`   |
| `capabilities`       | the atoms it advertised                                |
| `responseTimeMs`     | greeting to completion                                 |

## What makes it fail

| Verdict          | When                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| down             | the greeting is `BYE`: the server is refusing this connection ("too many connections", "shutting down") |
| down             | whatever answered on the port did not send an IMAP greeting                                              |
| down             | the server rejected `CAPABILITY` with `NO` or `BAD`                                                      |
| down             | the server completed `CAPABILITY` and named no `IMAP4rev1`/`IMAP4rev2`                                   |
| down             | `requiredCapability` is set and no longer appears in the list                                            |
| degraded         | the exchange took longer than the monitor's degraded threshold                                           |
| down (transport) | the connection failed, timed out, or was closed mid-conversation                                         |

A `BYE` greeting is the case this type exists for. The socket opens, so a
`tcp` monitor on port 143 reports a healthy server for as long as it is
turning every real client away.

### `requiredCapability`

One capability atom. `STARTTLS`, `IDLE`, `AUTH=PLAIN`: that the server
must keep advertising. Compared case-insensitively, because IMAP atoms
are. It is for the failure a check of the greeting alone cannot see: a
mail server that stops offering `STARTTLS` after a config reload is still
up, still greets, still answers `CAPABILITY`, and every client that
insisted on encryption has silently stopped being able to fetch mail.

Leave it empty and the monitor only asserts that the store answers.

## Limitations

- **Plaintext only.** `STARTTLS` is never issued, so **port 993 (implicit
  TLS) will never answer this probe**, it expects a TLS handshake before
  the first byte of IMAP. Use 143. What this type reports is that the
  store is listening and talking, not that its TLS is healthy; put a
  `tls-expiry` monitor on the same host for that.
- **Nothing is authenticated, deliberately.** Sending `LOGIN` over a
  plaintext connection would put a mailbox password on the wire on every
  check forever, and RFC 3501 §7.2.1 requires a server that refuses
  cleartext logins to advertise `LOGINDISABLED` and reject it, so an
  authenticating check would report every correctly configured mail
  server as down. `LOGINDISABLED` in the capability list is a sign of a
  well-configured server, not a fault.
- **No mailbox is opened.** "Can this account list its inbox" is a
  different check from "is the store serving", and it cannot be made
  without credentials this type will not carry.
- **The capability list is truncated at 64 entries** and the banner at
  200 characters. Both are written to the check history on every check.
- Responses containing IMAP _literals_ (`{42}` followed by raw bytes) are
  not parsed. Neither a greeting nor a `CAPABILITY` response may contain
  one.
- `requiredCapability` cannot be set from the monitor dialog yet, it
  travels through the API, an import, or an export/edit/import round
  trip.

## Where it lives

|            |                                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| Descriptor | `src/modules/monitors/types/catalog.ts` (`imapDescriptor`)                    |
| Spec       | `src/modules/monitors/types/specs/imap.ts`                                    |
| Probe      | `src/modules/monitors/types/probes/imap.ts`                                   |
| Tests      | `tests/unit/check-imap.test.ts`, `tests/integration/monitor-imap-ftp.test.ts` |

The unit suite dials a real IMAP server on loopback, a scripted
`net.createServer`, not a stubbed probe, so the socket, the read
boundaries, the parse and the hang-ups are all exercised by the tests.

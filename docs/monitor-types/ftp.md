# `ftp`: a file server greets, answers commands, and takes the account

Opens a TCP control connection to an FTP server, reads the greeting,
sends `FEAT`, and (when an account is configured) sends `USER` and
`PASS`. Then it quits. No data connection is ever opened.

|          |                                                         |
| -------- | ------------------------------------------------------- |
| Kind     | `active`: Vigil dials it on the monitor's interval     |
| Target   | a bare hostname, e.g. `files.example.com`               |
| Port     | required, defaults to **21**                            |
| Settings | `username`, `password` (both optional)                  |
| Secrets  | `password`                                              |
| Recovery | supported. The target can be re-probed to verify a fix |

## What it observes

| Fact             | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `greetingCode`   | the reply code the server opened with. 220 when it is ready |
| `banner`         | the greeting text, truncated to 200 characters               |
| `featCode`       | what it answered `FEAT` with, 211 when it listed features   |
| `features`       | the feature lines, when it listed any                        |
| `loginCode`      | the last reply of the login, when an account is configured   |
| `responseTimeMs` | greeting to last reply                                       |

## What makes it fail

| Verdict          | When                                                             |
| ---------------- | ---------------------------------------------------------------- |
| down             | the greeting is not 220-421 "too many users" above all         |
| down             | whatever answered on the port did not send an FTP reply          |
| down             | the server stopped speaking FTP after its banner                 |
| down             | an account is configured and the server did not answer 230       |
| degraded         | the exchange took longer than the monitor's degraded threshold   |
| down (transport) | the connection failed, timed out, or was closed mid-conversation |

Two of those are the reason this type exists rather than a `tcp` monitor
on port 21:

- **421 at the connection limit.** The server accepts the socket and then
  refuses everyone. A TCP check calls it healthy.
- **A banner with nothing behind it.** A proxy or load balancer in front
  of a dead backend prints a canned 220 and then answers nothing that
  parses. `FEAT` is what catches it: a _reply_, any reply, including
  `500 command not understood`: proves the server took a command and
  answered it.

A server too old for `FEAT` (RFC 2389 is an extension) answers 500 or 502. That is not a failure and does not affect the verdict.

### The account

`username` alone is enough for a server that grants anonymous access;
`password` is sent only when the server answers 331. A refusal is
recorded as a fact and judged, never returned as a transport error, an
operator whose credentials expired must not be told their file server is
unreachable.

If the server asks for a password and none is stored, the check reports
"The server asked for a password and none is configured" rather than
sending an empty one, which would come back as a 530 that reads like a
wrong password.

## Limitations

- **The password travels in the clear.** FTP has no other way, and this
  type never issues `AUTH TLS`. Point it at an account that can list a
  directory and nothing else. The credential is stored like any other
  monitor setting: masked out of the edit dialog and out of exports,
  never included in an incident email, a webhook body or a status page.
- **Plaintext only.** **Port 990 (implicit FTPS) will never answer this
  probe**, it expects a TLS handshake before the first byte of FTP. Use 21. What this type reports is that the server is listening and talking,
  not that its TLS is healthy; put a `tls-expiry` monitor on the same
  host for that.
- **Control connection only.** No `PASV`, no `PORT`, no `LIST`, so
  nothing here proves a transfer would succeed. A monitor that opened a
  data channel every interval would need a firewall exception on both
  sides and would eventually be blamed for exhausting the server's
  passive port range.
- A CR or LF in the username or password is refused at validation: both
  values are written onto a line-oriented protocol verbatim, so a line
  break would append a command of the author's choosing to the session.
- **The feature list is truncated at 32 entries** and the banner at 200
  characters. Both are written to the check history on every check.
- The account cannot be set from the monitor dialog yet, it travels
  through the API, an import, or an export/edit/import round trip.

## Where it lives

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Descriptor | `src/modules/monitors/types/catalog.ts` (`ftpDescriptor`)                    |
| Spec       | `src/modules/monitors/types/specs/ftp.ts`                                    |
| Probe      | `src/modules/monitors/types/probes/ftp.ts`                                   |
| Tests      | `tests/unit/check-ftp.test.ts`, `tests/integration/monitor-imap-ftp.test.ts` |

The unit suite dials a real FTP control server on loopback, a scripted
`net.createServer`, not a stubbed probe. It includes the case that
separates FTP's reply format from SMTP's: RFC 959 §4.2 lets the middle
lines of a multi-line reply carry no code at all, which is what a
multi-line FTP banner usually is, and a reader borrowed from the SMTP
probe would end the greeting on the wrong line.

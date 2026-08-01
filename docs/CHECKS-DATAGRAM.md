# The datagram checks: `udp`, `ntp`, `radius`

Three check types speak UDP. They share a transport, and they share the
thing that makes UDP different from every other check in Vigil: there is
no handshake to succeed. A TCP connect that completes is proof something
is listening. A datagram that is sent is proof only that the kernel
accepted it.

So all three send something the far end is obliged to answer, and all
three treat the **reply** as the evidence. What follows is what each one
sends, what it judges, and — more usefully — what it cannot tell you.

| Type     | Sends                        | Default port    | Credentials             |
| -------- | ---------------------------- | --------------- | ----------------------- |
| `udp`    | a payload you write          | none — required | none                    |
| `ntp`    | a 48-byte SNTP client packet | 123             | none                    |
| `radius` | an Access-Request            | 1812            | shared secret + account |

---

## What is true of all three

**Silence is ambiguous, and is reported as silence.** A lost datagram, a
firewall that drops rather than rejects, and a service that will not
answer this particular payload are indistinguishable from the outside.
The check reports `No reply within 5000ms` and does not guess which
happened.

**A closed port usually — not always — says so.** A host with nothing
bound to the port answers with ICMP port unreachable, which Vigil reports
as `Nothing is listening on 5514/udp`. That message is a gift, not a
guarantee: plenty of firewalls suppress ICMP, and then a closed port is
indistinguishable from a silent one.

**Replies are filtered by source and by content.** The probe's socket is
connected, so the kernel discards datagrams from anything but the server
being watched, and each type additionally checks that the _payload_
answers the request it made — NTP by the timestamp the server echoes
back, RADIUS by the request identifier and the reply's signature. Without
that second test, a late reply to the previous check is measured as this
one's answer.

**Targets are hostnames.** Same rule as every other check type: no
scheme, no port in the field, no IP literal. The name is resolved once
for the egress guard and once to choose the socket family, which means
these checks carry the same residual every socket-based probe in Vigil
does — a name that resolves to a public address for the guard and a
private one a moment later. `SECURITY.md` records it; closing it means
pinning an address through every probe.

**The monitor form does not render these types' settings yet.** The
target and the port are asked for; the payload, the clock tolerance and
the RADIUS credentials are set through the API or an import. Every one of
them has a default, so a monitor created in the form is valid — see the
per-type notes for what that default actually watches.

---

## `udp` — send a datagram, expect a reply

The generic one. You supply the payload; the check reports what came
back.

| Setting            | Default | Meaning                                                              |
| ------------------ | ------- | -------------------------------------------------------------------- |
| `payload`          | `""`    | Sent verbatim.                                                       |
| `payloadEncoding`  | `text`  | `text` or `hex` — how the payload _and_ the expected reply are read. |
| `expectedResponse` | none    | A substring the reply must contain.                                  |

Facts: reply size, a printable preview of the first 120 bytes, whether
the reply matched, and the round trip. The only assertion is the content
match, and it is only made when you have asked for one — a monitor with
no expectation is judged on "something answered, fast enough", which is
the UDP equivalent of a TCP port check.

**Limitations**

- **The default payload is empty.** A zero-length datagram is legal and
  some services answer it; most do not. A `udp` monitor created with no
  payload will usually report `No reply` — that is the check working, and
  it is why the payload is the first thing to set.
- **Payloads are capped at 1024 bytes**, well under a typical MTU. A
  larger datagram fragments, and a fragmented probe measures the
  network's willingness to reassemble it rather than whether the service
  answers.
- **Matching is a substring, not a parse.** For a binary protocol write
  both sides as hex (`00ff2a`, whitespace ignored); the reply is then
  matched against its own hex.
- **The reply preview is stored.** It goes in the check ledger and can
  appear in an incident. Do not point this at an endpoint whose reply
  contains a secret.

## `ntp` — ask a time server for the time

Sends a version 4 SNTP client packet and reads the four timestamps that
make up an NTP measurement: when we sent, when the server received, when
it replied, when we received.

Facts: stratum, leap indicator, clock offset, round-trip delay, the
reference identifier (`GPS` for a stratum-1 clock, the upstream server's
address above that), and the round trip.

Judged down when the server says it is not synchronised — leap indicator
3, or stratum 16. Judged degraded when the clock offset exceeds
`maxOffsetMs` (default 1000).

**Limitations**

- **The offset is measured against the machine Vigil runs on.** It says
  the two clocks disagree, never which of them is wrong. That is exactly
  why a large offset is _degraded_ and never _down_: a monitoring host
  whose own clock has drifted would otherwise page for every time server
  in the world at once, which looks like a global outage and is not. Run
  a time daemon on the Vigil host and keep this check honest.
- **A kiss-o'-death is reported as misconfigured, not as an outage.** A
  server answering `RATE` is telling us the check interval is faster than
  its policy allows; `DENY` and `RSTR` mean the client is not welcome.
  The server is healthy in all three cases. Raise the interval, or ask
  the operator of the server.
- **Point it at a server, not a pool.** `pool.ntp.org` answers from a
  different machine every check, so a bad member is invisible in the
  average and a good one alternates with it.
- **No NTS, no symmetric-key authentication.** The reply is unsigned,
  so what this check proves about a _public_ time source is that
  something on the path answered with a plausible time.
- **Era 0 only.** NTP's 32-bit second count wraps in February 2036.
- **Not measured:** root delay, root dispersion and jitter, which are
  what an NTP client uses to decide whether an answer is worth believing.
  This check reports the answer, not its own confidence in it.

## `radius` — authenticate, and check the answer's signature

Sends an Access-Request for a configured account and reads the reply. The
reply's Response Authenticator is verified against the shared secret,
which is what makes the rest of the packet worth reading at all.

| Setting         | Default         | Meaning                                            |
| --------------- | --------------- | -------------------------------------------------- |
| `secret`        | none            | The shared secret. **Required to check anything.** |
| `username`      | `vigil-monitor` | The account to authenticate as.                    |
| `password`      | `""`            | Its password, encrypted per RFC 2865 §5.2.         |
| `nasIdentifier` | `vigil`         | What the request calls itself.                     |
| `expectAccept`  | `false`         | Whether only an Access-Accept counts as healthy.   |

Facts: the reply code and its name, whether the signature verified, and
the round trip.

By default **any signed answer is healthy**, including an Access-Reject:
a rejection proves the server read the packet, verified the shared
secret, consulted its user store, and made a decision. That is the usual
way to monitor RADIUS — with credentials that are meant to fail. Set
`expectAccept` when the account is a real test account, where a rejection
means the directory behind the server has stopped answering.

The request carries a Message-Authenticator (RFC 3579 §3.2). FreeRADIUS
3.2.5 and later can be configured to require one — the BlastRADIUS
mitigation, CVE-2024-3596 — and a request refused for its absence is
dropped silently, which would arrive here as an outage that is not one.

**Limitations**

- **No secret, no check.** A monitor without one reports `misconfigured`
  and sends nothing. It is deliberately not `down`: an unfilled field
  must never look like an outage.
- **A reply that does not verify is misconfigured, not down.** The
  server answered, so it is alive; what is wrong is the stored secret, or
  something else is answering on that port. Reporting it as down would
  name the wrong fault, and reporting it as up would trust a packet
  anything on the path could have written.
- **The secret and the account password are stored like any other
  monitor setting.** They are masked in the UI, in exports and in the
  API, and they are not encrypted at rest. Use a dedicated account with
  no privileges beyond being authenticated.
- **RADIUS is MD5, by protocol.** The password cipher and the reply
  signature are defined in terms of it (RFC 2865 §5.2, §3), so this is
  not a choice a client gets to make. It is why RADIUS must not cross a
  network you do not trust — a property of the protocol, reported
  honestly rather than papered over.
- **Authentication only.** Port 1812 (or 1645 on older kit). RADIUS
  accounting on 1813 is a different exchange and is not implemented.
- **PAP only.** The check sends User-Name and User-Password. It does not
  speak CHAP, MS-CHAP or EAP, so a server whose policy refuses PAP will
  answer Access-Reject — which, with the default `expectAccept: false`,
  is still read as "the server is alive".
- **An Access-Challenge counts as alive.** It is a server mid-EAP asking
  for more, and the conversation is not continued.

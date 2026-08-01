# `ldap` and `ssh`: two protocol checks that speak for themselves

Both of these answer a question a TCP check on the same port cannot. A
socket that opens proves a kernel accepted a connection; it does not
prove a directory can still reach its database, or that `sshd` is behind
the systemd socket unit that just accepted on its behalf. Each of these
types exchanges the smallest amount of protocol that separates the two,
and then stops.

---

## `ldap` — one simple bind

Vigil connects, sends a BER-encoded `BindRequest` (RFC 4511 §4.2), reads
the `BindResponse`, and unbinds. No search follows it, so the check costs
the directory one authentication and no index work, however often it
runs.

**What it observes**

| Fact                | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `bindResponse`      | The peer answered with a bind response at all      |
| `resultCode`        | The LDAP result code (0 is `success`)              |
| `resultMessage`     | That code in words                                 |
| `diagnosticMessage` | The server's own text, truncated to 200 characters |
| `responseTimeMs`    | Connect, bind and answer                           |

**When it is down**

- Nothing answered as a directory — the wrong port, a TLS listener, a
  proxy in front of a dead backend.
- The bind was refused. **Any** non-zero result code is down, including
  `invalidCredentials`: a directory that will not let the application in
  is an outage for that application, whatever it is doing for everyone
  else.

A refusal is never reported as a transport error. `invalidCredentials`
means the directory is running, answering, and saying no — and "wrong
password" must never be indistinguishable from "unreachable" on a
timeline. Active Directory's real reason arrives in
`diagnosticMessage`, where `data 52e` (bad password) and `data 532`
(expired password) are different incidents with different fixes.

**Settings**

| Field          | Meaning                                             |
| -------------- | --------------------------------------------------- |
| `bindDn`       | The DN to bind as. Empty binds anonymously.         |
| `bindPassword` | The simple-bind password. **A secret** — see below. |

A password with no DN is refused at the form: RFC 4511 §4.2 carries the
credential _for_ a name, so a directory handed one without a name
compares it against an anonymous bind and answers `success` — a green
monitor whose password is being ignored.

A DN with no password is allowed, and that is deliberate. It is the
_unauthenticated bind_ of RFC 4513 §5.1.2, which servers refuse — and it
is exactly the shape an **imported** monitor arrives in, because the
export masked the credential and the importer strips the mask rather
than writing it. The monitor is created, reports
`The directory refused the bind: Invalid credentials`, and the import
report names `bindPassword` in `secretsToReenter`. Refusing the shape
instead would have dropped the monitor altogether: a check that fails
loudly is worth more than one that does not exist.

`bindPassword` is declared in the spec's `secretFields`, which is what
makes it masked in everything the server renders, replaced by
`__vigil_unchanged_secret__` in an export, and dropped rather than
written on import. The bind **DN** is not masked: it is an identity, not
a credential, and an operator has to be able to see which account the
check binds as. It is kept out of `describeTarget` all the same — an
incident email and a public status page are no place to name the service
account Vigil authenticates with.

### Limitations

- **Plaintext only.** No StartTLS and no LDAPS. Port 636 expects a TLS
  handshake before the first BER byte, so it will never answer this
  probe; use 389, or 3268 for an Active Directory global catalog. What
  the check reports is that the directory is answering, not that its TLS
  is healthy — put a `tls-expiry` monitor on 636 for that.
- **A bind, not a search.** It cannot tell you that a particular subtree
  is readable or that replication is current. A directory that binds and
  then fails every search reads as up here.
- **Simple authentication only.** No SASL, no GSSAPI, no client
  certificates. A directory configured to require any of those answers
  `strongerAuthRequired` or `inappropriateAuthentication`, and Vigil
  reports that refusal honestly rather than pretending to satisfy it.
- **One authentication per interval.** A directory with lockout policies
  counts failures: point the monitor at a service account, and expect a
  wrong password to lock that account out the way any other client
  would.

---

## `ssh` — the version banner, and nothing else

RFC 4253 §4.2: an SSH server sends `SSH-2.0-OpenSSH_9.6p1 Debian-3` as
soon as it accepts, before any key exchange. Vigil reads that line and
hangs up. It writes **nothing** — not even its own identification
string, which would start a Diffie-Hellman the monitored host has to pay
for every interval and which proves nothing the banner has not already
proved.

**What it observes**

| Fact              | Meaning                                         |
| ----------------- | ----------------------------------------------- |
| `identified`      | The peer sent an SSH identification string      |
| `protocolVersion` | `2.0`, or `1.99` on something very old          |
| `softwareVersion` | `OpenSSH_9.6p1`, `dropbear_2022.83`             |
| `banner`          | The whole line, bounded by §4.2's own 255 bytes |
| `responseTimeMs`  | Connect to greeting                             |

**When it is down**

- Nothing identified itself as SSH: a web server on the port, a proxy in
  front of a daemon that is gone, or a host that accepts and hangs up —
  which is what one over `MaxStartups` does.
- The banner does not contain the expected text, when one is configured.

**Settings**

| Field            | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `expectedBanner` | Substring the banner must contain. Empty asserts nothing. |

`OpenSSH_9` catches the rollback that put the old build back on a
bastion; `Debian` catches the failover that quietly moved the service to
a different image. Leave it empty and the check asserts only that
something answering SSH is there, which is the right assertion for most
hosts: one that stops answering is the outage whatever version it ran.

### Limitations

- **It never authenticates, and never will.** No key, no password, no
  `publickey` attempt. That is the design: an SSH check that logged in
  would need a credential on the monitoring host, and the monitoring
  host would become a credentialed foothold on every machine it watches.
  This type therefore holds no secrets at all — an exported `ssh`
  monitor arrives in another tenant complete and immediately working.
- **The banner is printed early.** `sshd` writes it after forking and
  accepting, so a daemon that is refusing every key, serving a broken
  host key, or out of PAM sessions still greets this probe cheerfully.
  It answers "is the daemon accepting and talking", which is strictly
  more than a TCP check on 22 can answer and strictly less than a login.
- **Every check is a line in the auth log.** `sshd` records
  `Connection closed by <ip> port <n> [preauth]` for each one. On a
  60-second interval that is 1,440 lines a day per monitor. The probe
  closes with a FIN rather than a reset, precisely so those lines read
  as closures and not as the `Connection reset by` an intrusion-detection
  rule counts — but a rule that counts pre-auth disconnects at all will
  still see them. Allow-list the monitoring host.
- **Banner text is not a version guarantee.** `DebianBanner no` and any
  number of hardening guides remove or rewrite it, and nothing stops a
  host from lying. `expectedBanner` catches accidents, not adversaries.

---

## What both types share

They dial their own sockets, so both go through the egress guard in
`src/modules/monitors/types/probes/guard.ts`: a hostname that passes the
form can still resolve into private space by the time the worker runs,
and the metadata endpoint is refused whatever
`ALLOW_PRIVATE_MONITOR_TARGETS` says. The residual DNS-rebinding window
that applies to every socket-opening probe applies to these two as well,
and is written down in `SECURITY.md`.

Neither probe judges anything. Each returns facts and, at most, a
transport error; "the bind was refused" and "the banner is the wrong
version" are assertions declared in the spec and evaluated by the shared
condition engine, which is what makes a stored observation
re-judgeable later against a different spec version.

### Setting the fields the dialog does not render yet

`bindDn`, `bindPassword` and `expectedBanner` are validated, stored,
merged, masked, exported and imported like any other type's settings,
but the monitor dialog does not draw an input for them — it renders the
shared sections a type declares (`port`, here) and nothing else. Until
it does, they are set the way `redis`' password and `mqtt`'s credentials
have been set since 1.12.0: through the monitor API, or by importing a
file that carries them.

```json
{
  "format": "vigil.monitors",
  "version": 1,
  "exportedAt": "2026-08-01T00:00:00.000Z",
  "monitors": [
    {
      "name": "Directory (EU)",
      "checkType": "ldap",
      "url": "ldap.example.com",
      "port": 389,
      "method": "GET",
      "intervalSeconds": 60,
      "timeoutMs": 10000,
      "degradedThresholdMs": 3000,
      "expectedStatusCode": null,
      "bodyKeyword": null,
      "keywordAbsent": false,
      "tlsCheck": false,
      "tlsWarnDays": 14,
      "failureWindowSeconds": 120,
      "paused": false,
      "config": {
        "bindDn": "cn=vigil,ou=service,dc=example,dc=com",
        "bindPassword": "the-service-account-password"
      }
    }
  ]
}
```

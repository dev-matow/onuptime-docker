# SQL Server and Oracle: what these two checks really watch

Both of these types speak their database's wire protocol directly, with
no driver. That is the same trade the MySQL, MongoDB, Redis and MQTT
checks already make. Vigil ships one database client, for the database
it cannot avoid, but for these two it also decides how far each check
can go. This page says exactly how far, because a monitor that watches
less than you think it does is worse than no monitor at all.

|              | `sqlserver`                                    | `oracledb`                                |
| ------------ | ---------------------------------------------- | ----------------------------------------- |
| Target       | `sqlserver://user:password@host:1433/database` | `oracle://host:1521/SERVICE_NAME`         |
| Also accepts | `mssql://`                                     | `oracledb://`                             |
| Signs in     | yes, with SQL authentication                   | **no**                                    |
| Runs a query | `SELECT 1`                                     | no                                        |
| Credentials  | in the connection string                       | refused                                   |
| Port         | from the connection string (1433 default)      | from the connection string (1521 default) |

---

## `sqlserver`: greet, sign in, run a query

The check is three round trips of TDS:

1. **PRELOGIN.** The server answers with its version and with what it
   expects about encryption. A well-formed answer already proves more
   than a TCP connect on 1433 does: something there is framing TDS.
2. **LOGIN7.** The login and password from the connection string, and
   the database from its path. The `fDatabase` flag is set to _fatal_,
   so a database that is offline, suspect, restoring or gone fails the
   login rather than dropping the session into `master`. That is
   deliberate: "the application's database is unavailable" is an outage,
   and a check that stopped at the greeting would report it as healthy.
3. **`SELECT 1`.** A server that has exhausted its worker threads, or is
   still recovering, accepts a login and then answers nothing. The
   smallest query there is separates that from a healthy one, and costs
   the monitored server nothing.

### The limitation: the login is plaintext

TDS obfuscates the password with a fixed nibble swap and an XOR. That is
not encryption, and it is not meant to be. Real secrecy comes from TLS
negotiated _inside_ the PRELOGIN exchange, which is a TLS handshake
tunnelled through TDS packets rather than a flag. Vigil's probe does not
implement that tunnel, so it asks for `ENCRYPT_NOT_SUP` and requires the
server to agree.

When the server does not agree, the check stops after the greeting:

- `encryptionRequired` becomes `true`,
- `loginOk` and `queryOk` are recorded as **unknown**, not as failures,
- the login and query assertions have no opinion, so the monitor is
  judged on the greeting and its latency alone.

Reporting such a server as down would be reporting on Vigil rather than
on the server. Servers that behave this way:

- **Azure SQL Database and Azure SQL Managed Instance**, always.
- Any SQL Server with **Force Encryption** turned on in Configuration
  Manager.
- A server answering `ENCRYPT_OFF`: which despite the name means
  "encrypt the login packet and nothing after it", and needs the same
  handshake.

For those, the monitor is a TDS greeting check. Pair it with something
that watches the application's own health endpoint, or run Vigil where
it can reach a server that permits a plaintext login.

### What it costs the server

One login and one trivial query per interval. SQL Server records the
login in its default audit ("Login succeeded for user…" every check, at
the default `Failed and successful logins` setting), which at a 60-second
interval is 1,440 rows a day in the error log. Either turn the audit down
to failed logins only, or lengthen the interval. The check is not more
useful at 60 seconds than at 300.

The check names itself: `program_name` is `vigil` in
`sys.dm_exec_sessions`, so a DBA who finds the connections can tell what
they are.

### The login to point it at

Nothing but `CONNECT`. The query is `SELECT 1`, which needs no
permission on any object:

```sql
CREATE LOGIN vigil WITH PASSWORD = '…';
CREATE USER vigil FOR LOGIN vigil;   -- in the database you name in the URL
-- and nothing else. No db_datareader, no VIEW SERVER STATE.
```

The connection string is stored like any other monitor setting and is
readable by anyone who can edit the monitor, so this login should be
able to connect and do nothing else. It never appears in an incident
email, a webhook body or a status page: `describeTarget` prints
`host:port/database` and the export format carries the target verbatim
only inside the file an operator downloads.

### Facts

| Fact                 | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `preloginOk`         | The server answered a TDS PRELOGIN. False means whatever is on that port is not SQL Server. |
| `serverVersion`      | From the greeting, e.g. `16.0.4085`. Available even when the login cannot be attempted.     |
| `encryptionRequired` | The server would not accept a plaintext login. See above.                                   |
| `loginOk`            | The credentials and the database were accepted. Unknown when encryption is required.        |
| `queryOk`            | The server ran `SELECT 1` and returned a row.                                               |
| `serverError`        | The server's own words for a refused login or a failed batch.                               |
| `responseTimeMs`     | The whole conversation, connect included. The degraded threshold applies to this.           |

---

## `oracledb`: ask the listener for the service

This check sends one TNS connect request and reads the answer. It does
**not** sign in and it runs no query, and that is a dependency decision
rather than an oversight: Oracle's login is O5LOGON, a session-key
exchange, an AES-encrypted verifier and a data-type negotiation phase,
and the only practical shortcut is `node-oracledb`, a native addon whose
thick mode additionally wants Oracle Instant Client installed on the
host. Neither belongs in a container whose pitch is two processes and a
Postgres. So the check is the one that fits on the wire, and this page
is where it says so rather than implying more.

**What it proves is still the useful part.** A TCP check on 1521 proves
the listener process is alive, which is the least interesting thing about
an Oracle deployment. A listener answers `ACCEPT` only when an instance
has registered the service you named _and_ has a handler free for it. The
failures that answer `REFUSE` on a port a TCP check finds perfectly
healthy are the everyday ones:

| Code                  | What it means                                                                           |
| --------------------- | --------------------------------------------------------------------------------------- |
| ORA-12514             | The service is not registered. The instance never came up, or is not the one you named. |
| ORA-12505             | Same, for a SID rather than a service name.                                             |
| ORA-12516 / ORA-12520 | The listener has no free handler of the right kind.                                     |
| ORA-12518             | The listener could not hand the connection off.                                         |
| ORA-12528             | Every instance is blocking new connections (a database still opening).                  |

Vigil reports the code _and_ Oracle's own wording for it, and the server
version the listener volunteers in the refusal, so the incident email
says which repair is needed rather than a bare number.

### What it costs the database

On Linux a listener hands a dedicated connection to a freshly spawned
server process, so an accepted request creates a process that this probe
then abandons; the connection also appears in `listener.log`. That is the
same cost as any connection attempt from any client, and it is why the
connect descriptor names itself:

```
(CID=(PROGRAM=vigil)(HOST=vigil)(USER=vigil))
```

A DBA reading the listener log can see what keeps connecting. It is also
why the interval is worth thinking about: at 60 seconds this is 1,440
spawned-and-dropped server processes a day.

### The target refuses credentials

`oracle://system:password@host:1521/SERVICE` is rejected with a message
saying so. This check never signs in, so a password in the target would
be a secret stored in the database, carried into every export and never
sent anywhere. Refusing it costs one edit; keeping it would cost a
credential.

`describeTarget` still strips a `user:password@` if one ever reaches a
row. The schema could be relaxed by someone who never reads the
redaction code, and a row can arrive from a build that had a different
rule.

### Service names, not SIDs

The path is a **service name**. A SID-only database, no service
registered, `(SID=ORCL)` in every client's `tnsnames.ora`. Cannot be
named here; use the service name the instance registers (by default the
database name, sometimes with a domain: `ORCL.example.com`). The name is
restricted to letters, digits, `.`, `_` and `-`, because it is
interpolated into `(CONNECT_DATA=(SERVICE_NAME=…))` and a parenthesis in
it would not be a bad name, it would be a different request.

### Facts

| Fact               | Meaning                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listenerAnswered` | A well-formed TNS packet came back. False means whatever is on that port is not an Oracle listener.                                                                                          |
| `accepted`         | The listener accepted a connection for this service. A hand-off (REDIRECT) counts; it is never followed, because the address in it comes from the far end and the egress guard never saw it. |
| `listenerResponse` | `accept`, `redirect`, `refuse`, `resend`, or the raw packet type.                                                                                                                            |
| `serviceError`     | `ORA-12514: listener does not currently know of service requested…` and friends.                                                                                                             |
| `serverVersion`    | Decoded from the `VSNNUM` a listener puts in a refusal, so it is present exactly when things are going wrong.                                                                                |
| `responseTimeMs`   | Connect and answer. The degraded threshold applies to this.                                                                                                                                  |

---

## Both types

- **Egress.** Both resolve the host and refuse private, loopback,
  link-local and metadata addresses before dialling, exactly like every
  other socket-opening probe. `ALLOW_PRIVATE_MONITOR_TARGETS` widens the
  first two for development and never the last two.
- **Recovery.** Both support the recovery loop's verification probe:
  re-running them is cheap and side-effect free.
- **Import from Uptime Kuma.** Kuma's `sqlserver` and `oracledb`
  monitors both store a full connection string with credentials. The
  SQL Server one maps across whole. The Oracle one cannot keep its
  credentials (Vigil has nowhere to send them) so a host, port and
  service name is what carries.
- **Verified against a protocol fixture, not against a licensed
  server.** `tests/unit/check-sqlserver.test.ts` and
  `tests/unit/check-oracledb.test.ts` each stand up a server that frames
  real packets, decodes what the probe sent (down to reversing TDS's
  password obfuscation) and answers with a real token stream or a real
  TNS packet. Neither Microsoft SQL Server nor Oracle Database was
  available to the machine these were written on, so the wire formats
  come from MS-TDS and from TNS as documented and observed, and the
  fixtures are what proves the encoders and parsers agree.

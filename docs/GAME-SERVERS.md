# Game servers: the `steam` and `gamedig` check types

Two check types watch game servers, both over UDP, both by speaking the
wire protocol directly. This page says exactly what they can see, and —
more usefully — exactly what they cannot.

| Type      | Asks                             | Default port | Settings     |
| --------- | -------------------------------- | ------------ | ------------ |
| `steam`   | A2S_INFO, the Steam server query | 27015        | none         |
| `gamedig` | one of three query protocols     | none, ask    | the protocol |

They overlap on purpose: `steam` is the A2S query on its own, with the
Steam-specific facts (bots, VAC, the game the server is running);
`gamedig` is the same question asked in three dialects, with the facts
they all share. Uptime Kuma has the same two monitors for the same
reason, and an import from it needs both names to land somewhere.

---

## `steam` — A2S_INFO

One query, twenty-five bytes, and the reply a player's server browser
reads. Vigil sends it, parses it and records:

| Fact             | What it is                                        |
| ---------------- | ------------------------------------------------- |
| `answered`       | a readable A2S_INFO reply came back               |
| `serverName`     | the server's name, stripped of control characters |
| `map`            | the map it is running                             |
| `game`           | the game or mod, in the server's own words        |
| `players`        | players connected, bots included                  |
| `maxPlayers`     | slots                                             |
| `bots`           | of those players, how many are bots               |
| `vacSecured`     | whether VAC is on                                 |
| `responseTimeMs` | the round trip, challenge included                |

**What it judges.** Two things, and only two:

- **down** when something answers on the port and it is not an A2S_INFO
  reply. Silence is a transport failure instead — see below.
- **degraded** when the round trip is slower than the monitor's degraded
  threshold.

**What it deliberately does not judge.** A full server is not degraded.
A popular server is full every evening, and filing that as degraded
spends the amber state on the server's best hours and drags its uptime
figure down for succeeding. The player counts are recorded as facts and
shown on the monitor's page; they do not get to decide anything. The
current map is not asserted on either, for the same reason: maps rotate,
and a monitor that pages when the server does the thing it exists to do
is a monitor people turn off.

**The challenge.** Since December 2020 a Source server answers an
unchallenged A2S_INFO with a four-byte token and expects it echoed back
— the fix for an amplification attack that used game servers as
reflectors. Vigil does the round trip automatically and includes it in
the measured response time, because a player's client pays for it too.
Older GoldSrc servers answer the first query outright; both work, and
which happened is not reported, being a property of the server's build
date rather than of its health.

---

## `gamedig` — three protocols, not three hundred games

The id is `gamedig` because that is what Uptime Kuma calls this monitor
and what an import carries across. **It is not the GameDig library.**

GameDig ships a table of roughly three hundred game ids. Almost every
one of them resolves to a handful of wire protocols; what the table
really holds is which port and which quirk each title uses. Vigil speaks
three of those protocols and does not have the table.

| Protocol    | Query          | Conventional port | Covers                                                                                         |
| ----------- | -------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `source`    | A2S_INFO       | 27015             | every Source and GoldSrc title: CS, TF2, Garry's Mod, Rust, ARK, Valheim, L4D                  |
| `minecraft` | GameSpy4 query | 25565             | Minecraft Java Edition, with `enable-query=true`                                               |
| `quake3`    | `getstatus`    | 27960             | id Tech 3 and its descendants: Quake III, Call of Duty ≤4, Wolfenstein: ET, OpenArena, Xonotic |

Facts are the four every protocol can answer — `answered`,
`serverName`, `map`, `players`, `maxPlayers` — plus `responseTimeMs`.
The assertions are the same two `steam` makes.

### Why the library was not taken as a dependency

- **It dials its own sockets.** Every probe in Vigil resolves its target
  through the egress guard before connecting, precisely so a
  domain-validated target cannot be walked into `10.0.0.1` or the cloud
  metadata endpoint. A dependency that resolves and connects on its own
  is an SSRF hole with a pleasant API.
- **It would be the first monitor dependency.** Fourteen types already
  speak their protocols by hand; the product ships as two processes and
  a Postgres, with no broker and no driver except `pg`.
- **The three queries are ninety lines of wire format between them.** A
  dependency that large would be bought for a lookup table.

### What that costs you

A game whose server speaks something else cannot be watched with this
type. Named explicitly, because "gamedig" implies otherwise:

- **Minecraft Bedrock** (RakNet unconnected ping) — not supported.
  Bedrock and Java are different protocols on different ports.
- **Minecraft's TCP server-list ping** — not used. Vigil asks the UDP
  query port, which the server only opens when `enable-query=true` is
  set in `server.properties`. A server without it is healthy and
  completely silent, and Vigil will report a transport failure every
  interval. Set the property, or watch the game port with a `tcp`
  monitor instead.
- **GameSpy 1/2/3** (Unreal, UT2004, Battlefield 1942, older ARMA),
  **Ventrilo**, **TeamSpeak 2/3**, **Mumble**, **Nadeo/Trackmania**,
  **SA-MP**, **Terraria**, **Frostbite RCON**, **Discord** — not
  supported.
- Anything else GameDig's table names and these three protocols do not
  cover.

If you need one of those, a `tcp` monitor on the game port still tells
you the process is listening. It will not tell you the server is
answering players, which is the difference this type exists for.

### Choosing the protocol

The protocol is stored in the monitor's config as
`{"protocol": "source" | "minecraft" | "quake3"}`. **The monitor form
does not render a picker for it yet**, so a monitor created in the UI
queries `source`; a monitor created by import or through the API queries
whatever it was given. The same is true of several types added in this
release, and it is a gap in the form rather than in the type. Until the
form grows the field, a Minecraft or Quake III monitor is created by
importing an export file with the protocol set.

The port is required and has no default, because the right one is a
property of the protocol rather than of the type. Guessing 27015 would
be wrong for two thirds of the servers this watches.

---

## Limitations that apply to both

- **IPv4 only.** The query goes out on a `udp4` socket. A game server
  reachable only over IPv6 cannot be watched.
- **One retransmit.** UDP is allowed to lose datagrams, and a monitor
  that reported the internet's ordinary loss as downtime would be
  useless. Vigil sends the query again half way through the timeout and
  takes whichever reply arrives first. Both attempts — and, for
  Minecraft and the A2S challenge, both round trips — share one absolute
  deadline, so a monitor never spends more than its timeout.
- **Silence is a transport failure, not a failed assertion.** "No reply
  within 5000ms" is Vigil saying it could not measure. A datagram that
  arrives and cannot be read is the opposite: something is listening on
  that port and it is not the server you meant, which is nearly always
  the wrong port or the wrong protocol, and the monitor says so.
- **A multi-packet A2S reply reports `unknown`, never `down`.** Vigil
  does not reassemble split replies — that would mean packet ids,
  ordering and bzip2 payloads on the older engines, for a case A2S_INFO
  does not produce in practice. If it ever happens, the monitor reports
  "not measured" with that sentence, because a limitation of Vigil's
  that read as an outage would be a page at 3am for a server that is
  running perfectly.
- **No credentials, anywhere.** None of these queries authenticates —
  that is what makes them usable by a server browser. Neither type
  stores a secret, so neither has anything to mask in an export, in a
  webhook body or in the edit form.
- **What is not read.** From an A2S reply, everything after the VAC
  byte: the version string, the extra-data block, and The Ship's extra
  fields. Nothing asserts on them, and a parser that walks them is a
  parser a game nobody here has can break. From a Minecraft reply, the
  full stat (plugins, player names, version) — the basic stat answers
  the question. From a `getstatus` reply, the player names and scores:
  the count is what matters and the names are somebody's chat handle.
- **Server names are printed as the server chose them,** minus control
  characters and truncated at 80 characters. They reach incident emails,
  CSV exports and public status pages, and every byte was chosen by the
  far end.

## Not yet mapped from Uptime Kuma

`docs/KUMA-IMPORT.md` still records `gamedig` and `steam` as "not
imported — Vigil has no game-server check type". That is out of date now
in principle, but the importer mapping has not been rewritten: Kuma's
`game` field is a game id, not a protocol, and turning three hundred ids
into three protocols is a table this release does not have. Until then,
those monitors are reported as skipped rather than imported into a check
that would query the wrong thing.

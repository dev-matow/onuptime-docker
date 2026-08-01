# `rabbitmq` — a node says whether its own health checks pass

Issues one authenticated `GET` against a RabbitMQ node's management API,
at `/api/health/checks/alarms`, and reads the answer.

|          |                                                                           |
| -------- | ------------------------------------------------------------------------- |
| Kind     | `active` — Vigil dials it on the monitor's interval                       |
| Target   | the management plugin's base URL, e.g. `https://rabbit.example.com:15672` |
| Port     | none — it is already in the URL                                           |
| Settings | `username`, `password` (both optional, in practice required)              |
| Secrets  | `password`                                                                |
| Recovery | supported — the target can be re-probed to verify a fix                   |

## Why the management API and not AMQP

A node with a memory or disk alarm in effect still accepts AMQP
connections. It accepts them and then blocks every publisher on them,
which is exactly the outage worth paging about — and a check that opened
a connection would be green for the whole of it. `/api/health/checks/alarms`
is the node asking itself the question and answering in one round trip.

The path is fixed rather than configurable. A settable path would turn a
check with one meaning into a small HTTP client whose meaning depends on
what somebody typed, and `json-query` already exists for that.

`checks/alarms` is deliberately the node-local check. The cluster-wide
ones (`virtual-hosts`, `port-listener`) answer for peers as well, so
three monitors on three nodes would all go red for one node's alarm and
nobody could tell which node to look at.

## What it observes

| Fact             | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `statusCode`     | what the management API answered — 200 pass, 503 fail                                          |
| `alarmsClear`    | true when the node reported a passing health check                                             |
| `alarmReason`    | the node's own words, e.g. `resource alarm(s) in effect:[memory]` — null when the check passed |
| `responseTimeMs` | request to last byte of the answer                                                             |

## What makes it fail

| Verdict          | When                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| down             | the node answered 503, or a body saying `"status":"failed"`                                             |
| down             | any status code other than 200 or 503 — a 500 from the plugin, a 502 from a proxy in front of it, a 3xx |
| degraded         | the answer took longer than the monitor's degraded threshold                                            |
| down (transport) | the connection failed, timed out, or the body stopped arriving                                          |
| indeterminate    | 401 or 403 — the stored credentials were refused                                                        |
| indeterminate    | 404 — no health check at that path                                                                      |
| indeterminate    | 200 that is not a health-check document                                                                 |

The three `indeterminate` rows are the important ones. Each is Vigil
saying it could not make the measurement, and each would be a lie as
`down`: a rotated password, a management plugin nobody enabled and a URL
pointing at a login page are all operator errors, and an operator error
that is indistinguishable from an outage is the one failure a monitoring
product may not have.

## The credentials

RabbitMQ's management API authenticates every request, so in practice
this type needs a user — one with the `monitoring` tag, which can read
the health checks and nothing else:

```bash
rabbitmqctl add_user vigil 'a-long-password'
rabbitmqctl set_user_tags vigil monitoring
```

They are sent as HTTP Basic. A password with no user name is refused at
validation, because Basic has one field and a silently unsent password
comes back as a 401 that reads like the wrong one.

The password is stored like any other monitor setting: masked out of the
edit dialog, masked in exports, and never included in an incident email,
a webhook body or a status page. `describeTarget` also strips any
`user:password@` an operator pasted into the URL itself — a browser will
hand them one that has it.

## Limitations

- **Needs RabbitMQ 3.8.4 or newer.** The granular health checks arrived
  there. An older node answers 404, which reports as `indeterminate`
  with a message saying so, not as an outage.
- **Redirects are not followed.** A 3xx is reported as a failure with
  its status code. Following it would either drop the credential at the
  origin boundary — surfacing as a 401 that reads like a wrong password
  — or carry a broker credential to an origin the operator never typed.
  If your management UI redirects, point the monitor at the URL it
  redirects to.
- **HTTP Basic over plain HTTP sends the password in the clear.** Use an
  `https://` URL. Vigil will not stop you using `http://`, because a
  management API on a private network behind a VPN is a legitimate
  deployment.
- **One node per monitor.** The target is a single node's management
  API, so a three-node cluster is three monitors — which is the point:
  each one names the node that is in trouble. Roll them up with a
  `group` monitor if you want a single cluster state.
- **It does not check queues, consumers or vhosts.** Depth, consumer
  count and unroutable messages are application questions with
  application thresholds; `json-query` against `/api/queues/...` is the
  type for those.
- The credentials cannot be set from the monitor dialog yet — they
  travel through the API, an import, or an export/edit/import round
  trip. The same is true of the `redis` and `mqtt` passwords today.

## Where it lives

|            |                                                                                  |
| ---------- | -------------------------------------------------------------------------------- |
| Descriptor | `src/modules/monitors/types/catalog.ts` (`rabbitmqDescriptor`)                   |
| Spec       | `src/modules/monitors/types/specs/rabbitmq.ts`                                   |
| Probe      | `src/modules/monitors/types/probes/rabbitmq.ts`                                  |
| Tests      | `tests/unit/check-rabbitmq.test.ts`, `tests/integration/broker-monitors.test.ts` |

The unit suite starts a real HTTP server on loopback and points the probe
at it, so what is proved is that the probe builds a URL a node would
route, sends a credential a node would accept, and reads an answer a node
would give — including the case where the base URL is mounted under a
reverse proxy's path prefix, which an absolute-path join would silently
throw away.

Every request goes through `modules/monitors/egress.ts`, which resolves
and classifies the address before connecting and then connects to the
address it classified. That matters more here than for most types: the
request carries an Authorization header.

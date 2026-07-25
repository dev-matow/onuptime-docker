# Support

Vigil Core is free software maintained by one developer. Support is
best-effort and happens in the open.

## Check the documentation first

Most questions are answered here:

- [QUICK_START.md](QUICK_START.md) — install and run
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, managed platforms, bare metal
- [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) — branding, roles, common extensions
- [docs/UPGRADE.md](docs/UPGRADE.md) — taking updates after you customize
- [docs/HANDBOOK.md](docs/HANDBOOK.md) — commands, conventions, debugging
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together

## Asking a question

Open a [GitHub issue](https://github.com/artaspervyj-dotcom/vigil-core/issues).
To get a fast, useful answer, include:

- your Vigil Core version (see [CHANGELOG.md](CHANGELOG.md)),
- which process is affected — the app or the worker,
- the relevant log lines. Both processes emit structured JSON to stdout;
  set `LOG_LEVEL=debug` temporarily for check-level detail.

Security issues go to [SECURITY.md](SECURITY.md) instead — privately,
not in an issue.

## What to expect

Issues are read and triaged, but this is not a product with an SLA. Bug
reports with a reproduction get attention first; "how do I…" questions
are answered when time allows and often end up improving the docs.

If you need guaranteed response times, a hosted deployment, or features
that aren't here, the commercial edition is at
[vigil-uptime.com](https://vigil-uptime.com) — see
["What the commercial edition adds"](README.md#what-the-commercial-edition-adds)
in the README for the honest list of what's different.

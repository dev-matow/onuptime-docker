# Support

## Check the documentation first

Most questions are answered here:

- [QUICK_START.md](QUICK_START.md), install and run
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Docker, managed platforms, bare metal
- [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md), branding, roles, common extensions
- [docs/UPGRADE.md](docs/UPGRADE.md), taking updates after you customize
- [docs/HANDBOOK.md](docs/HANDBOOK.md), commands, conventions, debugging
- [ARCHITECTURE.md](ARCHITECTURE.md), how the pieces fit together

Every guide in the tree is indexed under **Documentation** in the
[README](README.md), grouped by what you are trying to do: install and
operate, what the product does, building on it, selling it.

## Before you buy

Questions about licensing, deployment or whether Vigil fits your case:
use [**the contact page**](https://vigil-uptime.com/contact.html), or
email s8kur3@gmail.com directly. See `COMMERCIAL.md` for
what a purchase includes.

## After you buy

Use the support channel on your purchase receipt. To get a fast, useful
answer, include:

- your Vigil version (see [CHANGELOG.md](CHANGELOG.md)),
- which process is affected: the app, the worker, or one of the two
  optional containers (the synthetics runner, a probe agent),
- the relevant log lines. Both processes emit structured JSON to stdout;
  set `LOG_LEVEL=debug` temporarily for check-level detail.

## What support covers

Support covers deploying and running Vigil **as shipped**: install,
configuration, migrations, Docker, and the documented features. It does
not cover your own modifications, your third-party infrastructure, or
custom features built on top. The documentation is written to make those
self-serviceable.

# Changelog — Vigil Core

Vigil Core and the commercial edition are cut from the same commit and
carry the same version number. This file records what that means for the
free edition; entries for commercial-only features live in the other
repository, because they are not in this one and listing them here would
describe software you do not have.

## 1.11.0 — 2026-07-28

**The first release generated from the shared tree**, and the reason the
version number jumps from 1.0.1: Core is no longer a hand-copy that has
to be kept up to date by remembering to. It is produced by deleting the
commercial code from the commercial tree, by the same script that runs in
that repository's build gate. If Core stops building, the release does
not exist.

### Added

- **Six check types behind a registry** — HTTP(S), TCP/port, ping (ICMP),
  DNS records, TLS-certificate expiry and domain-registration expiry.
  Adding one is five files and no dispatch to edit.
- **A condition engine** — assertions are typed and declared per check
  type, and a verdict is recomputable from the stored facts.
- **Adaptive scheduling** — the interval is a baseline the scheduler
  tightens on a suspicious monitor and relaxes on a steady one. The
  minimum is **2 seconds**, measured as what the queue delivers rather
  than what the form will accept.
- **Failure windows in seconds** rather than a count of consecutive
  checks, so "down for two minutes" survives a change of interval.
- **Many status pages per organization**, each with its own URL,
  components, visibility and subscribers.
- **Private and password-protected status pages.**
- **Double-opt-in email subscribers** on public pages, with one-click
  unsubscribe.
- **An audit page** — Core already recorded every mutation; it now has a
  screen to read them on.
- **The observation ledger** — hash-chained check history with per-actor
  sequences.
- **Incident acknowledgement.**

### Changed

- **Licence: AGPL-3.0-or-later → Apache-2.0** (from 1.0.2). No copyleft
  obligation: modify it, keep the changes private, run it for clients,
  sell it. Copies obtained under the AGPL remain available under it.

### Fixed

- **An organization was capped at 100 members**, from a library default.
  Two changes were needed and either alone leaves a wall; both are in.

### Upgrading from 1.0.x

1.0.x carried a single squashed migration that has been replaced by the
canonical lineage, so there is **no in-place upgrade path**. A 1.0.x
install is days old by construction; back up, start a fresh database,
migrate, and recreate your monitors. See [docs/UPGRADE.md](docs/UPGRADE.md).

## 1.0.1 — 2026-07-26

Public status page cache key now includes the slug.

## 1.0.0 — 2026-07-25

First public release: HTTP(S) monitoring with keyword assertions,
incidents, one public status page, four team roles and an audit trail.
Hand-copied from the commercial tree, which is the problem 1.11.0 fixes.

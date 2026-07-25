# Upgrade guide

How to take Vigil Core updates after you've customized your copy.

## The workflow

Treat this repository as an upstream remote:

```bash
git remote add vigil-upstream https://github.com/artaspervyj-dotcom/vigil-core.git
git fetch vigil-upstream

# Review what changed
git log --oneline HEAD..vigil-upstream/main
git diff HEAD...vigil-upstream/main --stat

# Merge (or rebase your changes onto the new version)
git merge vigil-upstream/main
```

Because customizations concentrate in predictable places (branding
files, `globals.css`, your own modules), merges stay small. The
architecture keeps upstream-heavy areas (`src/modules`, `src/worker`,
`src/db/schema`) separate from the areas you are likely to touch
(branding, `globals.css`, your custom routes).

## After every upgrade

```bash
npm install                # dependency changes
npm run db:migrate         # new SQL migrations apply in order
npm run typecheck && npm run lint && npm test
```

Database changes always ship as ordered files in `drizzle/` — never
edit an existing migration; upstream never rewrites one.

## Version policy

- Patch/minor updates: additive migrations, no breaking service
  signatures.
- Breaking changes (major): called out in the release notes with a
  migration section, and service-signature changes are listed
  explicitly.

## If a merge goes wrong

Your escape hatch is the service layer: as long as
`src/modules/*/service.ts` functions keep their `(db, actor, input)`
signatures, UI and worker from either side keep working. Resolve
conflicts there first, run the integration suite
(`npx vitest run tests/integration/`), then reconcile UI.

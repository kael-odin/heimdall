# Contributing

## Setup

This repository contains three separately installable projects:

```powershell
pnpm -C core install --frozen-lockfile
pnpm -C console install --frozen-lockfile
pnpm -C packages/mcp install --frozen-lockfile
pnpm -C core exec playwright install chromium
```

Use Node 22.13 or newer as recorded in `.node-version` and the pinned pnpm
version from `package.json`. If the bundled Corepack cannot verify the pnpm
release, upgrade Corepack or install pnpm 11.28.10 globally.

## Before opening a pull request

Run the normal local gate:

```powershell
pnpm check
```

For changes that affect capture, verification, acceptance, QA, or release
packaging, also run:

```powershell
pnpm test:full
pnpm acceptance:benchmark
pnpm qa:benchmark
```

Never weaken a verifier, gate, evidence hash, redirect policy, or test timeout
to manufacture a pass. Preserve failure evidence and state clearly whether a
result came from a real workflow, an isolated fixture, or source inspection.

## Security and privacy

Do not commit `.env` files, API keys, session state, raw HAR files, customer
data, or captured pages without redistribution permission. Report security
issues according to [SECURITY.md](SECURITY.md).

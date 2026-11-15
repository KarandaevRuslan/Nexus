# Contributing

Thank you for your interest in Nexus. The project maintains a small, explicitly checked public API and strict ownership boundaries between Core subsystems.

## Setup

Use Node.js >=22.16.0 and the committed npm lockfile:

```bash
npm ci
npm run typecheck
npm run test:all
npm run check:release
```

`check:release` inspects the **built** package and should run after `test:all` or `npm run build`.

## Code changes

- Place behavior in the existing owning subsystem (`state`, `transactions`, `reactions`, `scheduling`, `lifecycle`, or `diagnostics`); do not introduce another catch-all runtime folder.
- Keep Core independent of Frida, Java independent of IL2CPP, and the managed adapter Bridge-neutral.
- Update `scripts/check-architecture.cjs` and the architecture documentation **only when a new dependency is intentional**. Type-only imports are checked as well.
- Preserve the public exports and ownership semantics. Changes to commits, conflict policies, snapshots, `before/after`, or scheduling fairness need explicit tests and an explanation of the behavior change.
- Add tests for lifecycle teardown, rejection paths, and reentrancy. Do not delete tests just to obtain a green CI run.
- Avoid committing generated output, screenshots, binary images, agent reports, or environment secrets. Such media are ignored by default; use `git add -f` only after an explicit decision to include a particular asset.

## Frida changes

The CI Frida checks run on Node/mock environments; they do **not** prove real Native, Java, or IL2CPP compatibility. Document device/Bridge versions and actual results from the scenarios in [`scripts/e2e/README.md`](scripts/e2e/README.md) before describing a hardware-dependent change as verified.

See the [English architecture summary](ARCHITECTURE.md) and the [detailed architecture guidance](docs/ARCHITECTURE.md) for subsystem boundaries.

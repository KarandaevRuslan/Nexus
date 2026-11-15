# Changelog

This file records public-release-facing changes. Older internal development notes may be present in local source archives under `docs/history/`; they are intentionally not included in the release package.

## [Unreleased]

- No changes recorded yet.

## [0.1.20] - 2026-11-16

- Redesigned the English README with a centered logo, status badges, and a clearer guide to using the GitHub Release package.
- Added a dedicated Nexus PNG icon to the repository and release package; unrelated binary media remain ignored.
- Migrated the C AST and Dining Philosophers example apps to imports from the packed `nexus/core` entry point.
- Added packed-package consumer smoke tests to the regular validation suite.

## [0.1.19]

- Rename the GitHub-distributed npm package from `nexus-prototype` to `nexus`.
- Update package self-reference tests, examples, and installation instructions to use `nexus/core` and `nexus/frida`.
- No runtime API or behavior changes; this is a package naming change only.

## [0.1.18]

- The existing transactional Core and optional Native, Java, and IL2CPP adapters retain their CommonJS public entry points.
- Core implementation is organized into independently owned state, transaction, reaction, scheduling, lifecycle, and diagnostics subsystems.
- Architecture checks, API export checks, integration tests, and agent mock smoke tests are part of the release gate.
- GitHub distribution now includes a minimal npm-installable tarball built from the public compiled library; generated demo agents are excluded.

> Device-level Frida tests are manual and are **not claimed to have passed**.

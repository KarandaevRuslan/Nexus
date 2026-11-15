# Changelog

This file records public-release-facing changes. Older internal development notes may be present in local source archives under `docs/history/`; they are intentionally not included in the release package.

## [Unreleased]

- No changes recorded yet.

## [0.1.18]

- The existing transactional Core and optional Native, Java, and IL2CPP adapters retain their CommonJS public entry points.
- Core implementation is organized into independently owned state, transaction, reaction, scheduling, lifecycle, and diagnostics subsystems.
- Architecture checks, API export checks, integration tests, and agent mock smoke tests are part of the release gate.
- GitHub distribution now includes a minimal npm-installable tarball built from the public compiled library; generated demo agents are excluded.

> Device-level Frida tests are manual and are **not claimed to have passed**.

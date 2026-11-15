# Nexus

**Nexus** is a TypeScript transactional and reactive runtime for coordinating state changes, events, and handlers. It also provides **optional** adapters for Frida Native, Java, and IL2CPP instrumentation.

The current version is **0.1.18**. The package is **CommonJS** and requires **Node.js 22.16.0 or later** for its supported build and test workflow. This is an early release, not a promise of production-ready Frida compatibility.

## Highlights

- **Stores** hold versioned, dispatcher-owned state; reads and writes go through a transaction context.
- **Events** deliver transactional messages without retaining a latest value.
- **Handlers** react to Store changes or Event occurrences, with `inline` or `deferred` execution and `latest` or `each` delivery.
- **Atomic commits** validate transaction drafts before publishing state changes; post-commit effects are kept separate.
- **Scopes** own registrations and resources for explicit cleanup.
- **Frida adapters** are optional and independent of the Core; the Node package is **not** itself a loadable Frida agent.

## Install / build

To work from a clone:

```bash
npm ci
npm run build
npm run test:all
```

For GitHub Releases, a versioned **`.tgz` npm package archive** is attached to the release. Download it and install that file in a Node project:

```bash
npm install ./nexus-prototype-0.1.18.tgz
```

The package name is currently `nexus-prototype` for compatibility with the existing entry points and checks. **It is not published to the npm registry** (`private: true`); a GitHub release does not imply npm availability. Do not use `npm install nexus-prototype` expecting this release to exist on npm.

## Quick start

Run this CommonJS example after installing the release tarball:

```js
const { Dispatcher, Handler } = require('nexus-prototype/core');

const dispatcher = new Dispatcher();
const scope = dispatcher.scope();
const counter = scope.store(0);

class LogCounter extends Handler {
  run(ctx) {
    const value = ctx.read(counter);
    ctx.effect(() => console.log('Committed counter:', value));
  }
}

scope.register(new LogCounter(), {
  on: { any: [counter] },
  execution: 'inline',
});

dispatcher.inline(ctx => ctx.set(counter, 1));
console.log(dispatcher.inline(ctx => ctx.read(counter))); // 1
scope.dispose();
```

`Dispatcher.inline()` commits synchronously. Use `dispatcher.submit()` for a queued transaction (its promise resolves after **its own** commit), or `dispatcher.submitAndWait()` to wait for Nexus-managed causal descendants. Neither method waits for unrelated I/O or external timers.

A handler's `when()` and `run()` must be **synchronous**. Use `ctx.effect()` for work that should happen only *after* a successful commit. External side effects are not automatically rolled back.

### Package entry points

| Entry point | Contents |
| --- | --- |
| `nexus-prototype` | Public Core and Frida exports |
| `nexus-prototype/core` | `Dispatcher`, `Store`, `Event`, `Handler`, `Context`, `Scope`, and related types |
| `nexus-prototype/frida` | Native, Java, and IL2CPP adapter functions and types |
| `nexus-prototype/frida-adapter` | Compatibility adapter entry point |

TypeScript declarations ship alongside the compiled CommonJS JavaScript. Internal `src/core/**` modules beyond the public exports are not a supported API.

## Frida integration and limitations

The package exposes `attachHook`, `observeModule`, `attachJavaHook`, and `attachIl2CppHook`, but **Frida Bridge/runtime objects must be supplied by the host environment**. These APIs do not make the published CommonJS library a Frida Gadget script.

For an explicitly bundled example agent, run `npm run build:agent` from a clone. This builds `dist/agents/native.js` and `dist/agents/smoke.js` locally. The **native example contains illustrative, unverified offsets and ABI assumptions** and is intentionally **excluded from the GitHub release package**. `npm run smoke:agent` tests a mocked host, not a real device. Do not deploy the sample agent to a device without independently verifying its hooks and running the real-device test matrix in [`scripts/e2e/README.md`](scripts/e2e/README.md).

Current constraints include copying the full Map for snapshots, no cancellation of already-running asynchronous work on `Scope.dispose()`, and no rollback of external Bridge/I/O side effects. Borrowed Frida wrapper objects must not be held across deferred callbacks. See [Architecture](ARCHITECTURE.md) and [the detailed internal architecture notes](docs/ARCHITECTURE.md) for the remaining guarantees and trade-offs.

## Development and quality gates

```bash
npm run typecheck
npm run test:all
npm run check:architecture
npm run check:release  # requires npm run build first
```

`test:all` covers unit and integration suites, architectural import boundaries, export contracts, generated declaration compatibility, and the mock-agent smoke test. **Actual Native/ART/IL2CPP device tests are separate and manual**; CI passing is not evidence that they succeeded.

This repository includes additional demos under `examples/`, the C AST experiment in `c-ast/`, and a separate dining-philosophers demo in `dining-philosophers/`. These are **source-tree examples, not part of the release package**.

## Documentation

- [Architecture overview (English)](ARCHITECTURE.md)
- [Detailed architecture notes (Russian)](docs/ARCHITECTURE.md)
- [API guide (Russian)](docs/NEXUS_GUIDE_RU.md)
- [Contribution guidelines](CONTRIBUTING.md)
- [Release checklist](RELEASE_CHECKLIST.md)
- [Security reporting](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT License](LICENSE.md). Copyright (c) 2026 Nexus contributors.

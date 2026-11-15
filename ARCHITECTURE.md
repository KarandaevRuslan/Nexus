# Architecture

This document describes **Nexus v0.1.18** as implemented in this repository. For a more detailed, module-by-module account of its verified dependency boundaries, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Russian).

## Execution model

```text
                  Public API (src/index.ts)
                    /                \
           Core (src/core)        Frida (src/frida)
                  |               /    |      \
        Dispatcher facade       native java   il2cpp
                  |                      \   /
        +---------+----------+          managed
        |         |          |       (Bridge-neutral)
   transactions reactions  scheduling
        |         |          |
        +-----> state     work queue
                  |          |
             snapshots    causal scheduling
                  \          /
               lifecycle + diagnostics
```

At the Core boundary:

1. A `Dispatcher` creates Stores, Events, Scopes, and Handler registrations.
2. A synchronous Context callback stages Store writes, Event emissions, Handler requests, and post-commit effects.
3. Transaction preflight validates writes and buffer admission **before** durable publication.
4. A successful commit publishes a coherent revision. Subscribed handlers run inline or through the deferred scheduler according to their registration options.
5. `ctx.effect()` callbacks execute after commit; their external work is **not** part of the atomic state update.

`when()` receives a separate read-only runtime view. A Handler's `run()` cannot be asynchronous; a Context is invalid after its callback returns.

## Ownership by subsystem

| Area | Responsibility | Important boundary |
| --- | --- | --- |
| `src/core/dispatcher.ts` | Public composition root and Core object identities | Wires services but does not implement the underlying queues or commit algorithm |
| `src/core/state/` | Versioned Store cells, revisions, preflight, snapshots | Does not own subscriptions or scheduling |
| `src/core/transactions/` | Transaction guard, draft processing, atomic commit orchestration | Uses narrow publication/admission ports, not concrete queue/subscription implementations |
| `src/core/reactions/` | Handler registration, subscriptions, conflict rules, wave evaluation | Does not own persistent Store cells or scheduler timers |
| `src/core/scheduling/` | Work queue, causal chains, fairness quotas, completion waiters | Scheduler connects to the transaction/wave executors only after they exist |
| `src/core/lifecycle/` | Scope relations and reverse-order disposal | Disposing does not abort user code that is already running |
| `src/core/diagnostics/` | Protected error reporting | Errors from post-commit work cannot roll back a completed commit |
| `src/core/internal/` | Small shared interfaces and contracts | Internal, not a public dependency surface |
| `src/frida/native/`, `java/`, `il2cpp/` | Host-specific hook and module adapters | Java and IL2CPP must not import each other |
| `src/frida/managed/` | Shared managed-invocation behavior | Independent of specific Java and IL2CPP Bridge imports |

The scheduler is constructed before the transaction and wave executors, then connected **once** through `scheduler.connect(...)`. This avoids invoking callbacks against partially initialized `Dispatcher` fields.

## Imports and exports

`src/index.ts`, `src/core/index.ts`, and `src/frida/index.ts` are the supported source-level public entry points. The package exports map points to compiled `dist/src/` CommonJS JavaScript and `.d.ts` declarations. Forwarding modules preserve older internal source paths where they existed, but the release contract is limited to the declared package exports.

Core code must **not** import Frida code. The adapter subtrees preserve separation between Native, Java, and IL2CPP, and the shared managed layer is Bridge-agnostic. `scripts/check-architecture.cjs` parses TypeScript imports/exports, checks disallowed edges (including type-only edges), and rejects runtime import cycles. `npm run test:architecture` exercises negative dependency cases.

## Transaction and scheduling guarantees

- A successful transaction makes its Store changes and Event emissions visible as a consistent commit. The `StateTable` owns revision and cell state.
- `on: { any: [...] }` responds to a matching Store or Event; `on: { all: [...] }` tracks Stores only.
- `delivery: "latest"` coalesces pending notifications; `delivery: "each"` keeps a bounded pending queue under its configured buffer policy.
- `execution: "inline"` runs a handler in the synchronous reaction path; `execution: "deferred"` schedules it for later.
- Conflict policies and causal wave limits prevent unsafe overlapping handler writes and unbounded feedback; they do **not** provide a general-purpose database transaction system.
- `submit()` waits for the submitted command's commit. `submitAndWait()` additionally waits for Nexus-managed causal work but not independent promises, timers, or external callbacks.

The default `storage: "immutable"` mode copies/freezes supported values. `storage: "reference"` is an explicit escape hatch for opaque host objects and cannot provide historic snapshot isolation from external mutation.

## Frida builds are separate

`npm run build` compiles the reusable **Node/CommonJS library** to `dist/src/`. `npm run build:agent` additionally produces standalone Frida example bundles under `dist/agents/`. The standalone Native example contains illustrative target-specific offsets and ABI assumptions, so **release packaging excludes `dist/agents/`**. Java/IL2CPP host-specific behavior is not validated against real devices in the ordinary CI pipeline; see `scripts/e2e/README.md`.

## Checks and known limits

`npm run test:all` runs type checking, unit/integration tests, bootstrap and port checks, architecture gates, public export checks, agent bundle generation, mocked agent smoke test, package entry/declaration checks, and the C AST suite. The GitHub CI workflow additionally checks the exact package file list with `npm run check:release`.

Known limits: snapshots copy the entire state Map; existing asynchronous work is not cancelled by disposal; external I/O and Frida side effects are not rolled back; deferred callbacks must not retain borrowed native/managed wrapper objects; Native callback error handling differs between `onEnter` and `onLeave`. These constraints require independent design and real-host verification before any stronger reliability claim.

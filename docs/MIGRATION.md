# Миграция внутренних путей (Nexus v0.1.18, структурный PR)

**Публичная поверхность и семантика не менялись:** `src/index.ts`, `src/core/index.ts`, `src/frida/index.ts`, совместимые `src/core.ts` и `src/frida-adapter.ts` экспортируют те же runtime names. Протокол CommonJS сохранён. Типовые экспортные имена сверяются с original v0.1.18 в `scripts/api-golden.json`.

## Канонические реализации

| Старое расположение | Новый владелец |
| --- | --- |
| `core/state-table.ts`, `core/value-snapshot.ts` | `core/state/` |
| `core/subscriptions.ts`, `core/conflicts.ts`, `core/validate-options.ts` | `core/reactions/` |
| `core/work-queue.ts`, `core/causality.ts` | `core/scheduling/` |
| `core/runtime/{transaction-engine,guard}.ts` | `core/transactions/{transaction-engine,transaction-guard}.ts` |
| `core/runtime/{registration-config,registration-manager,wave-executor}.ts` | `core/reactions/` |
| `core/runtime/scheduler.ts` | `core/scheduling/scheduler.ts` |
| `core/runtime/error-reporter.ts` | `core/diagnostics/error-reporter.ts` |
| `core/runtime/defaults.ts` | `core/internal/defaults.ts` |
| `core/contracts-runtime.ts` | `core/internal/contracts-runtime.ts` |
| `frida/{hooks,modules,types}.ts` | `frida/native/` |
| `frida/{java,java-registry}.ts` | `frida/java/{hooks,registry}.ts` |
| `frida/il2cpp.ts` | `frida/il2cpp/hooks.ts` |
| `frida/{managed-invocation,managed-options,managed-types}.ts` | `frida/managed/`; Bridge-type contracts now live in `frida/java/types` and `frida/il2cpp/types` |

**Прямые старые пути** вне `core/runtime` сохранены как тонкие forwarding modules, если они существовали в previous archive. `core/runtime/*` — *непубличные* пути, для них forwarding намеренно удалён во избежание повторного появления свалки. При внутренних импортах используйте канонические папки.

## Packaging

Для исходников: `npm ci && npm run build`, после чего Node CJS entrypoint — `dist/src/index.js`, типы — `dist/src/index.d.ts`. Пакет остаётся `private: true`, не обещает публикацию npm. `npm run build:agent` создаёт **отдельный standalone Frida bundle**, а не CommonJS `dist/src/` под видом Gadget-агента.

Нет нового API синхронных перехватов, нет изменений atomic wave, нет MVCC и нет отмены внешних async операций. Установка на реальный Android/Unity не была частью Node CI.

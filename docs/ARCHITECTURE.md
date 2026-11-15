# Nexus v0.1.18 — проверяемые архитектурные границы

## Источник истины и композиция

Nexus остаётся **CommonJS TypeScript-прототипом**. Единственный создающий конкретные внутренние реализации узел — `src/core/dispatcher.ts`. Его публичные методы совместимы с v0.1.18; `src/core/index.ts`, `src/frida/index.ts`, `src/index.ts`, `src/core.ts`, `src/frida-adapter.ts` остаются публичными входами.

```text
                         API: src/index.ts
                           /          \
             core/index.ts             frida/index.ts
                   |                     |
             Dispatcher          native/   java/   il2cpp/
             composition          |         \     /
                   |              |        managed/ (no bridge imports)
     +-------------+--------------+-----------
     |             |              |           |
 reactions/     transactions/   scheduling/  lifecycle/
     |          (publication port)   |           |
     |                 |          WorkQueue      Scope
     +---> state/ <----+              |
                 ^                CausalChain
                 |
           internal/ports.ts  [type-only contracts]
                 ^
           diagnostics/ [ErrorSink]
```

**Направление:** `Dispatcher` создаёт конкретные сервисы, но не дублирует их алгоритмы; `TransactionEngine` знает `CommitPublicationPort` и `BufferAdmissionPort`, а **не** `SubscriptionIndex`/`WorkQueue`/`Dispatcher`; `Scheduler` знает `ScheduleExecutorPort`, а **не** `WaveExecutor`/`TransactionEngine`/`Dispatcher`. `WaveExecutor` меняет причинный контекст лишь через `withActiveCause` (с восстановлением в `finally`).

`Scheduler` создаётся без обратных callback, затем создаются `TransactionEngine` и `WaveExecutor`, затем `scheduler.connect(...)` однократно связывает уже **готовые** объекты. До вызова `connect` доступ к executor вызывает ошибку, двойное подключение запрещено. Конструктор `Dispatcher` не вызывает пользовательские Handler до завершения подключения; первый `initial` проверен отдельным тестом.

## Единственные владельцы изменяемого состояния

| Каталог / модуль | Инвариант и изменяемый ресурс | Что запрещено |
| --- | --- | --- |
| `core/state/state-table.ts` | Единственный владелец `cells`, `revision`, `nextStoreId`; `commit` выполняет preflight до публикации | Не знает очередей, подписок, Frida; сохраняет алгоритм копирования Map |
| `core/transactions/transaction-guard.ts` | `evaluationDepth`, `committing`: единственный источник фазового reentrancy-ограничения | Не проводит Commit |
| `core/transactions/transaction-engine.ts` | Локальный `CommitFrame`, transactional signals/effects; связывает atomic publication с портом уведомлений | Не создаёт таймеры, не мутирует подписки непосредственно |
| `core/reactions/subscriptions.ts` | Индексы подписчиков Stores/Events и `on.all` bookkeeping | Не изменяет durable StateTable |
| `core/reactions/registration-manager.ts` | `nextRegistrationId`, `activeHandlers` — эксклюзивность Handler и cleanup; `registration.ts` хранит runtime lifecycle state в WeakMap | Не владеет очередью и commit-критической секцией |
| `core/reactions/conflicts.ts` | Установленные правила конфликтов и их handles | Не публикует Store; правила `reject/skip/sequence` не менялись |
| `core/reactions/wave-executor.ts` | Временные speculative contexts, порядок wave/sequence replay | Не владеет активной cause, таймерами или waiters |
| `core/scheduling/work-queue.ts` | Очереди команд/jobs и буфер `delivery: each/latest` | Не выполняет пользовательские callbacks |
| `core/scheduling/scheduler.ts` | `currentCause`, `currentEffectCause`, completion waiters, `nextCauseId`, timer flags, quotas and fairness | Не открывает StateTable, не создаёт подписки |
| `core/lifecycle/` | `ScopeRelations` — граф зависимостей, `releaseLifo` — повторяемая очистка | Не владеет регистрацией Stores |
| `core/diagnostics/` | Защищённая доставка ошибок, async reporter rejection | Не отменяет commit и не меняет failure policy |
| `core/dispatcher.ts` | Identity Stores/Events, `nextEventId`, конфигурация глубины `inline` | Не определяет queue fairness и не делает публикацию snapshots |
| `frida/native`, `java`, `il2cpp` | Собственные Bridge-ресурсы и handles | Не импортируют друг друга; `managed` не знает API Bridge |

`Scope` и `Context` сохраняют **публичные типы и объектную идентичность Dispatcher**; `RegistrationManager` всё ещё принимает owner типа `Dispatcher` для проверки ownership и конструктора `Registration`. Эти type-only связи намеренно оставлены как контракт v0.1.18, а не замаскированы неявным token. Полное сокрытие `_` API — отдельная миграция.

## Машинно проверяемая карта импортов

`npm run check:architecture` использует TypeScript AST, анализирует `import`, `export ... from`, `require`/dynamic import с литеральным аргументом, отдельно считает **runtime** и **type-only** ребра, проверяет runtime cycles по SCC. Матрица допустимых *внешних* направлений фиксируется в `scripts/check-architecture.cjs` (`allow`, `typeOnly`, `runtimeExceptions`). Краткая человекочитаемая версия:

| Откуда | Допустимые зависимости **вне своей области** | Особые ограничения |
| --- | --- | --- |
| `core` (любой) | Только `core/*` | **НИКОГДА** `frida/*` |
| `core/state` | `core` API/модели, `internal` | Запрещены `reactions`, `scheduling`, Bridge — даже `import type` |
| `core/transactions` | `state`, `internal/ports`, базовые типы, **type-only** `scheduling/causality` | Нет прямого `reactions`, таймеров, подписок; публикация только через `CommitPublicationPort` |
| `core/reactions` | `state` (type-only), `scheduling` (type-only, кроме явно зарегистрированной `CausalChain`), `transactions` (type-only), `internal`, core-models | Разрешённые runtime исключения перечислены по конкретным файлам |
| `core/scheduling` | `internal`, core types, `transactions` (type-only) | Не импортировать `Dispatcher` как runtime-значение |
| `core/lifecycle`, `diagnostics` | Только Core-модели или `internal` по матрице | Не импортируют Bridge/планировщик как новый runtime dependency |
| `frida/native` | Native, Core public + core contract helper | Не импортирует Java/IL2CPP |
| `frida/java` и `frida/il2cpp` | Свою область, `frida/managed` и типы Core | Между Java ↔ IL2CPP импорты запрещены, включая типовые |
| `frida/managed` | Свой независимый managed protocol, Core contract helpers | **Никогда** не импортирует `frida/java`/`frida/il2cpp` |
| Публичные barrels | Объявленные подсистемы | `src/frida/index.ts` сохраняет 5 runtime exports + типы |

Входящее type-only ребро не считается исполняемым циклом, однако **отображается в отчёте**, проверяется по `allow/typeOnly` и может быть запрещено. Новую межобластную зависимость нельзя добавлять без документированного разрешения в проверяющей карте. Негативные тесты `npm run test:architecture` проверяют запрещённый импорт типа, запрещённый runtime Dispatcher, Java→IL2CPP и исполняемый цикл.

## Before / after (одна и та же методика AST)

`node scripts/graph-metrics.cjs <source-root>` (метрики включают forwarding modules, а также отдельные объявления импорта):

| Метрика | Предыдущий архив `nexus_refactored.zip` | Данная версия |
| --- | ---: | ---: |
| `.ts` модулей в `src` | 42 | 65 |
| Статических import/export связей | 187 | 218 |
| Runtime / type-only связей | 82 / 105 | 100 / 118 |
| Runtime SCC с циклами | 0 | 0 |
| Самая большая type-inclusive SCC | 19 | 20 |
| Разнотипных реализаций в `core/runtime` | 8 | 0 |
| Прямой concrete `TransactionEngine` → `SubscriptionIndex` | 1 (type) | **0** (через порт) |
| Прямой concrete `TransactionEngine` → `Dispatcher` | 1 (type) | **0** (context factory) |
| Скрытая связь Scheduler → будущие поля Dispatcher | 3 callback до присвоения полей | **0**, явный `connect` |

**Не утверждаем, будто общее число рёбер или размер type-SCC уменьшились.** Они немного увеличились из-за **сохранённых совместимых forwarding modules, отдельного internal ports и новых узких adapter entrypoints**. Уменьшились *конкретные запрещаемые связи*; новые ограничения можно проверять. Аудит считал 162 связи иным сканированием; эти числа **не сопоставляются** со значениями 187/218. Полный граф автоматически генерируется и сохраняется в `docs/graphs/` в поставке.

## Гарантии транзакций (без изменения алгоритмов)

1. `Handler.when` получает объект `ReadContext`, не содержащий mutator методов. `Handler.run` синхронен, ctx может локально подготовить write, emit, request и effect.
2. `StateTable.commit` проводит optimistic validation и предельную проверку емкости `each` **до публикации**; общий Commit одной wave/sequence атомарен.
3. `TransactionGuard` блокирует вложенную публикацию во время speculative evaluation и commit, но допускает callback reentry из уже выполненного **post-commit** effect.
4. Сразу после Commit подписчики получают согласованные snapshots; эффекты запускаются позже, в отдельной фазе. Promise-returning effect не откатывает Store и не задерживает завершение Nexus-цепочки.
5. `Scheduler.submit` дожидается только собственного Commit; `submitAndWait` — причинно связанных Nexus jobs/commands. Внешний `await`, собственный таймер или native callback вне причинной цепочки не входят в гарантию.

## Поставка и реальная Frida

- `npm run build`: CommonJS `dist/src/**.js` и декларации `.d.ts` (internal-only/npm-private prototype).
- `npm run build:agent`: самостоятельные `dist/agents/native.js` (демо с **непроверенными** игровыми offset/ABI!) и `dist/agents/smoke.js` (без хуков и адресов). Только явно импортируемые Java/IL2CPP Bridge-профили должны попадать в дополнительный bundle.
- `npm run smoke:agent`: **Node.js vm + Frida-globals mock**, не реальный Gadget.
- `npm run test:e2e:real`: **только вручную**, с установленным вне проекта Frida host и тестовым процессом. Таблица реальных сценариев в [`scripts/e2e/README.md`](../scripts/e2e/README.md). Если устройство не подключено, статус **NOT RUN**.

Известные НЕ исправленные ограничения: Snapshot копирует всю `Map`; `Scope.dispose()` не отменяет уже начатый async код; заимствованные Native/Java/IL2CPP объекты нельзя удерживать до deferred callback; внешние Bridge side effects и I/O не откатываются; `sequence`/конфликт остаются atomic wave; native `onEnter/onLeave` error policy пока асимметричен. Требуют отдельного RFC/runtime PR.

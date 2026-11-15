# Nexus v0.1.18 — руководство программиста

> Короткий, но полный справочник **публичного API** по рефакторингу v2. Примеры написаны на TypeScript. Здесь описано поведение **фактического кода проекта**, а не предполагаемые возможности будущих версий. Внутренние методы с `_` и классы из `core/internal` не являются пользовательским API.

## 1. Как устроен Nexus

Nexus — транзакционный реактивный движок. Его основные элементы:

- **`Dispatcher`** — отдельный экземпляр движка: создаёт данные, проводит транзакции, планирует реакции.
- **`Store<T>`** — типизированное состояние. Сам `Store` — *дескриптор*, а значение читают/меняют через `Context`.
- **`Event<T>`** — событие с данными, **без хранения последнего значения**.
- **`Handler`** — реакция: `when()` решает, выполнять ли её, `run()` подготавливает изменения.
- **`Registration`** — конкретная подписка обработчика; **`Scope`** — владелец ресурсов и подписок.

Модель исполнения: **команда → черновик (`ctx.set/emit/request`) → проверка → атомарный Commit → оповещение обработчиков → post-commit эффекты**. Если транзакция сорвалась до Commit, её черновики и `ctx.effect()` не публикуются. Внешние действия нельзя автоматически откатить.

## 2. Установка, сборка, импорты

Из корня распакованного проекта:

```bash
npm ci
npm run build
npm run test:all
```

Нужны Node.js **22.16+** и закреплённый в проекте TypeScript **5.9.3**. Это приватный CommonJS-проект (`private: true`), а не опубликованный npm-пакет. Импорт **внутри исходников проекта**:

```ts
import { Dispatcher, Handler, type Context, type ReadContext } from "../src/core";
import { attachHook, observeModule, attachJavaHook, attachIl2CppHook } from "../src/frida";
```

Для файла в *корне* проекта вместо `../src/core` нужен `./src/core`; относительный путь зависит от расположения файла. Совместимые точки входа: `src/index.ts` (Core + Frida), `src/core/index.ts`, `src/frida/index.ts`, `src/frida-adapter.ts`. Собранная Node-точка входа — `dist/src/index.js` (есть `.d.ts`); в `package.json` также объявлены `./core`, `./frida`, `./frida-adapter`. **`dist/src/*.js` нельзя использовать как Frida Gadget agent**: для него существует отдельная сборка `npm run build:agent`.

> Примечание о записи: `Store<number>` — значение типа `number`; `ctx => ...` — callback; `override` — стандартное ключевое слово TypeScript; литералы `"inline"`, `"each"` и т. п. — строгие значения опций, а не произвольные строки.

## 3. Минимальная работающая программа

Сохраните как `examples/quickstart.ts` (это **новый файл** относительно корня проекта):

```ts
import { Dispatcher, Handler, type Context, type ReadContext } from "../src/core";

const d = new Dispatcher();
const scope = d.scope();
const counter = scope.store(0);

class CounterLog extends Handler {
  override when(ctx: ReadContext): boolean {
    return ctx.change(counter) !== undefined;
  }
  override run(ctx: Context): void {
    const value = ctx.read(counter);
    ctx.effect(() => console.log("Значение после Commit:", value));
  }
}

scope.register(new CounterLog(), {
  on: { any: [counter] },
  execution: "inline",
});

d.inline(ctx => ctx.set(counter, 1));  // синхронно выведет: Значение после Commit: 1
console.log(d.inline(ctx => ctx.read(counter))); // 1
scope.dispose(); // снимает подписку и освобождает Store
```

Если файл добавлен в `examples/`, выполните `npm run build && node dist/examples/quickstart.js`.

## 4. `Dispatcher`: создание, транзакции, планировщик

```ts
const d = new Dispatcher({
  conflictFallback: "reject",       // "reject" (по умолчанию) | "skip"
  maxInlineWaves: 32,             // предел inline-волн за один drain
  maxInlineDepth: 32,             // предел вложенности inline()
  maxWavesPerTurn: 32,            // deferred-волн за проход планировщика
  maxCommandsBeforeDeferred: 16, // квота справедливости для команд
  maxCausalWaves: 256,           // предел причинно связанной цепочки
  onError: error => console.error("Nexus:", error),
});
```

Все лимиты — положительные целые числа. Основные методы:

| Синтаксис | Что делает |
| --- | --- |
| `d.store(initial, options?)` | Создаёт `Store<T>`; можно владеть им через `scope.store()`. |
| `d.event<T>(options?)` | Создаёт `Event<T>`; альтернатива — `scope.event()`. |
| `d.register(handler, options?)` | Регистрирует `Handler`, возвращает `Registration`. |
| `d.scope()` | Создаёт независимый `Scope`. |
| `d.inline(ctx => { ... })` | Выполняет **синхронную** транзакцию; возвращает результат callback, затем завершает inline-реакции. |
| `d.submit(ctx => { ... })` | Ставит команду в очередь; `Promise<R>` завершается после **её собственного** Commit. |
| `d.submitAndWait(ctx => { ... })` | Ждёт Commit команды **и её Nexus-причинные реакции**; не ждёт произвольные async-эффекты/таймеры. |
| `d.request(reg)` | Вызывает обработчик **вне** транзакции; для inline-подписки может отработать синхронно. |
| `d.flush(maxWaves?)` | Вручную обрабатывает очередь; предел по умолчанию — `10000`. |
| `d.unregister(reg)` / `reg.dispose()` | Останавливает регистрацию и вызывает `onDispose()`. |
| `d.unregisterStore(store)` / `d.unregisterEvent(event)` | Удаляет источник, **только если у него нет активных подписчиков**. |
| `d.currentRevision` | Номер последней подтверждённой ревизии (только чтение). |
| `d.conflicts` | Настройка конфликтов обработчиков; см. §9. |

```ts
const result: number = d.inline(ctx => {
  ctx.set(counter, 5);
  return ctx.read(counter); // видит свой черновик: 5
});
async function queuedExample(): Promise<void> {
  const ownCommit = await d.submit(ctx => { ctx.update(counter, n => n + 1); return "ok"; });
  await d.submitAndWait(ctx => ctx.set(counter, 7));
  console.log(ownCommit); // "ok"
}
```

`inline()`, `Handler.when()` и `Handler.run()` **не принимают Promise-подобный результат**: не пишите `async` в этих callback и не храните `ctx` после возврата. Завершившийся `Context` недействителен. Вложенный `inline()` из *ещё вычисляемой* транзакции запрещён; из post-commit эффекта отдельная транзакция возможна при соблюдении лимитов.

## 5. `Store<T>`: состояние и операции `Context`

```ts
const score = d.store(0); // equals: Object.is; storage: "immutable"
const player = d.store({ hp: 100, nickname: "hero" });
const selected = d.store({ id: 10 }, {
  equals: (a, b) => a.id === b.id,
  storage: "immutable", // "immutable" | "reference"
});

d.inline(ctx => {
  const hp = ctx.read(player).hp;
  ctx.set(player, { ...ctx.read(player), hp: hp - 10 });
  ctx.update(score, n => n + 2);
  ctx.set(score, 2, { record: "always" });
});
```

`ctx.read(store)` читает видимое значение, включая **свои** уже подготовленные записи; `ctx.update(store, previous => next, options?)` — сокращение для чтения и `set`; `ctx.set(store, value, options?)` подготавливает запись, но не публикует её до Commit. `ctx.version(store)` возвращает версию Store в текущем снимке. `Store` имеет доступные поля только для чтения `id`, `owner`, `storage`, `equals`; **методов `store.get()` / `store.set()` нет**.

Опция `record` у `set/update`:

| Значение | Поведение |
| --- | --- |
| `"changed"` (по умолчанию) | Регистрирует изменение, только если `equals(old, new)` вернул `false`. |
| `"always"` | Регистрирует даже равное значение: уведомление будет `kind: "touched"`. |

При **`storage: "immutable"`** Nexus делает из значений отдельные глубоко замороженные копии; поддерживаются примитивы, массивы и обычные data-объекты. `Map`, экземпляры классов, функции внутри структур, getter/setter и native wrapper не поддерживаются. **`storage: "reference"`** допускает непрозрачные объекты без копирования: тогда их мутации за пределами Nexus **не откатываются**, а исторические снимки не защищены. Для Frida-указателей обычно безопаснее сохранять *строковый адрес/ID*.

### Как узнать, что именно изменилось

Внутри реакции:

```ts
const change = ctx.change(score); // Change<number> | undefined
if (change) {
  console.log(change.store, change.revision, change.version, change.kind);
  // kind: "changed" | "touched"
  console.log(ctx.before.read(score), "→", ctx.after.read(score));
  console.log(ctx.before.version(score), ctx.after.version(score));
}
```

`ctx.before`/`ctx.after` — снимки **до и после той транзакции, которая вызвала реакцию**. У них есть `revision`, `read(store)`, `version(store)`. `ctx.revision` — ревизия текущего контекста; `ctx.change(store)` описывает уведомление **этого** запуска, а не всю историю изменений. При ручном `request()` и `initial` без нового Commit снимки `before/after` одинаковы. При `delivery: "latest"` хранится последнее объединённое уведомление, не полный журнал.

## 6. `Event<T>`: одноразовые сообщения

```ts
const damage = d.event<{ points: number }>();

class ApplyDamage extends Handler {
  override run(ctx: Context): void {
    const occurrence = ctx.event(damage); // EventOccurrence<{points: number}> | undefined
    if (!occurrence) return;
    ctx.update(score, n => n - occurrence.value.points);
  }
}
const damageReg = d.register(new ApplyDamage(), {
  on: { any: [damage] },
  delivery: "each", execution: "inline",
});

d.inline(ctx => ctx.emit(damage, { points: 3 }));
```

`ctx.emit(event, value)` публикует событие **только после успешного Commit**. `ctx.event(event)` получает значение **конкретного вызвавшего события**, а не последнее значение во времени. Проверяйте `occurrence !== undefined`: для `Event<void>` допустимо `{ value: undefined }`. В отличие от `Store`, у `Event` нет `read()`, версии и истории; в `on.all` его использовать нельзя. `EventOptions.storage` — тот же `"immutable" | "reference"`.

## 7. `Handler`, `when`, `run`, `Registration`

```ts
class Threshold extends Handler {
  constructor() {
    super({ on: { any: [score] }, execution: "deferred" }); // настройки по умолчанию экземпляра
  }
  override when(ctx: ReadContext): boolean {
    return ctx.change(score) !== undefined && ctx.read(score) >= 10;
  }
  override run(ctx: Context): void {
    const value = ctx.read(score);
    ctx.effect(() => console.log("Достигнуто", value));
  }
  override onDispose(): void {
    console.log("Снята подписка");
  }
}
const reg = d.register(new Threshold(), { execution: "inline" }); // переопределение настроек
console.log(reg.id, reg.active, reg.delivery, reg.execution, reg.sources);
reg.dispose();
```

- **`when(ctx: ReadContext): boolean`** по умолчанию возвращает `true`. Это **реально read-only объект**: `read`, `version`, `change`, `event`, `before`, `after`, `revision`; у него нет `set/update/emit/request/effect`. Он должен быть синхронным и без побочных эффектов.
- **`run(ctx: Context): void`** обязателен; готовит `set/update/emit/request/effect`, не делает внешних необратимых действий напрямую. Сам `Context` недействителен после вызова.
- **`onDispose(): void`** необязателен; синхронная очистка. При ошибке очистку можно повторить, вызвав `dispose()` ещё раз.
- **`Handler`** — поведение; **`Registration`** — один факт установки этого поведения. Нельзя повторно зарегистрировать **тот же экземпляр** `Handler`, пока его предыдущая регистрация не освобождена.

### Настройки регистрации (`new Handler(options)` и `d.register(handler, options)`)

Формы `on.any` и `on.all` взаимоисключающие: `on: { any: [...] }` или `on: { all: [...] }`.

| Поле | Значения и смысл |
| --- | --- |
| `on` | `{ any: [storeOrEvent, ...] }`: любой источник; **либо** `{ all: [store1, store2, ...] }`: дождаться сигналов **всех Store**. Без `on` — только ручные `request()`/`initial`. |
| `execution` | `"deferred"` (**по умолчанию**) — через планировщик; `"inline"` — синхронная реакция после Commit. |
| `delivery` | `"latest"` (**по умолчанию**) — объединять ожидающие вызовы; `"each"` — отдельное задание для каждого уведомления. |
| `initial` | `false` (**по умолчанию**) / `true` — один стартовый запуск после регистрации. При `execution: "inline"` может выполниться до возврата `register()`. |
| `buffer` | Только при `delivery: "each"`: `{ capacity: 1024, overflow: "reject" }` по умолчанию; варианты переполнения ниже. |

```ts
const regAll = d.register(new Threshold(), {
  on: { all: [score, player] }, // только Store; "each" здесь запрещён
  delivery: "latest", execution: "deferred", initial: true,
});

const regEach = d.register(new ApplyDamage(), {
  on: { any: [damage] }, delivery: "each",
  buffer: { capacity: 64, overflow: "drop-oldest" },
});
```

`buffer.overflow`:

- `"reject"` — **до Commit** выбросить `BufferOverflowError`; транзакция-источник не публикуется.
- `"drop-oldest"` — удалить самый старый ожидающий вызов этой регистрации.
- `"drop-newest"` — не добавлять новый вызов.

Счётчик потерь: `reg.droppedJobs`. Другие поля только для чтения: `reg.handler`, `reg.owner`, `reg.mode` (`"any" | "all"`), `reg.buffer`, `reg.active`, `reg.cleanupComplete`, `reg.cleanupInProgress`. `reg.dispose()` — основной способ остановки вне `Scope`.

## 8. Вызов реакции вручную и post-commit эффекты

```ts
class ManualTask extends Handler {
  override run(ctx: Context): void { ctx.effect(() => console.log("Вызов вручную")); }
}
const reg = d.register(new ManualTask()); // без on — только явные запросы

d.request(reg); // реакция запускается независимо от уведомления Store

d.inline(ctx => {
  ctx.update(score, n => n + 1);
  ctx.request(reg);  // запуск будет запланирован ТОЛЬКО после успешного Commit
  ctx.effect(() => console.log("Commit уже состоялся"));
});
```

`d.request(reg)` планирует сразу; `ctx.request(reg)` — **транзакционный** сигнал. Оба требуют действующую регистрацию именно этого `Dispatcher`.

`ctx.effect(callback, options?)` используется для логов, файлов, Frida API, сетевых действий, сторонних мутаций и прочих **необратимых** действий:

```ts
ctx.effect(() => sendToExternalSystem(), {
  owner: scope,                 // не запускать, если Scope уже закрыт
  lifetime: "registration",   // по умолчанию в Handler: привязан к его регистрации
});
ctx.effect(() => console.log("независимо от регистрации"), {
  lifetime: "independent",    // убирает ТОЛЬКО привязку к Registration
});
```

Внутри `Handler.run()` эффект по умолчанию также принадлежит породившей его `Registration`: если она была снята до запуска эффекта, эффект пропускается. `lifetime: "independent"` снимает **только эту** привязку; явный `owner: scope` всё равно соблюдается. Ошибки эффекта направляются в `DispatcherOptions.onError`; уже состоявшийся Commit **не откатывается**. Promise, возвращённый эффектом, **не ожидается** `inline/submit/submitAndWait`. Защита `owner` проверяет **момент старта**, а не отменяет код после `await`.

## 9. Конфликты нескольких `Handler` в одной волне

По умолчанию, если два обработчика одной волны пишут **один и тот же Store**, возникает `ConflictError`. Глобальная запасная политика `conflictFallback: "skip"` позволяет пропускать конфликтную волну; специальное правило определяет поведение для пары регистраций и Store:

```ts
const target = d.store(10);
const trigger = d.store(0);
class Double extends Handler { override run(ctx: Context): void { ctx.update(target, n => n * 2); } }
class PlusThree extends Handler { override run(ctx: Context): void { ctx.update(target, n => n + 3); } }
const a = d.register(new Double(), { on: { any: [trigger] }, execution: "inline" });
const b = d.register(new PlusThree(), { on: { any: [trigger] }, execution: "inline" });

const rule = d.conflicts.add({
  store: target,
  between: [a, b],
  resolve: { strategy: "sequence", order: [a, b] }, // сначала ×2, потом +3
});
d.inline(ctx => ctx.set(trigger, 1)); // target = 23
console.log(rule.active, rule.rule.resolve.strategy);
rule.dispose(); // снимает правило, но НЕ регистрации
```

`resolve` принимает `{ strategy: "reject" }`, `{ strategy: "skip" }` или `{ strategy: "sequence", order: [firstReg, secondReg] }`. `sequence` повторно вычисляет обработчики **в указанном порядке**, но итог всё равно Commit-ится атомарно для волны. Конфликт способен отменить и независимые записи **в той же волне**. `ConflictRuleHandle` имеет `active`, `rule`, `dispose()`. Правила удаляются при освобождении соответствующей регистрации/Store.

## 10. `Scope`: владение и гарантированная очистка

```ts
const owner = d.scope();
const total = owner.store(0);
const notification = owner.event<string>();
const registered = owner.register(new Threshold(), { initial: false });
owner.cleanup(() => console.log("Освободить внешний ресурс"));

const child = owner.child(); // дочерний Scope; будет закрыт перед родителем
child.cleanup(() => console.log("Закрыть ресурс дочернего Scope"));

const externalBorrower = d.scope();
externalBorrower.dependsOn(owner); // owner.dispose() запрещён, пока borrower жив
externalBorrower.dispose();

const guarded = owner.guard(() => console.log("Только пока owner.active"));
guarded();
async function finishOwner(): Promise<void> {
  await owner.submit(ctx => ctx.set(total, 1));
  await owner.submitAndWait(ctx => ctx.set(total, 2));
  owner.dispose(); // отписки → дети → onDispose → cleanups → Stores → Events
}
```

`scope.active` показывает доступность. `scope.store/event/register` создают **владение**; `scope.cleanup(fn)` добавляет синхронный callback очистки; `scope.submit/submitAndWait` привязывают **ещё не начавшуюся** команду к сроку жизни владельца. При `dispose()` она отменится с отклонением Promise. Если уже выполняется, её не прерывают посреди синхронного Commit.

`scope.child()` создаёт дочернее владение; `scope.dependsOn(otherScope)` объявляет **заимствование** чужих ресурсов: владелец не может освободиться раньше заёмщика. Чтение чужого Store **само по себе** зависимость не создаёт. Зависимости циклическими быть не могут. `scope.guard(fn)` прекращает **новые** вызовы после закрытия, но **не отменяет** таймер, слушатель или уже начатую асинхронную операцию: для этого нужна `scope.cleanup(() => clearInterval(id))` или аналогичная очистка.

При ошибке очистки возникает `AggregateError`: очистка останавливается, неосвобождённые ресурсы остаются для **повторного `dispose()`**; успешно очищенные повторно не вызываются.

## 11. Ошибки и границы гарантий

| Класс | Когда встречается |
| --- | --- |
| `ConflictError` | Несогласованные записи в одной волне, устаревший снимок. |
| `FeedbackError` | Превышены пределы вложенности/причинной цепочки/inline-волн. |
| `BufferOverflowError` | Буфер `delivery: "each"` заполнен при `overflow: "reject"`. |
| `RegistrationSetupError` | Ошибка первого запуска **и** ошибка откатной очистки; содержит `registration`, `executionError`, `cleanupError`. |
| `PostCommitReactionError` | Исходный `inline()` **уже закоммитил** изменения, но последующая inline-реакция упала; содержит `committedRevision`, `cause`. **Не повторяйте исходную запись вслепую.** |
| `ManagedHookFailure` | Ошибка managed-хука при `failure: "propagate"`; содержит `phase`, `originalCalled`, `cause`. |

```ts
import { PostCommitReactionError } from "../src/core";
try {
  d.inline(ctx => ctx.set(score, 100));
} catch (error) {
  if (error instanceof PostCommitReactionError) {
    console.error("Данные УЖЕ сохранены, ревизия:", error.committedRevision);
  } else {
    throw error;
  }
}
```

**Не путайте:** исключение *до Commit* откатывает подготовленные Nexus-записи/события; post-commit ошибка не откатывает уже опубликованное состояние. Nexus не откатывает внешнее I/O, изменение полей Java-объектов, вызовы оригинальных методов и нативную память. `submitAndWait` ждёт свою причинную **Nexus**-цепочку, а не произвольные внешние Promise. Лимиты планировщика защищают от бесконечных циклов, но не являются дедлайнами реального времени.

## 12. Frida: Native, Java и IL2CPP

Адаптеры получают **явный** runtime/Bridge; ядро не обращается к глобальным `Java`/`Il2Cpp`. Все обработчики хуков синхронные. `Scope` владеет установкой и восстановлением хука. Примеры ниже показывают **схему подключения**, а не готовые offsets/ABI для конкретного приложения. Реальные Gadget/ART/Unity-тесты в поставке имеют статус **NOT RUN**.

### 12.1. Native: `observeModule()` и `attachHook()`

```ts
import { Dispatcher } from "../src/core";
import { attachHook, observeModule, type FridaRuntime, type NativePointerLike } from "../src/frida";

// В Frida эти глобальные объекты предоставляет сам runtime:
declare const Process: FridaRuntime["Process"];
declare const Interceptor: FridaRuntime["Interceptor"];
const runtime: FridaRuntime = { Process, Interceptor };

const d = new Dispatcher();
const root = d.scope();
const lastArg = root.store<string | null>(null);

observeModule(d, root, runtime, "libexample.so", (module, moduleScope) => {
  const verifiedOffset = 0x1234; // ОБЯЗАТЕЛЬНО заменить на проверенный адрес/ABI
  const address: NativePointerLike = module.base.add(verifiedOffset);

  attachHook<{ argument?: string }>(d, moduleScope, runtime, address, {
    onEnter(_ctx, args, state, invocation) {
      state.argument = args[0]?.toString();
      // invocation.threadId — ID потока; state — отдельный объект на вызов.
      void invocation.threadId;
    },
    onLeave(ctx, retval, state, invocation) {
      if (retval.toInt32() === 0 || !state.argument) return;
      ctx.set(lastArg, state.argument);
      void invocation;
    },
  });
});
// root.dispose() снимет observer, хуки и все дочерние Scope.
```

- `observeModule(dispatcher, parentScope, runtime, moduleName, (module, loadScope) => void)` вызывает callback на загрузку библиотеки; `loadScope` освобождается на выгрузке, parent владеет всеми дочерними scope. `module`: `{ name, base, size }`.
- `attachHook<TState>(dispatcher, scope, runtime, address, { onEnter?, onLeave? })` устанавливает `Interceptor.attach`; возвращает `void`, удаляется через `scope.dispose()`.
- `onEnter(ctx, args, state, invocation)` / `onLeave(ctx, retval, state, invocation)` — **разные** callback одной native-инвокации; `state` служит для данных между ними и очищается на выходе. `args` и `retval` — borrowed native-значения: не сохраняйте их для отложенной работы без явной безопасной копии/преобразования.
- `NativePointerLike`: `add(offset)`, `toString()`, `toInt32()`, `isNull()`, `equals(ptr)`; `FridaInvocation` имеет `threadId` и произвольные поля. Ошибки `onEnter` и `onLeave` имеют **несимметричную** текущую политику проброса; после-Commit ошибка реакции в `onEnter` репортится. Не рассчитывайте на универсальный fallback native-хуков.

### 12.2. Java: `attachJavaHook()`

```ts
import { attachJavaHook, type JavaBridgeLike } from "../src/frida";

declare const java: JavaBridgeLike; // передайте установленный Java Bridge
const javaHook = attachJavaHook<[number], number>(d, root, java, {
  className: "com.example.Calculator",
  methodName: "sum",
  overload: ["int"],            // точная сигнатура перегрузки обязательна
  failure: "passthrough",        // или "propagate"
  callbacks: {
    before(ctx, call) {
      call.replaceArg(0, Math.max(0, call.args[0]));
      // call.skipOriginal(42);  // не вызывать исходный метод; вернуть 42
      ctx.effect(() => console.log("Вызов Java начался"));
    },
    after(_ctx, call) {
      call.replaceResult((call.result ?? 0) + 1);
    },
  },
  // invokeOriginal: (receiver, args) => ... // необязательный обход wrapper
});
void javaHook.ready.then(() => console.log(javaHook.active));
// Внутри async-функции можно написать: await javaHook.ready;
// root.dispose() вернёт прежнюю .implementation.
```

Один `JavaMethodLike` overload нельзя дважды установить под управлением Nexus; `overload` — **массив названий типов**, а не список аргументов вызова. Bridge-объект должен предоставлять `perform(callback)` и `use(className)`; выбранный метод — `.overload(...)`, `.call(receiver, ...args)`, `.implementation`. `ManagedHookHandle` содержит **только** `ready: Promise<void>` и `active: boolean`; отдельного `dispose()` на нём нет: закрывайте `Scope`.

### 12.3. IL2CPP: `attachIl2CppHook()`

```ts
import { attachIl2CppHook, type Il2CppBridgeLike } from "../src/frida";

declare const il2cpp: Il2CppBridgeLike;
const ilHook = attachIl2CppHook<[number], number>(d, root, il2cpp, {
  assembly: "Assembly-CSharp",
  className: "Game.Calculator",
  methodName: "Compute",
  overload: ["System.Int32"], // необязательно; зависит от Bridge и метода
  callbacks: {
    before(_ctx, call) { if (call.args[0] < 0) call.skipOriginal(0); },
    after(_ctx, call) { call.replaceResult(call.result ?? 0); },
  },
  failure: "propagate",
  // invokeOriginal: (receiver, args) => ... // при нестандартном способе вызова
});
void ilHook.ready.then(() => console.log(ilHook.active));
// Внутри async-функции можно написать: await ilHook.ready;
// root.dispose(): вызовет method.revert() (нужна поддержка конкретного Bridge).
```

`Il2CppBridgeLike` должен предоставлять `perform(callback)` и `domain.assembly(name).image.class(name).method(name)`. У метода требуются `invoke(...args)`, `revert()`, `.implementation`, опционально `.overload(...)`. Правильность `invoke/revert` **зависит от версии** `frida-il2cpp-bridge`; mock-успех не подтверждает реальную эксплуатацию.

### 12.4. Общий синтаксис Java/IL2CPP: `ManagedCall`

В обоих адаптерах протокол одинаков:

| Синтаксис в `callbacks` | Действие |
| --- | --- |
| `before(ctx, call)` | Синхронный callback **перед** оригинальным методом (с собственной Nexus-транзакцией). |
| `after(ctx, call)` | Синхронный callback **после** оригинала (с другой Nexus-транзакцией). |
| `call.receiver` | `this` перехваченного метода; borrowed ссылка. |
| `call.args` | **Поверхностная** копия массива аргументов. |
| `call.replaceArg(index, value)` | Замена аргумента верхнего уровня **только в `before`**. |
| `call.skipOriginal(result)` | **Только в `before`**: пропустить оригинал и задать результат (для `void` передайте `undefined`). |
| `call.result` | Текущее возвращаемое значение; `undefined`, если ещё не установлено. |
| `call.replaceResult(value)` | Установить/заменить результат (в `before` или `after`). |
| `call.skipped` | Был ли пропущен оригинал. |

По умолчанию `failure: "passthrough"`: при ошибке в `before` ошибка сообщается через `onError`, оригинал вызывается с **исходным** массивом аргументов; при ошибке в `after` возвращается результат, зафиксированный **до `after`**. При `failure: "propagate"` выбрасывается `ManagedHookFailure` с `phase: "before" | "after"`, `originalCalled`, `cause`. Успешная транзакция `before` не включает original-метод в свой Commit. Замена элемента `call.args[0]` — подготовленная модификация копии, а изменение `call.args[0].field` — **немедленная внешняя мутация**, которую Nexus не откатит. `ManagedCall` недействителен после завершения вызова; re-entry может быть ограничен guard'ом.

## 13. Шпаргалка экспортируемых типов и API

**Core — классы/ошибки:** `Dispatcher`, `Context`, `Handler`, `Registration`, `Scope`, `Store`, `Event`, `ConflictResolver`, `ConflictRuleHandle`, `ConflictError`, `FeedbackError`, `BufferOverflowError`, `RegistrationSetupError`, `PostCommitReactionError`.

**Core — типы:** `StoreOptions<T>`, `Change<T>`, `EventOptions`, `EventOccurrence<T>`, `ReadSnapshot`, `ReadContext`, `EffectOptions`, `RecordPolicy` (`"changed" | "always"`), `WriteOptions`, `Delivery` (`"latest" | "each"`), `Execution` (`"inline" | "deferred"`), `Source` (`Store | Event`), `RegistrationOptions`, `DispatcherOptions`, `BufferOptions`, `ConflictFallback`, `ConflictRule`, `CommitOutcome` (`{ revision: number; changes: number }`, тип результата внутреннего Commit).

**Frida — функции и ошибка:** `attachHook`, `observeModule`, `attachJavaHook`, `attachIl2CppHook`, `ManagedHookFailure`.

**Frida — типы:** `NativePointerLike`, `FridaModule`, `FridaInvocation`, `FridaRuntime`, `HookCallbacks<TState>`, `JavaBridgeLike`, `JavaClassLike`, `JavaMethodLike`, `Il2CppBridgeLike`, `Il2CppClassLike`, `Il2CppMethodLike`, `ManagedCall<Args, Result>`, `ManagedHookCallbacks<Args, Result>`, `ManagedHookHandle`, `ManagedFailurePolicy` (`"passthrough" | "propagate"`).

**Что запускать:** `npm run demo`, `npm run events-demo`, `npm run conflict-demo`, `npm run collatz-demo`, `npm run test:all`, `npm run build:agent`. Исходные иллюстрации — `examples/`; детали реализации и ограничений — `README.md` и `docs/ARCHITECTURE.md` проекта.

---

**Правило на каждый день:** данные меняйте через `Context`, подписки размещайте в `Scope`, необратимые действия переносите в `ctx.effect()`, а входы Frida/Java/IL2CPP считайте короткоживущими и синхронными. Так сохраняются атомарность Nexus, управляемая очистка и предсказуемые реакции.

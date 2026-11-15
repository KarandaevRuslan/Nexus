# Dining Philosophers — React + Nexus

Отдельное React-приложение на **Nexus v0.1.20**. Оно размещено **рядом с** `examples/`, а не внутри `src/`. Код ядра Nexus не меняется: приложение импортирует `nexus/core` **из установленного `.tgz`**, а не по относительному пути `../src/core`.

Основа проекта — присланный JavaFX-проект `DinningPhilosophers.zip`. Сохранены круглый стол, пять философов по умолчанию, независимые периоды размышления/еды, случайный выбор свободного места, атомарное получение обеих вилок, журнал событий, изменение времени еды и кнопки Start / Pause / Continue / Stop.

## Windows PowerShell: запуск

Из **корня проекта Nexus**:

```powershell
npm ci
npm run examples:install
npm run philosophers:dev
```

`examples:install` сначала собирает архив `nexus-0.1.20.tgz`, затем запускает `npm ci` для обоих примеров. `dining-philosophers/package.json` использует `"nexus": "file:../nexus-0.1.20.tgz"`. При выносе приложения в отдельный репозиторий поменяйте путь на скачанный архив релиза либо URL GitHub Release.

Откройте URL, который покажет Vite (обычно **http://localhost:5173**).

Продакшн-сборка:

```powershell
npm run philosophers:build
npm --prefix dining-philosophers run preview
```

Vite собирает исходники React-приложения и подключённый пакет `nexus` из `node_modules`. Код `../src/core` не импортируется, путь к исходникам Nexus не разрешён в Vite вручную.

Проверка симуляции **без React/Vite**, из корня Nexus после `npm run prepare:examples` (при установленном TypeScript):

```powershell
npm run philosophers:test
```

Стандартные тесты Nexus: `npm test`.

## Что реализовано

- Философы **3–10**, по умолчанию **5**. На каждого приходится одно место и одна вилка, как в Java-оригинале.
- `Think → RequestSeat → WaitForks → Eat → Think` — переходы управляются событиями Nexus.
- Во время симуляции изменение `eatMs` влияет на **новые** приёмы пищи; уже начатые не прерываются.
- Время в модели виртуальное: `setInterval()` в React только отправляет импульсы, увеличивая виртуальное время на `75 ms × speed`. Пауза замораживает время. Физических потоков или busy-loop нет.
- Детерминированный seed обеспечивает повторяемость и позволяет проверять сценарии.
- Процесс захвата **двух** вилок одним Commit — центральное условие безопасности.
- FIFO-очередь с **резервированием вилок старшими ожидающими** снижает риск starvation. Независимые пары могут есть одновременно.
- Логи ограничены последними 160 сообщениями; показаны количество обедов, ожидание, текущая конкуренция за ресурсы.
- Кнопки сохранения/загрузки настроек используют `localStorage`/JSON вместо XML-файла исходного JavaFX. Изменять seed и количество философов можно только после Stop.

## Архитектура

```text
nexus/
├── src/                      # Только библиотека Nexus
├── examples/                 # Примеры библиотеки
└── dining-philosophers/      # Отдельный пакетный consumer
    ├── domain/
    │   ├── types.ts          # Состояние стола, философов, конфигурация
    │   ├── random.ts         # Воспроизводимый выбор места/длительности
    │   ├── table.ts          # Чистая логика переходов и виртуального времени
    │   ├── allocator.ts      # FIFO арбитр с атомарной выдачей вилок
    │   └── invariants.ts     # Проверка корректности ресурсов
    ├── nexus/
    │   ├── create-simulation.ts      # Composition root / Engine API
    │   └── handlers/
    │       ├── clock-handler.ts      # Event<Pulse> → Store<Table> + Event<Rebalance>
    │       ├── fork-arbiter.ts       # Event<Rebalance> → Store<Table> + Event<MealStarted>
    │       └── observers.ts         # Обновление read model и уведомления
    ├── ui/
    │   ├── components/              # Стол, философы, лог, управление
    │   ├── hooks/use-dining.ts      # React lifecycle и внешние тики
    │   └── styles/                  # Стили распределены по областям
    ├── tests/run.cjs               # Проверки инвариантов, конкуренции, fairness
    ├── tsconfig.model.json         # Тестирование без React-зависимостей
    ├── tsconfig.json               # Типизация React-приложения
    └── package.json                # Собственные React/Vite зависимости
```

**Нет** глобального `Waiter.getInstance()`, централизованного mutable singleton и доступа UI к таблице с правом записи. Изменения проходят только через `Dispatcher.inline()` / `Context.set()`; действия через `Event<T>`; UI подписан на post-commit состояние.

## Движок событий

```text
React interval → tick(ms)
                ↓
          Event<Pulse>
                ↓
           ClockHandler
                ↓
     Store<TableState> (один Commit)
                +
         Event<Rebalance>
                ↓
            ForkArbiter
                ↓
  atomic Store<TableState> (оба fork сразу)
                +
      Event<MealStarted> (каждый факт отдельно)
                ↓
             Observer
                ↓
         React read model
```

Правила состояния — **чистые функции** (`domain/`). Никаких `setTimeout()`, DOM-объектов или React-кода внутри `Handler.run()`.

## Соответствие Java-исходнику и отличия

| Java | React + Nexus |
|---|---|
| `Philosopher extends Thread` | Состояние философа + события виртуального времени |
| `Fork` + `Semaphore` | `forks: (ownerId\|null)[]`, атомарное выделение |
| `Seat` | `seats: (ownerId\|null)[]`, выбор из свободных |
| `Waiter` singleton | Чистый `allocateForks` + отдельный `ForkArbiter` Handler |
| `Thread.sleep()` | `dueAt` в виртуальном времени, без блокировки UI |
| `Thread.suspend/resume` | Статус симуляции `paused/running`, без небезопасных примитивов |
| JavaFX/FXML `CanvasPane` | React + интерактивная SVG-схема стола |
| `MessageService` / logs queue | Ограниченный журнал в Store, React-компонент |
| XML `config.cfg` | JSON в `localStorage` браузера |

**Не полная побитовая копия Java-программы**: настоящие Java-потоки не используются, выбор мест воспроизводим по seed, а FIFO-резервирование справедливее spin-попыток оригинального `Waiter`. Эти отличия сознательные.

## Ограничения

Результаты показывают корректность **логической конкурентности** на одном JavaScript-потоке. Не доказаны свойства многопоточной синхронизации, а конечный стресс-прогон не является математическим доказательством отсутствия starvation при любом расписании. В `React.StrictMode` экземпляр движка пересоздаётся при повторном цикле эффектов разработки и освобождается вместе с компонентом. Любые сторонние async-процессы, начавшиеся до `Scope.dispose()`, не отменяются автоматически Nexus.

/** Public contract regressions for Nexus v0.1.5. */
import { Context, Dispatcher, Handler, PostCommitReactionError, type ReadContext, type Store } from "../src/core";
import { eq, ok, throws, values } from "./helpers";

// Compile-time assertion: a ReadContext cannot stage writes or effects.
function readOnlyTypeContract(ctx: ReadContext, store: Store<number>): void {
  ctx.read(store);
  ctx.version(store);
  ctx.change(store);
  ctx.before.read(store);
  ctx.after.read(store);
  // @ts-expect-error ReadContext has no set
  ctx.set(store, 123);
  // @ts-expect-error ReadContext has no update
  ctx.update(store, (v: number) => v + 1);
  // @ts-expect-error ReadContext has no effect
  ctx.effect(() => {});
}
void readOnlyTypeContract;

async function guardIsActuallyReadOnly(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), output = d.store(0);
  let guardCount = 0, runCount = 0;
  let leaked: ReadContext | undefined;
  class OnlyGuard extends Handler {
    override when(ctx: ReadContext): boolean {
      guardCount++;
      leaked = ctx;
      eq(ctx.read(source), 1);
      eq(ctx.after.read(source), 1);
      eq(ctx.change(source)?.kind, "changed");
      ok(Object.isFrozen(ctx));
      eq(typeof (ctx as unknown as { set?: unknown }).set, "undefined");
      eq(typeof (ctx as unknown as { effect?: unknown }).effect, "undefined");
      return false;
    }
    override run(_ctx: Context): void { runCount++; }
  }
  d.register(new OnlyGuard(), { on: { any: [source] }, execution: "inline" });
  d.inline(ctx => ctx.set(source, 1));
  eq(guardCount, 1);
  eq(runCount, 0);
  eq(values(d, output), 0);
  eq(d.currentRevision, 1);
  // The restricted view cannot be used after its underlying Context expires.
  throws(() => leaked!.read(source));
}

async function unsafeCastCannotWrite(): Promise<void> {
  const d = new Dispatcher();
  const trigger = d.store(0), target = d.store(0);
  let calledRun = false;
  class MaliciousGuard extends Handler {
    override when(ctx: ReadContext): boolean {
      // Deliberately bypass TypeScript. Runtime capability still has no mutators.
      (ctx as unknown as Context).set(target, 777);
      return true;
    }
    override run(): void { calledRun = true; }
  }
  d.register(new MaliciousGuard(), { on: { any: [trigger] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(trigger, 1)), PostCommitReactionError);
  eq(calledRun, false);
  eq(values(d, target), 0);
}

async function constructorDefaultsAndInitial(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(2), b = d.store(4), output = d.store(0);
  let runs = 0;
  class Calculate extends Handler {
    constructor(
      private readonly a: Store<number>,
      private readonly b: Store<number>,
      private readonly output: Store<number>,
    ) {
      super({ on: { any: [a, b] }, execution: "inline", initial: true });
    }
    override run(ctx: Context): void {
      runs++;
      ctx.set(this.output, ctx.read(this.a) + ctx.read(this.b));
    }
  }
  const h = new Calculate(a, b, output);
  const reg = d.register(h);
  eq(reg.execution, "inline");
  eq(reg.delivery, "latest");
  eq(reg.sources.length, 2);
  eq(runs, 1);
  eq(values(d, output), 6);
  d.inline(ctx => ctx.set(a, 10));
  eq(values(d, output), 14);
  eq(runs, 2);
}

async function registerOverrideReplacesDefaults(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0), b = d.store(0);
  let runs = 0;
  class Observe extends Handler {
    constructor() { super({ on: { any: [a] }, execution: "inline", initial: true }); }
    override run(): void { runs++; }
  }
  const r = d.register(new Observe(), {
    on: { any: [b] }, execution: "deferred", initial: false,
  });
  eq(r.execution, "deferred");
  eq(r.sources[0], b);
  eq(runs, 0);
  d.inline(ctx => ctx.set(a, 1));
  d.flush();
  eq(runs, 0);
  d.inline(ctx => ctx.set(b, 1));
  eq(runs, 0);
  d.flush();
  eq(runs, 1);
}

async function constructorConfigCaptured(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0), b = d.store(0);
  const sources = [a];
  const buffer = { capacity: 2, overflow: "drop-oldest" as const };
  const options = { on: { any: sources }, execution: "deferred" as const,
    delivery: "each" as const, buffer };
  let runs = 0;
  class Listen extends Handler {
    constructor() { super(options); }
    override run(): void { runs++; }
  }
  const handler = new Listen();
  sources[0] = b;
  buffer.capacity = 99;
  eq((handler.options.on as { any: readonly Store<any>[] }).any[0], a);
  eq(handler.options.buffer?.capacity, 2);
  ok(Object.isFrozen(handler.options));
  const r = d.register(handler);
  eq(r.sources[0], a);
  eq(r.buffer.capacity, 2);
  d.inline(ctx => ctx.set(a, 1));
  d.flush();
  eq(runs, 1);
}

async function deliveryOverrideDiscardsObsoleteBuffer(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  let runs = 0;
  class Observer extends Handler {
    constructor() { super({
      on: { any: [source] },
      delivery: "each",
      buffer: { capacity: 1, overflow: "reject" },
    }); }
    override run(): void { runs++; }
  }
  const reg = d.register(new Observer(), { delivery: "latest", execution: "deferred" });
  eq(reg.delivery, "latest");
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  d.flush();
  eq(runs, 1);
}

async function oneInstancePerActiveRegistration(): Promise<void> {
  const d1 = new Dispatcher(), d2 = new Dispatcher();
  let disposed = 0;
  class One extends Handler {
    override run(): void {}
    override onDispose(): void { disposed++; }
  }
  const handler = new One();
  const r1 = d1.register(handler);
  throws(() => d1.register(handler));
  throws(() => d2.register(handler));
  r1.dispose();
  r1.dispose();
  eq(disposed, 1);
  const r2 = d2.register(handler);
  eq(r2.active, true);
  r2.dispose();
  eq(disposed, 2);
}

async function failedInitialExecutionReleasesInstance(): Promise<void> {
  const d = new Dispatcher();
  let disposed = 0;
  class Explodes extends Handler {
    constructor() { super({ initial: true, execution: "inline" }); }
    override run(): void { throw new Error("initial failure"); }
    override onDispose(): void { disposed++; }
  }
  const h = new Explodes();
  throws(() => d.register(h));
  eq(disposed, 1);
  // The previous failed registration does not keep the instance claimed.
  const r = d.register(h, { initial: false });
  r.dispose();
  eq(disposed, 2);
}

async function scopeInheritsDefaults(): Promise<void> {
  const d = new Dispatcher();
  const s = d.scope();
  const input = s.store(0);
  let runs = 0;
  class Listener extends Handler {
    constructor() { super({ on: { any: [input] }, execution: "inline" }); }
    override run(): void { runs++; }
  }
  s.register(new Listener());
  d.inline(ctx => ctx.set(input, 1));
  eq(runs, 1);
  s.dispose();
}

export const contractCases: Array<[string, () => Promise<void>]> = [
  ["guard receives a real read-only runtime capability", guardIsActuallyReadOnly],
  ["unsafe guard cast cannot write", unsafeCastCannotWrite],
  ["Handler super options and initial default", constructorDefaultsAndInitial],
  ["register overrides Handler defaults", registerOverrideReplacesDefaults],
  ["Handler options capture arrays and buffer", constructorConfigCaptured],
  ["delivery override discards obsolete each buffer", deliveryOverrideDiscardsObsoleteBuffer],
  ["single active registration across Dispatchers", oneInstancePerActiveRegistration],
  ["failed inline initial registration is rolled back", failedInitialExecutionReleasesInstance],
  ["Scope.register inherits Handler defaults", scopeInheritsDefaults],
];

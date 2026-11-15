import { ReadContext, Context, Dispatcher, Handler } from "../src/core";
import { attachHook, observeModule } from "../src/frida-adapter";
import type { FridaRuntime, FridaModule, NativePointerLike, FridaInvocation } from "../src/frida-adapter";
import { eq, ok } from "./helpers";

class Ptr implements NativePointerLike {
  constructor(readonly n: number) {}
  add(offset: number): Ptr { return new Ptr(this.n + offset); }
  toString(): string { return `0x${this.n.toString(16)}`; }
  toInt32(): number { return this.n; }
  isNull(): boolean { return this.n === 0; }
  equals(other: NativePointerLike): boolean { return this.toString() === other.toString(); }
}
class FakeFrida {
  observer: { onAdded(module: FridaModule): void; onRemoved(module: FridaModule): void } | undefined;
  attached = new Map<string, { onEnter?: (this: FridaInvocation, args: NativePointerLike[]) => void;
    onLeave?: (this: FridaInvocation, result: NativePointerLike) => void }>();
  countDetach = 0;
  readonly api: FridaRuntime = {
    Process: {
      attachModuleObserver: cb => { this.observer = cb; return { detach: () => { this.observer = undefined; } }; },
    },
    Interceptor: {
      attach: (address, cb) => {
        const key = address.toString();
        this.attached.set(key, cb);
        return { detach: () => { this.attached.delete(key); this.countDetach++; } };
      },
    },
  };
  call(address: Ptr, args: Ptr[], body: () => number): number {
    const callback = this.attached.get(address.toString());
    const invocation: FridaInvocation = { threadId: 123 };
    callback?.onEnter?.call(invocation, args);
    const ret = body();
    callback?.onLeave?.call(invocation, new Ptr(ret));
    return ret;
  }
}

async function case10(): Promise<void> {
  const d = new Dispatcher();
  const rt = new FakeFrida();
  const root = d.scope();
  let enterSeen = "";
  let leaveSeen = "";
  let loaded = 0;
  observeModule(d, root, rt.api, "libgame.so", (module, child) => {
    loaded++;
    attachHook<{ saved?: string }>(d, child, rt.api, module.base.add(4), {
      onEnter(_ctx, args, state) { state.saved = args[0]!.toString(); },
      onLeave(_ctx, retval, state) { enterSeen = state.saved!; leaveSeen = retval.toString(); },
    });
  });
  const module = { name: "libgame.so", base: new Ptr(0x1000), size: 100 };
  rt.observer?.onAdded(module);
  eq(loaded, 1);
  rt.call(new Ptr(0x1004), [new Ptr(42)], () => 7);
  eq(enterSeen, "0x2a");
  eq(leaveSeen, "0x7");
  rt.observer?.onRemoved(module);
  eq(rt.attached.size, 0);
  eq(rt.countDetach, 1);
  root.dispose();
  ok(!rt.observer);
}

async function case11(): Promise<void> {
  // Full simulated native hook -> Store commit -> inline Handler -> native addItem(Diamond).
  const d = new Dispatcher();
  const rt = new FakeFrida();
  const root = d.scope();
  const GOLD = 1001, DIAMOND = 1002;
  const initAddress = new Ptr(0x1004), addAddress = new Ptr(0x1008);
  const inventory = new Map<string, Map<number, number>>();
  function count(address: string, id: number): number { return inventory.get(address)?.get(id) ?? 0; }
  function addNative(address: Ptr, id: number, amount: number): number {
    return rt.call(addAddress, [address, new Ptr(id), new Ptr(amount)], () => {
      const items = inventory.get(address.toString()) ?? new Map<number, number>();
      const next = (items.get(id) ?? 0) + amount;
      if (next < 0) return 0;
      items.set(id, next);
      inventory.set(address.toString(), items);
      return 1;
    });
  }
  type Player = { address: string | null; generation: number; gold: number | null };
  const player = root.store<Player>({ address: null, generation: 0, gold: null });
  let handlerRuns = 0;
  class Sync extends Handler {
    override when(ctx: ReadContext): boolean {
      const change = ctx.change(player);
      if (!change) return false;
      const before = ctx.before.read(player);
      const after = ctx.after.read(player);
      return Boolean(after.address && after.gold !== null && after.gold !== before.gold);
    }
    run(ctx: Context): void {
      handlerRuns++;
      const state = ctx.read(player);
      if (state.address === null || state.gold === null) return;
      const address = new Ptr(Number.parseInt(state.address, 16));
      const desired = state.gold >= 10000 ? 5000 : Math.round(state.gold / 2);
      ctx.effect(() => { const delta = desired - count(state.address!, DIAMOND); if (delta) addNative(address, DIAMOND, delta); });
    }
  }
  root.register(new Sync(), { on: { any: [player] }, delivery: "each", execution: "inline" });
  attachHook<{ address?: string }>(d, root, rt.api, initAddress, {
    onEnter(_ctx, args, state) { state.address = args[0]!.toString(); },
    onLeave(ctx, _ret, state) { ctx.update(player, prev => ({ address: state.address!, generation: prev.generation + 1, gold: null })); },
  });
  attachHook<{ address?: string; isGold?: boolean }>(d, root, rt.api, addAddress, {
    onEnter(ctx, args, state) {
      const current = ctx.read(player);
      if (args[1]!.toInt32() === GOLD && current.address === args[0]!.toString()) {
        state.isGold = true;
        state.address = args[0]!.toString();
      }
    },
    onLeave(ctx, ret, state) {
      if (!state.isGold || !state.address || ret.toInt32() === 0) return;
      const current = ctx.read(player);
      ctx.set(player, { ...current, gold: count(state.address, GOLD) });
    },
  });
  const p1 = new Ptr(0xabc), p2 = new Ptr(0xdef);
  rt.call(initAddress, [p1], () => 1);
  addNative(p2, GOLD, 3000);
  eq(handlerRuns, 0);
  addNative(p1, GOLD, 200);
  eq(handlerRuns, 1);
  eq(count(p1.toString(), DIAMOND), 100); // synchronized before native addItem returns
  addNative(p1, GOLD, 10800);
  eq(count(p1.toString(), DIAMOND), 5000);
  eq(handlerRuns, 2); // nested Diamond calls did not re-trigger Gold sync
  root.dispose();
  eq(rt.attached.size, 0);
}


export const fridaCases: Array<[string, () => Promise<void>]> = [
  ["Frida adapter mock lifetime", case10],
  ["Frida inventory integration, nested hook", case11],
];

/**
 * Illustrative Frida agent entry point.
 * IMPORTANT: Replace offsets, ABI and item IDs with values verified for your target.
 * This file compiles with the project's structural Frida interfaces; the build:agent script produces a standalone Native bundle. Hardware runtime
 * compatibility remains NOT RUN unless tested on an actual device.
 */
import { ReadContext, Context, Dispatcher, Handler, type Store } from "../src/core";
import { attachHook, observeModule } from "../src/frida/native";
import type { FridaRuntime, NativePointerLike } from "../src/frida/native";

// The declarations below refer to globals supplied by the actual Frida runtime.
declare const Process: FridaRuntime["Process"];
declare const Interceptor: FridaRuntime["Interceptor"];
declare const ptr: (address: string) => NativePointerLike;
declare const NativeFunction: new (
  address: NativePointerLike,
  returnType: string,
  argumentTypes: readonly string[],
) => (...args: unknown[]) => number;

const LIBRARY = "libgame.so";
const OFFSETS = {
  initializePlayer: 0x123456,
  addItem: 0x234567,
  getItemCount: 0x345678,
};
const GOLD = 1001;
const DIAMOND = 1002;

interface PlayerState {
  readonly address: string | null;
  readonly generation: number;
  readonly gold: number | null;
}

function targetDiamonds(gold: number): number {
  return gold >= 10_000 ? 5_000 : Math.round(
    5000 * Math.expm1(4 * Math.max(0, gold) / 10_000) / Math.expm1(4),
  );
}

class GoldSync extends Handler {
  constructor(
    private readonly player: Store<PlayerState>,
    private readonly addItem: (player: NativePointerLike, item: number, amount: number) => number,
    private readonly getItemCount: (player: NativePointerLike, item: number) => number,
  ) { super(); }

  override when(ctx: ReadContext): boolean {
    const change = ctx.change(this.player);
    if (!change) return false;
    const before = ctx.before.read(this.player);
    const after = ctx.after.read(this.player);
    return after.address !== null && after.gold !== null && before.gold !== after.gold;
  }

  override run(ctx: Context): void {
    const state = ctx.read(this.player);
    if (state.address === null || state.gold === null) return;
    const address = ptr(state.address);
    const desired = targetDiamonds(state.gold);
    ctx.effect(() => {
      const current = this.getItemCount(address, DIAMOND);
      const delta = desired - current;
      // This demonstration assumes addItem accepts signed deltas.
      if (delta !== 0) this.addItem(address, DIAMOND, delta);
    });
  }
}

const dispatcher = new Dispatcher();
const scope = dispatcher.scope();
// Store only the pointer address as a primitive string, not an opaque Frida object.
const player = scope.store<PlayerState>({ address: null, generation: 0, gold: null });
const runtime: FridaRuntime = { Process, Interceptor };

observeModule(dispatcher, scope, runtime, LIBRARY, (module, moduleScope) => {
  const initAddress = module.base.add(OFFSETS.initializePlayer);
  const addAddress = module.base.add(OFFSETS.addItem);
  const getCountAddress = module.base.add(OFFSETS.getItemCount);

  const rawAdd = new NativeFunction(addAddress, "int", ["pointer", "int", "int"]);
  const rawCount = new NativeFunction(getCountAddress, "int", ["pointer", "int"]);
  const addItem = (who: NativePointerLike, id: number, delta: number): number => rawAdd(who, id, delta);
  const getItemCount = (who: NativePointerLike, id: number): number => rawCount(who, id);

  moduleScope.register(new GoldSync(player, addItem, getItemCount), {
    on: { any: [player] }, delivery: "each", execution: "inline",
  });

  attachHook<{ address?: NativePointerLike }>(dispatcher, moduleScope, runtime, initAddress, {
    onEnter(_ctx, args, invocation) { invocation.address = args[0]; },
    onLeave(ctx, _retval, invocation) {
      const address = invocation.address;
      if (!address || address.isNull()) return;
      ctx.update(player, previous => ({
        address: address.toString(), generation: previous.generation + 1, gold: null,
      }));
    },
  });

  attachHook<{ address?: NativePointerLike; generation?: number }>(dispatcher, moduleScope, runtime, addAddress, {
    onEnter(ctx, args, invocation) {
      const current = ctx.read(player);
      if (args[1]?.toInt32() !== GOLD || current.address !== args[0]?.toString()) return;
      invocation.address = args[0];
      invocation.generation = current.generation;
    },
    onLeave(ctx, retval, invocation) {
      const who = invocation.address;
      if (!who || retval.toInt32() === 0) return;
      const previous = ctx.read(player);
      if (previous.address !== who.toString() || previous.generation !== invocation.generation) return;
      ctx.set(player, { ...previous, gold: getItemCount(who, GOLD) });
    },
  });
});

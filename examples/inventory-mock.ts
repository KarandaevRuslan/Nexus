/**
 * Minimal runnable demonstration: an inventory change commits Gold,
 * triggering an inline Handler that calls the native-like addItem function.
 * No Frida API required; real callback wiring is covered by tests/frida.spec.ts.
 */
import { ReadContext, Context, Dispatcher, Handler, type Store } from "../src/core";

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

class InventoryMock {
  private readonly balances = new Map<number, number>();
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly player: Store<PlayerState>,
    private readonly address: string,
  ) {}

  get(item: number): number { return this.balances.get(item) ?? 0; }

  /** Models a game method and a successful Gold onLeave callback. */
  addItem(item: number, amount: number): void {
    const next = this.get(item) + amount;
    if (next < 0) throw new Error("Inventory refuses negative balance");
    this.balances.set(item, next);

    if (item === GOLD) {
      this.dispatcher.inline(ctx => {
        const state = ctx.read(this.player);
        if (state.address === this.address) {
          ctx.set(this.player, { ...state, gold: this.get(GOLD) });
        }
      });
    }
  }
}

class GoldSync extends Handler {
  constructor(
    private readonly player: Store<PlayerState>,
    private readonly inventory: InventoryMock,
  ) { super(); }

  override when(ctx: ReadContext): boolean {
    const change = ctx.change(this.player);
    if (!change) return false;
    const before = ctx.before.read(this.player);
    const after = ctx.after.read(this.player);
    return after.gold !== null && after.address !== null && before.gold !== after.gold;
  }

  override run(ctx: Context): void {
    const state = ctx.read(this.player);
    if (state.gold === null) return;
    const desired = targetDiamonds(state.gold);
    ctx.effect(() => {
      const delta = desired - this.inventory.get(DIAMOND);
      if (delta !== 0) this.inventory.addItem(DIAMOND, delta);
    });
  }
}

const dispatcher = new Dispatcher();
const scope = dispatcher.scope();
const player = scope.store<PlayerState>({ address: null, generation: 0, gold: null });
const inventory = new InventoryMock(dispatcher, player, "0xabc");
scope.register(new GoldSync(player, inventory), {
  on: { any: [player] }, delivery: "each", execution: "inline",
});

dispatcher.inline(ctx => ctx.set(player, {
  address: "0xabc", generation: 1, gold: null,
}));

inventory.addItem(GOLD, 5_000);
console.log("Gold:", inventory.get(GOLD), "Diamond:", inventory.get(DIAMOND));

inventory.addItem(GOLD, 7_000);
console.log("Gold:", inventory.get(GOLD), "Diamond:", inventory.get(DIAMOND));

if (inventory.get(DIAMOND) !== targetDiamonds(inventory.get(GOLD))) {
  throw new Error("Gold-to-Diamond synchronization failed");
}
scope.dispose();

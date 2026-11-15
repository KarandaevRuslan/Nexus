import { Context, Dispatcher, Handler, type ReadContext } from "../src/core";

/** One reusable asynchronous workflow, without smuggling an event through a Store. */
export function createDamageWorkflow(initialHealth = 100) {
  const dispatcher = new Dispatcher();
  const scope = dispatcher.scope();
  const damage = scope.event<{ amount: number }>();
  const health = scope.store(initialHealth);
  const audit = scope.store<readonly string[]>([]);

  class Audit extends Handler {
    override run(ctx: Context): void {
      const current = ctx.read(health);
      ctx.update(audit, lines => [...lines, `Health after damage: ${current}`]);
    }
  }
  const auditRegistration = scope.register(new Audit(), { execution: "deferred" });

  class ApplyDamage extends Handler {
    constructor() { super({ on: { any: [damage] }, execution: "deferred", delivery: "each" }); }

    override when(ctx: ReadContext): boolean {
      const occurrence = ctx.event(damage);
      return occurrence !== undefined && occurrence.value.amount >= 0;
    }

    override run(ctx: Context): void {
      const amount = ctx.event(damage)!.value.amount;
      ctx.update(health, current => Math.max(0, current - amount));
      // Audit runs only if THIS Handler's transaction commits.
      ctx.request(auditRegistration);
    }
  }
  scope.register(new ApplyDamage());

  return {
    async apply(amount: number) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("damage must be a non-negative safe integer");
      await scope.submitAndWait(ctx => ctx.emit(damage, { amount }));
      return dispatcher.inline(ctx => ({ health: ctx.read(health), audit: [...ctx.read(audit)] }));
    },
    dispose() { scope.dispose(); },
  };
}

import { Context, Dispatcher, Handler } from "../src/core";

function runExample(reverse: boolean): void {
  const dispatcher = new Dispatcher(); // Unspecified collisions default to reject.
  const A = dispatcher.store(10);
  const trigger = dispatcher.store<void>(undefined);

  class Multiply extends Handler {
    override run(ctx: Context): void {
      ctx.update(A, value => value * 2);
    }
  }
  class Add extends Handler {
    override run(ctx: Context): void {
      ctx.update(A, value => value + 3);
    }
  }

  const multiply = dispatcher.register(new Multiply(), {
    on: { any: [trigger] }, execution: "inline",
  });
  const add = dispatcher.register(new Add(), {
    on: { any: [trigger] }, execution: "inline",
  });

  const rule = dispatcher.conflicts.add({
    store: A,
    between: [multiply, add],
    resolve: {
      strategy: "sequence",
      order: reverse ? [add, multiply] : [multiply, add],
    },
  });

  dispatcher.inline(ctx => ctx.set(trigger, undefined, { record: "always" }));
  console.log(reverse ? "Add then Multiply:" : "Multiply then Add:",
    dispatcher.inline(ctx => ctx.read(A)));
  rule.dispose();
}

runExample(false); // 23
runExample(true);  // 26

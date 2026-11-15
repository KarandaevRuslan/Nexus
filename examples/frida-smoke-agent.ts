/** Safe, offset-free Frida loading smoke. No native hook is installed.
 * It confirms that a real Frida JS runtime can execute the packaged Core.
 * The Native, Java and IL2CPP Bridge lifecycle tests require separate fixtures.
 */
import { Dispatcher } from "../src/core";

declare const send: (payload: unknown) => void;

const dispatcher = new Dispatcher();
const state = dispatcher.store(0);
dispatcher.inline(ctx => ctx.set(state, 1));
send({ protocol: "nexus-smoke-v1", revision: dispatcher.currentRevision,
  value: dispatcher.inline(ctx => ctx.read(state)) });

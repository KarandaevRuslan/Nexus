import type { JavaBridgeLike, JavaMethodLike } from "./types";

/** Hook ownership is per Java Bridge runtime; the Java method's native `handle`
 * is used when exposed by frida-java-bridge. For minimal test bridges without
 * `handle`, the class/method/signature is a deliberately conservative fallback.
 * Same-runtime hooks through different overload wrapper objects are rejected.
 */
const activeByBridge = new WeakMap<JavaBridgeLike, Map<string, symbol>>();
const activeByObject = new WeakMap<JavaMethodLike, symbol>();

export function claimJavaMethod(
  java: JavaBridgeLike,
  method: JavaMethodLike,
  selector: readonly [string, string, readonly string[]],
): () => void {
  const pointer = method.handle;
  const handle = pointer == null ? null : String(pointer);
  const key = handle === null
    ? `signature:${JSON.stringify(selector)}`
    : `handle:${handle}`;
  let entries = activeByBridge.get(java);
  if (!entries) {
    entries = new Map<string, symbol>();
    activeByBridge.set(java, entries);
  }
  if (entries.has(key) || activeByObject.has(method)) {
    throw new Error(`Java method already has a Nexus hook (${key})`);
  }
  const token = Symbol("Nexus Java hook");
  entries.set(key, token);
  activeByObject.set(method, token);
  return () => {
    if (entries!.get(key) === token) entries!.delete(key);
    if (activeByObject.get(method) === token) activeByObject.delete(method);
  };
}

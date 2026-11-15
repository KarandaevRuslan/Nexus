/**
 * v0.1.2 invariant: by default, StateTable owns a detached, deeply frozen copy.
 * Only primitives, arrays and plain data objects are supported. This is deliberately
 * strict: Object.freeze(Map) does NOT prevent Map.set(), and cloning an arbitrary
 * native-backed class instance would destroy its identity/behavior.
 *
 * Opaque values require an explicit StoreOptions.storage = 'reference'. Such Stores
 * have weaker isolation guarantees; prefer storing primitives/serializable records.
 */
export function copyAndFreeze<T>(value: T): T {
  const visited = new WeakMap<object, object>();

  function copy(input: unknown): unknown {
    if (input === null || (typeof input !== "object" && typeof input !== "function")) return input;
    if (typeof input === "function") {
      throw new TypeError("Store immutable values cannot contain functions; use storage:'reference'");
    }
    if (visited.has(input)) return visited.get(input);

    const array = Array.isArray(input);
    const proto = Object.getPrototypeOf(input);
    if (!array && proto !== Object.prototype && proto !== null) {
      throw new TypeError("Store immutable values support only plain objects and arrays; use storage:'reference' for opaque objects");
    }
    const output: any = array ? new Array(input.length) : Object.create(proto);
    visited.set(input, output);

    for (const key of Reflect.ownKeys(input)) {
      if (array && key === "length") continue;
      const desc = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in desc)) {
        throw new TypeError("Store immutable values cannot contain getters/setters");
      }
      Object.defineProperty(output, key, {
        value: copy(desc.value),
        enumerable: desc.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(output);
  }

  return copy(value) as T;
}

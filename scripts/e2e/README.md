# Real Frida / ART / Unity IL2CPP validation (manual device gate)

**Status: NOT RUN in this refactoring environment.** A Node.js `vm` smoke or mock
Bridge does not establish native ABI or GC/thread-safety guarantees.

The safe load check never installs a hook and only sends a Nexus revision:

```sh
npm ci
npm run build:agent
npm install --no-save frida # host-side test tool; not a library dependency
FRIDA_DEVICE=usb FRIDA_PID=<owned_test_process_pid> node scripts/e2e/real-frida.cjs
```

For full integration, use a dedicated *owned* Android/Unity test fixture with
version-pinned Frida server/Gadget, Java Bridge and frida-il2cpp-bridge. Never
inject `examples/frida-agent.ts` without replacing its **illustrative** offsets,
ABI and IDs with validated values. Record host + device versions, OS/API level,
Bridge versions, thread IDs, observed callback sequence and failure logs.

Manual test matrix (independently gate each, PASS/FAIL/NOT RUN):

| Runtime | Required scenario | Observable acceptance |
| --- | --- | --- |
| Native Interceptor | successful onEnter/onLeave, per-invocation state, simultaneous threads | state isolated and freed once; no fabricated state on failed onEnter |
| Native Interceptor | throw in onEnter, onLeave, post-commit reaction | declared legacy error policy observed; no leaked listener or invocation state |
| Native Interceptor | nested invocation and Scope.dispose during callback | no use of disposed owner on later callback |
| ART / Java | same overload via two wrapper objects, separate classloaders | identity and duplicate-hook policy match documented registry constraints |
| ART / Java | install error, original, before/after, skipOriginal | same original-called and fallback semantics as mock suite |
| ART / Java | deactivate/restore `.implementation`, synchronous re-entry | implementation restored; no unhandled rejections |
| Unity / IL2CPP | method overload, invoke, `revert()`, original | supported Bridge release documented; restore exactly once |
| Unity / IL2CPP | failure and synchronous re-entry | failure policy stable; no borrowed references cross deferred turns |
| All | dispose/exception paths; repetition under `--unhandled-rejections=strict` host | no unexpected unhandled errors or abandoned registrations |

These scenarios are **specification**, not automated test successes. Build and
CI only verify mock adapters and safe bundle loading. Report real outcomes
separately; do not mark this PR production-ready without full device runs.

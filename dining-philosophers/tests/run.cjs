/** Standalone reproducible tests for the actual Nexus-based simulation model. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The React app is ESM, but the standalone TS test output targets CommonJS.
fs.writeFileSync(path.join(__dirname, '../.test-dist/package.json'), '{"type":"commonjs"}');
const { test } = require('node:test');
const {createDiningSimulation} = require('../.test-dist/nexus/create-simulation.js');
const {makeTable, startTable, advanceTable} = require('../.test-dist/domain/table.js');
const {allocateForks} = require('../.test-dist/domain/allocator.js');
const {checkTableInvariants} = require('../.test-dist/domain/invariants.js');

const config = (count = 5, seed = 42, eatMs = 250) => ({ count, seed, eatMs });
const withEngine = (opts, fn) => { const e = createDiningSimulation(opts); try { fn(e); } finally {e.dispose();} };
const simulate = (e, steps = 500, dt = 50) => { for (let i = 0; i < steps; i++) { e.tick(dt); checkTableInvariants(e.snapshot); } };

test('Default Java-compatible table: five philosophers / seats / forks', () => {
  withEngine(config(), e => {
    assert.equal(e.snapshot.count, 5);
    assert.deepEqual(e.snapshot.forks, [null,null,null,null,null]);
    assert.deepEqual(e.snapshot.seats, [null,null,null,null,null]);
    assert.equal(e.snapshot.status, 'stopped');
  });
});

test('Start, Pause, Resume, Stop and Restart maintain resource invariants', () => {
  withEngine(config(), e => {
    e.start(); simulate(e, 120);
    const before = e.snapshot.timeMs;
    e.pause(); e.tick(1000); assert.equal(e.snapshot.timeMs, before);
    e.resume(); e.tick(75); assert.equal(e.snapshot.timeMs, before + 75);
    e.stop(); assert.deepEqual(e.snapshot.forks, [null,null,null,null,null]);
    assert.equal(e.snapshot.totalMeals, 0);
    e.start(); simulate(e, 100); assert.ok(e.snapshot.totalMeals > 0);
    assert.deepEqual(e.snapshot.philosophers.map(p=>p.id), [1,2,3,4,5]);
  });
});

test('Every active philosopher holds BOTH unique adjacent forks and one unique seat', () => {
  withEngine(config(7, 11, 350), e => { e.start();simulate(e, 1600, 55);assert.ok(e.snapshot.totalMeals > 300); });
});

test('Non-neighboring philosophers eat concurrently', () => {
  withEngine(config(5, 42, 200), e => {
    e.start();simulate(e, 800);assert.equal(e.snapshot.maxConcurrentEating, 2);
  });
});

test('FIFO reservation prevents newer neighboring waiter from overtaking older waiter', () => {
  const t = makeTable(config(5, 40, 200));
  // Fork 1 is held by P3, preventing P1 at seat 0 from obtaining both forks.
  // P2 at seat 1 would otherwise be able to take forks 1 and 2. The reservation
  // policy must not grant P2 a fork required by older queued P1.
  const philosophers = t.philosophers.map(p => ({...p}));
  philosophers[0] = { ...philosophers[0], phase:'waiting-forks', seat:0, waitingSince:10 };
  philosophers[1] = { ...philosophers[1], phase:'waiting-forks', seat:1, waitingSince:20 };
  philosophers[2] = { ...philosophers[2], phase:'eating', seat:4, dueAt:400 };
  const state = { ...t, status:'running', timeMs:40, queue:[1,2], philosophers,
    seats:[1,2,null,null,3], forks:[3,null,null,null,3]};
  // Correct fork mapping for P3 at seat 4 is forks 4 and 0.
  checkTableInvariants(state);
  const {state: next, started} = allocateForks(state);
  assert.deepEqual(started, []);
  assert.deepEqual(next.queue, [1,2]);
});

test('Atomic grant is a single table transition, not two independent fork acquisitions', () => {
  const original = makeTable(config());
  const st = {...original, status:'running', queue:[1], seats:[1,null,null,null,null],
    philosophers:original.philosophers.map((p,i)=>i===0 ? {...p,phase:'waiting-forks',seat:0,waitingSince:5}:p),
    timeMs:55};
  const granted = allocateForks(st);
  assert.deepEqual(granted.started,[1]);
  assert.deepEqual(granted.state.forks.slice(0,2),[1,1]);
  assert.deepEqual(st.forks,[null,null,null,null,null]);
  checkTableInvariants(granted.state);
});

test('Pure reducers do not mutate previous snapshots or published arrays', () => {
  const initial = startTable(makeTable(config()));
  const snapshot = JSON.stringify(initial);
  const after = advanceTable(initial,1500).state;
  assert.equal(JSON.stringify(initial), snapshot);
  assert.notStrictEqual(after.forks, initial.forks);
  assert.notStrictEqual(after.philosophers, initial.philosophers);
});

test('Deterministic executions: same input generates identical states and logs', () => {
  let a,b;
  withEngine(config(5, 800, 300), e => {e.start();simulate(e, 400);a = JSON.stringify(e.snapshot);});
  withEngine(config(5, 800, 300), e => {e.start();simulate(e, 400);b = JSON.stringify(e.snapshot);});
  assert.equal(a,b);
});

test('Many philosophers: each eventually eats in bounded simulation, without modeled deadlock', () => {
  for (const count of [3,4,5,6,7,8,9,10]) {
    for (const seed of [1,7,42,203,65535]) {
      withEngine(config(count, seed, 200), e => {
        e.start();simulate(e, 1400, 50);
        const meals = e.snapshot.philosophers.map(p=>p.meals);
        assert.ok(meals.every(m => m > 0), `${count}/${seed}: starvation in finite run ${meals}`);
        assert.ok(e.snapshot.maxConcurrentEating <= Math.floor(count/2));
        assert.ok(e.snapshot.totalMeals > count * 20);
      });
    }
  }
});

test('Meal-started events are delivered separately, even when grants happen together', () => {
  withEngine(config(5,42,200), e => {
    const started=[];
    const un = e.subscribeMealStarted(ev => started.push(ev));
    e.start();simulate(e, 500);
    const completed = e.snapshot.totalMeals;
    const active = e.snapshot.philosophers.filter(p=>p.phase==='eating').length;
    assert.equal(started.length, completed + active);
    assert.ok(started.every(ev => Number.isInteger(ev.philosopherId) && ev.at >= 0));
    un();
  });
});

test('Subscriptions and disposal stop further observations and operations', () => {
  const e=createDiningSimulation(config());let n=0;
  const unsub=e.subscribe(()=>n++); assert.equal(n,1);
  e.start();assert.ok(n>1);
  unsub();const previous=n;e.tick(80);assert.equal(n,previous);
  e.dispose();e.dispose();assert.throws(()=>e.tick(80),/disposed/);
});

test('Configuration and invalid inputs are validated at boundaries', () => {
  withEngine(config(), e => {
    assert.throws(()=>e.tick(0), RangeError);
    assert.throws(()=>e.tick(1.2), RangeError);
    assert.throws(()=>e.setEatDuration(3), RangeError);
    assert.throws(()=>e.configure(config(2)), RangeError);
    e.configure(config(8,88,250));assert.equal(e.snapshot.count,8);
    e.start();assert.throws(()=>e.configure(config(5)),/Stop/);
    e.setEatDuration(900);assert.equal(e.snapshot.eatMs,900);
  });
});

test('Bounded log history does not grow indefinitely; clearing logs preserves model', () => {
  withEngine(config(), e => {
    e.start();simulate(e,1800);
    assert.ok(e.snapshot.logs.length <= 160);
    const meals=e.snapshot.totalMeals;
    e.clearLogs();assert.equal(e.snapshot.logs.length,0);
    assert.equal(e.snapshot.totalMeals,meals);
  });
});

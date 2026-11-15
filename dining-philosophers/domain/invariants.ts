import type { TableState } from "./types";

export function checkTableInvariants(table: TableState): void {
  const n = table.count;
  if (table.forks.length !== n || table.seats.length !== n || table.philosophers.length !== n) {
    throw new Error("Table arrays have inconsistent lengths");
  }
  const queued = new Set<number>();
  for (const id of table.queue) {
    if (queued.has(id)) throw new Error(`P${id} is queued twice`);
    queued.add(id);
  }
  let meals = 0;
  let eating = 0;
  for (const p of table.philosophers) {
    meals += p.meals;
    if (p.id < 1 || p.id > n) throw new Error(`Unexpected philosopher P${p.id}`);
    const seated = p.phase === "eating" || p.phase === "waiting-forks";
    if (seated !== (p.seat !== null)) throw new Error(`Seat/phase mismatch for P${p.id}`);
    if (p.seat !== null && table.seats[p.seat] !== p.id) throw new Error(`Seat ownership mismatch for P${p.id}`);
    if (p.phase === "eating") {
      eating++;
      if (p.seat === null || table.forks[p.seat] !== p.id || table.forks[(p.seat + 1) % n] !== p.id) {
        throw new Error(`P${p.id} eating without both forks`);
      }
    }
    if (queued.has(p.id) !== (p.phase === "waiting-forks")) throw new Error(`Queue/phase mismatch for P${p.id}`);
  }
  for (let i = 0; i < n; i++) {
    const owner = table.forks[i];
    if (owner !== null && table.philosophers[owner - 1]?.phase !== "eating") {
      throw new Error(`Fork ${i + 1} assigned to philosopher who is not eating`);
    }
    const seatOwner = table.seats[i];
    if (seatOwner !== null && table.philosophers[seatOwner - 1]?.seat !== i) {
      throw new Error(`Seat ${i + 1} assigned twice or wrongly`);
    }
  }
  if (meals !== table.totalMeals) throw new Error("Meal count mismatch");
  if (eating > Math.floor(n / 2)) throw new Error("More adjacent philosophers eating than possible");
  if (table.status === "stopped" && (eating > 0 || table.queue.length > 0)) {
    throw new Error("Stopped simulation holds resources");
  }
}

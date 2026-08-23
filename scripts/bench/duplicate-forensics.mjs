#!/usr/bin/env node
/**
 * WHERE a duplicate observation came from.
 *
 * The capacity sweep counts pairs closer together than the tightest gap
 * the adaptive scheduler can ask for. A count is enough to notice; it is
 * not enough to fix anything, and the release's central claim - that the
 * scheduler cannot enqueue a monitor whose check is still running - is
 * exactly the kind of claim a count can neither confirm nor refute.
 *
 * `monitor_checks` carries the ledger's actor id, and one worker process
 * is one actor. So each pair can say whether it was two workers probing
 * the same monitor (an exclusivity failure) or one worker probing twice
 * (a scheduling failure), and those want opposite fixes.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("set DATABASE_URL");
  process.exit(2);
}
const c = new Client({ connectionString: url });
await c.connect();

const { rows } = await c.query(`
  with ordered as (
    select c.monitor_id, c.checked_at, c.actor_id, m.interval_seconds,
           lag(c.checked_at) over w as prev_at,
           lag(c.actor_id)  over w as prev_actor
      from monitor_checks c
      join monitors m on m.id = c.monitor_id
    window w as (partition by c.monitor_id order by c.checked_at)
  )
  select monitor_id,
         round(extract(epoch from (checked_at - prev_at))::numeric, 3) as gap_seconds,
         actor_id, prev_actor,
         (actor_id is distinct from prev_actor) as different_workers
    from ordered
   where prev_at is not null
     and extract(epoch from (checked_at - prev_at)) < interval_seconds::float / 16
   order by gap_seconds
`);

console.log(`duplicate pairs: ${rows.length}`);
const cross = rows.filter((r) => r.different_workers).length;
console.log(`  two different workers: ${cross}`);
console.log(`  the same worker twice: ${rows.length - cross}`);
if (rows.length > 0) {
  const gaps = rows.map((r) => Number(r.gap_seconds)).sort((a, b) => a - b);
  console.log(
    `  gap min ${gaps[0]}s  median ${gaps[Math.floor(gaps.length / 2)]}s  max ${gaps[gaps.length - 1]}s`,
  );
  console.log(
    "  sample:",
    rows
      .slice(0, 5)
      .map((r) => `${r.gap_seconds}s ${r.different_workers ? "cross" : "same"}`)
      .join(", "),
  );
}
await c.end();

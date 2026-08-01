// A local target on a spread of ports. One port would make the
// benchmark measure the per-target fairness cap instead of the
// scheduler.
import { createServer } from "node:http";
const base = Number(process.env.PORT ?? 38080);
const n = Number(process.env.PORTS ?? 20);
for (let i = 0; i < n; i++) {
  createServer((_q, r) => {
    r.writeHead(200, { "content-length": "2" });
    r.end("ok");
  }).listen(base + i, "127.0.0.1");
}
console.log(`targets on 127.0.0.1:${base}..${base + n - 1}`);

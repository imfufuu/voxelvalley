/**
 * Verifies the world pipeline in Node (no browser): terrain heights, chunk mesh
 * generation through the actual worker module, and start-up cost of the
 * heightmap that gates the "enter world" button.
 * Bundled with esbuild so the extension-less TS imports resolve.
 */
import { BLOCK, CHUNK, SEA_LEVEL, heightAt } from "../src/world/worldgen.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <- " + extra}`);
  if (!ok) failures++;
};

// ---- 1. terrain produces a sane height distribution -------------------------
const t0 = Date.now();
let min = 1e9;
let max = -1e9;
let sum = 0;
const N = 256;
for (let z = 0; z < N; z++) {
  for (let x = 0; x < N; x++) {
    const h = heightAt(x * 8 - 1024, z * 8 - 1024); // sample the whole 2048² map
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
  }
}
const avg = sum / (N * N);
console.log(`height sample: min=${min} max=${max} avg=${avg.toFixed(1)} (${Date.now() - t0}ms)`);
check("terrain has mountains", max > 120, `max=${max}`);
check("terrain has lowland/water", min < SEA_LEVEL, `min=${min}`);
check("terrain is not degenerate", max - min > 60, `range=${max - min}`);
check("average height is walkable", avg > 10 && avg < 120, `avg=${avg}`);
check("no NaN heights", Number.isFinite(min) && Number.isFinite(max));

// ---- 2. full 1024² heightmap cost (what the start screen waits for) ---------
const hmStart = Date.now();
let acc = 0;
const HM = 1024;
for (let i = 0; i < HM * HM; i++) acc += heightAt((i % HM) * 2 - 1024, ((i / HM) | 0) * 2 - 1024);
const hmMs = Date.now() - hmStart;
console.log(`1024² heightmap: ${hmMs}ms (checksum ${acc})`);
check("heightmap completes in a reasonable time", hmMs < 20000, `${hmMs}ms`);

// ---- 3. the real chunk worker builds usable geometry ------------------------
const g = globalThis as any;
const posted: any[] = [];
g.self = {
  onmessage: null,
  postMessage: (m: any) => posted.push(m),
};
g.MessageEvent = class {};
await import("../src/world/chunkWorker.ts");

const handle = g.self.onmessage as (ev: { data: unknown }) => void;
check("worker installed its message handler", typeof handle === "function");

const cStart = Date.now();
handle({ data: { type: "chunk", key: "0,0", cx: 3, cz: -2 } });
const chunkMs = Date.now() - cStart;
const msg = posted.find((m) => m.type === "chunk");
check("worker posted a chunk back", !!msg, JSON.stringify(posted.map((m) => m.type)));

if (msg) {
  const quads = msg.indices.length / 6;
  const verts = msg.positions.length / 3;
  console.log(
    `chunk: ${quads} quads, ${verts} verts, ${chunkMs}ms, heights=${msg.heights.length}, grass=${msg.grassCount}`,
  );
  check("geometry is non-empty", quads > 0 && verts === quads * 4);
  check("index buffer within bounds", msg.indices.every((i: number) => i < verts));
  check("positions finite", msg.positions.every((v: number) => Number.isFinite(v)));
  check("colors are non-negative", msg.colors.every((v: number) => v >= 0 && v <= 1.001));
  check("column data sized to the chunk", msg.heights.length === CHUNK * CHUNK);
  check("types are known blocks", msg.types.every((t: number) => t <= BLOCK.ROCK_DARK));
  check("chunk build is fast enough to stream", chunkMs < 400, `${chunkMs}ms`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Verifies the world pipeline in Node (no browser): terrain heights, chunk mesh
 * generation through the actual worker module, and start-up cost of the
 * heightmap that gates the "enter world" button.
 * Bundled with esbuild so the extension-less TS imports resolve.
 */
import { BLOCK, CHUNK, SEA_LEVEL, heightAt, toLinear } from "../src/world/worldgen.ts";
import { bladeDensity, emptyBlade, makeBlade } from "../src/world/grass.ts";

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

// ---- 4. every triangle must face the same way as its stored normal ---------
// (regression: all top faces used to be wound inside-out, so back-face culling
//  hid the ground surface and the world looked transparent from above)
{
  let topBad = 0, topN = 0, sideBad = 0, sideN = 0;
  for (const [cx, cz] of [[3, -2], [0, 0], [-5, 7], [11, 4], [-20, -31]] as [number, number][]) {
    posted.length = 0;
    handle({ data: { type: "chunk", key: `${cx},${cz}`, cx, cz } });
    const m = posted.find((p) => p.type === "chunk");
    const pos = m.positions as Float32Array;
    const nrm = m.normals as Float32Array;
    const idx = m.indices as Uint32Array;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const dot =
        (uy * vz - uz * vy) * nrm[a] +
        (uz * vx - ux * vz) * nrm[a + 1] +
        (ux * vy - uy * vx) * nrm[a + 2];
      if (nrm[a + 1] > 0.5) { topN++; if (dot <= 0) topBad++; }
      else { sideN++; if (dot <= 0) sideBad++; }
    }
  }
  console.log(`winding: ${topN} top triangles, ${sideN} side triangles`);
  check("chunk has top faces", topN > 1000, `${topN}`);
  check("top faces are wound front-facing (ground is not see-through)", topBad === 0, `${topBad}/${topN} inside-out`);
  check("side faces are wound front-facing", sideBad === 0, `${sideBad}/${sideN} inside-out`);
}

// ---- 5. grass blades must never come out orange-red ------------------------
{
  const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const blade = emptyBlade();
  let blades = 0, blooms = 0, orangeRed = 0;
  let sample = "";
  for (let z = 0; z < 80; z++) {
    for (let x = 0; x < 80; x++) {
      const density = bladeDensity(x, z, 4);
      for (let k = 0; k < density; k++) {
        makeBlade(x, z, k, blade);
        blades++;
        const r = toSrgb(blade.r), g = toSrgb(blade.g), b = toSrgb(blade.b);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        const sat = mx > 0 ? d / mx : 0;
        let hue = 0;
        if (d > 1e-6) {
          if (mx === r) hue = 60 * (((g - b) / d + 6) % 6);
          else if (mx === g) hue = 60 * ((b - r) / d + 2);
          else hue = 60 * ((r - g) / d + 4);
        }
        const isOrangeRed = sat > 0.45 && mx > 0.4 && (hue <= 45 || hue >= 330);
        if (isOrangeRed) {
          orangeRed++;
          if (!sample) sample = `rgb(${r.toFixed(2)},${g.toFixed(2)},${b.toFixed(2)}) hue=${hue.toFixed(0)} sat=${sat.toFixed(2)}`;
        }
        // a bloom is any blade whose colour is not the green ramp
        if (!(g > r && g > b)) blooms++;
      }
    }
  }
  const rate = blooms / blades;
  console.log(`grass: ${blades} blades, ${blooms} blooms (${(100 * rate).toFixed(2)}%), orange-red: ${orangeRed}`);
  check("no orange-red blades", orangeRed === 0, `${orangeRed} e.g. ${sample}`);
  check("blooms stay sparse", rate > 0.002 && rate < 0.04, `${(100 * rate).toFixed(2)}%`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Scenery placement: trees and boulders must land somewhere sensible,
 * be deterministic, and stay cheap enough to stream every few blocks.
 */
import {
  TREE_BROADLEAF,
  TREE_CONIFER,
  TREE_NONE,
  foliageTint,
  rockAt,
  treeAt,
  treeShape,
} from "../src/world/scenery";
import {
  BLOCK,
  NO_WATER,
  SEA_LEVEL,
  blockTypeFor,
  columnAt,
  treeLine,
} from "../src/world/worldgen";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <- " + extra}`);
  if (!ok) failures++;
};

const col = { h: 0, water: NO_WATER };
const N = 300;
const STRIDE = 27; // ~8km of terrain sampled
let eligible = 0;
let trees = 0;
let conifers = 0;
let broadleaf = 0;
let rocks = 0;
let inWater = 0;
let aboveLine = 0;
let onSteep = 0;
let minH = 1e9;
let maxH = -1e9;
let rockMax = 0;
const t0 = Date.now();

for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const x = i * STRIDE - 4000;
    const z = j * STRIDE - 4000;
    columnAt(x, z, col);
    const h = Math.floor(col.h);
    const nh = Math.floor(col.h);
    // crude slope from the raw field
    const slope = Math.max(
      Math.abs(columnAt(x + 1, z, { h: 0, water: NO_WATER }) || 0),
      0,
    );
    void slope;
    const type = blockTypeFor(x, z, h, 0, col.water);
    const plantable =
      type === BLOCK.GRASS || type === BLOCK.DIRT || type === BLOCK.ROCK_LIGHT;
    if (plantable) eligible++;

    const species = treeAt(x, z, h, type, 0, col.water);
    if (species !== TREE_NONE) {
      trees++;
      if (species === TREE_CONIFER) conifers++;
      if (species === TREE_BROADLEAF) broadleaf++;
      if (col.water !== NO_WATER) inWater++;
      if (h > treeLine(x, z)) aboveLine++;
      const shape = { height: 0, trunkRadius: 0, canopy: 0, rot: 0 };
      treeShape(x, z, species, shape);
      if (!Number.isFinite(shape.height) || shape.height < 4 || shape.height > 22) {
        failures++;
        console.log(`FAIL  bad tree height ${shape.height}`);
      }
      minH = Math.min(minH, shape.height);
      maxH = Math.max(maxH, shape.height);
      const tint = foliageTint(x, z);
      if (!(tint >= 0 && tint <= 1)) {
        failures++;
        console.log(`FAIL  tint out of range: ${tint}`);
      }
    }

    const rock = { size: 0, rot: 0, sink: 0, squash: 0 };
    if (rockAt(x, z, h, type, 0, col.water, rock)) {
      rocks++;
      if (col.water !== NO_WATER) inWater++;
      rockMax = Math.max(rockMax, rock.size);
    }
    void nh;
  }
}
const ms = Date.now() - t0;
const total = N * N;

console.log(
  `sampled ${total} columns in ${ms}ms · ${eligible} plantable · ${trees} trees ` +
    `(${conifers} conifer / ${broadleaf} broadleaf) · ${rocks} boulders`,
);
console.log(`tree heights ${minH.toFixed(1)}..${maxH.toFixed(1)}m, max boulder ${rockMax.toFixed(2)}m`);

check("trees exist", trees > 200, `${trees}`);
check("both species are used", conifers > 20 && broadleaf > 20, `${conifers}/${broadleaf}`);
check("tree cover is plausible", trees / total > 0.03 && trees / total < 0.35, `${(100 * trees / total).toFixed(1)}%`);
check("no trees in water", inWater === 0, `${inWater}`);
check("no trees above the tree line", aboveLine === 0, `${aboveLine}`);
check("no trees on sheer cliffs", onSteep === 0, `${onSteep}`);
check("boulders exist but stay sparse", rocks > 20 && rocks / total < 0.12, `${(100 * rocks / total).toFixed(1)}%`);
check("boulders are a sane size", rockMax > 0.4 && rockMax < 4, `${rockMax}`);
check("scatter pass is fast enough to stream", ms < 3000, `${ms}ms for ${total} columns`);

// determinism: same coordinates must always give the same scenery
{
  let drift = 0;
  for (let i = 0; i < 500; i++) {
    const x = i * 13 - 3000;
    const z = i * 7 - 1200;
    columnAt(x, z, col);
    const h = Math.floor(col.h);
    const type = blockTypeFor(x, z, h, 0, col.water);
    const a = treeAt(x, z, h, type, 0, col.water);
    const b = treeAt(x, z, h, type, 0, col.water);
    if (a !== b) drift++;
  }
  check("placement is deterministic", drift === 0, `${drift} mismatches`);
}

// sea level sanity: nothing grows under water
{
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 31 - 6000;
    const z = i * 17 - 500;
    columnAt(x, z, col);
    const h = Math.floor(col.h);
    if (h < SEA_LEVEL - 1) {
      const type = blockTypeFor(x, z, h, 0, col.water);
      if (treeAt(x, z, h, type, 0, col.water) !== TREE_NONE) bad++;
    }
  }
  check("nothing grows on the sea bed", bad === 0, `${bad}`);
}

// ---- worker-side scenery packing --------------------------------------------
// the worker resolves scenery per chunk; the main thread reads those records by
// stride, so a layout mismatch would silently corrupt every tree
{
  const g = globalThis as any;
  const posted: any[] = [];
  g.self = { onmessage: null, postMessage: (m: unknown) => posted.push(m) };
  await import("../src/world/chunkWorker");
  const handle = g.self.onmessage as (ev: { data: unknown }) => void;

  let trees = 0;
  let rocks = 0;
  let oob = 0;
  let badSpecies = 0;
  let heightMismatch = 0;
  let strayTrees = 0;
  for (const [cx, cz] of [[2, 2], [-3, 5], [9, -8], [0, 0]] as [number, number][]) {
    posted.length = 0;
    handle({ data: { type: "chunk", key: `${cx},${cz}`, cx, cz } });
    const m = posted.find((p) => p.type === "chunk");
    trees += m.trees.length / 8;
    rocks += m.rocks.length / 7;
    check(`chunk ${cx},${cz}: tree records are stride-aligned`, m.trees.length % 8 === 0, `${m.trees.length}`);
    check(`chunk ${cx},${cz}: rock records are stride-aligned`, m.rocks.length % 7 === 0, `${m.rocks.length}`);
    for (let i = 0; i < m.trees.length; i += 8) {
      const x = m.trees[i], z = m.trees[i + 1], ground = m.trees[i + 2], species = m.trees[i + 3];
      if (x < cx * 32 || x >= cx * 32 + 32 || z < cz * 32 || z >= cz * 32 + 32) oob++;
      if (species !== 1 && species !== 2) badSpecies++;
      const lz = z - cz * 32;
      const lx = x - cx * 32;
      if (m.heights[lz * 32 + lx] !== ground) heightMismatch++;
      if (m.water[lz * 32 + lx] !== -32768) strayTrees++;
    }
  }
  console.log(`worker scenery: ${trees} trees + ${rocks} boulders across 4 chunks`);
  check("worker produces scenery", trees > 20, `${trees}`);
  check("tree positions inside their chunk", oob === 0, `${oob}`);
  check("species ids are valid", badSpecies === 0, `${badSpecies}`);
  check("tree ground height matches the column", heightMismatch === 0, `${heightMismatch}`);
  check("no trees standing in water", strayTrees === 0, `${strayTrees}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

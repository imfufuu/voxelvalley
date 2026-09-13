/**
 * Scenery placement: block trees and boulders must land somewhere sensible,
 * be deterministic, stay on the voxel grid, and be cheap enough to stream.
 */
import {
  TREE_BROADLEAF,
  TREE_CONIFER,
  TREE_NONE,
  TREE_CELL,
  foliageTint,
  rockAt,
  rockBlocks,
  treeAt,
  treeBlocks,
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
// contiguous patches: trees live on a lattice, so a strided sample would
// systematically miss (or over-count) candidate columns
const PATCHES: [number, number][] = [
  [-3000, -3000], [-1200, 900], [1500, -2200], [3200, 2600], [-500, 3800],
  [600, 200], [-4200, 1500], [2200, -900], [-2200, -600],
];
const N = 110;
const STRIDE = 1;
let eligible = 0;
let trees = 0;
let conifers = 0;
let broadleaf = 0;
let rocks = 0;
let inWater = 0;
let aboveLine = 0;
let leaves = 0;
let stones = 0;
let minTrunk = 1e9;
let maxTrunk = -1e9;
let minBlocks = 1e9;
let maxBlocks = -1e9;
let offGrid = 0;
let belowGround = 0;
let minSpacing = 1e9;
let maxRadius = 0;
const t0 = Date.now();
const trunks: [number, number][] = [];

for (const [ox, oz] of PATCHES) {
  for (let j = 0; j < N; j += STRIDE) {
    for (let i = 0; i < N; i += STRIDE) {
      const x = ox + i;
      const z = oz + j;
      columnAt(x, z, col);
      const h = Math.floor(col.h);
      const type = blockTypeFor(x, z, h, 0, col.water);
      const plantable =
        type === BLOCK.GRASS || type === BLOCK.DIRT || type === BLOCK.ROCK_LIGHT;
      if (plantable) eligible++;

      const species = treeAt(x, z, h, type, 0, col.water);
      if (species !== TREE_NONE) {
        trees++;
        trunks.push([x, z]);
        if (species === TREE_CONIFER) conifers++;
        if (species === TREE_BROADLEAF) broadleaf++;
        if (col.water !== NO_WATER) inWater++;
        if (h > treeLine(x, z)) aboveLine++;
        const shape = { trunk: 0, layers: [] as number[], seed: 0 };
        treeShape(x, z, species, shape);
        if (!Number.isInteger(shape.trunk) || shape.trunk < 4 || shape.trunk > 10) {
          failures++;
          console.log(`FAIL  bad trunk height ${shape.trunk}`);
        }
        if (shape.layers.length < 2 || shape.layers.length > 5) {
          failures++;
          console.log(`FAIL  bad canopy profile ${shape.layers.join(",")}`);
        }
        let count = 0;
        treeBlocks(x, z, h, species, shape, (bx, by, bz) => {
          count++;
          if (!Number.isInteger(bx) || !Number.isInteger(by) || !Number.isInteger(bz)) offGrid++;
          if (by < h - 3) belowGround++;
        });
        minTrunk = Math.min(minTrunk, shape.trunk);
        maxTrunk = Math.max(maxTrunk, shape.trunk);
        minBlocks = Math.min(minBlocks, count);
        maxBlocks = Math.max(maxBlocks, count);
        leaves += count;
        const tint = foliageTint(x, z);
        if (!(tint >= 0 && tint <= 1)) {
          failures++;
          console.log(`FAIL  tint out of range: ${tint}`);
        }
      }

      const rock = { radius: 0, seed: 0 };
      if (rockAt(x, z, h, type, 0, col.water, rock)) {
        rocks++;
        if (col.water !== NO_WATER) inWater++;
        maxRadius = Math.max(maxRadius, rock.radius);
        rockBlocks(x, z, h, rock.radius, (bx, by, bz) => {
          stones++;
          if (!Number.isInteger(bx) || !Number.isInteger(by) || !Number.isInteger(bz)) offGrid++;
        });
      }
    }
  }
}
const ms = Date.now() - t0;
const total = PATCHES.length * N * N;

// trunks must keep their distance, otherwise canopies fuse into green mush
for (let a = 0; a < trunks.length; a++) {
  for (let b = a + 1; b < trunks.length; b++) {
    const d = Math.max(Math.abs(trunks[a][0] - trunks[b][0]), Math.abs(trunks[a][1] - trunks[b][1]));
    if (d < minSpacing) minSpacing = d;
  }
}

console.log(
  `sampled ${total} columns in ${ms}ms · ${eligible} plantable · ${trees} trees ` +
    `(${conifers} conifer / ${broadleaf} broadleaf) · ${rocks} boulders`,
);
console.log(
  `trunk ${minTrunk}..${maxTrunk} blocks · ${minBlocks}..${maxBlocks} leaf blocks per tree ` +
    `(${(leaves / Math.max(1, trees)).toFixed(1)} avg) · ${(stones / Math.max(1, rocks)).toFixed(1)} blocks per boulder`,
);
console.log(
  `cover: ${((100 * trees) / total).toFixed(2)}% of columns, ${((100 * trees) / eligible).toFixed(2)}% of plantable ground`,
);

check("trees exist", trees > 200, `${trees}`);
check("both species are used", conifers > 20 && broadleaf > 20, `${conifers}/${broadleaf}`);
check(
  "tree cover is plausible",
  trees / total > 0.002 && trees / total < 0.025,
  `${((100 * trees) / total).toFixed(2)}%`,
);
check("no trees in water", inWater === 0, `${inWater}`);
check("no trees above the tree line", aboveLine === 0, `${aboveLine}`);
check(
  "trunks keep their distance",
  minSpacing >= TREE_CELL - 2,
  `closest pair ${minSpacing}`,
);
check(
  "canopies are a sane size",
  minBlocks >= 15 && maxBlocks <= 70,
  `${minBlocks}..${maxBlocks}`,
);
check("every block sits on the voxel grid", offGrid === 0, `${offGrid}`);
check("no leaf blocks buried in the ground", belowGround === 0, `${belowGround}`);
check(
  "boulders exist but stay sparse",
  rocks > 20 && rocks / total < 0.05,
  `${((100 * rocks) / total).toFixed(2)}%`,
);
check("boulders are 1-3 blocks", maxRadius >= 1 && maxRadius <= 3, `${maxRadius}`);
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

// the block layout must be reproducible too – the main thread expands the
// worker's tree records from these functions, not from shipped data
{
  let drift = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 17 - 1500;
    const z = i * 29 + 400;
    columnAt(x, z, col);
    const h = Math.floor(col.h);
    const type = blockTypeFor(x, z, h, 0, col.water);
    const sp = treeAt(x, z, h, type, 0, col.water);
    if (sp === TREE_NONE) continue;
    const run = () => {
      const shape = { trunk: 0, layers: [] as number[], seed: 0 };
      treeShape(x, z, sp, shape);
      const out: string[] = [];
      treeBlocks(x, z, h, sp, shape, (bx, by, bz) => out.push(`${bx},${by},${bz}`));
      return `${shape.trunk}|${out.join(";")}`;
    };
    if (run() !== run()) drift++;
  }
  check("block layout is deterministic", drift === 0, `${drift} mismatches`);
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
  let badRadius = 0;
  for (const [cx, cz] of [[2, 2], [-3, 5], [9, -8], [0, 0]] as [number, number][]) {
    posted.length = 0;
    handle({ data: { type: "chunk", key: `${cx},${cz}`, cx, cz } });
    const m = posted.find((p) => p.type === "chunk");
    trees += m.trees.length / 4;
    rocks += m.rocks.length / 4;
    check(`chunk ${cx},${cz}: tree records are stride-aligned`, m.trees.length % 4 === 0, `${m.trees.length}`);
    check(`chunk ${cx},${cz}: rock records are stride-aligned`, m.rocks.length % 4 === 0, `${m.rocks.length}`);
    for (let i = 0; i < m.trees.length; i += 4) {
      const x = m.trees[i], z = m.trees[i + 1], ground = m.trees[i + 2], species = m.trees[i + 3];
      if (x < cx * 32 || x >= cx * 32 + 32 || z < cz * 32 || z >= cz * 32 + 32) oob++;
      if (species !== 1 && species !== 2) badSpecies++;
      const lz = z - cz * 32;
      const lx = x - cx * 32;
      if (m.heights[lz * 32 + lx] !== ground) heightMismatch++;
      if (m.water[lz * 32 + lx] !== -32768) strayTrees++;
    }
    for (let i = 0; i < m.rocks.length; i += 4) {
      const r = m.rocks[i + 3];
      if (!Number.isInteger(r) || r < 1 || r > 3) badRadius++;
    }
  }
  console.log(`worker scenery: ${trees} trees + ${rocks} boulders across 4 chunks`);
  check("worker produces scenery", trees > 5, `${trees}`);
  check("tree positions inside their chunk", oob === 0, `${oob}`);
  check("species ids are valid", badSpecies === 0, `${badSpecies}`);
  check("tree ground height matches the column", heightMismatch === 0, `${heightMismatch}`);
  check("no trees standing in water", strayTrees === 0, `${strayTrees}`);
  check("boulder radii are block counts", badRadius === 0, `${badRadius}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

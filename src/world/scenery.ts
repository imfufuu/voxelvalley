/**
 * Deterministic scenery placement: Minecraft-style block trees and boulders.
 *
 * Every tree is a stack of whole blocks on the voxel grid – a square trunk
 * column plus leaf cubes – so nothing here is ever rotated or scaled off the
 * grid. Pure functions, no three.js, so the distributions can be unit-tested
 * in Node.
 */
import { fbm, hash2, smoothstep } from "./noise";
import { BLOCK, NO_WATER, SEA_LEVEL, treeLine } from "./worldgen";

export const TREE_NONE = 0;
export const TREE_CONIFER = 1;
export const TREE_BROADLEAF = 2;

/**
 * Trees are planted on a jittered lattice: every cell has exactly one
 * candidate column, so trunks keep their distance and canopies only brush
 * against each other instead of fusing into a green mush.
 */
export const TREE_CELL = 6;
/** share of an eligible cell that is actually planted (forest patchiness) */
const TREE_DENSITY = 0.62;
/** live multiplier so the player can dial the forest in game (`/trees`) */
let densityScale = 1;
export function setTreeDensity(scale: number) {
  densityScale = Math.max(0, Math.min(3, scale));
}
export function treeDensity(): number {
  return densityScale;
}

export interface TreeShape {
  /** trunk height in whole blocks */
  trunk: number;
  /** leaf layer radii, bottom -> top: 2 = 5x5, 1 = 3x3, 0 = single block */
  layers: number[];
  /** stable per-tree random, 0..1 */
  seed: number;
}

/** spruce profiles, chosen by height class */
const CONIFER_LAYERS: number[][] = [
  [2, 1, 0],
  [2, 1, 1, 0],
  [2, 2, 1, 1, 0],
];
/** oak: two full 5x5 layers with a 3x3 cap */
const BROADLEAF_LAYERS = [2, 2, 1];

/**
 * is there a tree on this column? returns TREE_NONE / TREE_CONIFER / TREE_BROADLEAF
 *
 * `slope` and `water` come straight from the chunk mesher, so re-testing a
 * column here costs nothing.
 */
export function treeAt(
  x: number,
  z: number,
  h: number,
  type: number,
  slope: number,
  water: number,
): number {
  if (water !== NO_WATER) return TREE_NONE;
  if (type !== BLOCK.GRASS && type !== BLOCK.DIRT && type !== BLOCK.ROCK_LIGHT) return TREE_NONE;
  if (slope > 2.3) return TREE_NONE;
  if (h < SEA_LEVEL + 2) return TREE_NONE;

  const tl = treeLine(x, z);
  if (h > tl) return TREE_NONE;

  // one candidate column per lattice cell -> guaranteed spacing between trunks
  const cx = Math.floor(x / TREE_CELL);
  const cz = Math.floor(z / TREE_CELL);
  if (x - cx * TREE_CELL !== 1 + Math.floor(hash2(cx * 7 + 1, cz * 13 + 5) * 3)) return TREE_NONE;
  if (z - cz * TREE_CELL !== 1 + Math.floor(hash2(cx * 11 - 3, cz * 5 + 9) * 3)) return TREE_NONE;

  // forest patches, thinning out towards the tree line
  const patch = fbm(x * 0.0075 + 11, z * 0.0075 - 7, 3) * 0.5 + 0.5;
  const alt = 1 - smoothstep(tl - 34, tl, h);
  const chance = patch * alt * TREE_DENSITY * densityScale;
  if (hash2(cx * 91 + 13, cz * 57 - 5) > chance) return TREE_NONE;

  // conifers take over with altitude and on colder, wetter slopes
  const cold = fbm(x * 0.0012 + 300, z * 0.0012 - 200, 2) * 0.5 + 0.5;
  const t = (h - SEA_LEVEL) / Math.max(1, tl - SEA_LEVEL);
  return t * 0.7 + cold * 0.5 > 0.62 ? TREE_CONIFER : TREE_BROADLEAF;
}

/** trunk height + leaf profile for the tree on this column */
export function treeShape(x: number, z: number, species: number, out: TreeShape): void {
  const r1 = hash2(x * 31 + 7, z * 17 - 3);
  const r2 = hash2(x * 13 - 5, z * 29 + 11);
  out.seed = hash2(x * 7 + 3, z * 3 - 17);
  const layers =
    species === TREE_CONIFER
      ? CONIFER_LAYERS[Math.min(CONIFER_LAYERS.length - 1, Math.floor(r2 * 3))]
      : BROADLEAF_LAYERS;
  out.trunk =
    species === TREE_CONIFER ? 5 + Math.floor(r1 * 5) : 4 + Math.floor(r1 * 3);
  out.layers.length = layers.length;
  for (let i = 0; i < layers.length; i++) out.layers[i] = layers[i];
}

/**
 * Enumerate the leaf blocks of a tree. `emit` receives the block's minimum
 * corner in world block coordinates, so a cube placed there fills exactly one
 * voxel of the grid.
 */
export function treeBlocks(
  x: number,
  z: number,
  ground: number,
  species: number,
  shape: TreeShape,
  emit: (bx: number, by: number, bz: number) => void,
): void {
  const { trunk, layers } = shape;
  // conifers keep a couple of bare trunk blocks below the canopy
  const first = ground + trunk - (species === TREE_CONIFER ? 3 : 2);
  for (let k = 0; k < layers.length; k++) {
    const r = layers[k];
    const by = first + k;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // the corners of the wide layers are often missing, like vanilla oaks
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) {
          if (hash2(x + dx * 7 + k * 31, z + dz * 5 - k * 13) < 0.62) continue;
        }
        emit(x + dx, by, z + dz);
      }
    }
  }
}

export interface RockShape {
  /** radius in whole blocks: 1 = single cube, 2 = small cairn, 3 = boulder */
  radius: number;
  /** stable per-rock random, 0..1 */
  seed: number;
}

/** boulder on this column? fills `out` and returns true */
export function rockAt(
  x: number,
  z: number,
  h: number,
  type: number,
  slope: number,
  water: number,
  out: RockShape,
): boolean {
  if (water !== NO_WATER) return false;
  if (type === BLOCK.SAND || type === BLOCK.WATERBED) return false;
  if (h < SEA_LEVEL + 1) return false;
  const r = hash2(x * 61 - 9, z * 43 + 21);
  const patch = fbm(x * 0.011 - 33, z * 0.011 + 19, 2) * 0.5 + 0.5;
  const chance = patch * (type === BLOCK.STONE || type === BLOCK.ROCK_LIGHT ? 0.1 : 0.028);
  if (r > chance) return false;
  const roll = hash2(x * 5 + 1, z * 11 - 2);
  // most of the eligible ground stays clear: a pebble every few steps is
  // plenty, and real boulders should feel rare
  if (roll < 0.45) return false;
  out.seed = hash2(x * 23, z * 37);
  out.radius = roll > 0.985 ? 3 : roll > 0.88 ? 2 : 1;
  if (slope > 2 && roll > 0.6) out.radius = Math.min(3, out.radius + 1);
  return true;
}

/**
 * Enumerate the cubes of a boulder: a stepped, ragged little cairn that is
 * sunk one block into the ground so it reads as part of the terrain.
 */
export function rockBlocks(
  x: number,
  z: number,
  ground: number,
  radius: number,
  emit: (bx: number, by: number, bz: number) => void,
): void {
  for (let dy = 0; dy < radius; dy++) {
    const rr = radius - 1 - dy;
    for (let dz = -rr; dz <= rr; dz++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > rr) continue;
        // knock off the occasional corner so the cluster is not a clean pyramid
        if (rr > 0 && Math.abs(dx) + Math.abs(dz) === rr && hash2(x + dx * 3, z + dz * 9 + dy) < 0.3) {
          continue;
        }
        emit(x + dx, ground - 1 + dy, z + dz);
      }
    }
  }
}

/** canopy colour jitter, 0..1 (also used for trunk tint) */
export function foliageTint(x: number, z: number): number {
  return fbm(x * 0.02, z * 0.02, 2) * 0.5 + 0.5;
}

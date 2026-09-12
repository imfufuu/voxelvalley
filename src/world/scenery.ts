/**
 * Deterministic scenery placement (trees, boulders).
 * Pure functions, no three.js, so the distributions can be unit-tested in Node.
 */
import { fbm, hash2, smoothstep } from "./noise";
import { BLOCK, NO_WATER, SEA_LEVEL, treeLine } from "./worldgen";

export const TREE_NONE = 0;
export const TREE_CONIFER = 1;
export const TREE_BROADLEAF = 2;

export interface TreeShape {
  /** total height in blocks */
  height: number;
  trunkRadius: number;
  canopy: number;
  rot: number;
}

export interface RockShape {
  size: number;
  rot: number;
  /** how far the rock sinks into the ground (fraction of its size) */
  sink: number;
  squash: number;
}

/** is there a tree on this column? returns TREE_NONE / TREE_CONIFER / TREE_BROADLEAF */
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

  // forest patches, thinning out towards the tree line
  const patch = fbm(x * 0.0075 + 11, z * 0.0075 - 7, 3) * 0.5 + 0.5;
  const alt = 1 - smoothstep(tl - 34, tl, h);
  const chance = patch * alt * 0.42;
  if (hash2(x * 91 + 13, z * 57 - 5) > chance) return TREE_NONE;

  // conifers take over with altitude and on colder, wetter slopes
  const cold = fbm(x * 0.0012 + 300, z * 0.0012 - 200, 2) * 0.5 + 0.5;
  const t = (h - SEA_LEVEL) / Math.max(1, tl - SEA_LEVEL);
  return t * 0.7 + cold * 0.5 > 0.62 ? TREE_CONIFER : TREE_BROADLEAF;
}

export function treeShape(x: number, z: number, species: number, out: TreeShape): void {
  const r1 = hash2(x * 31 + 7, z * 17 - 3);
  const r2 = hash2(x * 13 - 5, z * 29 + 11);
  const r3 = hash2(x * 7 + 3, z * 3 - 17);
  if (species === TREE_CONIFER) {
    out.height = 8 + r1 * 9;
    out.trunkRadius = 0.16 + r2 * 0.12;
    out.canopy = 0.85 + r3 * 0.5;
  } else {
    out.height = 6 + r1 * 6.5;
    out.trunkRadius = 0.2 + r2 * 0.18;
    out.canopy = 1.35 + r3 * 0.85;
  }
  out.rot = r2 * Math.PI * 2;
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
  out.size = 0.5 + hash2(x * 5 + 1, z * 11 - 2) * (slope > 2 ? 2.4 : 1.5);
  out.rot = hash2(x * 23, z * 37) * Math.PI * 2;
  out.sink = 0.25 + hash2(x * 2 - 7, z * 19 + 5) * 0.3;
  out.squash = 0.55 + hash2(x * 41 + 9, z * 13 - 4) * 0.5;
  return true;
}

/** canopy colour jitter, 0..1 (also used for trunk tint) */
export function foliageTint(x: number, z: number): number {
  return fbm(x * 0.02, z * 0.02, 2) * 0.5 + 0.5;
}

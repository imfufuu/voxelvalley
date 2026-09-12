import { fbm, hash2 } from "./noise";
import { toLinear } from "./worldgen";

export interface Blade {
  /** offset inside the block column */
  ox: number;
  oz: number;
  height: number;
  width: number;
  rotation: number;
  phase: number;
  /** colour, linear space (three.js works in linear internally) */
  r: number;
  g: number;
  b: number;
}

/**
 * Wildflower tints. The old palette interpolated yellow -> salmon -> hot pink,
 * and because "is this a flower" was tested against the same hash that drives
 * blade height, blossoms were always the tallest blades: together that read as
 * orange-red clumps poking out of the grass. These stay pastel under any light.
 */
const FLOWER_TINTS: Array<[number, number, number]> = [
  [0.95, 0.95, 0.9], // white
  [0.96, 0.91, 0.65], // butter
  [0.97, 0.85, 0.9], // pale rose
  [0.82, 0.8, 0.97], // lilac
];

/** share of blades that bloom */
const FLOWER_RATE = 0.012;

export function emptyBlade(): Blade {
  return { ox: 0, oz: 0, height: 0, width: 0, rotation: 0, phase: 0, r: 0, g: 0, b: 0 };
}

/** how many blades a grass block gets (a few blocks stay sparse) */
export function bladeDensity(x: number, z: number, perBlock: number): number {
  return hash2(x * 7, z * 13) > 0.12 ? perBlock : 1;
}

/** deterministic blade for block (x,z), k-th instance */
export function makeBlade(x: number, z: number, k: number, out: Blade): Blade {
  const rx = hash2(x * 31 + k * 5, z * 17 + k * 3);
  const rz = hash2(x * 13 - k * 9, z * 23 + k * 11);
  const rr = hash2(x * 3 + k, z * 41 + k * 7);
  // independent of rr, so blooms are no longer systematically the tallest blades
  const bloom = hash2(x * 137 + k * 29 + 7, z * 211 - k * 13 + 3);

  out.ox = rx;
  out.oz = rz;
  out.height = 0.45 + rr * 0.72;
  out.width = 0.055 + rr * 0.035;
  out.rotation = rx * Math.PI * 2;
  out.phase = rr * 20;

  if (bloom > 1 - FLOWER_RATE) {
    const pick = Math.min(
      FLOWER_TINTS.length - 1,
      Math.floor(hash2(x * 5 + 1, z * 9 + 2) * FLOWER_TINTS.length),
    );
    const t = FLOWER_TINTS[pick];
    out.height *= 1.12;
    out.width *= 1.15;
    out.r = toLinear(t[0]);
    out.g = toLinear(t[1]);
    out.b = toLinear(t[2]);
  } else {
    const tint = fbm((x + rx) * 0.05, (z + rz) * 0.05, 2) * 0.5 + 0.5;
    out.r = toLinear(0.2 + tint * 0.22);
    out.g = toLinear(0.4 + tint * 0.3);
    out.b = toLinear(0.11 + tint * 0.12);
  }
  return out;
}

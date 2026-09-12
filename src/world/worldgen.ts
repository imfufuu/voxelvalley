import { clamp, fbm, hash2, noise2, ridged, smoothstep } from "./noise";

export const WORLD_SIZE = 2048; // 2048 x 2048 blocks
export const HALF = WORLD_SIZE / 2;
export const SEA_LEVEL = 36;
export const CHUNK = 32;
export const MAX_HEIGHT = 220;

export const BLOCK = {
  WATERBED: 0,
  SAND: 1,
  GRASS: 2,
  DIRT: 3,
  STONE: 4,
  SNOW: 5,
  ROCK_DARK: 6,
} as const;

/**
 * Terrain elevation for a world column.
 * Mixes: wide continents -> open valleys -> ridged snow mountain ranges -> hills -> micro detail.
 */
export function terrainHeight(x: number, z: number): number {
  // domain warp for more organic shapes
  const wx = x + fbm(x * 0.0021 + 31.7, z * 0.0021 - 12.3, 3) * 46;
  const wz = z + fbm(x * 0.0021 - 5.1, z * 0.0021 + 88.9, 3) * 46;

  // large scale continent / valley floor
  const cont = fbm(wx * 0.00085, wz * 0.00085, 5);
  let h = SEA_LEVEL + 6 + cont * 34;

  // broad open valley basins (flatten terrain where the basin mask is strong)
  const basin = smoothstep(0.18, 0.65, fbm(wx * 0.0013 + 400, wz * 0.0013 - 220, 3) * 0.5 + 0.5);
  const valleyFloor = SEA_LEVEL + 4 + cont * 8;
  h = h * (1 - basin * 0.72) + valleyFloor * (basin * 0.72);

  // mountain range mask
  let mask = (fbm(x * 0.00062 + 120.5, z * 0.00062 - 77.2, 4) * 0.5 + 0.5 - 0.27) / 0.30;
  mask = clamp(mask, 0, 1);
  mask = mask * mask * (3 - 2 * mask);
  mask *= 1 - basin * 0.5;

  if (mask > 0.001) {
    const r = ridged(wx * 0.0022, wz * 0.0022, 6);
    const peaks = Math.pow(r, 1.15);
    h += mask * peaks * 205;
    // secondary crags
    h += mask * fbm(wx * 0.009, wz * 0.009, 4) * 9;
  }

  // rolling hills in lowland
  h += (1 - mask) * fbm(wx * 0.0075, wz * 0.0075, 4) * 6.5;
  // micro detail
  h += fbm(x * 0.045, z * 0.045, 2) * 1.15;

  // carve meandering rivers through lowlands
  const riverN = fbm(wx * 0.0011 + 900, wz * 0.0011 + 300, 3);
  const river = 1 - Math.min(1, Math.abs(riverN) / 0.055);
  if (river > 0 && mask < 0.55) {
    const strength = river * river * (1 - mask / 0.55);
    h -= strength * 16 * (1 - smoothstep(SEA_LEVEL + 40, SEA_LEVEL + 90, h));
  }

  // beach flattening near the shoreline
  const d = h - SEA_LEVEL;
  if (d > -3 && d < 3.5) h = SEA_LEVEL + d * 0.55;

  // fade to ocean at the map border so the 2048² island reads as an island
  const edge =
    1 -
    smoothstep(HALF - 210, HALF - 20, Math.max(Math.abs(x), Math.abs(z))) *
      (1 - 0.12 * (noise2(x * 0.01, z * 0.01) * 0.5 + 0.5));
  h = (h - (SEA_LEVEL - 16)) * edge + (SEA_LEVEL - 16);

  return h;
}

export function heightAt(x: number, z: number): number {
  return Math.floor(terrainHeight(x, z));
}

export function snowLine(x: number, z: number): number {
  return 92 + fbm(x * 0.004, z * 0.004, 3) * 14;
}

export function blockTypeFor(x: number, z: number, h: number, slope: number): number {
  if (h < SEA_LEVEL - 2) return BLOCK.WATERBED;
  if (h <= SEA_LEVEL + 2) return BLOCK.SAND;
  const sl = snowLine(x, z);
  if (h > sl + (slope > 4 ? 10 : 0)) return BLOCK.SNOW;
  if (h > sl - 10 && slope < 3 && hash2(x, z) < 0.55) return BLOCK.SNOW;
  if (slope >= 4) return BLOCK.STONE;
  if (slope >= 3) return hash2(x * 3, z * 7) > 0.5 ? BLOCK.STONE : BLOCK.DIRT;
  if (h > sl - 24) return hash2(x * 5, z * 3) > 0.7 ? BLOCK.STONE : BLOCK.GRASS;
  return BLOCK.GRASS;
}

type RGB = [number, number, number];

/** sRGB -> linear (three.js works in linear space internally) */
export function toLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

const PALETTE: Record<number, RGB> = {
  [BLOCK.WATERBED]: [0.35, 0.33, 0.26],
  [BLOCK.SAND]: [0.83, 0.76, 0.55],
  [BLOCK.GRASS]: [0.34, 0.55, 0.22],
  [BLOCK.DIRT]: [0.42, 0.31, 0.2],
  [BLOCK.STONE]: [0.47, 0.47, 0.5],
  [BLOCK.SNOW]: [0.94, 0.96, 0.99],
  [BLOCK.ROCK_DARK]: [0.3, 0.29, 0.31],
};

export function topColor(type: number, x: number, z: number, h: number, out: RGB): RGB {
  const base = PALETTE[type] ?? PALETTE[BLOCK.STONE];
  let r = base[0],
    g = base[1],
    b = base[2];
  if (type === BLOCK.GRASS) {
    // biome tint: drier / yellower in low warm valleys, deeper green in wet ones
    const t = fbm(x * 0.0032 + 61, z * 0.0032 - 23, 3) * 0.5 + 0.5;
    r += t * 0.2 - 0.06;
    g += 0.1 - t * 0.12;
    b += t * 0.06 - 0.03;
    const alt = smoothstep(SEA_LEVEL + 30, SEA_LEVEL + 80, h);
    r -= alt * 0.06;
    g -= alt * 0.1;
  }
  const j = (hash2(x, z) - 0.5) * (type === BLOCK.SNOW ? 0.04 : 0.11);
  out[0] = toLinear(clamp(r + j, 0, 1));
  out[1] = toLinear(clamp(g + j, 0, 1));
  out[2] = toLinear(clamp(b + j, 0, 1));
  return out;
}

export function sideColor(type: number, depth: number, x: number, z: number, out: RGB): RGB {
  let t = type;
  if (type === BLOCK.GRASS) t = depth < 4 ? BLOCK.DIRT : BLOCK.STONE;
  else if (type === BLOCK.SNOW) t = depth < 1 ? BLOCK.SNOW : BLOCK.STONE;
  else if (type === BLOCK.SAND) t = depth < 3 ? BLOCK.SAND : BLOCK.STONE;
  else if (type === BLOCK.WATERBED) t = BLOCK.WATERBED;
  const base = PALETTE[t];
  const j = (hash2(x * 17 + depth * 31, z * 13 - depth * 7) - 0.5) * 0.1;
  const dark = 1 - Math.min(0.28, depth * 0.018);
  out[0] = toLinear(clamp((base[0] + j) * dark, 0, 1));
  out[1] = toLinear(clamp((base[1] + j) * dark, 0, 1));
  out[2] = toLinear(clamp((base[2] + j) * dark, 0, 1));
  return out;
}

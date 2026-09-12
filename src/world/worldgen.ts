import { clamp, fbm, hash2, noise2, ridged, smoothstep } from "./noise";

export const WORLD_SIZE = 9048; // 9048 x 9048 blocks
export const HALF = WORLD_SIZE / 2;
export const SEA_LEVEL = 36;
export const CHUNK = 32;
export const MAX_HEIGHT = 384;
/** sentinel for "this column has no water above it" */
export const NO_WATER = -32768;
/** lakes above this altitude freeze over into ice */
export const FREEZE_LINE = 198;

export const BLOCK = {
  WATERBED: 0,
  SAND: 1,
  GRASS: 2,
  DIRT: 3,
  STONE: 4,
  SNOW: 5,
  ROCK_DARK: 6,
  ICE: 7,
  ROCK_LIGHT: 8,
} as const;

export interface Column {
  /** terrain surface height */
  h: number;
  /** water surface height, or NO_WATER */
  water: number;
}

// scratch output of terrainHeight(), consumed by columnAt()
let riverDepth = 0;
let lakeLevel = NO_WATER;

/**
 * Terrain elevation for a world column.
 * Domain-warped continents -> broad basins -> ridged ranges (plus rare
 * sky-piercing "极天" ranges) -> foothills -> river carving -> glacial lakes
 * -> shoreline flattening -> island edge.
 */
export function terrainHeight(x: number, z: number): number {
  riverDepth = 0;
  lakeLevel = NO_WATER;

  // ---- domain warp, keeps ridges from looking like a grid ------------------
  const wx = x + fbm(x * 0.0013 + 31.7, z * 0.0013 - 12.3, 3) * 70;
  const wz = z + fbm(x * 0.0013 - 5.1, z * 0.0013 + 88.9, 3) * 70;

  // ---- continents ---------------------------------------------------------
  const cont = fbm(wx * 0.00042, wz * 0.00042, 5);
  let h = SEA_LEVEL + 2 + cont * 46;

  // ---- broad lowland basins (open valleys / plains) ------------------------
  const basin = smoothstep(
    0.42,
    0.82,
    fbm(wx * 0.00095 + 400, wz * 0.00095 - 220, 3) * 0.5 + 0.5,
  );
  const valleyFloor = SEA_LEVEL + 3 + cont * 12;
  h = h * (1 - basin * 0.62) + valleyFloor * (basin * 0.62);

  // ---- mountain range mask ------------------------------------------------
  let mask = (fbm(x * 0.0004 + 120.5, z * 0.0004 - 77.2, 4) * 0.5 + 0.5 - 0.46) / 0.22;
  mask = clamp(mask, 0, 1);
  mask = mask * mask * (3 - 2 * mask);
  mask *= 1 - basin * 0.6;

  // ---- rare sky-piercing ranges (peaks break through the cloud deck) ------
  let sky = (fbm(x * 0.00022 - 310.2, z * 0.00022 + 188.4, 3) * 0.5 + 0.5 - 0.58) / 0.15;
  sky = clamp(sky, 0, 1);
  sky = sky * sky * (3 - 2 * sky);
  sky *= mask;

  if (mask > 0.001) {
    const r = ridged(wx * 0.00155, wz * 0.00155, 7);
    // ridged multifractal tops out well below 1, so stretch it before use
    const peaks = Math.pow(clamp(r * 1.35, 0, 1), 1.05);
    h += mask * peaks * (190 + sky * 258);
    // crags
    h += mask * fbm(wx * 0.0075, wz * 0.0075, 4) * 11;
    // long-wavelength range height variation, so ridges rise and fall
    h += mask * (1 - sky) * (fbm(wx * 0.0009 + 12, wz * 0.0009 - 8, 2) * 0.5 + 0.5) * 26;
  }

  // ---- foothills + micro detail ------------------------------------------
  h += (1 - mask) * fbm(wx * 0.0062, wz * 0.0062, 4) * 7.5;
  h += fbm(x * 0.042, z * 0.042, 2) * 1.1;

  // ---- meandering rivers carved through the lowlands ----------------------
  const rn = fbm(wx * 0.00075 + 900, wz * 0.00075 + 300, 3);
  const river = 1 - Math.min(1, Math.abs(rn) / 0.05);
  if (river > 0 && mask < 0.75) {
    const strength = river * river * (1 - mask / 0.75);
    const carve = strength * 26 * (1 - smoothstep(SEA_LEVEL + 45, SEA_LEVEL + 150, h));
    h -= carve;
    // fill most of the channel back up with water
    riverDepth = carve * 0.72;
  }

  // ---- glacial / valley lakes: a slowly varying water table in uplands ----
  const pocket = fbm(x * 0.0016 + 55.5, z * 0.0016 - 71.3, 2) * 0.5 + 0.5;
  if (pocket > 0.74 && mask > 0.5 && h > SEA_LEVEL + 20) {
    const t = (pocket - 0.74) / 0.26;
    const level = SEA_LEVEL + 22 + t * 185;
    if (level > h + 0.6) lakeLevel = level;
  }

  // ---- beach flattening near the shoreline --------------------------------
  const d = h - SEA_LEVEL;
  if (d > -4 && d < 4) h = SEA_LEVEL + d * 0.5;

  // ---- fade to ocean at the map border ------------------------------------
  const edge =
    1 -
    smoothstep(HALF - 520, HALF - 40, Math.max(Math.abs(x), Math.abs(z))) *
      (1 - 0.12 * (noise2(x * 0.01, z * 0.01) * 0.5 + 0.5));
  h = (h - (SEA_LEVEL - 18)) * edge + (SEA_LEVEL - 18);

  return h;
}

export function heightAt(x: number, z: number): number {
  return Math.floor(terrainHeight(x, z));
}

/**
 * Full column sample: terrain height + the water surface sitting on top of it
 * (ocean, river or lake). NO_WATER when the column is dry.
 */
export function columnAt(x: number, z: number, out: Column): void {
  const h = terrainHeight(x, z);
  let water = NO_WATER;

  if (riverDepth > 0.12 && h + riverDepth > SEA_LEVEL + 0.4) water = h + riverDepth;
  if (lakeLevel !== NO_WATER && lakeLevel > h + 0.2 && lakeLevel > SEA_LEVEL + 0.4) {
    water = water === NO_WATER ? lakeLevel : Math.max(water, lakeLevel);
  }
  // the ocean itself: handled by the big sea plane, but the player still
  // needs to know there is water here for swimming / footsteps
  if (h < SEA_LEVEL) water = water === NO_WATER ? SEA_LEVEL : Math.max(water, SEA_LEVEL);

  out.h = h;
  out.water = water;
}

export function snowLine(x: number, z: number): number {
  return 134 + fbm(x * 0.0035, z * 0.0035, 3) * 22;
}

/** above this, trees stop growing */
export function treeLine(x: number, z: number): number {
  return snowLine(x, z) - 18;
}

export function blockTypeFor(x: number, z: number, h: number, slope: number, water: number): number {
  // lake / river bed and shoreline
  if (water !== NO_WATER) {
    const depth = water - h;
    if (depth > 0.05 && depth < 1.8) return BLOCK.SAND;
    if (depth >= 1.8) return BLOCK.WATERBED;
  }
  if (h < SEA_LEVEL - 2) return BLOCK.WATERBED;
  if (h <= SEA_LEVEL + 2) return BLOCK.SAND;

  const sl = snowLine(x, z);
  // glacier fields: high, flat, permanently frozen
  if (h > sl + 58 && slope < 2.4) return BLOCK.ICE;
  if (h > sl + (slope > 4 ? 12 : 0)) return BLOCK.SNOW;
  if (h > sl - 12 && slope < 3 && hash2(x, z) < 0.55) return BLOCK.SNOW;
  if (slope >= 4) return BLOCK.STONE;
  if (slope >= 3) return hash2(x * 3, z * 7) > 0.5 ? BLOCK.STONE : BLOCK.DIRT;
  if (h > sl - 30) return hash2(x * 5, z * 3) > 0.62 ? BLOCK.ROCK_LIGHT : BLOCK.GRASS;
  return BLOCK.GRASS;
}

type RGB = [number, number, number];

/** sRGB -> linear (three.js works in linear space internally) */
export function toLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

const PALETTE: Record<number, RGB> = {
  [BLOCK.WATERBED]: [0.34, 0.32, 0.25],
  [BLOCK.SAND]: [0.83, 0.76, 0.55],
  [BLOCK.GRASS]: [0.34, 0.55, 0.22],
  [BLOCK.DIRT]: [0.42, 0.31, 0.2],
  [BLOCK.STONE]: [0.47, 0.47, 0.5],
  [BLOCK.SNOW]: [0.94, 0.96, 0.99],
  [BLOCK.ROCK_DARK]: [0.3, 0.29, 0.31],
  [BLOCK.ICE]: [0.78, 0.87, 0.93],
  [BLOCK.ROCK_LIGHT]: [0.57, 0.56, 0.54],
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
    const alt = smoothstep(SEA_LEVEL + 30, SEA_LEVEL + 90, h);
    r -= alt * 0.06;
    g -= alt * 0.1;
  }
  const jitter = type === BLOCK.SNOW ? 0.04 : type === BLOCK.ICE ? 0.03 : 0.11;
  const j = (hash2(x, z) - 0.5) * jitter;
  out[0] = toLinear(clamp(r + j, 0, 1));
  out[1] = toLinear(clamp(g + j, 0, 1));
  out[2] = toLinear(clamp(b + j, 0, 1));
  return out;
}

export function sideColor(type: number, depth: number, x: number, z: number, out: RGB): RGB {
  let t = type;
  if (type === BLOCK.GRASS) t = depth < 4 ? BLOCK.DIRT : BLOCK.STONE;
  else if (type === BLOCK.SNOW) t = depth < 1 ? BLOCK.SNOW : BLOCK.STONE;
  else if (type === BLOCK.ICE) t = depth < 2 ? BLOCK.ICE : BLOCK.STONE;
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

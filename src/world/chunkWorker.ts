/// <reference lib="webworker" />
import {
  BLOCK,
  CHUNK,
  HALF,
  SEA_LEVEL,
  blockTypeFor,
  heightAt,
  sideColor,
  topColor,
} from "./worldgen";

const MAXQ = CHUNK * CHUNK * 32;
const positions = new Float32Array(MAXQ * 12);
const normals = new Float32Array(MAXQ * 12);
const colors = new Float32Array(MAXQ * 12);
const indices = new Uint32Array(MAXQ * 6);

const S = CHUNK + 2; // heights incl. 1 block border
const hBuf = new Int16Array(S * S);
const tBuf = new Uint8Array(S * S);

let q = 0; // quad counter

const rgb: [number, number, number] = [0, 0, 0];

function quad(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
  r: number, g: number, b: number,
  a0: number, a1: number, a2: number, a3: number,
) {
  if (q >= MAXQ) return;
  const v = q * 12;
  positions[v] = ax; positions[v + 1] = ay; positions[v + 2] = az;
  positions[v + 3] = bx; positions[v + 4] = by; positions[v + 5] = bz;
  positions[v + 6] = cx; positions[v + 7] = cy; positions[v + 8] = cz;
  positions[v + 9] = dx; positions[v + 10] = dy; positions[v + 11] = dz;
  for (let i = 0; i < 4; i++) {
    normals[v + i * 3] = nx;
    normals[v + i * 3 + 1] = ny;
    normals[v + i * 3 + 2] = nz;
  }
  colors[v] = r * a0; colors[v + 1] = g * a0; colors[v + 2] = b * a0;
  colors[v + 3] = r * a1; colors[v + 4] = g * a1; colors[v + 5] = b * a1;
  colors[v + 6] = r * a2; colors[v + 7] = g * a2; colors[v + 8] = b * a2;
  colors[v + 9] = r * a3; colors[v + 10] = g * a3; colors[v + 11] = b * a3;

  const o = q * 6;
  const i0 = q * 4;
  // flip triangulation on strong AO gradients to avoid diagonal artefacts
  if (a0 + a2 > a1 + a3) {
    indices[o] = i0; indices[o + 1] = i0 + 1; indices[o + 2] = i0 + 2;
    indices[o + 3] = i0; indices[o + 4] = i0 + 2; indices[o + 5] = i0 + 3;
  } else {
    indices[o] = i0 + 1; indices[o + 1] = i0 + 2; indices[o + 2] = i0 + 3;
    indices[o + 3] = i0 + 1; indices[o + 4] = i0 + 3; indices[o + 5] = i0;
  }
  q++;
}

function occ(d: number) {
  return d <= 0 ? 0 : d >= 2 ? 1 : d * 0.5;
}

function buildChunk(cx: number, cz: number) {
  q = 0;
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;

  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) {
      const wx = ox + ix - 1;
      const wz = oz + iz - 1;
      hBuf[iz * S + ix] = heightAt(wx, wz);
    }
  }
  for (let iz = 1; iz <= CHUNK; iz++) {
    for (let ix = 1; ix <= CHUNK; ix++) {
      const i = iz * S + ix;
      const h = hBuf[i];
      const slope = Math.max(
        Math.abs(h - hBuf[i - 1]),
        Math.abs(h - hBuf[i + 1]),
        Math.abs(h - hBuf[i - S]),
        Math.abs(h - hBuf[i + S]),
      );
      tBuf[i] = blockTypeFor(ox + ix - 1, oz + iz - 1, h, slope);
    }
  }

  for (let iz = 1; iz <= CHUNK; iz++) {
    for (let ix = 1; ix <= CHUNK; ix++) {
      const i = iz * S + ix;
      const h = hBuf[i];
      const wx = ox + ix - 1;
      const wz = oz + iz - 1;
      const type = tBuf[i];
      const x0 = wx;
      const x1 = wx + 1;
      const z0 = wz;
      const z1 = wz + 1;

      // ---- top face (with baked ambient occlusion) ----
      topColor(type, wx, wz, h, rgb);
      const hw = hBuf[i - 1], he = hBuf[i + 1], hn = hBuf[i - S], hs = hBuf[i + S];
      const hnw = hBuf[i - S - 1], hne = hBuf[i - S + 1], hsw = hBuf[i + S - 1], hse = hBuf[i + S + 1];
      const aoC = (s1: number, s2: number, c: number) => {
        const o1 = occ(s1 - h), o2 = occ(s2 - h), oc = occ(c - h);
        const v = o1 + o2 > 1.6 ? 2 : o1 + o2 + oc;
        return 1 - Math.min(0.55, v * 0.19);
      };
      const a00 = aoC(hw, hn, hnw); // (x0,z0)
      const a10 = aoC(he, hn, hne); // (x1,z0)
      const a11 = aoC(he, hs, hse); // (x1,z1)
      const a01 = aoC(hw, hs, hsw); // (x0,z1)
      quad(
        x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1,
        0, 1, 0,
        rgb[0], rgb[1], rgb[2],
        a00, a10, a11, a01,
      );

      // ---- side faces ----
      const sides: Array<[number, number, number, number]> = [
        [he, 1, 0, 0],
        [hw, -1, 0, 0],
        [hs, 0, 0, 1],
        [hn, 0, 0, -1],
      ];
      for (let s = 0; s < 4; s++) {
        const [nh, nx, , nz] = sides[s];
        let diff = h - nh;
        if (diff <= 0) continue;
        if (diff > 40) diff = 40;
        const steps = Math.min(diff, 5);
        for (let d = 0; d < steps; d++) {
          const yTop = h - d;
          const yBot = d === steps - 1 ? h - diff : yTop - 1;
          sideColor(type, d, wx, wz, rgb);
          const shade = nx !== 0 ? 0.74 : 0.86;
          const tA = 1 * shade;
          const bA = (1 - Math.min(0.3, (d + 1) * 0.05)) * shade;
          if (nx === 1) {
            quad(x1, yTop, z0, x1, yTop, z1, x1, yBot, z1, x1, yBot, z0, 1, 0, 0, rgb[0], rgb[1], rgb[2], tA, tA, bA, bA);
          } else if (nx === -1) {
            quad(x0, yTop, z1, x0, yTop, z0, x0, yBot, z0, x0, yBot, z1, -1, 0, 0, rgb[0], rgb[1], rgb[2], tA, tA, bA, bA);
          } else if (nz === 1) {
            quad(x1, yTop, z1, x0, yTop, z1, x0, yBot, z1, x1, yBot, z1, 0, 0, 1, rgb[0], rgb[1], rgb[2], tA, tA, bA, bA);
          } else {
            quad(x0, yTop, z0, x1, yTop, z0, x1, yBot, z0, x0, yBot, z0, 0, 0, -1, rgb[0], rgb[1], rgb[2], tA, tA, bA, bA);
          }
        }
      }
    }
  }

  // compact column data for the main thread (collision, grass scattering)
  const heights = new Int16Array(CHUNK * CHUNK);
  const types = new Uint8Array(CHUNK * CHUNK);
  let hasWater = false;
  let grassCount = 0;
  for (let iz = 0; iz < CHUNK; iz++) {
    for (let ix = 0; ix < CHUNK; ix++) {
      const h = hBuf[(iz + 1) * S + ix + 1];
      const t = tBuf[(iz + 1) * S + ix + 1];
      heights[iz * CHUNK + ix] = h;
      types[iz * CHUNK + ix] = t;
      if (h < SEA_LEVEL) hasWater = true;
      if (t === BLOCK.GRASS) grassCount++;
    }
  }

  return {
    positions: positions.slice(0, q * 12),
    normals: normals.slice(0, q * 12),
    colors: colors.slice(0, q * 12),
    indices: indices.slice(0, q * 6),
    heights,
    types,
    hasWater,
    grassCount,
  };
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === "chunk") {
    const r = buildChunk(msg.cx, msg.cz);
    (self as unknown as Worker).postMessage(
      { type: "chunk", key: msg.key, cx: msg.cx, cz: msg.cz, ...r },
      [
        r.positions.buffer,
        r.normals.buffer,
        r.colors.buffer,
        r.indices.buffer,
        r.heights.buffer,
        r.types.buffer,
      ] as unknown as Transferable[],
    );
  } else if (msg.type === "heightmap") {
    const res: number = msg.res;
    const step = (HALF * 2) / res;
    const data = new Uint8Array(res * res);
    const batch = 64;
    for (let y0 = 0; y0 < res; y0 += batch) {
      const y1 = Math.min(res, y0 + batch);
      for (let y = y0; y < y1; y++) {
        const wz = -HALF + y * step;
        for (let x = 0; x < res; x++) {
          const wx = -HALF + x * step;
          const h = heightAt(wx, wz);
          data[y * res + x] = Math.max(0, Math.min(255, h));
        }
      }
      (self as unknown as Worker).postMessage({ type: "progress", value: y1 / res });
    }
    (self as unknown as Worker).postMessage({ type: "heightmap", res, data }, [
      data.buffer,
    ] as unknown as Transferable[]);
  }
};

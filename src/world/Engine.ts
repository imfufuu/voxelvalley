import * as THREE from "three";
import ChunkWorker from "./chunkWorker?worker&inline";
import {
  CLOUD_FRAG,
  CLOUD_VERT,
  GRASS_FRAG,
  GRASS_VERT,
  SKY_FRAG,
  SKY_VERT,
  WATER_FRAG,
  WATER_VERT,
} from "./shaders";
import { SoundKit } from "./Audio";
import { requestSteer, type LookMode } from "./steering";
import { clamp, fbm, hash2 } from "./noise";
import { BLOCK, CHUNK, HALF, SEA_LEVEL, WORLD_SIZE, heightAt, toLinear } from "./worldgen";

export type Quality = "low" | "medium" | "high" | "ultra";
export type { LookMode };

export interface Stats {
  x: number;
  y: number;
  z: number;
  fps: number;
  chunks: number;
  tris: number;
  biome: string;
  timeLabel: string;
  submerged: boolean;
  speed: number;
  grounded: boolean;
  /** how the camera is being steered right now */
  look: LookMode;
}


const QUALITY: Record<Quality, { radius: number; grassRange: number; grassPerBlock: number; shadow: number; pixelRatio: number }> = {
  low: { radius: 6, grassRange: 22, grassPerBlock: 2, shadow: 1024, pixelRatio: 1 },
  medium: { radius: 9, grassRange: 30, grassPerBlock: 3, shadow: 1536, pixelRatio: 1.25 },
  high: { radius: 12, grassRange: 38, grassPerBlock: 4, shadow: 2048, pixelRatio: 1.5 },
  ultra: { radius: 15, grassRange: 46, grassPerBlock: 5, shadow: 2048, pixelRatio: 2 },
};

interface ChunkRec {
  mesh: THREE.Mesh;
  heights: Int16Array;
  types: Uint8Array;
  cx: number;
  cz: number;
}

const HM_RES = 1024;

export class Engine {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  clock = new THREE.Clock();

  onProgress: (v: number, label: string) => void = () => {};
  onReady: () => void = () => {};
  onStats: (s: Stats) => void = () => {};
  onError: (message: string) => void = () => {};
  onMinimap: (url: string) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};

  quality: Quality = "high";
  private q = QUALITY.high;

  // world
  private chunks = new Map<string, ChunkRec>();
  private pending = new Set<string>();
  private queue: { cx: number; cz: number; d: number }[] = [];
  private lastScanKey = "";
  private scanDirty = true;
  private workers: Worker[] = [];
  private wIdx = 0;
  private terrainMat!: THREE.MeshLambertMaterial;
  private heightTex!: THREE.DataTexture;
  private heightData: Uint8Array | null = null;

  // visuals
  private sky!: THREE.Mesh;
  private skyMat!: THREE.ShaderMaterial;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private water!: THREE.Mesh;
  private waterMat!: THREE.ShaderMaterial;
  private grass!: THREE.Mesh;
  private grassMat!: THREE.ShaderMaterial;
  private grassGeo!: THREE.InstancedBufferGeometry;
  private grassCapacity = 0;
  private lastGrassPos = new THREE.Vector3(1e9, 0, 1e9);
  private clouds!: THREE.InstancedMesh;
  private cloudMat!: THREE.ShaderMaterial;
  private cloudAlpha!: THREE.InstancedBufferAttribute;
  private cloudCell = 20;
  private cloudGrid = 46;
  private lastCloudKey = "";
  private cloudDrift = 0;

  // player
  pos = new THREE.Vector3(0, 80, 0);
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  /** active steering mode once the player has entered the world */
  lookMode: LookMode = "pointer";
  /** true while the player is actually inside the world (start screen dismissed) */
  private entered = false;
  private dragLook = false;
  private dragLastX = 0;
  private dragLastY = 0;
  private keys = new Set<string>();
  private grounded = false;
  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private stepOffset = 0;
  private eyeHeight = 1.72;
  private fly = false;
  private fovTarget = 74;
  private lastStepIdx = 0;
  private wasInWater = false;
  sound = new SoundKit();
  private curFov = 74;
  private mouseSensitivity = 0.0022;

  // time
  timeOfDay = 0.33;
  timeSpeed = 0.004; // day fraction per second
  private elapsed = 0;

  private raf = 0;
  private frames = 0;
  private fpsTimer = 0;
  private fps = 60;
  private statTimer = 0;
  private disposed = false;
  private warnedHeightmap = false;
  private warnedChunks = false;
  ready = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, 2400);

    this.scene.fog = new THREE.FogExp2(0x9fc0e0, 0.0022);

    this.buildLights();
    this.buildSky();
    this.buildTerrainMaterial();
    this.buildWater();
    this.buildGrass();
    this.buildClouds();
    this.bindEvents();
    this.spawnWorkers();
  }

  /* ------------------------------------------------------------------ setup */

  private buildLights() {
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    const c = this.sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -70;
    c.right = 70;
    c.top = 70;
    c.bottom = -70;
    c.near = 1;
    c.far = 380;
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a5a3a, 0.9);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.22);
    this.scene.add(this.ambient);
  }

  private buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uZenith: { value: new THREE.Color(0x2f6fd0) },
        uHorizon: { value: new THREE.Color(0xcfe2f5) },
        uSunColor: { value: new THREE.Color(0xfff3d6) },
        uNight: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);
  }

  private buildTerrainMaterial() {
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // aerial perspective: fog thins out with altitude so distant peaks stay readable
    this.terrainMat.onBeforeCompile = (shader) => {
      shader.vertexShader = "varying float vWorldY;\n" + shader.vertexShader.replace(
        "#include <fog_vertex>",
        "#include <fog_vertex>\n  vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;",
      );
      shader.fragmentShader =
        "varying float vWorldY;\n" +
        shader.fragmentShader.replace(
          "#include <fog_fragment>",
          `#ifdef USE_FOG
             float fd = fogDensity * vFogDepth;
             float ff = 1.0 - exp(-fd * fd);
             ff *= exp(-max(vWorldY - 44.0, 0.0) * 0.0068);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(ff, 0.0, 1.0));
           #endif`,
        );
    };
    this.terrainMat.customProgramCacheKey = () => "terrain-aerial";
    this.heightTex = new THREE.DataTexture(
      new Uint8Array(HM_RES * HM_RES),
      HM_RES,
      HM_RES,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.needsUpdate = true;
  }

  private buildWater() {
    const geo = new THREE.PlaneGeometry(1100, 1100, 200, 200);
    geo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uZenith: { value: new THREE.Color(0x2f6fd0) },
        uHorizon: { value: new THREE.Color(0xcfe2f5) },
        uFogColor: { value: new THREE.Color(0x9fc0e0) },
        uFogDensity: { value: 0.0022 },
        uHeightMap: { value: this.heightTex },
        uWorldSize: { value: WORLD_SIZE },
        uSeaLevel: { value: SEA_LEVEL },
        uShallow: { value: new THREE.Color(0x2f8f9d) },
        uDeep: { value: new THREE.Color(0x0a2740) },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.y = SEA_LEVEL;
    this.water.frustumCulled = false;
    this.water.renderOrder = 10;
    this.scene.add(this.water);
  }

  private bladeGeometry() {
    // tapered blade: 3 segments + tip
    const levels = [0, 0.34, 0.66, 1.0];
    const widths = [0.5, 0.42, 0.28, 0.0];
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < levels.length; i++) {
      pos.push(-widths[i], levels[i], 0, widths[i], levels[i], 0);
      nrm.push(-0.35, 0.1, 0.93, 0.35, 0.1, 0.93);
    }
    for (let i = 0; i < levels.length - 1; i++) {
      const a = i * 2,
        b = i * 2 + 1,
        c = i * 2 + 2,
        d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    return g;
  }

  private buildGrass() {
    const base = this.bladeGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("normal", base.getAttribute("normal"));
    this.grassCapacity = 60000;
    geo.setAttribute(
      "iPos",
      new THREE.InstancedBufferAttribute(new Float32Array(this.grassCapacity * 3), 3),
    );
    geo.setAttribute(
      "iParams",
      new THREE.InstancedBufferAttribute(new Float32Array(this.grassCapacity * 4), 4),
    );
    geo.setAttribute(
      "iColor",
      new THREE.InstancedBufferAttribute(new Float32Array(this.grassCapacity * 3), 3),
    );
    geo.instanceCount = 0;
    this.grassGeo = geo;

    this.grassMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uWind: { value: 0.55 },
        uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
        uRange: { value: this.q.grassRange },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uAmbient: { value: new THREE.Color(0x5a7090) },
        uFogColor: { value: new THREE.Color(0x9fc0e0) },
        uFogDensity: { value: 0.0022 },
      },
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
      side: THREE.DoubleSide,
    });
    this.grass = new THREE.Mesh(geo, this.grassMat);
    this.grass.frustumCulled = false;
    this.grass.castShadow = false;
    this.grass.receiveShadow = false;
    this.scene.add(this.grass);
  }

  private buildClouds() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const count = this.cloudGrid * this.cloudGrid;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uTop: { value: new THREE.Color(0xffffff) },
        uBottom: { value: new THREE.Color(0x9fb0cc) },
        uFogColor: { value: new THREE.Color(0x9fc0e0) },
        uFogDensity: { value: 0.0012 },
        uCameraPos: { value: new THREE.Vector3() },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: true,
    });
    this.clouds = new THREE.InstancedMesh(box, this.cloudMat, count);
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cloudAlpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.cloudAlpha.setUsage(THREE.DynamicDrawUsage);
    box.setAttribute("iAlpha", this.cloudAlpha);
    this.clouds.frustumCulled = false;
    this.clouds.count = 0;
    this.clouds.renderOrder = 5;
    this.scene.add(this.clouds);
  }

  private spawnWorkers() {
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new ChunkWorker();
      w.onmessage = (ev: MessageEvent) => this.onWorkerMessage(ev);
      w.onerror = (ev: ErrorEvent) => {
        this.onError(
          `地形 Worker 启动失败：${ev.message || "unknown error"}（内联 Worker 在此环境可能不可用）`,
        );
      };
      this.workers.push(w);
    }
    this.workers[0].postMessage({ type: "heightmap", res: HM_RES });
  }

  /* ------------------------------------------------------------- chunk flow */

  private onWorkerMessage(ev: MessageEvent) {
    if (this.disposed) return;
    const m = ev.data;
    if (m.type === "progress") {
      this.onProgress(m.value * 0.45, "生成 2048 × 2048 地形高度场…");
      return;
    }
    if (m.type === "heightmap") {
      this.heightData = m.data as Uint8Array;
      (this.heightTex.image.data as Uint8Array).set(this.heightData!);
      this.heightTex.needsUpdate = true;
      this.buildMinimap();
      this.placePlayer();
      this.onProgress(0.5, "构建区块网格…");
      return;
    }
    if (m.type === "chunk") {
      this.pending.delete(m.key);
      this.addChunk(m);
      this.scanDirty = true;
      this.pumpQueue();
    }
  }

  private addChunk(m: any) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(m.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const ox = m.cx * CHUNK;
    const oz = m.cz * CHUNK;
    const hs = m.heights as Int16Array;
    let minH = 1e5;
    let maxH = -1e5;
    for (let i = 0; i < hs.length; i++) {
      if (hs[i] < minH) minH = hs[i];
      if (hs[i] > maxH) maxH = hs[i];
    }
    minH = Math.min(minH, SEA_LEVEL) - 42; // side skirts can reach well below
    const cy = (minH + maxH) * 0.5;
    const half = (maxH - minH) * 0.5 + 1;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + CHUNK / 2, cy, oz + CHUNK / 2),
      Math.sqrt(CHUNK * CHUNK * 0.5 + half * half) + 1,
    );
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.scene.add(mesh);
    this.chunks.set(m.key, {
      mesh,
      heights: m.heights,
      types: m.types,
      cx: m.cx,
      cz: m.cz,
    });

    // newly streamed ground near the player needs its grass scattered
    const dx = ox + CHUNK / 2 - this.pos.x;
    const dz = oz + CHUNK / 2 - this.pos.z;
    if (dx * dx + dz * dz < (this.q.grassRange + CHUNK) ** 2) {
      this.lastGrassPos.set(1e9, 0, 1e9);
    }
  }

  private pumpQueue() {
    while (this.pending.size < this.workers.length * 2 && this.queue.length) {
      const job = this.queue.shift()!;
      const key = `${job.cx},${job.cz}`;
      if (this.chunks.has(key) || this.pending.has(key)) continue;
      this.pending.add(key);
      this.workers[this.wIdx++ % this.workers.length].postMessage({
        type: "chunk",
        key,
        cx: job.cx,
        cz: job.cz,
      });
    }
  }

  private updateChunks(force = false) {
    const R = this.q.radius;
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    const maxC = Math.floor(HALF / CHUNK);
    const scanKey = `${pcx},${pcz},${R}`;
    if (!force && scanKey === this.lastScanKey && !this.scanDirty) return;
    this.lastScanKey = scanKey;
    this.scanDirty = false;

    this.queue.length = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > R + 0.3) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (cx < -maxC || cx >= maxC || cz < -maxC || cz >= maxC) continue;
        const key = `${cx},${cz}`;
        if (this.chunks.has(key) || this.pending.has(key)) continue;
        this.queue.push({ cx, cz, d });
      }
    }
    this.queue.sort((a, b) => a.d - b.d);
    this.pumpQueue();

    // unload + shadow casting toggle
    for (const [key, rec] of this.chunks) {
      const dx = rec.cx - pcx;
      const dz = rec.cz - pcz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R + 2.5) {
        this.scene.remove(rec.mesh);
        rec.mesh.geometry.dispose();
        this.chunks.delete(key);
      } else {
        const shouldCast = d <= 3;
        if (rec.mesh.castShadow !== shouldCast) rec.mesh.castShadow = shouldCast;
      }
    }
  }

  /** column surface height (top of solid block) */
  heightAtWorld(x: number, z: number): number {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const cx = Math.floor(fx / CHUNK);
    const cz = Math.floor(fz / CHUNK);
    const rec = this.chunks.get(`${cx},${cz}`);
    if (rec) {
      const lx = fx - cx * CHUNK;
      const lz = fz - cz * CHUNK;
      return rec.heights[lz * CHUNK + lx];
    }
    return heightAt(fx, fz);
  }

  typeAtWorld(x: number, z: number): number {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const cx = Math.floor(fx / CHUNK);
    const cz = Math.floor(fz / CHUNK);
    const rec = this.chunks.get(`${cx},${cz}`);
    if (!rec) return -1;
    const lx = fx - cx * CHUNK;
    const lz = fz - cz * CHUNK;
    return rec.types[lz * CHUNK + lx];
  }

  /* --------------------------------------------------------------- minimap */

  private buildMinimap() {
    if (!this.heightData) return;
    const N = 256;
    const cv = document.createElement("canvas");
    cv.width = N;
    cv.height = N;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(N, N);
    const step = HM_RES / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const sx = Math.floor(x * step);
        const sy = Math.floor(y * step);
        const h = this.heightData[sy * HM_RES + sx];
        const hx = this.heightData[sy * HM_RES + Math.min(HM_RES - 1, sx + 1)];
        const hz = this.heightData[Math.min(HM_RES - 1, sy + 1) * HM_RES + sx];
        let r: number, g: number, b: number;
        if (h < SEA_LEVEL - 6) {
          r = 22; g = 58; b = 96;
        } else if (h < SEA_LEVEL) {
          r = 44; g = 104; b = 140;
        } else if (h < SEA_LEVEL + 3) {
          r = 196; g = 180; b = 132;
        } else if (h < 95) {
          const t = (h - SEA_LEVEL) / 60;
          r = 72 + t * 40; g = 116 - t * 22; b = 52 + t * 20;
        } else if (h < 118) {
          r = 118; g = 116; b = 118;
        } else {
          r = 236; g = 242; b = 250;
        }
        const shade = clamp(1 + (h - hx) * 0.06 + (h - hz) * 0.04, 0.6, 1.5);
        const o = (y * N + x) * 4;
        img.data[o] = clamp(r * shade, 0, 255);
        img.data[o + 1] = clamp(g * shade, 0, 255);
        img.data[o + 2] = clamp(b * shade, 0, 255);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.onMinimap(cv.toDataURL("image/png"));
  }

  /** find a nice grassy valley spawn near a mountain view */
  private placePlayer() {
    if (!this.heightData) return;
    let best: { x: number; z: number; score: number } | null = null;
    for (let i = 0; i < 900; i++) {
      const gx = Math.floor(hash2(i, 17) * HM_RES);
      const gz = Math.floor(hash2(i, 91) * HM_RES);
      const h = this.heightData[gz * HM_RES + gx];
      if (h < SEA_LEVEL + 3 || h > SEA_LEVEL + 22) continue;
      // want mountains within ~350 blocks
      let mountain = 0;
      for (let s = 0; s < 24; s++) {
        const a = (s / 24) * Math.PI * 2;
        const rx = clamp(gx + Math.cos(a) * 110, 0, HM_RES - 1) | 0;
        const rz = clamp(gz + Math.sin(a) * 110, 0, HM_RES - 1) | 0;
        mountain = Math.max(mountain, this.heightData[rz * HM_RES + rx]);
      }
      const wx = -HALF + (gx / HM_RES) * WORLD_SIZE;
      const wz = -HALF + (gz / HM_RES) * WORLD_SIZE;
      const score = mountain - Math.abs(h - (SEA_LEVEL + 9)) * 2;
      if (!best || score > best.score) best = { x: wx, z: wz, score };
    }
    if (best) {
      this.pos.set(best.x + 0.5, 0, best.z + 0.5);
      this.pos.y = heightAt(this.pos.x, this.pos.z) + this.eyeHeight + 0.2;
      this.yaw = Math.PI * 0.25;
    }
  }

  /* ----------------------------------------------------------------- grass */

  private rebuildGrass() {
    const range = this.q.grassRange;
    const per = this.q.grassPerBlock;
    const iPos = this.grassGeo.getAttribute("iPos") as THREE.InstancedBufferAttribute;
    const iPar = this.grassGeo.getAttribute("iParams") as THREE.InstancedBufferAttribute;
    const iCol = this.grassGeo.getAttribute("iColor") as THREE.InstancedBufferAttribute;
    const pa = iPos.array as Float32Array;
    const ba = iPar.array as Float32Array;
    const ca = iCol.array as Float32Array;

    let n = 0;
    const px = Math.floor(this.pos.x);
    const pz = Math.floor(this.pos.z);
    const r = Math.ceil(range);
    const r2 = range * range;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const x = px + dx;
        const z = pz + dz;
        const t = this.typeAtWorld(x, z);
        if (t !== BLOCK.GRASS) continue;
        const h = this.heightAtWorld(x, z);
        const density = hash2(x * 7, z * 13) > 0.12 ? per : 1;
        for (let k = 0; k < density; k++) {
          if (n >= this.grassCapacity) break;
          const rx = hash2(x * 31 + k * 5, z * 17 + k * 3);
          const rz = hash2(x * 13 - k * 9, z * 23 + k * 11);
          const rr = hash2(x * 3 + k, z * 41 + k * 7);
          const gx = x + rx;
          const gz = z + rz;
          pa[n * 3] = gx;
          pa[n * 3 + 1] = h;
          pa[n * 3 + 2] = gz;
          const tall = 0.45 + rr * 0.72;
          ba[n * 4] = tall;
          ba[n * 4 + 1] = 0.055 + rr * 0.035;
          ba[n * 4 + 2] = rx * Math.PI * 2;
          ba[n * 4 + 3] = rr * 20.0;
          const flower = rr > 0.985;
          const tint = fbm(gx * 0.05, gz * 0.05, 2) * 0.5 + 0.5;
          if (flower) {
            const f = hash2(x * 5, z * 9);
            ca[n * 3] = toLinear(0.85 + f * 0.15);
            ca[n * 3 + 1] = toLinear(0.75 - f * 0.35);
            ca[n * 3 + 2] = toLinear(0.25 + f * 0.5);
          } else {
            ca[n * 3] = toLinear(0.2 + tint * 0.22);
            ca[n * 3 + 1] = toLinear(0.4 + tint * 0.3);
            ca[n * 3 + 2] = toLinear(0.11 + tint * 0.12);
          }
          n++;
        }
      }
    }
    iPos.needsUpdate = true;
    iPar.needsUpdate = true;
    iCol.needsUpdate = true;
    iPos.clearUpdateRanges?.();
    this.grassGeo.instanceCount = n;
    this.lastGrassPos.copy(this.pos);
  }

  /* ---------------------------------------------------------------- clouds */

  private updateClouds(dt: number) {
    this.cloudDrift += dt * 1.35;
    const cell = this.cloudCell;
    const G = this.cloudGrid;
    const originX = Math.round((this.pos.x - this.cloudDrift) / cell);
    const originZ = Math.round(this.pos.z / cell);
    const key = `${originX},${originZ}`;
    const mat = new THREE.Matrix4();
    if (key !== this.lastCloudKey) {
      this.lastCloudKey = key;
      let n = 0;
      const alphas = this.cloudAlpha.array as Float32Array;
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const ci = originX + i - G / 2;
          const cj = originZ + j - G / 2;
          const nx = ci * cell * 0.0022;
          const nz = cj * cell * 0.0022;
          let d = fbm(nx, nz, 4) * 0.5 + 0.5;
          d += fbm(nx * 3.1 + 40, nz * 3.1 - 20, 3) * 0.16;
          if (d < 0.54) continue;
          const dens = Math.min(1, (d - 0.54) / 0.26);
          const hRand = hash2(ci, cj);
          const sy = 4 + dens * 11 + hRand * 4;
          const sx = cell * (0.85 + hash2(ci * 3, cj * 7) * 0.3);
          const sz = cell * (0.85 + hash2(ci * 11, cj * 5) * 0.3);
          const y = 168 + Math.sin(ci * 0.7) * 5 + Math.cos(cj * 0.5) * 5 + dens * 8;
          mat.makeScale(sx, sy, sz);
          mat.setPosition(ci * cell, y, cj * cell);
          this.clouds.setMatrixAt(n, mat);
          alphas[n] = 0.82 + dens * 0.18;
          n++;
          if (n >= G * G) break;
        }
      }
      this.clouds.count = n;
      this.clouds.instanceMatrix.needsUpdate = true;
      this.cloudAlpha.needsUpdate = true;
    }
    this.clouds.position.x = this.cloudDrift;
    this.clouds.position.z = Math.sin(this.cloudDrift * 0.03) * 6;
  }

  /* ------------------------------------------------------------ atmosphere */

  private updateSky(dt: number) {
    this.timeOfDay = (this.timeOfDay + this.timeSpeed * dt) % 1;
    const a = (this.timeOfDay - 0.25) * Math.PI * 2;
    const sunDir = new THREE.Vector3(Math.cos(a) * 0.86, Math.sin(a) * 0.86, -0.28).normalize();
    const e = sunDir.y;

    const dayT = clamp((e + 0.06) / 0.28, 0, 1); // 0 night -> 1 day
    const duskT = Math.max(0, 1 - Math.abs(e) / 0.26); // horizon glow

    const zenithDay = new THREE.Color(0x2f6ed0);
    const zenithNight = new THREE.Color(0x070c1e);
    const horizonDay = new THREE.Color(0xd6e7f7);
    const horizonNight = new THREE.Color(0x141d33);
    const duskCol = new THREE.Color(0xff9b52);

    const zenith = zenithNight.clone().lerp(zenithDay, dayT);
    zenith.lerp(new THREE.Color(0x3a5ea8), duskT * 0.4);
    const horizon = horizonNight.clone().lerp(horizonDay, dayT);
    horizon.lerp(duskCol, duskT * 0.75);

    const sunCol = new THREE.Color(0xfff4dd).lerp(new THREE.Color(0xff7a2a), Math.pow(duskT, 1.5) * 0.85);
    const nightF = 1 - dayT;

    this.skyMat.uniforms.uSunDir.value.copy(sunDir);
    this.skyMat.uniforms.uZenith.value.copy(zenith);
    this.skyMat.uniforms.uHorizon.value.copy(horizon);
    this.skyMat.uniforms.uSunColor.value.copy(sunCol);
    this.skyMat.uniforms.uNight.value = nightF;
    this.skyMat.uniforms.uTime.value = this.elapsed;

    const sunIntensity = Math.max(0, e) * 2.6 + 0.05;
    this.sun.color.copy(sunCol);
    this.sun.intensity = sunIntensity;
    this.sun.position.copy(sunDir).multiplyScalar(160).add(this.pos);
    this.sun.target.position.copy(this.pos);
    this.sun.target.updateMatrixWorld();

    this.hemi.intensity = 0.35 + dayT * 0.75;
    this.hemi.color.copy(horizon).lerp(new THREE.Color(0xffffff), 0.25);
    this.hemi.groundColor.set(0x3a4a2e).lerp(new THREE.Color(0x0a0f1a), nightF);
    this.ambient.intensity = 0.1 + dayT * 0.16;

    const submerged = this.pos.y < SEA_LEVEL;
    const fog = this.scene.fog as THREE.FogExp2;
    const fogCol = submerged
      ? new THREE.Color(0x12506b).lerp(new THREE.Color(0x04121d), nightF * 0.7)
      : horizon.clone().lerp(zenith, 0.18);
    fog.color.copy(fogCol);
    fog.density = submerged ? 0.055 : 0.0027;
    this.renderer.toneMappingExposure = submerged ? 0.85 : 1.02 + nightF * 0.12;

    // share with custom shaders
    const wu = this.waterMat.uniforms;
    wu.uSunDir.value.copy(sunDir);
    wu.uSunColor.value.copy(sunCol);
    wu.uZenith.value.copy(zenith);
    wu.uHorizon.value.copy(horizon);
    wu.uFogColor.value.copy(fogCol);
    wu.uFogDensity.value = fog.density;
    wu.uTime.value = this.elapsed;
    wu.uCameraPos.value.copy(this.camera.position);
    wu.uDeep.value.set(0x07243d).lerp(new THREE.Color(0x02101c), nightF);
    wu.uShallow.value.set(0x2e93a0).lerp(new THREE.Color(0x0d2b3a), nightF * 0.8);

    const gu = this.grassMat.uniforms;
    gu.uSunDir.value.copy(sunDir);
    gu.uSunColor.value.copy(sunCol).multiplyScalar(0.55 + dayT * 0.7);
    gu.uAmbient.value.copy(horizon).multiplyScalar(0.34 + dayT * 0.2);
    gu.uFogColor.value.copy(fogCol);
    gu.uFogDensity.value = fog.density;
    gu.uCameraPos.value.copy(this.camera.position);
    gu.uTime.value = this.elapsed;
    gu.uWind.value = 0.42 + Math.sin(this.elapsed * 0.11) * 0.22 + Math.sin(this.elapsed * 0.037) * 0.12;

    const cu = this.cloudMat.uniforms;
    cu.uSunDir.value.copy(sunDir);
    cu.uSunColor.value.copy(sunCol);
    cu.uTop.value.set(0xffffff).lerp(new THREE.Color(0xffd0a0), duskT * 0.6).lerp(new THREE.Color(0x1b2338), nightF * 0.85);
    cu.uBottom.value.set(0xa8bcd8).lerp(new THREE.Color(0xc98a72), duskT * 0.5).lerp(new THREE.Color(0x0f1524), nightF * 0.85);
    cu.uFogColor.value.copy(fogCol);
    cu.uCameraPos.value.copy(this.camera.position);
    void dt;
  }

  /* ---------------------------------------------------------------- player */

  private bindEvents() {
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onPointerLock);
    document.addEventListener("mousemove", this.onMouseMove);
    // drag-look fallback (pointer lock blocked / touch devices)
    this.canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === "Escape" && this.lookMode === "drag") {
      this.exitLook();
      return;
    }
    if (e.code === "KeyF") this.fly = !this.fly;
    if (e.code === "KeyM") this.sound.enabled = !this.sound.enabled;
    if (e.code === "KeyT") {
      this.timeSpeed = this.timeSpeed === 0 ? 0.004 : this.timeSpeed === 0.004 ? 0.03 : 0;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onPointerLock = () => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      this.lookMode = "pointer";
      this.entered = true;
      this.canvas.style.cursor = "";
    } else {
      this.entered = false;
    }
    this.onLockChange(locked);
    if (!locked) this.keys.clear();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.yaw -= e.movementX * this.mouseSensitivity;
    this.pitch -= e.movementY * this.mouseSensitivity;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  };

  /* --- fallback steering: hold a button and move the pointer --- */

  private onCanvasPointerDown = (e: PointerEvent) => {
    if (this.lookMode !== "drag" || !this.entered) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.dragLook = true;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
    this.canvas.style.cursor = "grabbing";
    this.canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragLook || !this.entered) return;
    const dx = e.clientX - this.dragLastX;
    const dy = e.clientY - this.dragLastY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
    this.yaw -= dx * this.mouseSensitivity * 1.6;
    this.pitch -= dy * this.mouseSensitivity * 1.6;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.dragLook) return;
    this.dragLook = false;
    this.canvas.style.cursor = "grab";
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  private onContextMenu = (e: Event) => {
    if (this.lookMode === "drag") e.preventDefault();
  };

  requestLock() {
    this.sound.resume();
    // already steering by dragging: just re-enter
    if (this.lookMode === "drag") {
      this.entered = true;
      this.onLockChange(true);
      return;
    }
    requestSteer(this.canvas, (mode) => {
      this.entered = true;
      if (mode === "pointer") {
        this.lookMode = "pointer";
        this.onLockChange(true);
      } else {
        this.enterDragMode();
      }
    });
  }

  /**
   * Pointer lock was refused (embedded/iframe preview, denied permission,
   * mobile…). Fall back to hold-the-button drag looking so the world stays
   * playable instead of the start button doing nothing.
   */
  private enterDragMode() {
    this.lookMode = "drag";
    this.entered = true;
    this.canvas.style.cursor = "grab";
    this.onLockChange(true);
  }

  /** leave the world (Esc in drag mode, or pointer lock released by the browser) */
  exitLook() {
    this.dragLook = false;
    this.entered = false;
    this.keys.clear();
    this.canvas.style.cursor = "";
    this.onLockChange(false);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private solidAt(x: number, z: number, feetY: number) {
    return this.heightAtWorld(x, z) > feetY + 1.02;
  }

  private updatePlayer(dt: number) {
    const k = this.keys;
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    const crouch = k.has("ControlLeft") || k.has("KeyC");
    const inWater = this.pos.y - this.eyeHeight < SEA_LEVEL - 0.2;

    let speed = crouch ? 2.0 : sprint ? 8.6 : 4.7;
    if (inWater) speed *= 0.55;
    if (this.fly) speed = sprint ? 42 : 16;

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (k.has("KeyW") || k.has("ArrowUp")) wish.add(forward);
    if (k.has("KeyS") || k.has("ArrowDown")) wish.sub(forward);
    if (k.has("KeyD") || k.has("ArrowRight")) wish.add(right);
    if (k.has("KeyA") || k.has("ArrowLeft")) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize();

    if (this.fly) {
      this.vel.set(wish.x * speed, 0, wish.z * speed);
      if (k.has("Space")) this.vel.y = speed * 0.8;
      else if (crouch) this.vel.y = -speed * 0.8;
      this.pos.addScaledVector(this.vel, dt);
      this.grounded = false;
    } else {
      const accel = this.grounded ? 42 : 12;
      this.vel.x += (wish.x * speed - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (wish.z * speed - this.vel.z) * Math.min(1, accel * dt);

      if (inWater) {
        this.vel.y += -7 * dt;
        this.vel.y *= 0.94;
        if (k.has("Space")) this.vel.y += 16 * dt;
      } else {
        this.vel.y -= 27 * dt;
        if (k.has("Space") && this.grounded) {
          this.vel.y = 8.4;
          this.grounded = false;
        }
      }
      this.vel.y = Math.max(this.vel.y, -55);

      // axis separated horizontal movement with auto step-up
      const feetY = this.pos.y - this.eyeHeight;
      const rad = 0.32;
      const nx = this.pos.x + this.vel.x * dt;
      const sx = Math.sign(this.vel.x) * rad;
      if (
        !this.solidAt(nx + sx, this.pos.z + rad * 0.9, feetY) &&
        !this.solidAt(nx + sx, this.pos.z - rad * 0.9, feetY)
      ) {
        this.pos.x = nx;
      } else this.vel.x *= 0.2;

      const nz = this.pos.z + this.vel.z * dt;
      const sz = Math.sign(this.vel.z) * rad;
      if (
        !this.solidAt(this.pos.x + rad * 0.9, nz + sz, feetY) &&
        !this.solidAt(this.pos.x - rad * 0.9, nz + sz, feetY)
      ) {
        this.pos.z = nz;
      } else this.vel.z *= 0.2;

      this.pos.y += this.vel.y * dt;

      // ground resolution (sample the 4 corners of the player footprint)
      let ground = -Infinity;
      for (const [ox, oz] of [
        [rad, rad],
        [-rad, rad],
        [rad, -rad],
        [-rad, -rad],
      ]) {
        ground = Math.max(ground, this.heightAtWorld(this.pos.x + ox, this.pos.z + oz));
      }
      const feet = this.pos.y - this.eyeHeight;
      if (feet <= ground) {
        if (!this.grounded && this.vel.y < -8) this.landDip = Math.min(0.36, -this.vel.y * 0.017);
        const delta = ground + this.eyeHeight - this.pos.y;
        if (Math.abs(delta) < 1.35 && this.vel.y > -9) {
          this.stepOffset = clamp(this.stepOffset + delta, -1.2, 1.2);
        }
        this.pos.y = ground + this.eyeHeight;
        this.vel.y = 0;
        this.grounded = true;
      } else if (feet > ground + 0.02) {
        this.grounded = false;
      }
    }

    // clamp to the 2048² map
    const lim = HALF - 2;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);

    // ---------------- head bob / camera feel ----------------
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const moving = hSpeed > 0.6 && (this.grounded || inWater);
    this.bobPhase += dt * (4.6 + hSpeed * 0.92);
    const targetBob = moving ? Math.min(1, hSpeed / 8.6) : 0;
    this.bobAmount += (targetBob - this.bobAmount) * Math.min(1, dt * 8);
    this.landDip *= Math.max(0, 1 - dt * 6);
    this.stepOffset *= Math.max(0, 1 - dt * 13);

    const bobY = Math.sin(this.bobPhase * 2) * 0.052 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.048 * this.bobAmount;
    const roll = Math.cos(this.bobPhase) * 0.013 * this.bobAmount;
    const breathe = Math.sin(this.elapsed * 1.1) * 0.012;

    // footsteps driven by the bob cycle
    const stepIdx = Math.floor((this.bobPhase * 2) / Math.PI);
    if (stepIdx !== this.lastStepIdx) {
      this.lastStepIdx = stepIdx;
      if (this.bobAmount > 0.22 && (this.grounded || inWater)) {
        const bt = this.typeAtWorld(this.pos.x, this.pos.z);
        const surf = inWater
          ? "water"
          : bt === BLOCK.SAND
            ? "sand"
            : bt === BLOCK.SNOW
              ? "snow"
              : bt === BLOCK.STONE
                ? "stone"
                : "grass";
        this.sound.step(surf as "grass", Math.min(1, 0.4 + this.bobAmount));
      }
    }
    if (inWater !== this.wasInWater) {
      this.wasInWater = inWater;
      if (inWater && Math.abs(this.vel.y) > 1) this.sound.splash();
    }

    const eye = this.pos.y - this.stepOffset - this.landDip + bobY + breathe - (crouch ? 0.5 : 0);
    const rightV = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.set(this.pos.x + rightV.x * bobX, eye, this.pos.z + rightV.z * bobX);

    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.pitch - this.bobAmount * 0.012, this.yaw, roll, "YXZ"),
    );
    this.camera.quaternion.copy(q);

    this.fovTarget = 74 + (sprint && hSpeed > 6 ? 7 : 0) + (inWater ? -4 : 0);
    this.curFov += (this.fovTarget - this.curFov) * Math.min(1, dt * 5);
    if (Math.abs(this.camera.fov - this.curFov) > 0.01) {
      this.camera.fov = this.curFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------ loop */

  start() {
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.elapsed += dt;
      this.frames++;
      this.fpsTimer += dt;
      if (this.fpsTimer > 0.5) {
        this.fps = this.frames / this.fpsTimer;
        this.frames = 0;
        this.fpsTimer = 0;
      }

      // watchdogs: a failure here used to leave the start screen stuck at 50%
      if (!this.heightData && !this.warnedHeightmap && this.elapsed > 25) {
        this.warnedHeightmap = true;
        this.onError("地形高度场生成超时，Web Worker 可能未能启动。");
      }
      if (this.heightData && !this.ready && !this.warnedChunks && this.elapsed > 60) {
        this.warnedChunks = true;
        this.onError("区块网格构建超时，图形驱动可能不支持所需的 WebGL 特性。");
      }

      this.updatePlayer(dt);
      if (this.heightData) this.updateChunks();
      this.updateSky(dt);
      this.updateClouds(dt);

      if (this.lastGrassPos.distanceToSquared(this.pos) > 36) this.rebuildGrass();
      this.grassMat.uniforms.uCameraPos.value.copy(this.camera.position);
      this.grassMat.uniforms.uRange.value = this.q.grassRange;

      this.sound.setWind(
        this.grassMat.uniforms.uWind.value,
        clamp((this.pos.y - 45) / 150, 0, 1),
      );

      this.water.position.x = Math.round(this.pos.x / 4) * 4;
      this.water.position.z = Math.round(this.pos.z / 4) * 4;
      this.sky.position.copy(this.camera.position);
      this.sky.scale.setScalar(1500);

      if (!this.ready && this.heightData && this.chunks.size > 40) {
        this.ready = true;
        this.onProgress(1, "准备就绪");
        this.onReady();
      } else if (!this.ready && this.heightData) {
        this.onProgress(0.5 + Math.min(0.49, this.chunks.size / 90), "构建区块网格…");
      }

      this.renderer.render(this.scene, this.camera);

      this.statTimer += dt;
      if (this.statTimer > 0.2) {
        this.statTimer = 0;
        this.emitStats();
      }
    };
    loop();
  }

  private emitStats() {
    const h = this.pos.y - this.eyeHeight;
    const t = this.typeAtWorld(this.pos.x, this.pos.z);
    let biome = "平原";
    if (h < SEA_LEVEL) biome = "水域";
    else if (t === BLOCK.SAND) biome = "海岸沙滩";
    else if (t === BLOCK.SNOW) biome = "雪峰";
    else if (t === BLOCK.STONE) biome = "裸岩山坡";
    else if (h > 95) biome = "高山草甸";
    else if (h > 60) biome = "丘陵";
    else biome = "开阔山谷";

    const mins = Math.floor(this.timeOfDay * 1440);
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");

    this.onStats({
      x: this.pos.x,
      y: h,
      z: this.pos.z,
      fps: this.fps,
      chunks: this.chunks.size,
      tris: Math.round(this.renderer.info.render.triangles / 1000),
      biome,
      timeLabel: `${hh}:${mm}`,
      submerged: this.camera.position.y < SEA_LEVEL,
      speed: Math.hypot(this.vel.x, this.vel.z),
      grounded: this.grounded,
      look: this.lookMode,
    });
  }

  setQuality(qq: Quality) {
    this.quality = qq;
    this.q = QUALITY[qq];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    this.grassMat.uniforms.uRange.value = this.q.grassRange;
    this.lastGrassPos.set(1e9, 0, 1e9);
    this.scanDirty = true;
  }

  setTimeOfDay(t: number) {
    this.timeOfDay = t;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("pointerlockchange", this.onPointerLock);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("pointerdown", this.onCanvasPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.sound.dispose();
    this.workers.forEach((w) => w.terminate());
    this.chunks.forEach((c) => c.mesh.geometry.dispose());
    this.renderer.dispose();
  }
}

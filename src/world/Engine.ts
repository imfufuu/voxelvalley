import * as THREE from "three";
import ChunkWorker from "./chunkWorker?worker&inline";
import {
  CLOUD_FRAG,
  CLOUD_VERT,
  GRASS_FRAG,
  GRASS_VERT,
  SKY_FRAG,
  SKY_VERT,
  SURF_FRAG,
  SURF_VERT,
  WATER_FRAG,
  WATER_VERT,
} from "./shaders";
import { SoundKit } from "./Audio";
import { requestSteer, type LookMode } from "./steering";
import { clamp, hash2 } from "./noise";
import { bladeDensity, emptyBlade, makeBlade } from "./grass";
import { TREE_CONIFER, foliageTint } from "./scenery";
/** scenery record strides, must match the worker's packing */
const TREE_STRIDE = 8;
const ROCK_STRIDE = 7;
import {
  BLOCK,
  CHUNK,
  FREEZE_LINE,
  HALF,
  NO_WATER,
  SEA_LEVEL,
  WORLD_SIZE,
  heightAt,
} from "./worldgen";

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
  quality: Quality;
}


interface QualityPreset {
  radius: number;
  grassRange: number;
  grassPerBlock: number;
  shadow: number;
  pixelRatio: number;
  /** scenery (trees / boulders) streaming radius in blocks */
  vegRange: number;
  /** raymarch samples through the cloud deck */
  cloudSteps: number;
  cloudOctaves: number;
}

const QUALITY: Record<Quality, QualityPreset> = {
  low: { radius: 8, grassRange: 22, grassPerBlock: 2, shadow: 1024, pixelRatio: 1, vegRange: 70, cloudSteps: 12, cloudOctaves: 3 },
  medium: { radius: 11, grassRange: 30, grassPerBlock: 3, shadow: 1536, pixelRatio: 1.25, vegRange: 90, cloudSteps: 18, cloudOctaves: 3 },
  high: { radius: 13, grassRange: 38, grassPerBlock: 4, shadow: 2048, pixelRatio: 1.5, vegRange: 110, cloudSteps: 26, cloudOctaves: 4 },
  ultra: { radius: 15, grassRange: 48, grassPerBlock: 5, shadow: 2048, pixelRatio: 2, vegRange: 130, cloudSteps: 34, cloudOctaves: 5 },
};

/** cloud deck: high enough to feel like weather, low enough for the sky-piercing ranges */
const CLOUD_BASE = 168;
const CLOUD_TOP = 236;

interface ChunkRec {
  mesh: THREE.Mesh;
  /** inland water surface (rivers / lakes) – absent for most chunks */
  water: THREE.Mesh | null;
  heights: Int16Array;
  /** per-column water surface, NO_WATER when dry */
  waterLevels: Int16Array;
  types: Uint8Array;
  /** per-tree records from the worker: x, y, species, height, trunkR, canopy, rot */
  trees: Float32Array;
  /** per-boulder records: x, y, size, rot, sink, squash */
  rocks: Float32Array;
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
  /** chat/command console */
  onQuality: (q: Quality) => void = () => {};
  onConsole: (open: boolean) => void = () => {};
  onConsoleLine: (text: string) => void = () => {};
  onMinimap: (url: string) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};

  quality: Quality = "ultra";
  private q: QualityPreset = QUALITY.ultra;

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
  private waterMapData: Uint8Array | null = null;

  // visuals
  private sky!: THREE.Mesh;
  private skyMat!: THREE.ShaderMaterial;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private water!: THREE.Mesh;
  private waterMat!: THREE.ShaderMaterial;
  /** rivers + glacial lakes, drawn per chunk */
  private surfMat!: THREE.ShaderMaterial;
  private grass!: THREE.Mesh;
  private grassMat!: THREE.ShaderMaterial;
  private grassGeo!: THREE.InstancedBufferGeometry;
  private grassCapacity = 0;
  private lastGrassPos = new THREE.Vector3(1e9, 0, 1e9);
  /** raymarched cloud deck: one big slab the camera lives inside */
  private clouds!: THREE.Mesh;
  private cloudMat!: THREE.ShaderMaterial;
  private cloudDrift = 0;

  // scenery
  private trunks!: THREE.InstancedMesh;
  private cones!: THREE.InstancedMesh;
  private blobs!: THREE.InstancedMesh;
  private boulders!: THREE.InstancedMesh;
  private vegUniforms = { uTime: { value: 0 }, uWind: { value: 0.6 } };
  private lastVegPos = new THREE.Vector3(1e9, 0, 1e9);
  private vegCap = { trunk: 7000, cone: 14000, blob: 14000, rock: 4000 };

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
  private fovBase = 74;
  private lastStepIdx = 0;
  private wasInWater = false;
  private headUnder = false;
  sound = new SoundKit();
  private curFov = 74;
  private mouseSensitivity = 0.0022;

  // time
  timeOfDay = 0.33;
  /** normal day fraction per second; /freeze and /timescale change the multiplier */
  static readonly NORMAL_TIME_SPEED = 0.004;
  timeSpeed = 0.004;
  /** multiplier applied to timeSpeed (0 = frozen, 1 = normal) */
  timeScale = 1;
  private elapsed = 0;

  // input
  consoleOpen = false;
  /** multiplier for walking / sprinting speed, settable via /speed */
  walkScale = 1;

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

    this.camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, 2600);

    this.scene.fog = new THREE.FogExp2(0x9fc0e0, 0.0022);

    this.buildLights();
    this.buildSky();
    this.buildTerrainMaterial();
    this.buildWater();
    this.buildSurfaceWater();
    this.buildGrass();
    this.buildVegetation();
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

  /** rivers, glacial lakes, tarns */
  private buildSurfaceWater() {
    this.surfMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uZenith: { value: new THREE.Color(0x2f6ed0) },
        uHorizon: { value: new THREE.Color(0xcfe2f5) },
        uFogColor: { value: new THREE.Color(0x9fc0e0) },
        uFogDensity: { value: 0.0027 },
        uFreezeLine: { value: FREEZE_LINE },
        uShallow: { value: new THREE.Color(0x3e9aa4) },
        uDeep: { value: new THREE.Color(0x0a2740) },
      },
      vertexShader: SURF_VERT,
      fragmentShader: SURF_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Cloud deck: not boxes any more. A single huge slab the camera lives inside;
   * the fragment shader raymarches 3D noise through it, so the clouds behave
   * like lit fog and mountains can poke straight through.
   */
  private buildClouds() {
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uAmbient: { value: new THREE.Color(0x8fa6c4) },
        uFogColor: { value: new THREE.Color(0x9fc0e0) },
        uFogDensity: { value: 0.0027 },
        uTime: { value: 0 },
        uBase: { value: CLOUD_BASE },
        uTop: { value: CLOUD_TOP },
        uCoverage: { value: 0.46 },
        uDensity: { value: 0.16 },
        uSteps: { value: this.q.cloudSteps },
        uOctaves: { value: this.q.cloudOctaves },
        uWind: { value: new THREE.Vector2(1.6, 0.9) },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
    });
    // trigger volume: big enough to cover the view, small enough to stay
    // inside the far plane
    const span = 2600;
    const geo = new THREE.BoxGeometry(span, CLOUD_TOP - CLOUD_BASE, span);
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 6;
    this.scene.add(this.clouds);
  }

  /** vegetation material: lambert + a wind sway injected into the vertex stage */
  private vegMaterial(sway: number) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    const u = this.vegUniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWind = u.uWind;
      shader.uniforms.uSway = { value: sway };
      shader.vertexShader =
        "uniform float uTime;\nuniform float uWind;\nuniform float uSway;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             vec3 iOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           #else
             vec3 iOrigin = vec3(0.0);
           #endif
           float phase = iOrigin.x * 0.13 + iOrigin.z * 0.17;
           float gust = 0.55 + 0.45 * sin(uTime * 0.6 + iOrigin.x * 0.01 + iOrigin.z * 0.013);
           float amp = uSway * uWind * gust * max(transformed.y, 0.0);
           transformed.x += sin(uTime * 1.15 + phase) * amp;
           transformed.z += cos(uTime * 0.93 + phase * 1.3) * amp * 0.7;`,
        );
    };
    mat.customProgramCacheKey = () => `veg-${sway}`;
    return mat;
  }

  private buildVegetation() {
    const trunkGeo = new THREE.CylinderGeometry(0.72, 1, 1, 6, 1, false);
    trunkGeo.translate(0, 0.5, 0);
    const coneGeo = new THREE.ConeGeometry(1, 1, 7);
    coneGeo.translate(0, 0.5, 0);
    const blobGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);

    this.trunks = new THREE.InstancedMesh(trunkGeo, this.vegMaterial(0.05), this.vegCap.trunk);
    this.cones = new THREE.InstancedMesh(coneGeo, this.vegMaterial(0.14), this.vegCap.cone);
    this.blobs = new THREE.InstancedMesh(blobGeo, this.vegMaterial(0.1), this.vegCap.blob);
    this.boulders = new THREE.InstancedMesh(rockGeo, this.vegMaterial(0.0), this.vegCap.rock);

    for (const m of [this.trunks, this.cones, this.blobs, this.boulders]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(m.instanceMatrix.count * 3).fill(1),
        3,
      );
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      this.scene.add(m);
    }
    this.cones.castShadow = true;
    this.blobs.castShadow = true;
    this.trunks.castShadow = true;
    this.boulders.castShadow = true;
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
      this.onProgress(m.value * 0.45, `生成 ${WORLD_SIZE} × ${WORLD_SIZE} 地形高度场…`);
      return;
    }
    if (m.type === "heightmap") {
      this.heightData = m.data as Uint8Array;
      this.waterMapData = m.water as Uint8Array;
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

    let waterMesh: THREE.Mesh | null = null;
    if (m.wIndices && m.wIndices.length) {
      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute("position", new THREE.BufferAttribute(m.wPositions, 3));
      wgeo.setAttribute("normal", new THREE.BufferAttribute(m.wNormals, 3));
      wgeo.setAttribute("aDepth", new THREE.BufferAttribute(m.wDepths, 1));
      wgeo.setIndex(new THREE.BufferAttribute(m.wIndices, 1));
      wgeo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(ox + CHUNK / 2, (minH + maxH) * 0.5, oz + CHUNK / 2),
        Math.sqrt(CHUNK * CHUNK * 0.5 + half * half) + 2,
      );
      waterMesh = new THREE.Mesh(wgeo, this.surfMat);
      waterMesh.matrixAutoUpdate = false;
      waterMesh.renderOrder = 9;
      this.scene.add(waterMesh);
    }

    this.chunks.set(m.key, {
      mesh,
      water: waterMesh,
      heights: m.heights,
      waterLevels: m.water,
      types: m.types,
      trees: m.trees,
      rocks: m.rocks,
      cx: m.cx,
      cz: m.cz,
    });

    // newly streamed ground near the player needs its grass scattered
    const dx = ox + CHUNK / 2 - this.pos.x;
    const dz = oz + CHUNK / 2 - this.pos.z;
    if (dx * dx + dz * dz < (this.q.grassRange + CHUNK) ** 2) {
      this.lastGrassPos.set(1e9, 0, 1e9);
    }
    if (dx * dx + dz * dz < (this.q.vegRange + CHUNK) ** 2) {
      this.lastVegPos.set(1e9, 0, 1e9);
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
        if (rec.water) {
          this.scene.remove(rec.water);
          rec.water.geometry.dispose();
        }
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

  /** the 3x3 chunks around the player exist, so there is ground underfoot */
  private localChunksReady(): boolean {
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.chunks.has(`${pcx + dx},${pcz + dz}`)) return false;
      }
    }
    return true;
  }

  /** water surface at a column (ocean, river, lake) or NO_WATER */
  waterAt(x: number, z: number): number {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const cx = Math.floor(fx / CHUNK);
    const cz = Math.floor(fz / CHUNK);
    const rec = this.chunks.get(`${cx},${cz}`);
    if (!rec) return NO_WATER;
    const lx = fx - cx * CHUNK;
    const lz = fz - cz * CHUNK;
    return rec.waterLevels[lz * CHUNK + lx];
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

        // rivers and lakes on top of the terrain shading
        if (this.waterMapData) {
          const w = this.waterMapData[sy * HM_RES + sx];
          if (w > 0 && w > h && h > SEA_LEVEL - 1) {
            const deep = clamp((w - h) / 26, 0, 1);
            img.data[o] = clamp(30 + (1 - deep) * 70, 0, 255);
            img.data[o + 1] = clamp(96 + (1 - deep) * 74, 0, 255);
            img.data[o + 2] = clamp(150 + (1 - deep) * 46, 0, 255);
          }
        }
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
      // never spawn in a river / lake
      if (this.waterMapData && this.waterMapData[gz * HM_RES + gx] > h) continue;
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
    const blade = emptyBlade();

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
        const density = bladeDensity(x, z, per);
        for (let k = 0; k < density; k++) {
          if (n >= this.grassCapacity) break;
          makeBlade(x, z, k, blade);
          pa[n * 3] = x + blade.ox;
          pa[n * 3 + 1] = h;
          pa[n * 3 + 2] = z + blade.oz;
          ba[n * 4] = blade.height;
          ba[n * 4 + 1] = blade.width;
          ba[n * 4 + 2] = blade.rotation;
          ba[n * 4 + 3] = blade.phase;
          ca[n * 3] = blade.r;
          ca[n * 3 + 1] = blade.g;
          ca[n * 3 + 2] = blade.b;
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
    // wind moves the noise field; the slab itself just follows the camera
    this.cloudDrift += dt * 1.35;
    this.clouds.position.set(this.pos.x, (CLOUD_BASE + CLOUD_TOP) * 0.5, this.pos.z);
    const cu = this.cloudMat.uniforms;
    cu.uCameraPos.value.copy(this.camera.position);
    cu.uTime.value = this.elapsed + this.cloudDrift;
    cu.uWind.value.set(1.6 + Math.sin(this.elapsed * 0.05) * 0.6, 0.9);
  }

  /**
   * Scenery instances are resolved once per chunk inside the worker; here we
   * only compose matrices for the chunks around the player, so re-scattering
   * costs a few milliseconds instead of a full noise pass over the area.
   */
  private rebuildVegetation() {
    const range = this.q.vegRange;
    const r2 = range * range;
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    const span = Math.ceil(range / CHUNK);

    const mat = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const vpos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const cap = this.vegCap;
    let nTrunk = 0, nCone = 0, nBlob = 0, nRock = 0;

    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const rec = this.chunks.get(`${pcx + dx},${pcz + dz}`);
        if (!rec) continue;

        const trees = rec.trees;
        for (let i = 0; i < trees.length; i += TREE_STRIDE) {
          const x = trees[i];
          const z = trees[i + 1];
          const ddx = x - this.pos.x;
          const ddz = z - this.pos.z;
          if (ddx * ddx + ddz * ddz > r2) continue;
          const ground = trees[i + 2];
          const species = trees[i + 3];
          const height = trees[i + 4];
          const trunkR = trees[i + 5];
          const canopy = trees[i + 6];
          const rot = trees[i + 7];
          const base = ground - 0.2;
          const tint = foliageTint(x, z);

          if (nTrunk < cap.trunk) {
            euler.set(0, rot, 0);
            quat.setFromEuler(euler);
            vpos.set(x, base, z);
            scl.set(trunkR, height * 0.62, trunkR);
            mat.compose(vpos, quat, scl);
            this.trunks.setMatrixAt(nTrunk, mat);
            const bark = 0.15 + tint * 0.1;
            color.setRGB(bark, bark * 0.76, bark * 0.52);
            this.trunks.setColorAt(nTrunk, color);
            nTrunk++;
          }

          if (species === TREE_CONIFER) {
            for (let k = 0; k < 3 && nCone < cap.cone; k++) {
              const f = k / 3;
              const w = canopy * (1.55 - f * 0.6);
              const hh = height * (0.54 - f * 0.1);
              euler.set(0, rot + k * 0.7, 0);
              quat.setFromEuler(euler);
              vpos.set(x, base + height * (0.22 + f * 0.27), z);
              scl.set(w, hh, w);
              mat.compose(vpos, quat, scl);
              this.cones.setMatrixAt(nCone, mat);
              const g = 0.15 + tint * 0.12 + f * 0.03;
              color.setRGB(g * 0.6, g, g * 0.55);
              this.cones.setColorAt(nCone, color);
              nCone++;
            }
          } else {
            for (let k = 0; k < 3 && nBlob < cap.blob; k++) {
              const a = hash2(x * 3 + k, z * 7 - k) * Math.PI * 2;
              const rad = k === 0 ? 0 : canopy * 0.5;
              const w = canopy * (k === 0 ? 1 : 0.7);
              euler.set(hash2(x + k, z) * 0.5, a, hash2(x, z + k) * 0.5);
              quat.setFromEuler(euler);
              vpos.set(
                x + Math.cos(a) * rad,
                base + height * (k === 0 ? 0.78 : 0.66),
                z + Math.sin(a) * rad,
              );
              scl.set(w, w * 0.84, w);
              mat.compose(vpos, quat, scl);
              this.blobs.setMatrixAt(nBlob, mat);
              const g = 0.19 + tint * 0.15;
              color.setRGB(g * 0.7, g, g * 0.44);
              this.blobs.setColorAt(nBlob, color);
              nBlob++;
            }
          }
        }

        const rocks = rec.rocks;
        for (let i = 0; i < rocks.length; i += ROCK_STRIDE) {
          const x = rocks[i];
          const z = rocks[i + 1];
          const ddx = x - this.pos.x;
          const ddz = z - this.pos.z;
          if (ddx * ddx + ddz * ddz > r2) continue;
          if (nRock >= cap.rock) break;
          const ground = rocks[i + 2];
          const size = rocks[i + 3];
          const rot = rocks[i + 4];
          const sink = rocks[i + 5];
          const squash = rocks[i + 6];
          euler.set(hash2(x * 5, z) * 0.5, rot, hash2(x, z * 3) * 0.5);
          quat.setFromEuler(euler);
          vpos.set(x, ground - size * sink, z);
          scl.set(size, size * squash, size * 0.9);
          mat.compose(vpos, quat, scl);
          this.boulders.setMatrixAt(nRock, mat);
          const g = 0.27 + hash2(x * 7, z * 11) * 0.12;
          color.setRGB(g, g * 0.98, g * 0.94);
          this.boulders.setColorAt(nRock, color);
          nRock++;
        }
      }
    }

    for (const [mesh, n] of [
      [this.trunks, nTrunk],
      [this.cones, nCone],
      [this.blobs, nBlob],
      [this.boulders, nRock],
    ] as Array<[THREE.InstancedMesh, number]>) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.vegUniforms.uTime.value = this.elapsed;
    this.lastVegPos.copy(this.pos);
  }

  /* ------------------------------------------------------------ atmosphere */

  private updateSky(dt: number) {
    this.timeOfDay = (this.timeOfDay + this.timeSpeed * this.timeScale * dt) % 1;
    if (this.timeOfDay < 0) this.timeOfDay += 1;
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

    const submerged = this.headUnder || this.pos.y < SEA_LEVEL;
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
    cu.uFogColor.value.copy(fogCol);
    cu.uFogDensity.value = fog.density;
    cu.uCameraPos.value.copy(this.camera.position);
    cu.uTime.value = this.elapsed;
    // clouds are lit by the sky above and bounced light below; at night they go cold
    cu.uAmbient.value
      .copy(horizon)
      .multiplyScalar(0.34 + dayT * 0.42)
      .add(new THREE.Color(0x0a1020).multiplyScalar(nightF * 0.5));

    const su = this.surfMat.uniforms;
    su.uSunDir.value.copy(sunDir);
    su.uSunColor.value.copy(sunCol);
    su.uZenith.value.copy(zenith);
    su.uHorizon.value.copy(horizon);
    su.uFogColor.value.copy(fogCol);
    su.uFogDensity.value = fog.density;
    su.uTime.value = this.elapsed;
    su.uCameraPos.value.copy(this.camera.position);
    su.uShallow.value.set(0x3e9aa4).lerp(new THREE.Color(0x0d2b3a), nightF * 0.8);
    su.uDeep.value.set(0x07243d).lerp(new THREE.Color(0x02101c), nightF);

    this.vegUniforms.uWind.value = 0.45 + Math.sin(this.elapsed * 0.11) * 0.25 + Math.sin(this.elapsed * 0.037) * 0.14;
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
    // command console: slash or enter opens it, escape closes it again
    const opensConsole =
      e.code === "Slash" ||
      e.code === "NumpadDivide" ||
      e.code === "Enter" ||
      e.code === "NumpadEnter" ||
      e.code === "KeyT";
    if (opensConsole && !this.consoleOpen) {
      e.preventDefault();
      this.openConsole();
      return;
    }
    if (e.code === "Escape" && this.consoleOpen) {
      e.preventDefault();
      this.closeConsole();
      return;
    }
    if (this.consoleOpen) return; // typing, not playing

    this.keys.add(e.code);
    if (e.code === "Escape" && this.lookMode === "drag") {
      this.exitLook();
      return;
    }
    if (e.code === "KeyF") this.fly = !this.fly;
    if (e.code === "KeyM") this.sound.enabled = !this.sound.enabled;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onPointerLock = () => {
    if (this.consoleOpen) return; // we released the lock to let the player type
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
    if (this.lookMode !== "drag" || !this.entered || this.consoleOpen) return;
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

  /** open the command console (releases pointer lock so the player can type) */
  openConsole() {
    if (this.consoleOpen || !this.entered) return;
    this.consoleOpen = true;
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.onConsole(true);
  }

  closeConsole() {
    if (!this.consoleOpen) return;
    this.consoleOpen = false;
    this.onConsole(false);
    if (this.lookMode === "pointer") this.requestLock();
  }

  /** run a `/command`; results are reported through onConsoleLine */
  runCommand(raw: string): void {
    const line = raw.trim().replace(/^\/+/, "");
    if (!line) return;
    const say = (t: string) => this.onConsoleLine(t);
    const parts = line.split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const num = (i: number) => Number(parts[i]);
    const bad = (why: string) => say(`× ${why}`);
    const clock = () => {
      const mins = Math.floor(this.timeOfDay * 1440);
      return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    };

    switch (cmd) {
      case "help":
      case "?":
        say("指令：");
        say("  /time <0-24>        设置时刻（小时，如 /time 8.5）");
        say("  /tick <0-24000>     按 tick 设置时刻（一天 24000 tick）");
        say("  /freeze             暂停时间流动");
        say("  /resume             恢复正常时间流速");
        say("  /timescale <倍率>   时间流速倍率（0 = 静止，1 = 正常）");
        say("  /tp <x> <z> [y]     传送到坐标（y 省略则落到地表）");
        say("  /surface            回到当前位置的地表");
        say("  /fly                切换飞行观景");
        say("  /speed <倍率>       行走速度倍率");
        say("  /quality <档位>     low / medium / high / ultra");
        say("  /clouds <0-1>       云量");
        say("  /fov <度数>         视野角");
        say("  /where              显示坐标、地貌与时间");
        say("  /world              世界信息");
        say("  /menu               退出到开始界面");
        break;

      case "time": {
        const v = num(1);
        if (!Number.isFinite(v)) return bad("用法：/time <0-24>");
        this.timeOfDay = ((v / 24) % 1 + 1) % 1;
        say(`时间 → ${clock()}（tick ${Math.round(this.timeOfDay * 24000)}）`);
        break;
      }
      case "tick": {
        const v = Math.round(num(1));
        if (!Number.isFinite(v)) return bad("用法：/tick <0-24000>");
        this.timeOfDay = (((v % 24000) + 24000) % 24000) / 24000;
        say(`tick → ${v}（${clock()}）`);
        break;
      }
      case "freeze":
        this.timeScale = 0;
        say(`时间已冻结在 ${clock()}（/resume 恢复）`);
        break;
      case "resume":
      case "unfreeze":
      case "thaw":
        this.timeScale = 1;
        say("时间恢复正常流速");
        break;
      case "timescale":
      case "tickspeed": {
        const v = num(1);
        if (!Number.isFinite(v) || v < 0) return bad("用法：/timescale <倍率，0-60>");
        this.timeScale = Math.min(60, v);
        say(`时间流速 ×${this.timeScale}${this.timeScale === 0 ? "（已冻结）" : ""}`);
        break;
      }
      case "tp": {
        const x = num(1);
        const z = parts.length >= 4 ? num(3) : num(2);
        const y = parts.length >= 4 ? num(2) : undefined;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return bad("用法：/tp <x> <z> [y]");
        const lim = HALF - 4;
        this.pos.x = clamp(x, -lim, lim);
        this.pos.z = clamp(z, -lim, lim);
        this.pos.y =
          y !== undefined && Number.isFinite(y)
            ? y + this.eyeHeight
            : Math.max(heightAt(this.pos.x, this.pos.z), this.waterAt(this.pos.x, this.pos.z)) +
              this.eyeHeight +
              1;
        this.vel.set(0, 0, 0);
        this.scanDirty = true;
        this.lastGrassPos.set(1e9, 0, 1e9);
        this.lastVegPos.set(1e9, 0, 1e9);
        say(`传送 → ${this.pos.x.toFixed(0)}, ${(this.pos.y - this.eyeHeight).toFixed(0)}, ${this.pos.z.toFixed(0)}`);
        break;
      }
      case "surface": {
        const ground = Math.max(
          heightAt(this.pos.x, this.pos.z),
          this.waterAt(this.pos.x, this.pos.z),
        );
        this.pos.y = ground + this.eyeHeight + 0.5;
        this.vel.set(0, 0, 0);
        say(`回到地表 y=${ground.toFixed(0)}`);
        break;
      }
      case "fly":
        this.fly = !this.fly;
        say(this.fly ? "飞行：开" : "飞行：关");
        break;
      case "speed":
      case "walk": {
        const v = num(1);
        if (!Number.isFinite(v) || v <= 0) return bad("用法：/speed <倍率，0.1-10>");
        this.walkScale = Math.min(10, Math.max(0.1, v));
        say(`行走速度 ×${this.walkScale}`);
        break;
      }
      case "quality": {
        const q = (parts[1] || "").toLowerCase() as Quality;
        if (!["low", "medium", "high", "ultra"].includes(q)) return bad("用法：/quality low|medium|high|ultra");
        this.setQuality(q);
        say(`画质 → ${q}（视距 ${this.q.radius * CHUNK}m，云层采样 ${this.q.cloudSteps}）`);
        break;
      }
      case "clouds": {
        const v = num(1);
        if (!Number.isFinite(v) || v < 0 || v > 1) return bad("用法：/clouds <0-1>");
        this.cloudMat.uniforms.uCoverage.value = 0.62 - v * 0.42;
        say(`云量 → ${(v * 100).toFixed(0)}%`);
        break;
      }
      case "fov": {
        const v = num(1);
        if (!Number.isFinite(v) || v < 40 || v > 120) return bad("用法：/fov <40-120>");
        this.fovBase = v;
        say(`视野 → ${v}°`);
        break;
      }
      case "where": {
        const wl = this.waterAt(this.pos.x, this.pos.z);
        say(
          `坐标 ${this.pos.x.toFixed(1)}, ${(this.pos.y - this.eyeHeight).toFixed(1)}, ${this.pos.z.toFixed(1)}` +
            ` · 高度 ${(this.pos.y - this.eyeHeight).toFixed(0)}m` +
            (wl === NO_WATER ? "" : ` · 水深 ${(wl - (this.pos.y - this.eyeHeight)).toFixed(1)}m`) +
            ` · ${clock()} · ${this.fps.toFixed(0)} FPS`,
        );
        break;
      }
      case "world":
      case "seed":
        say(`世界 ${WORLD_SIZE} × ${WORLD_SIZE} 方块 · 海平面 ${SEA_LEVEL}m · 区块 ${CHUNK}`);
        say(`云层 ${CLOUD_BASE}-${CLOUD_TOP}m · 已加载 ${this.chunks.size} 区块 · 画质 ${this.quality}`);
        break;
      case "menu":
      case "pause":
        this.exitLook();
        say("已退出到开始界面");
        break;
      default:
        bad(`未知指令 /${cmd}，输入 /help 查看可用指令`);
    }
  }

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
    const surface = this.waterAt(this.pos.x, this.pos.z);
    const feetY0 = this.pos.y - this.eyeHeight;
    const wadeDepth = surface === NO_WATER ? 0 : Math.max(0, surface - feetY0);
    const inWater = wadeDepth > 0.15;
    // wading is still walking; only proper deep water swims
    const swimming = wadeDepth > 1.5;
    // fully under: camera below the surface
    this.headUnder = surface !== NO_WATER && this.pos.y < surface - 0.25;

    let speed = (crouch ? 2.0 : sprint ? 8.6 : 4.7) * this.walkScale;
    if (swimming) speed *= 0.55;
    else if (inWater) speed *= 0.78;
    if (this.fly) speed = (sprint ? 42 : 16) * this.walkScale;

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

      if (swimming) {
        // buoyancy: hold just under the surface, dive while crouching
        const target = surface - this.eyeHeight + (crouch ? -1.6 : 0.35);
        const diff = target - feetY0;
        this.vel.y += (diff * 9 - this.vel.y * 2.2) * dt;
        this.vel.y *= 0.965;
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

    // keep the player inside the world
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

    // Footsteps driven by the bob cycle. This used to fire twice per cycle
    // (~8/s at a sprint); one step per 1.5 cycles reads far better.
    const stepIdx = Math.floor(this.bobPhase / (Math.PI * 1.5));
    if (stepIdx !== this.lastStepIdx) {
      this.lastStepIdx = stepIdx;
      if (this.bobAmount > 0.22 && hSpeed > 1.2 && (this.grounded || inWater)) {
        if (inWater) {
          this.sound.wade(Math.min(1, 0.4 + this.bobAmount), wadeDepth);
        } else {
          const bt = this.typeAtWorld(this.pos.x, this.pos.z);
          const surf =
            bt === BLOCK.SAND
              ? "sand"
              : bt === BLOCK.SNOW
                ? "snow"
                : bt === BLOCK.STONE
                  ? "stone"
                  : bt === BLOCK.ICE
                    ? "stone"
                    : "grass";
          this.sound.step(surf as "grass", Math.min(1, 0.4 + this.bobAmount));
        }
      }
    }
    const deepEnough = swimming;
    if (deepEnough !== this.wasInWater) {
      this.wasInWater = deepEnough;
      if (deepEnough) this.sound.splash();
    }

    const eye = this.pos.y - this.stepOffset - this.landDip + bobY + breathe - (crouch ? 0.5 : 0);
    const rightV = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.set(this.pos.x + rightV.x * bobX, eye, this.pos.z + rightV.z * bobX);

    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.pitch - this.bobAmount * 0.012, this.yaw, roll, "YXZ"),
    );
    this.camera.quaternion.copy(q);

    this.fovTarget = this.fovBase + (sprint && hSpeed > 6 ? 7 : 0) + (inWater ? -4 : 0);
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

      // scenery is expensive to gather, so only re-scatter every few blocks
      if (this.lastVegPos.distanceToSquared(this.pos) > 100) this.rebuildVegetation();
      this.vegUniforms.uTime.value = this.elapsed;

      this.sound.setWind(
        this.grassMat.uniforms.uWind.value,
        clamp((this.pos.y - 45) / 150, 0, 1),
      );

      this.water.position.x = Math.round(this.pos.x / 4) * 4;
      this.water.position.z = Math.round(this.pos.z / 4) * 4;
      this.sky.position.copy(this.camera.position);
      this.sky.scale.setScalar(1500);

      if (!this.ready && this.heightData && this.chunks.size > 40 && this.localChunksReady()) {
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
      submerged:
        this.camera.position.y <
        Math.max(SEA_LEVEL, this.waterAt(this.camera.position.x, this.camera.position.z)),
      speed: Math.hypot(this.vel.x, this.vel.z),
      grounded: this.grounded,
      look: this.lookMode,
      quality: this.quality,
    });
  }

  setQuality(qq: Quality) {
    this.quality = qq;
    this.q = QUALITY[qq];
    this.onQuality(qq);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    this.grassMat.uniforms.uRange.value = this.q.grassRange;
    this.cloudMat.uniforms.uSteps.value = this.q.cloudSteps;
    this.cloudMat.uniforms.uOctaves.value = this.q.cloudOctaves;
    this.lastGrassPos.set(1e9, 0, 1e9);
    this.lastVegPos.set(1e9, 0, 1e9);
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
    this.chunks.forEach((c) => {
      c.mesh.geometry.dispose();
      if (c.water) c.water.geometry.dispose();
    });
    for (const m of [this.trunks, this.cones, this.blobs, this.boulders]) m.dispose();
    this.renderer.dispose();
  }
}

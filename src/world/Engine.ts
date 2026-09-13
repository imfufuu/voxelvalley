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
import {
  TREE_CONIFER,
  foliageTint,
  rockBlocks,
  setTreeDensity,
  treeBlocks,
  treeShape,
  type TreeShape,
} from "./scenery";
/** scenery record strides, must match the worker's packing */
const TREE_STRIDE = 4;
const ROCK_STRIDE = 4;
/** lazily expanded leaf cubes: x, y, z, r, g, b */
const LEAF_STRIDE = 6;
/** lazily expanded boulder cubes: x, y, z, grey */
const STONE_STRIDE = 4;
/** resolution of the expanded map view, in pixels */
const MAP_SIZE = 448;
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
  /** compass heading in radians, 0 = north (-Z), growing clockwise */
  heading: number;
  /** how the camera is being steered right now */
  look: LookMode;
  quality: Quality;
}

/** radius of the circular local minimap, in blocks */
export const MINIMAP_SPAN = 192;


interface QualityPreset {
  radius: number;
  grassRange: number;
  grassPerBlock: number;
  shadow: number;
  pixelRatio: number;
  /** scenery (trees / boulders) streaming radius in blocks */
  vegRange: number;
  /** instance budgets for the block scenery */
  leafCap: number;
  trunkCap: number;
  rockCap: number;
  /** raymarch samples through the cloud deck */
  cloudSteps: number;
  cloudOctaves: number;
}

const QUALITY: Record<Quality, QualityPreset> = {
  low: { radius: 8, grassRange: 22, grassPerBlock: 2, shadow: 1024, pixelRatio: 1, vegRange: 70, cloudSteps: 12, cloudOctaves: 3, leafCap: 7000, trunkCap: 700, rockCap: 2500 },
  medium: { radius: 11, grassRange: 30, grassPerBlock: 3, shadow: 1536, pixelRatio: 1.25, vegRange: 90, cloudSteps: 18, cloudOctaves: 3, leafCap: 12000, trunkCap: 1100, rockCap: 3500 },
  high: { radius: 13, grassRange: 38, grassPerBlock: 4, shadow: 2048, pixelRatio: 1.5, vegRange: 110, cloudSteps: 26, cloudOctaves: 4, leafCap: 18000, trunkCap: 1500, rockCap: 5000 },
  ultra: { radius: 15, grassRange: 48, grassPerBlock: 5, shadow: 2048, pixelRatio: 2, vegRange: 130, cloudSteps: 34, cloudOctaves: 5, leafCap: 26000, trunkCap: 2000, rockCap: 7000 },
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
  /** per-tree records from the worker: x, z, groundY, species */
  trees: Float32Array;
  /** per-boulder records: x, z, groundY, radius */
  rocks: Float32Array;
  /** leaf cubes of every tree in this chunk, expanded on first use */
  leaves: Float32Array | null;
  /** leaf range of tree `i` = [leafStart[i], leafStart[i + 1]) */
  leafStart: Uint32Array | null;
  /** boulder cubes, expanded on first use */
  stones: Float32Array | null;
  cx: number;
  cz: number;
}

const HM_RES = 1024;

/** sRGB colours for the top-down maps, mirroring the terrain palette */
const MAP_RGB: Record<number, [number, number, number]> = {
  [BLOCK.WATERBED]: [64, 68, 54],
  [BLOCK.SAND]: [214, 198, 152],
  [BLOCK.GRASS]: [92, 142, 60],
  [BLOCK.DIRT]: [112, 84, 56],
  [BLOCK.STONE]: [124, 124, 130],
  [BLOCK.SNOW]: [240, 244, 250],
  [BLOCK.ROCK_DARK]: [80, 78, 84],
  [BLOCK.ICE]: [186, 214, 230],
  [BLOCK.ROCK_LIGHT]: [150, 148, 144],
};

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
  /** full-screen map overlay was opened / closed */
  onMapOpen: (open: boolean) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  /** the player is inside the world (HUD on screen), console and map included */
  onEnter: (inWorld: boolean) => void = () => {};

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

  // scenery: everything is built from whole grid-aligned cubes
  private trunks!: THREE.InstancedMesh;
  private leaves!: THREE.InstancedMesh;
  private boulders!: THREE.InstancedMesh;
  private vegUniforms = { uTime: { value: 0 }, uWind: { value: 0.6 } };
  /** the one unit cube every tree / boulder block is instanced from */
  private vegCube!: THREE.BoxGeometry;
  private lastVegPos = new THREE.Vector3(1e9, 0, 1e9);
  private vegScratch = {
    mat: new THREE.Matrix4(),
    quat: new THREE.Quaternion(),
    pos: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    color: new THREE.Color(),
    shape: { trunk: 0, layers: [] as number[], seed: 0 } as TreeShape,
  };

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

  // maps
  /** full-screen map overlay (the minimap expands into it) */
  mapOpen = false;
  private wasEntered = false;
  private mapCanvas: HTMLCanvasElement | null = null;
  private lastMapPos = new THREE.Vector3(1e9, 0, 1e9);
  private mapTimer = 1;

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

  /** vegetation material: lambert, with an optional wind sway for the grass */
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
    // Minecraft-style scenery: one unit cube per block, origin at the block's
    // minimum corner so every instance snaps to the voxel grid.
    const cube = new THREE.BoxGeometry(1, 1, 1);
    cube.translate(0.5, 0.5, 0.5);
    this.vegCube = cube;
    const top = QUALITY.ultra;

    this.trunks = new THREE.InstancedMesh(cube, this.vegMaterial(0), top.trunkCap);
    this.leaves = new THREE.InstancedMesh(cube, this.vegMaterial(0), top.leafCap);
    this.boulders = new THREE.InstancedMesh(cube, this.vegMaterial(0), top.rockCap);

    for (const m of [this.trunks, this.leaves, this.boulders]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(m.instanceMatrix.count * 3).fill(1),
        3,
      );
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
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
      this.lastMapPos.set(1e9, 0, 1e9);
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
      leaves: null,
      leafStart: null,
      stones: null,
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

  /* ------------------------------------------------------------------ maps */

  /**
   * Top-down map of the terrain around (cx, cz), `span` blocks wide.
   * Loaded chunks are read block by block (real block colours, trees and all);
   * everything else falls back to the coarse world heightmap so the whole
   * 9048² world can be browsed without streaming it first.
   */
  renderMap(centerX: number, centerZ: number, span: number, size = MAP_SIZE): string | null {
    const hd = this.heightData;
    if (!hd || size <= 0) return null;
    const wd = this.waterMapData;
    const cv = (this.mapCanvas ??= document.createElement("canvas"));
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    const d = img.data;

    const bpp = span / size; // blocks per pixel
    const half = span / 2;
    const x0 = centerX - half;
    const z0 = centerZ - half;

    let chunk: ChunkRec | null = null;
    let ccx = 1e9;
    let ccz = 1e9;
    let sH = 0;
    let sW = NO_WATER;
    let sT: number = BLOCK.GRASS;
    const sample = (bx: number, bz: number) => {
      const cx = Math.floor(bx / CHUNK);
      const cz = Math.floor(bz / CHUNK);
      if (cx !== ccx || cz !== ccz) {
        ccx = cx;
        ccz = cz;
        chunk = this.chunks.get(`${cx},${cz}`) ?? null;
      }
      if (chunk) {
        const lx = bx - cx * CHUNK;
        const lz = bz - cz * CHUNK;
        sH = chunk.heights[lz * CHUNK + lx];
        sW = chunk.waterLevels[lz * CHUNK + lx];
        sT = chunk.types[lz * CHUNK + lx];
        return;
      }
      const gx = clamp(Math.floor(((bx + HALF) / WORLD_SIZE) * HM_RES), 0, HM_RES - 1);
      const gz = clamp(Math.floor(((bz + HALF) / WORLD_SIZE) * HM_RES), 0, HM_RES - 1);
      sH = hd[gz * HM_RES + gx];
      const w = wd ? wd[gz * HM_RES + gx] : 0;
      sW = w > 0 ? w : NO_WATER;
      sT =
        sH < SEA_LEVEL - 1
          ? BLOCK.WATERBED
          : sH <= SEA_LEVEL + 2
            ? BLOCK.SAND
            : sH > 205
              ? BLOCK.SNOW
              : sH > 150
                ? BLOCK.STONE
                : BLOCK.GRASS;
    };

    for (let py = 0; py < size; py++) {
      const bz = Math.floor(z0 + py * bpp);
      for (let px = 0; px < size; px++) {
        const bx = Math.floor(x0 + px * bpp);
        sample(bx, bz);
        const h = sH;
        const w = sW;
        const t = sT;
        sample(bx + 1, bz);
        const hx = sH;
        sample(bx, bz + 1);
        const hz = sH;

        const shade = clamp(1 + (h - hx) * 0.09 + (h - hz) * 0.05, 0.6, 1.5);
        let r: number;
        let g: number;
        let b: number;
        if (w !== NO_WATER && w > h) {
          const k = clamp((w - h) / 22, 0, 1); // 0 = shallows, 1 = deep
          if (h < SEA_LEVEL) {
            r = 96 - k * 72;
            g = 156 - k * 100;
            b = 188 - k * 88; // ocean
          } else {
            r = 74 - k * 46;
            g = 158 - k * 66;
            b = 180 - k * 44; // river / lake
          }
          if (h > FREEZE_LINE) {
            r = 196;
            g = 220;
            b = 236; // frozen glacial lake
          }
        } else {
          const c = MAP_RGB[t] ?? MAP_RGB[BLOCK.STONE];
          r = c[0];
          g = c[1];
          b = c[2];
        }
        const o = (py * size + px) * 4;
        d[o] = clamp(r * shade, 0, 255);
        d[o + 1] = clamp(g * shade, 0, 255);
        d[o + 2] = clamp(b * shade, 0, 255);
        d[o + 3] = 255;
      }
    }

    // stamp the trees of the streamed chunks, so forests read as forests
    const rad = bpp <= 1 ? 2 : bpp <= 2 ? 1 : 0;
    for (const rec of this.chunks.values()) {
      const trees = rec.trees;
      for (let i = 0; i < trees.length; i += TREE_STRIDE) {
        const px = Math.round((trees[i] + 0.5 - x0) / bpp);
        const py = Math.round((trees[i + 1] + 0.5 - z0) / bpp);
        if (px < rad || py < rad || px >= size - rad || py >= size - rad) continue;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const o = ((py + dy) * size + px + dx) * 4;
            if (d[o + 2] > d[o] + 12 && d[o + 2] > d[o + 1] + 12) continue; // water / ice
            d[o] = d[o] * 0.6;
            d[o + 1] = Math.min(255, d[o + 1] * 0.92 + 10);
            d[o + 2] = d[o + 2] * 0.6;
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    return cv.toDataURL("image/png");
  }

  /** drop every chunk so the world is rebuilt (used by /trees) */
  private rebuildChunks() {
    for (const rec of this.chunks.values()) {
      this.scene.remove(rec.mesh);
      rec.mesh.geometry.dispose();
      if (rec.water) {
        this.scene.remove(rec.water);
        rec.water.geometry.dispose();
      }
    }
    this.chunks.clear();
    this.lastScanKey = "";
    this.scanDirty = true;
    this.lastGrassPos.set(1e9, 0, 1e9);
    this.lastVegPos.set(1e9, 0, 1e9);
    this.lastMapPos.set(1e9, 0, 1e9);
  }

  /** refresh the circular minimap when the player has walked a few blocks */
  private updateMinimap(dt: number) {
    this.mapTimer += dt;
    if (this.mapTimer < 0.45) return;
    if (this.lastMapPos.distanceToSquared(this.pos) < 36) return;
    this.mapTimer = 0;
    const url = this.renderMap(this.pos.x, this.pos.z, MINIMAP_SPAN, MINIMAP_SPAN);
    if (url) {
      this.lastMapPos.copy(this.pos);
      this.onMinimap(url);
    }
  }

  /** open / close the full-screen map overlay */
  setMapOpen(open: boolean) {
    if (this.mapOpen === open) return;
    this.mapOpen = open;
    this.keys.clear();
    if (open && this.consoleOpen) {
      // the console cannot stay open underneath the map
      this.consoleOpen = false;
      this.onConsole(false);
    }
    if (open) {
      this.wasEntered = this.entered;
      this.entered = false;
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else if (this.wasEntered) {
      this.requestLock();
    }
    this.onMapOpen(open);
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
   * Expand a chunk's scenery records into grid-aligned cubes, once per chunk.
   * The worker only ships the trunk columns; the block layout is derived here
   * from the deterministic shapes in scenery.ts and cached on the record, so
   * re-scattering while walking costs a couple of memcpys.
   */
  private ensureScenery(rec: ChunkRec) {
    if (rec.leaves) return;
    const trees = rec.trees;
    const n = Math.floor(trees.length / TREE_STRIDE);
    const starts = new Uint32Array(n + 1);
    const leaf: number[] = [];
    const shape = this.vegScratch.shape;

    for (let t = 0; t < n; t++) {
      starts[t] = leaf.length / LEAF_STRIDE;
      const x = trees[t * TREE_STRIDE];
      const z = trees[t * TREE_STRIDE + 1];
      const ground = trees[t * TREE_STRIDE + 2];
      const species = trees[t * TREE_STRIDE + 3];
      treeShape(x, z, species, shape);
      const tint = foliageTint(x, z);
      const g = species === TREE_CONIFER ? 0.15 + tint * 0.12 : 0.17 + tint * 0.13;
      const r = g * (species === TREE_CONIFER ? 0.6 : 0.72);
      const b = g * (species === TREE_CONIFER ? 0.58 : 0.4);
      treeBlocks(x, z, ground, species, shape, (bx, by, bz) => {
        const j = 0.9 + hash2(bx * 3 + 1, bz * 7 - 2) * 0.2;
        leaf.push(bx, by, bz, r * j, g * j, b * j);
      });
    }
    starts[n] = leaf.length / LEAF_STRIDE;
    rec.leaves = new Float32Array(leaf);
    rec.leafStart = starts;

    const rocks = rec.rocks;
    const m = Math.floor(rocks.length / ROCK_STRIDE);
    const stone: number[] = [];
    for (let i = 0; i < m; i++) {
      const x = rocks[i * ROCK_STRIDE];
      const z = rocks[i * ROCK_STRIDE + 1];
      const ground = rocks[i * ROCK_STRIDE + 2];
      const radius = rocks[i * ROCK_STRIDE + 3];
      rockBlocks(x, z, ground, radius, (bx, by, bz) => {
        stone.push(bx, by, bz, 0.26 + hash2(bx * 7, bz * 11) * 0.12);
      });
    }
    rec.stones = new Float32Array(stone);
  }

  /**
   * Fill the trunk / leaf / boulder instances for the chunks around the
   * player. Chunks are visited nearest-first, so when the instance budget
   * runs out the distant treeline thins instead of random trees losing their
   * canopy while the trunk keeps standing.
   */
  private rebuildVegetation() {
    const range = this.q.vegRange;
    const r2 = range * range;
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    const span = Math.ceil(range / CHUNK);
    const { mat, quat, pos, scale, color, shape } = this.vegScratch;
    quat.identity();
    let nTrunk = 0;
    let nLeaf = 0;
    let nRock = 0;

    const near: { rec: ChunkRec; d: number }[] = [];
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const rec = this.chunks.get(`${pcx + dx},${pcz + dz}`);
        if (!rec) continue;
        const ox = rec.cx * CHUNK + CHUNK * 0.5 - this.pos.x;
        const oz = rec.cz * CHUNK + CHUNK * 0.5 - this.pos.z;
        near.push({ rec, d: Math.sqrt(ox * ox + oz * oz) });
      }
    }
    near.sort((a, b) => a.d - b.d);

    const capLeaf = this.q.leafCap;
    const capTrunk = this.q.trunkCap;
    const capRock = this.q.rockCap;

    for (const { rec, d } of near) {
      this.ensureScenery(rec);
      const leaves = rec.leaves!;
      const starts = rec.leafStart!;
      const stones = rec.stones!;
      // every corner of the chunk inside the radius -> skip the per-item test
      const whole = d + CHUNK * 0.72 <= range;

      const trees = rec.trees;
      for (let t = 0; t * TREE_STRIDE < trees.length; t++) {
        const x = trees[t * TREE_STRIDE];
        const z = trees[t * TREE_STRIDE + 1];
        if (!whole) {
          const ddx = x - this.pos.x;
          const ddz = z - this.pos.z;
          if (ddx * ddx + ddz * ddz > r2) continue;
        }
        const from = starts[t];
        const to = starts[t + 1];
        const count = to - from;
        // never leave a bare trunk behind: the tree is drawn whole or not at all
        if (count === 0 || nTrunk >= capTrunk || nLeaf + count > capLeaf) continue;

        treeShape(x, z, trees[t * TREE_STRIDE + 3], shape);
        mat.compose(pos.set(x, trees[t * TREE_STRIDE + 2], z), quat, scale.set(1, shape.trunk, 1));
        this.trunks.setMatrixAt(nTrunk, mat);
        const tint = foliageTint(x, z);
        const bark = 0.12 + tint * 0.07;
        this.trunks.setColorAt(nTrunk, color.setRGB(bark, bark * 0.72, bark * 0.46));
        nTrunk++;

        for (let i = from * LEAF_STRIDE; i < to * LEAF_STRIDE; i += LEAF_STRIDE) {
          mat.makeTranslation(leaves[i], leaves[i + 1], leaves[i + 2]);
          this.leaves.setMatrixAt(nLeaf, mat);
          this.leaves.setColorAt(nLeaf, color.setRGB(leaves[i + 3], leaves[i + 4], leaves[i + 5]));
          nLeaf++;
        }
      }

      for (let i = 0; i < stones.length; i += STONE_STRIDE) {
        if (nRock >= capRock) break;
        if (!whole) {
          const ddx = stones[i] - this.pos.x;
          const ddz = stones[i + 2] - this.pos.z;
          if (ddx * ddx + ddz * ddz > r2) continue;
        }
        mat.makeTranslation(stones[i], stones[i + 1], stones[i + 2]);
        this.boulders.setMatrixAt(nRock, mat);
        const v = stones[i + 3];
        this.boulders.setColorAt(nRock, color.setRGB(v, v * 0.98, v * 0.93));
        nRock++;
      }
    }

    for (const [mesh, n] of [
      [this.trunks, nTrunk],
      [this.leaves, nLeaf],
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
    if (this.mapOpen) {
      // map overlay owns the keyboard until it is dismissed
      if (e.code === "Escape" || e.code === "KeyM" || e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        this.setMapOpen(false);
      }
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
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      this.lookMode = "pointer";
      this.entered = true;
      this.canvas.style.cursor = "";
      this.onEnter(true);
    } else if (!this.consoleOpen && !this.mapOpen) {
      // we released the lock on purpose for the console / map: stay in the world
      this.entered = false;
      this.onEnter(false);
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
        say("  /map                打开 / 关闭大地图");
        say("  /trees <倍率>       森林密度（1 = 默认，0 = 无树）");
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
      case "trees":
      case "forest": {
        const v = num(1);
        if (!Number.isFinite(v) || v < 0) return bad("用法：/trees <倍率，0-3，1 = 默认>");
        setTreeDensity(v);
        this.rebuildChunks();
        say(`森林密度 ×${Math.min(3, v).toFixed(2)}，正在重建周围地形…`);
        break;
      }
      case "map":
        this.setMapOpen(!this.mapOpen);
        say(this.mapOpen ? "地图已打开（Esc / 点击 × 关闭）" : "地图已关闭");
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
      this.onEnter(true);
      return;
    }
    requestSteer(this.canvas, (mode) => {
      this.entered = true;
      if (mode === "pointer") {
        this.lookMode = "pointer";
        this.onLockChange(true);
        this.onEnter(true);
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
    this.onEnter(true);
  }

  /** leave the world (Esc in drag mode, or pointer lock released by the browser) */
  exitLook() {
    this.dragLook = false;
    this.entered = false;
    this.keys.clear();
    this.canvas.style.cursor = "";
    this.onLockChange(false);
    this.onEnter(false);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private solidAt(x: number, z: number, feetY: number) {
    return this.heightAtWorld(x, z) > feetY + 1.02;
  }

  private updatePlayer(dt: number) {
    if (this.mapOpen) return; // browsing the map, not walking
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

      this.updateMinimap(dt);
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
      heading: Math.atan2(-Math.sin(this.yaw), Math.cos(this.yaw)),
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
    for (const m of [this.trunks, this.leaves, this.boulders]) m.dispose();
    this.vegCube.dispose();
    this.renderer.dispose();
  }
}

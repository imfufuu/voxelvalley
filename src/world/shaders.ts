export const SKY_FN = /* glsl */ `
vec3 skyColor(vec3 dir, vec3 sunDir, vec3 zenithC, vec3 horizonC, vec3 sunCol) {
  float up = clamp(dir.y, -1.0, 1.0);
  float t = pow(clamp(up, 0.0, 1.0), 0.42);
  vec3 c = mix(horizonC, zenithC, t);
  float d = max(dot(normalize(dir), sunDir), 0.0);
  c += sunCol * pow(d, 6.0) * 0.16;
  c += sunCol * pow(d, 60.0) * 0.22;
  c = mix(c, horizonC * 0.82, smoothstep(0.0, -0.22, up));
  return c;
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always at far plane
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uNight;
uniform float uTime;
${SKY_FN}

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir, uSunDir, uZenith, uHorizon, uSunColor);

  // sun disk
  float d = dot(dir, uSunDir);
  float disk = smoothstep(0.99955, 0.99985, d);
  col += uSunColor * disk * 9.0;

  // stars
  if (uNight > 0.01 && dir.y > -0.02) {
    vec3 sp = floor(dir * 320.0);
    float s = hash31(sp);
    float star = smoothstep(0.9965, 1.0, s) * (0.5 + 0.5 * sin(uTime * 2.0 + s * 90.0));
    col += vec3(0.85, 0.9, 1.0) * star * uNight * 2.2 * smoothstep(-0.02, 0.25, dir.y);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------ water */

export const WATER_VERT = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uCameraPos;
varying vec3 vWorld;
varying float vDist;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = length(wp.xz - uCameraPos.xz);
  float fade = 1.0 - smoothstep(60.0, 360.0, dist);
  float t = uTime;
  float h = 0.0;
  h += sin(dot(wp.xz, vec2(0.86, 0.50)) * 0.62 + t * 1.05) * 0.11;
  h += sin(dot(wp.xz, vec2(-0.40, 0.92)) * 1.05 + t * 1.45) * 0.065;
  h += sin(dot(wp.xz, vec2(0.92, -0.21)) * 2.10 + t * 2.05) * 0.03 * fade;
  wp.y += h;
  vWorld = wp.xyz;
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying float vDist;

uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform sampler2D uHeightMap;
uniform float uWorldSize;
uniform float uSeaLevel;
uniform vec3 uShallow;
uniform vec3 uDeep;
${SKY_FN}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// analytic derivatives of the wave field
vec3 waveNormal(vec2 p, float t, float fade) {
  float dx = 0.0, dz = 0.0;
  vec2 d1 = vec2(0.86, 0.50); float k1 = 0.62;
  dx += cos(dot(p, d1) * k1 + t * 1.05) * 0.11 * k1 * d1.x;
  dz += cos(dot(p, d1) * k1 + t * 1.05) * 0.11 * k1 * d1.y;
  vec2 d2 = vec2(-0.40, 0.92); float k2 = 1.05;
  dx += cos(dot(p, d2) * k2 + t * 1.45) * 0.065 * k2 * d2.x;
  dz += cos(dot(p, d2) * k2 + t * 1.45) * 0.065 * k2 * d2.y;
  vec2 d3 = vec2(0.92, -0.21); float k3 = 2.10;
  dx += cos(dot(p, d3) * k3 + t * 2.05) * 0.03 * k3 * d3.x * fade;
  dz += cos(dot(p, d3) * k3 + t * 2.05) * 0.03 * k3 * d3.y * fade;
  vec2 d4 = vec2(0.25, 0.97); float k4 = 4.3;
  dx += cos(dot(p, d4) * k4 + t * 3.1) * 0.011 * k4 * d4.x * fade;
  dz += cos(dot(p, d4) * k4 + t * 3.1) * 0.011 * k4 * d4.y * fade;
  // fine chop
  float n = vnoise(p * 3.4 + vec2(t * 0.55, -t * 0.4));
  float n2 = vnoise(p * 3.4 + vec2(0.06, 0.0) + vec2(t * 0.55, -t * 0.4));
  float n3 = vnoise(p * 3.4 + vec2(0.0, 0.06) + vec2(t * 0.55, -t * 0.4));
  dx += (n2 - n) * 1.6 * fade;
  dz += (n3 - n) * 1.6 * fade;
  return normalize(vec3(-dx, 1.0, -dz));
}

float terrainHeightTex(vec2 p) {
  vec2 uv = (p + uWorldSize * 0.5) / uWorldSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uHeightMap, uv).r * 255.0;
}

void main() {
  float fade = 1.0 - smoothstep(50.0, 300.0, vDist);
  vec3 N = waveNormal(vWorld.xz, uTime, fade);
  vec3 V = normalize(uCameraPos - vWorld);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.85 + 0.02;

  float depth = max(0.0, uSeaLevel - terrainHeightTex(vWorld.xz));
  float shoreT = smoothstep(0.0, 5.0, depth);

  vec3 reflCol = skyColor(R, uSunDir, uZenith, uHorizon, uSunColor);
  vec3 body = mix(uShallow, uDeep, smoothstep(0.4, 11.0, depth));
  body *= (0.55 + 0.45 * max(uSunDir.y, 0.0));

  float fres = 0.022 + 0.978 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 col = mix(body, reflCol, clamp(fres, 0.0, 1.0));

  // sun specular + glitter
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 420.0);
  float glint = pow(max(dot(N, H), 0.0), 42.0) * 0.12;
  col += uSunColor * (spec * 5.0 + glint) * smoothstep(-0.05, 0.15, uSunDir.y);

  // sub-surface scattering on wave crests
  float crest = smoothstep(0.05, 0.24, length(N.xz));
  col += uShallow * crest * 0.16 * max(uSunDir.y, 0.0);

  // shoreline foam
  float waveEdge = sin(depth * 4.0 - uTime * 1.7 + vnoise(vWorld.xz * 0.7) * 5.0) * 0.5 + 0.5;
  float foam = (1.0 - smoothstep(0.0, 1.15, depth)) * (0.35 + 0.65 * waveEdge);
  foam += (1.0 - smoothstep(0.0, 0.35, depth)) * 0.5;
  foam *= smoothstep(0.02, 0.2, depth);
  float foamTex = vnoise(vWorld.xz * 2.6 + uTime * 0.2);
  col = mix(col, vec3(0.94, 0.97, 1.0), clamp(foam * (0.55 + 0.7 * foamTex), 0.0, 0.9));

  float alpha = mix(0.35, 0.96, shoreT);
  alpha = max(alpha, clamp(foam, 0.0, 1.0));
  alpha = mix(alpha, 1.0, clamp(fres, 0.0, 1.0) * 0.85);

  // exponential fog
  float fogF = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
  alpha = mix(alpha, 1.0, clamp(fogF, 0.0, 1.0));

  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------ grass */

export const GRASS_VERT = /* glsl */ `
precision highp float;
attribute vec3 iPos;
attribute vec4 iParams; // x: height, y: width, z: rotation, w: phase
attribute vec3 iColor;

uniform float uTime;
uniform vec3 uCameraPos;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uRange;

varying vec3 vColor;
varying float vUpness;
varying float vFade;
varying vec3 vNormalW;
varying vec3 vWorld;

void main() {
  float hgt = iParams.x;
  float wid = iParams.y;
  float rot = iParams.z;
  float phase = iParams.w;

  float dist = length(iPos.xz - uCameraPos.xz);
  float fade = 1.0 - smoothstep(uRange * 0.62, uRange, dist);

  vec3 p = position;
  p.x *= wid;
  p.y *= hgt * fade;
  p.z *= wid;

  float c = cos(rot), s = sin(rot);
  vec3 rp = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  vec3 nrm = vec3(normal.x * c - normal.z * s, normal.y, normal.x * s + normal.z * c);

  float t = uTime;
  float w = sin(dot(iPos.xz, uWindDir) * 0.16 + t * 1.45 + phase);
  float gust = sin(dot(iPos.xz, uWindDir) * 0.031 + t * 0.42) * 0.5 + 0.5;
  float flutter = sin(t * 6.2 + phase * 3.1) * 0.16;
  float bendAmt = (w * 0.55 + 0.45 + flutter) * uWind * (0.45 + gust * 0.9);
  float k = pow(clamp(position.y, 0.0, 1.0), 1.7);
  rp.xz += uWindDir * bendAmt * k * hgt * 0.55;
  rp.y -= abs(bendAmt) * k * hgt * 0.12;

  vec3 world = iPos + rp;
  vWorld = world;
  vColor = iColor;
  vUpness = clamp(position.y, 0.0, 1.0);
  vFade = fade;
  vNormalW = normalize(nrm + vec3(0.0, 0.55, 0.0));
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const GRASS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vUpness;
varying float vFade;
varying vec3 vNormalW;
varying vec3 vWorld;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCameraPos;

void main() {
  if (vFade < 0.02) discard;
  vec3 N = normalize(vNormalW);
  float ndl = max(dot(N, uSunDir), 0.0) * 0.75 + 0.25;
  vec3 col = vColor * (uAmbient + uSunColor * ndl);
  // tip lightening + root darkening
  col *= mix(0.55, 1.22, vUpness);
  col += uSunColor * pow(vUpness, 3.0) * 0.10 * max(uSunDir.y, 0.0);
  // exponential fog, same curve as the water/terrain, so distant meadows
  // dissolve into the horizon instead of staying a saturated green carpet
  float fogF = 1.0 - exp(-pow(length(vWorld - uCameraPos) * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
  gl_FragColor = vec4(col * 0.72, 1.0);
}
`;

/* ----------------------------------------------------------------- clouds */

export const CLOUD_VERT = /* glsl */ `
precision highp float;
attribute float iAlpha;
varying vec3 vNormalW;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vWorld = (modelMatrix * wp).xyz;
  vNormalW = normalize(mat3(instanceMatrix) * normal);
  vAlpha = iAlpha;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * wp;
}
`;

export const CLOUD_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormalW;
varying float vAlpha;
varying vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uFogColor;
uniform vec3 uCameraPos;
uniform float uFogDensity;

void main() {
  vec3 N = normalize(vNormalW);
  float up = N.y * 0.5 + 0.5;
  vec3 col = mix(uBottom, uTop, pow(up, 0.8));
  float sun = max(dot(N, uSunDir), 0.0);
  col += uSunColor * sun * 0.35;
  float dist = length(vWorld - uCameraPos);
  float fogF = 1.0 - exp(-pow(dist * uFogDensity * 0.55, 2.0));
  col = mix(col, uFogColor, clamp(fogF, 0.0, 0.85));
  float a = vAlpha * (1.0 - smoothstep(700.0, 1050.0, dist));
  gl_FragColor = vec4(col, a);
}
`;

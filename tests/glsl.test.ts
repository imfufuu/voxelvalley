/**
 * Parses every GLSL source in src/world/shaders.ts.
 * Catches syntax errors that would otherwise only surface at runtime, in a
 * browser, on someone else's machine.
 */
import { parser } from "@shaderfrog/glsl-parser";
import * as SHADERS from "../src/world/shaders";

/** three.js injects these before every shader; declare them so the file parses standalone */
const PRELUDE = `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;

let failures = 0;
let checked = 0;
for (const [name, src] of Object.entries(SHADERS)) {
  if (typeof src !== "string") continue;
  checked++;
  try {
    parser.parse(PRELUDE + src);
    console.log(`PASS  ${name} (${src.length}b)`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${(err as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${checked} shader sources checked`);
if (checked < 8) {
  failures++;
  console.log("FAIL  expected at least 8 shader sources");
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

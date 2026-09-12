/**
 * Node smoke test for the pointer-lock / drag fallback logic (no browser needed).
 * Run: node --experimental-strip-types /tmp/steering.test.ts
 */
import { requestSteer, type LookMode } from "../src/world/steering.ts";

type Listener = (ev: any) => void;

class FakeDoc {
  pointerLockElement: unknown = null;
  private ls = new Map<string, Set<Listener>>();
  addEventListener(t: string, fn: Listener) {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) {
    this.ls.get(t)?.delete(fn);
  }
  dispatch(t: string) {
    for (const fn of [...(this.ls.get(t) ?? [])]) fn({ type: t });
  }
  listenerCount(t: string) {
    return this.ls.get(t)?.size ?? 0;
  }
}

const g = globalThis as any;
const doc = new FakeDoc();
g.document = doc;
g.window = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) };

const canvas = { requestPointerLock: () => {} } as unknown as HTMLCanvasElement;

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <- " + extra}`);
  if (!ok) failures++;
}

async function run(
  name: string,
  setup: (c: any, d: FakeDoc) => void,
  script: (c: any, d: FakeDoc) => void | Promise<void>,
  expected: LookMode,
) {
  const d = new FakeDoc();
  g.document = d;
  const c: any = {};
  setup(c, d);
  const results: LookMode[] = [];
  requestSteer(c as HTMLCanvasElement, (m) => results.push(m));
  await script(c, d);
  await new Promise((r) => setTimeout(r, 500)); // outlast the 400ms fallback timer
  check(
    name,
    results.length === 1 && results[0] === expected,
    `got ${JSON.stringify(results)} expected ["${expected}"]`,
  );
  const leaked = d.listenerCount("pointerlockchange") + d.listenerCount("pointerlockerror");
  check(`  ${name}: listeners cleaned up`, leaked === 0, `${leaked} left`);
}

// 1. lock granted (event fires, promise resolves)
await run(
  "pointer lock granted -> pointer",
  (c, d) => {
    c.requestPointerLock = () => {
      d.pointerLockElement = c;
      d.dispatch("pointerlockchange");
      return Promise.resolve();
    };
  },
  async () => {},
  "pointer",
);

// 2. lock granted, promise resolves BEFORE the event is dispatched
await run(
  "promise resolves first -> still pointer",
  (c, d) => {
    c.requestPointerLock = () => {
      Promise.resolve().then(() => {
        d.pointerLockElement = c;
        d.dispatch("pointerlockchange");
      });
      return Promise.resolve();
    };
  },
  async () => {},
  "pointer",
);

// 3. browser rejects the promise (iframe / permissions policy)
await run(
  "promise rejected -> drag",
  (c) => {
    c.requestPointerLock = () => Promise.reject(new Error("blocked by permissions policy"));
  },
  async () => {},
  "drag",
);

// 4. pointerlockerror event
await run(
  "pointerlockerror event -> drag",
  (c, d) => {
    c.requestPointerLock = () => new Promise(() => {});
    setTimeout(() => d.dispatch("pointerlockerror"), 10);
  },
  async () => {},
  "drag",
);

// 5. promise resolves but no lock element ever set (silent refusal)
await run(
  "resolves without lock -> drag",
  (c) => {
    c.requestPointerLock = () => Promise.resolve();
  },
  async () => {},
  "drag",
);

// 6. old browser: requestPointerLock returns undefined and never fires anything
await run(
  "no promise, no event -> timeout then drag",
  (c) => {
    c.requestPointerLock = () => undefined;
  },
  async () => {},
  "drag",
);

// 7. throws synchronously
await run(
  "throws synchronously -> drag",
  (c) => {
    c.requestPointerLock = () => {
      throw new Error("nope");
    };
  },
  async () => {},
  "drag",
);

// 8. no requestPointerLock at all
await run(
  "requestPointerLock missing -> drag",
  (c) => {
    delete c.requestPointerLock;
  },
  async () => {},
  "drag",
);

// 9. repeated events must not trigger multiple callbacks
await run(
  "callback fires exactly once",
  (c, d) => {
    c.requestPointerLock = () => {
      d.pointerLockElement = c;
      d.dispatch("pointerlockchange");
      d.dispatch("pointerlockchange");
      d.dispatch("pointerlockerror");
      return Promise.resolve();
    };
  },
  async () => {},
  "pointer",
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

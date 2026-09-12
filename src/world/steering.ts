/**
 * Mouse steering: real pointer lock when the browser grants it, hold-and-drag
 * looking when it does not.
 *
 * Pointer lock is refused in a lot of perfectly normal situations — the page is
 * embedded in an iframe without `allow="pointer-lock"` (live previews, code
 * sandboxes, docs sites), the gesture was consumed, the user denied it, or the
 * browser simply does not implement it. The original code swallowed those
 * failures, so the "enter world" button looked broken: it was clicked, the lock
 * was refused, and nothing at all happened.
 */

export type LookMode = "pointer" | "drag";

/** how long to wait for the browser to answer a lock request before falling back */
const LOCK_TIMEOUT_MS = 400;
/** grace period: the promise can resolve before pointerlockchange is dispatched */
const DECIDE_DELAY_MS = 60;

/**
 * Ask for pointer lock. `onResult` is called exactly once, with `"pointer"` when
 * the lock was granted and `"drag"` when the world must fall back to dragging.
 */
export function requestSteer(
  canvas: HTMLCanvasElement,
  onResult: (mode: LookMode) => void,
): void {
  if (typeof canvas.requestPointerLock !== "function") {
    onResult("drag");
    return;
  }

  let settled = false;
  const finish = (mode: LookMode) => {
    if (settled) return;
    settled = true;
    cleanup();
    onResult(mode);
  };
  // the element, not the event, is the source of truth: a promise can resolve
  // even when the lock was ultimately refused
  const decide = () => finish(document.pointerLockElement === canvas ? "pointer" : "drag");
  const decideSoon = () => {
    window.setTimeout(decide, DECIDE_DELAY_MS);
  };
  const cleanup = () => {
    document.removeEventListener("pointerlockerror", onError);
    document.removeEventListener("pointerlockchange", decide);
    window.clearTimeout(timer);
  };
  const onError = () => finish("drag");

  document.addEventListener("pointerlockerror", onError);
  document.addEventListener("pointerlockchange", decide);
  const timer = window.setTimeout(decide, LOCK_TIMEOUT_MS);

  try {
    const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (r && typeof r.then === "function") r.then(decideSoon).catch(onError);
  } catch {
    onError();
  }
}

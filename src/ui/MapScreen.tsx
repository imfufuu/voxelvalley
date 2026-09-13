import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MINIMAP_SPAN, type Engine } from "../world/Engine";

/** zoom steps of the expanded map, in blocks across */
const SPANS = [MINIMAP_SPAN, 384, 768, 1536, 3072, 6144, 9048];
const ZOOM_LABEL = ["192 格", "384 格", "768 格", "1.5k 格", "3k 格", "6k 格", "全景"];

/**
 * Full-screen map view. Terrain inside the streamed radius is drawn from real
 * block data; beyond it the coarse world heightmap takes over, so the whole
 * 9048² world can be browsed.
 */
export function MapScreen({
  engine,
  heading,
  onClose,
}: {
  engine: Engine;
  heading: number;
  onClose: () => void;
}) {
  // the player is frozen while the map is up, so snapshot once
  const [player] = useState(() => ({
    x: engine.pos.x,
    z: engine.pos.z,
    y: engine.pos.y,
  }));
  const [zoom, setZoom] = useState(2);
  const [center, setCenter] = useState<{ x: number; z: number } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** live drag offset in pixels: the tile is only re-rendered on release */
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const span = SPANS[zoom];
  const cx = center?.x ?? player.x;
  const cz = center?.z ?? player.z;
  const following = center === null;

  // (re)render the terrain tile whenever the view changes
  useEffect(() => {
    const id = window.setTimeout(() => {
      setUrl(engine.renderMap(cx, cz, span));
    }, 16);
    return () => window.clearTimeout(id);
  }, [engine, cx, cz, span]);

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return null;
      const u = (clientX - box.left - shift.x) / box.width;
      const v = (clientY - box.top - shift.y) / box.height;
      return { x: cx - span / 2 + u * span, z: cz - span / 2 + v * span };
    },
    [cx, cz, span, shift.x, shift.y],
  );

  // wheel zoom keeps the block under the cursor pinned
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = Math.max(0, Math.min(SPANS.length - 1, zoom + (e.deltaY > 0 ? 1 : -1)));
      if (next === zoom) return;
      const p = toWorld(e.clientX, e.clientY);
      const k = SPANS[next] / span;
      if (p && k !== 1) {
        // keep p put: newCenter = p + (oldCenter - p) * k
        setCenter({
          x: p.x + (cx - p.x) * k,
          z: p.z + (cz - p.z) * k,
        });
      } else if (!following) {
        setCenter({ x: cx, z: cz });
      }
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [boxRef, zoom, span, cx, cz, following, toWorld]);

  const px = ((player.x - (cx - span / 2)) / span) * 100;
  const pz = ((player.z - (cz - span / 2)) / span) * 100;
  const playerVisible = px >= 0 && px <= 100 && pz >= 0 && pz <= 100;

  const coord = useMemo(
    () => (cursor ? `${cursor.x.toFixed(0)}, ${cursor.z.toFixed(0)}` : null),
    [cursor],
  );

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-[min(92vw,860px)] flex-col gap-3 rounded-2xl border border-white/12 bg-[#0b1220]/90 p-4 shadow-2xl">
        {/* header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <span className="text-[15px] font-semibold tracking-wide text-white/90">地图</span>
            <span className="font-mono text-[11px] text-white/40">
              {coord ?? `${player.x.toFixed(0)}, ${player.z.toFixed(0)}`}
            </span>
            {!following && (
              <button
                onClick={() => setCenter(null)}
                className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300 transition hover:bg-emerald-400/20"
              >
                回到玩家
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-white/15 px-2.5 py-1 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            Esc ✕
          </button>
        </div>

        {/* the map itself */}
        <div
          ref={boxRef}
          onPointerDown={(e) => {
            drag.current = { px: e.clientX, py: e.clientY };
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) {
              setShift({ x: e.clientX - d.px, y: e.clientY - d.py });
            }
            const w = toWorld(e.clientX, e.clientY);
            if (w) setCursor(w);
          }}
          onPointerUp={(e) => {
            (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
            drag.current = null;
            setDragging(false);
            const box = boxRef.current?.getBoundingClientRect();
            if (box && (shift.x !== 0 || shift.y !== 0)) {
              const k = span / box.width;
              setCenter({ x: cx - shift.x * k, z: cz - shift.y * k });
            }
            setShift({ x: 0, y: 0 });
          }}
          onPointerLeave={() => setCursor(null)}
          className={`relative mx-auto aspect-square w-full max-w-[min(76vh,780px)] overflow-hidden rounded-xl border border-white/15 bg-[#0d1424] ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          {url ? (
            <img
              src={url}
              alt="地图"
              draggable={false}
              className="absolute left-0 top-0 h-full w-full select-none"
              style={{
                imageRendering: "pixelated",
                transform: `translate(${shift.x}px, ${shift.y}px)`,
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-white/40">
              正在绘制地形…
            </div>
          )}

          {/* player marker */}
          {playerVisible && (
            <div
              className="pointer-events-none absolute h-0 w-0"
              style={{
                left: `${px}%`,
                top: `${pz}%`,
                transform: `translate(${shift.x}px, ${shift.y}px)`,
              }}
            >
              <div
                className="absolute -left-[7px] -top-[9px] h-[18px] w-[14px]"
                style={{ transform: `rotate(${(heading * 180) / Math.PI}deg)` }}
              >
                <div
                  className="h-full w-full"
                  style={{
                    background: "#fbbf24",
                    clipPath: "polygon(50% 0%, 100% 100%, 50% 78%, 0% 100%)",
                    filter: "drop-shadow(0 0 3px rgba(0,0,0,0.9))",
                  }}
                />
              </div>
            </div>
          )}

          {/* edges of the world */}
          <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/10" />
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 text-[11px] text-white/45">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoom((z) => Math.max(0, z - 1))}
              disabled={zoom === 0}
              className="h-6 w-6 rounded-md border border-white/15 text-white/70 transition hover:bg-white/10 disabled:opacity-30"
            >
              −
            </button>
            <span className="w-14 text-center font-mono tabular-nums text-white/70">
              {ZOOM_LABEL[zoom]}
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(SPANS.length - 1, z + 1))}
              disabled={zoom === SPANS.length - 1}
              className="h-6 w-6 rounded-md border border-white/15 text-white/70 transition hover:bg-white/10 disabled:opacity-30"
            >
              +
            </button>
            <span className="ml-2">滚轮缩放 · 拖动平移</span>
          </div>
          <div className="font-mono text-white/35">
            玩家 {player.x.toFixed(0)} / {player.z.toFixed(0)} · y {player.y.toFixed(0)}
          </div>
        </div>
      </div>
    </div>
  );
}

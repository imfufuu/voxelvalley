import type { Stats } from "../world/Engine";

const WORLD = 2048;

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-[10px] uppercase tracking-[0.18em] text-white/40">{label}</span>
      <span className={`font-mono text-[13px] tabular-nums ${accent ?? "text-white/90"}`}>{value}</span>
    </div>
  );
}

export function HUD({ stats, minimap }: { stats: Stats; minimap: string | null }) {
  const mx = ((stats.x + WORLD / 2) / WORLD) * 100;
  const mz = ((stats.z + WORLD / 2) / WORLD) * 100;

  return (
    <div className="pointer-events-none absolute inset-0 text-white">
      {/* crosshair */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative h-5 w-5 opacity-70">
          <div className="absolute left-1/2 top-0 h-1.5 w-[1.5px] -translate-x-1/2 bg-white/90 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
          <div className="absolute bottom-0 left-1/2 h-1.5 w-[1.5px] -translate-x-1/2 bg-white/90 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
          <div className="absolute left-0 top-1/2 h-[1.5px] w-1.5 -translate-y-1/2 bg-white/90 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
          <div className="absolute right-0 top-1/2 h-[1.5px] w-1.5 -translate-y-1/2 bg-white/90 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
          <div className="absolute left-1/2 top-1/2 h-[2px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70" />
        </div>
      </div>

      {/* telemetry */}
      <div className="absolute left-5 top-5 w-60 rounded-xl border border-white/10 bg-black/35 p-4 backdrop-blur-md">
        <div className="mb-3 flex items-center gap-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">
            Voxel Valley
          </span>
        </div>
        <div className="space-y-1.5">
          <Row label="坐标 X" value={stats.x.toFixed(1)} />
          <Row label="海拔 Y" value={stats.y.toFixed(1)} />
          <Row label="坐标 Z" value={stats.z.toFixed(1)} />
          <div className="my-2 h-px bg-white/10" />
          <Row label="地貌" value={stats.biome} accent="text-emerald-300" />
          <Row label="时间" value={stats.timeLabel} accent="text-amber-200" />
          <Row label="速度" value={`${stats.speed.toFixed(1)} m/s`} />
        </div>
      </div>

      {/* performance */}
      <div className="absolute right-5 top-5 rounded-xl border border-white/10 bg-black/35 px-4 py-3 backdrop-blur-md">
        <div className="space-y-1.5">
          <Row
            label="FPS"
            value={stats.fps.toFixed(0)}
            accent={stats.fps > 50 ? "text-emerald-300" : stats.fps > 30 ? "text-amber-300" : "text-rose-300"}
          />
          <Row label="区块" value={`${stats.chunks}`} />
          <Row label="三角面" value={`${stats.tris}K`} />
        </div>
      </div>

      {/* minimap */}
      {minimap && (
        <div className="absolute bottom-5 right-5">
          <div className="relative h-44 w-44 overflow-hidden rounded-xl border border-white/15 bg-black/40 shadow-2xl backdrop-blur">
            <img src={minimap} alt="map" className="h-full w-full object-cover" style={{ imageRendering: "pixelated" }} />
            <div
              className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/60 bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.9)]"
              style={{ left: `${mx}%`, top: `${mz}%` }}
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
              2048 × 2048
            </div>
          </div>
        </div>
      )}

      {/* controls hint */}
      <div className="absolute bottom-5 left-5 space-y-1 font-mono text-[11px] text-white/45">
        <div><span className="text-white/80">WASD</span> 行走 · <span className="text-white/80">Shift</span> 疾跑 · <span className="text-white/80">Space</span> 跳跃 / 上浮</div>
        <div><span className="text-white/80">C</span> 潜行 · <span className="text-white/80">F</span> 飞行 · <span className="text-white/80">T</span> 时间流速 · <span className="text-white/80">M</span> 静音 · <span className="text-white/80">Esc</span> 暂停</div>
        {stats.look === "drag" && (
          <div className="pt-1 text-amber-200/80">
            当前为拖动视角模式：按住鼠标左键拖动转视角（指针锁定被浏览器/嵌入环境拒绝）
          </div>
        )}
      </div>
    </div>
  );
}

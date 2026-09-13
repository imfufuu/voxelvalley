import { useEffect, useRef, useState } from "react";
import { MINIMAP_SPAN, type Stats } from "../world/Engine";

/** command console: `/` in game opens it, Enter runs, Esc closes */
function Console({
  open,
  log,
  onSubmit,
}: {
  open: boolean;
  log: string[];
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      // focus after the browser has handed the keyboard back
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-center">
      <div className="w-[min(92vw,720px)]">
        {log.length > 0 && (
          <div className="mb-2 space-y-0.5 px-1 font-mono text-[12px] text-white/70 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
            {log.slice(-5).map((line, i) => (
              <div key={`${i}-${line}`}>{line}</div>
            ))}
          </div>
        )}
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/15 bg-black/70 px-3 py-2 backdrop-blur-md">
          <span className="font-mono text-[13px] text-emerald-300">/</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                onSubmit(value);
                setValue("");
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            placeholder="输入指令，/help 查看全部"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent font-mono text-[13px] text-white/90 outline-none placeholder:text-white/30"
          />
        </div>
      </div>
    </div>
  );
}

/** circular minimap, always centred on the player, north up */
function Minimap({
  url,
  heading,
  onOpen,
}: {
  url: string | null;
  heading: number;
  onOpen: () => void;
}) {
  const deg = (heading * 180) / Math.PI;
  return (
    <button
      onClick={onOpen}
      title="点击查看大地图"
      className="pointer-events-auto group absolute left-5 top-5 h-40 w-40 rounded-full border border-white/25 bg-black/45 p-[3px] shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur-md transition hover:border-white/45"
    >
      <div className="relative h-full w-full overflow-hidden rounded-full bg-[#0b1220]">
        {url && (
          <img
            src={url}
            alt="小地图"
            draggable={false}
            className="h-full w-full select-none"
            style={{ imageRendering: "pixelated" }}
          />
        )}
        {/* vignette so the terrain fades into the bezel */}
        <div className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_22px_rgba(0,0,0,0.85)]" />

        {/* north */}
        <span className="pointer-events-none absolute left-1/2 top-[3px] -translate-x-1/2 font-mono text-[9px] font-bold text-white/75 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
          N
        </span>

        {/* player: centre of the circle, rotated to the look direction */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0">
          <div
            className="absolute -left-[6px] -top-[8px] h-[16px] w-[12px]"
            style={{ transform: `rotate(${deg}deg)` }}
          >
            <div
              className="h-full w-full"
              style={{
                background: "#fbbf24",
                clipPath: "polygon(50% 0%, 100% 100%, 50% 76%, 0% 100%)",
                filter: "drop-shadow(0 0 3px rgba(0,0,0,0.9))",
              }}
            />
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-1 text-center font-mono text-[8px] uppercase tracking-[0.18em] text-white/0 transition group-hover:text-white/70">
          点击展开
        </div>
      </div>
    </button>
  );
}

export function HUD({
  stats,
  minimap,
  consoleOpen,
  consoleLog,
  onCommand,
  onOpenMap,
}: {
  stats: Stats;
  minimap: string | null;
  consoleOpen: boolean;
  consoleLog: string[];
  onCommand: (value: string) => void;
  onOpenMap: () => void;
}) {
  const fps = stats.fps;
  const tint = fps > 50 ? "text-emerald-300" : fps > 30 ? "text-amber-300" : "text-rose-300";

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

      {/* fps – the only readout we keep on screen */}
      <div className="absolute right-5 top-5 rounded-md border border-white/10 bg-black/30 px-2.5 py-1 font-mono text-[12px] tabular-nums backdrop-blur-md">
        <span className={tint}>{Math.round(fps)}</span>
        <span className="ml-1 text-white/40">FPS</span>
      </div>

      <Minimap url={minimap} heading={stats.heading} onOpen={onOpenMap} />

      <Console open={consoleOpen} log={consoleLog} onSubmit={onCommand} />

      {/* controls hint */}
      <div className="absolute bottom-5 left-5 space-y-1 font-mono text-[11px] text-white/45">
        <div>
          <span className="text-white/80">WASD</span> 行走 ·{" "}
          <span className="text-white/80">Shift</span> 疾跑 ·{" "}
          <span className="text-white/80">Space</span> 跳跃 / 上浮
        </div>
        <div>
          <span className="text-white/80">C</span> 潜行 ·{" "}
          <span className="text-white/80">F</span> 飞行 ·{" "}
          <span className="text-white/80">M</span> 静音 ·{" "}
          <span className="text-white/80">/</span> 指令 ·{" "}
          <span className="text-white/80">Esc</span> 暂停
        </div>
        {stats.look === "drag" && (
          <div className="pt-1 text-amber-200/80">
            当前为拖动视角模式：按住鼠标左键拖动转视角（指针锁定被浏览器/嵌入环境拒绝）
          </div>
        )}
        <div className="pt-0.5 text-white/30">
          小地图半径 {MINIMAP_SPAN / 2} 格 · 点击查看大地图
        </div>
      </div>
    </div>
  );
}

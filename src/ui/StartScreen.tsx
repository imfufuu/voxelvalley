import type { Stats } from "../world/Engine";

/**
 * Deliberately tiny: a title, a progress bar, and the enter button.
 * Rendering quality defaults to the highest preset and is changed in game with
 * `/quality`, so there is nothing to configure here.
 */
export function StartScreen({
  ready,
  progress,
  progressLabel,
  onStart,
  stats,
  error,
}: {
  ready: boolean;
  progress: number;
  progressLabel: string;
  onStart: () => void;
  stats: Stats;
  error?: string | null;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050912]/85 backdrop-blur-[2px]">
      <div className="w-[min(88vw,430px)] px-2 text-center">
        <div className="text-[10px] uppercase tracking-[0.42em] text-emerald-300/70">
          Voxel Valley
        </div>
        <h1 className="mt-1 text-[26px] font-medium tracking-tight text-white">体素山谷</h1>

        {error ? (
          <div className="mt-6 rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-left text-[12px] leading-relaxed text-rose-200">
            {error}
          </div>
        ) : !ready ? (
          <div className="mt-7">
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-300 transition-all duration-200"
                style={{ width: `${Math.max(2, progress * 100)}%` }}
              />
            </div>
            <div className="mt-2.5 flex items-baseline justify-between font-mono text-[11px] text-white/45">
              <span>{progressLabel}</span>
              <span className="text-emerald-300 tabular-nums">{(progress * 100).toFixed(0)}%</span>
            </div>
          </div>
        ) : (
          <div className="mt-7">
            <button
              onClick={onStart}
              className="rounded-xl bg-emerald-400 px-7 py-3 text-[14px] font-semibold text-emerald-950 shadow-[0_10px_40px_rgba(52,211,153,0.28)] transition hover:bg-emerald-300"
            >
              进入世界
            </button>
            <div className="mt-3 font-mono text-[11px] text-white/35">
              {stats.chunks} 区块已加载 · 最高视距
            </div>
          </div>
        )}

        <div className="mt-8 font-mono text-[11px] leading-relaxed text-white/25">
          WASD 行走 · Shift 疾跑 · Space 跳跃 · C 潜行 · F 飞行 · M 静音
          <br />
          按 <span className="text-white/45">/</span> 打开指令（/help 查看全部）
        </div>
      </div>
    </div>
  );
}

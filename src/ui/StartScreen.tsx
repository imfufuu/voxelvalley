import type { Quality, Stats } from "../world/Engine";

const QUALITIES: { id: Quality; label: string; note: string }[] = [
  { id: "low", label: "流畅", note: "视距 192m" },
  { id: "medium", label: "均衡", note: "视距 288m" },
  { id: "high", label: "精细", note: "视距 384m" },
  { id: "ultra", label: "史诗", note: "视距 480m" },
];

const FEATURES = [
  { icon: "⛰", title: "连绵雪山", desc: "脊状分形噪声塑造 165m 高的雪线山脉" },
  { icon: "🌾", title: "随风草丛", desc: "数万株 GPU 实例化草叶，阵风逐波传递" },
  { icon: "🌊", title: "真实水面", desc: "Gerstner 波 + 菲涅耳反射 + 岸线泡沫" },
  { icon: "☁", title: "体块云层", desc: "分层漂移体素云与柔和大气散射光照" },
];

export function StartScreen({
  ready,
  progress,
  progressLabel,
  onStart,
  quality,
  onQuality,
  stats,
  error,
}: {
  ready: boolean;
  progress: number;
  progressLabel: string;
  onStart: () => void;
  quality: Quality;
  onQuality: (q: Quality) => void;
  stats: Stats;
  error?: string | null;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050912]/72 backdrop-blur-[3px]">
      <div className="w-[min(92vw,760px)] rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.09] to-white/[0.03] p-8 shadow-[0_30px_120px_rgba(0,0,0,0.6)] backdrop-blur-xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.42em] text-emerald-300/80">
          Voxel Exploration · 第一人称
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-white">
          体素山谷 <span className="text-white/35">/ Voxel Valley</span>
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/55">
          一张 2048 × 2048 方块的无缝大陆：开阔的河谷、高耸的雪峰、随风起伏的草海与折射天光的湖泊。
          全部地形由分形噪声实时生成，多线程区块化构建。
        </p>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="text-lg">{f.icon}</div>
              <div className="mt-1 text-[13px] font-medium text-white/90">{f.title}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-white/45">{f.desc}</div>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-white/40">画质</div>
          <div className="grid grid-cols-4 gap-2">
            {QUALITIES.map((q) => (
              <button
                key={q.id}
                onClick={() => onQuality(q.id)}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  quality === q.id
                    ? "border-emerald-400/60 bg-emerald-400/15 text-white"
                    : "border-white/10 bg-black/20 text-white/60 hover:border-white/25 hover:text-white/85"
                }`}
              >
                <div className="text-[13px] font-medium">{q.label}</div>
                <div className="text-[10px] text-white/40">{q.note}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-7">
          {error ? (
            <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-[13px] leading-relaxed text-rose-200">
              {error}
            </div>
          ) : ready ? (
            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={onStart}
                className="group relative overflow-hidden rounded-xl bg-emerald-400 px-7 py-3.5 text-[15px] font-semibold text-emerald-950 shadow-[0_10px_40px_rgba(52,211,153,0.35)] transition hover:bg-emerald-300"
              >
                进入世界 · 点击锁定鼠标
              </button>
              <div className="font-mono text-[11px] text-white/40">
                当前位置 {stats.x.toFixed(0)}, {stats.z.toFixed(0)} · {stats.biome} · {stats.chunks} 区块已加载
              </div>
              <div className="w-full font-mono text-[11px] leading-relaxed text-white/30">
                若浏览器/嵌入环境拒绝指针锁定，会自动切换为「按住鼠标左键拖动」转视角，Esc 退出。
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[12px] text-white/60">{progressLabel}</span>
                <span className="font-mono text-[12px] text-emerald-300">
                  {(progress * 100).toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-300 transition-all duration-200"
                  style={{ width: `${Math.max(2, progress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-white/10 pt-4 font-mono text-[11px] leading-relaxed text-white/35">
          WASD 行走 / Shift 疾跑 / Space 跳跃 / C 潜行 / F 飞行观景 / T 切换昼夜流速 / Esc 释放鼠标
        </div>
      </div>
    </div>
  );
}

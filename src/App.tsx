import { useEffect, useRef, useState } from "react";
import { Engine, type Quality, type Stats } from "./world/Engine";
import { HUD } from "./ui/HUD";
import { MapScreen } from "./ui/MapScreen";
import { StartScreen } from "./ui/StartScreen";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("初始化引擎…");
  const [ready, setReady] = useState(false);
  const [inWorld, setInWorld] = useState(false);
  const [minimap, setMinimap] = useState<string | null>(null);
  const [, setQuality] = useState<Quality>("ultra");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [stats, setStats] = useState<Stats>({
    x: 0, y: 0, z: 0, fps: 0, chunks: 0, tris: 0,
    biome: "—", timeLabel: "06:00", submerged: false, speed: 0, grounded: true,
    heading: 0, look: "pointer", quality: "ultra",
  });

  useEffect(() => {
    if (!canvasRef.current) return;
    let engine: Engine;
    try {
      engine = new Engine(canvasRef.current);
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error
          ? `无法初始化 WebGL：${err.message}`
          : "无法初始化 WebGL，请在支持 WebGL 的浏览器中打开。",
      );
      return;
    }
    engineRef.current = engine;
    engine.onProgress = (v, label) => {
      setProgress(v);
      setProgressLabel(label);
    };
    engine.onReady = () => setReady(true);
    engine.onError = (message) => setError(message);
    engine.onQuality = setQuality;
    engine.onConsole = (open) => setConsoleOpen(open);
    engine.onConsoleLine = (text) => setConsoleLog((prev) => [...prev.slice(-6), text]);
    engine.onStats = setStats;
    engine.onMinimap = setMinimap;
    engine.onMapOpen = setMapOpen;
    engine.onLockChange = () => {};
    engine.onEnter = setInWorld;
    engine.start();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const start = () => engineRef.current?.requestLock();
  const openMap = () => engineRef.current?.setMapOpen(true);

  const runCommand = (value: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const cmd = value.trim();
    if (cmd) engine.runCommand(cmd);
    engine.closeConsole();
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0a1020] font-sans select-none">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* cinematic grade */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 48%, rgba(0,0,0,0) 42%, rgba(4,8,16,0.32) 78%, rgba(2,5,12,0.62) 100%)",
        }}
      />
      {stats.submerged && (
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(16,96,132,0.22) 0%, rgba(6,48,74,0.55) 100%)",
            boxShadow: "inset 0 0 220px rgba(2,28,48,0.9)",
          }}
        />
      )}

      {inWorld && (
        <HUD
          stats={stats}
          minimap={minimap}
          consoleOpen={consoleOpen}
          consoleLog={consoleLog}
          onCommand={runCommand}
          onOpenMap={openMap}
        />
      )}

      {mapOpen && engineRef.current && (
        <MapScreen
          engine={engineRef.current}
          heading={stats.heading}
          onClose={() => engineRef.current?.setMapOpen(false)}
        />
      )}

      {!inWorld && (
        <StartScreen
          ready={ready}
          progress={progress}
          progressLabel={progressLabel}
          onStart={start}
          stats={stats}
          error={error}
        />
      )}
    </div>
  );
}

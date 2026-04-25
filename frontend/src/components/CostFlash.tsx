import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const DURATION = 2500; // ms
const PARTICLE_COUNT = 14;

export default function CostFlash() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    function handler(e: Event) {
      const { cost, prevTotal, newTotal } = (e as CustomEvent<{ cost: number; prevTotal: number; newTotal: number }>).detail;
      if (cost < 0.000001) return;
      if (busyRef.current) {
        // Already animating — just finalize header and skip
        window.dispatchEvent(new CustomEvent('costComplete', { detail: { newTotal } }));
        return;
      }
      start(cost, prevTotal, newTotal);
    }
    window.addEventListener('costIncurred', handler);
    return () => window.removeEventListener('costIncurred', handler);
  }, []);

  function start(cost: number, prevTotal: number, newTotal: number) {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const safeContainer: HTMLDivElement = container;
    const safeCanvas: HTMLCanvasElement = canvas;

    busyRef.current = true;
    safeContainer.style.display = 'block';
    safeCanvas.width = window.innerWidth;
    safeCanvas.height = window.innerHeight;

    const ctx = safeCanvas.getContext('2d')!;

    // Start and end positions
    const sx = window.innerWidth / 2;
    const sy = window.innerHeight / 2;
    const ex = window.innerWidth - 90; // near the header cost badge
    const ey = 22;

    // Build particles with randomised bezier control points
    const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
      const midX = (sx + ex) / 2;
      const midY = (sy + ey) / 2;
      return {
        sx: sx + (Math.random() - 0.5) * 24,
        sy: sy + (Math.random() - 0.5) * 24,
        cpx: midX + (Math.random() - 0.5) * 520,
        cpy: midY + (Math.random() - 0.5) * 380 - 80,
        ex: ex + (Math.random() - 0.5) * 24,
        ey: ey + (Math.random() - 0.5) * 12,
        delay: i * 55,          // ms stagger
        hue: 38 + Math.random() * 26, // gold → amber
      };
    });

    function ease(t: number) { return 1 - Math.pow(1 - t, 3); }
    function bez(t: number, p0: number, p1: number, p2: number) {
      return (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
    }

    let startTime: number | null = null;

    function frame(ts: number) {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      const globalT = Math.min(elapsed / DURATION, 1);

      // Update overlay countdown via direct DOM (no React re-render)
      if (labelRef.current) {
        labelRef.current.textContent = `$${(cost * (1 - globalT)).toFixed(4)}`;
      }

      // Dispatch header tick
      window.dispatchEvent(new CustomEvent('costProgress', {
        detail: { value: prevTotal + cost * globalT },
      }));

      // Draw particles
      ctx.clearRect(0, 0, safeCanvas.width, safeCanvas.height);
      for (const p of particles) {
        const pElapsed = elapsed - p.delay;
        if (pElapsed <= 0) continue;
        const pt = Math.min(pElapsed / (DURATION * 0.82), 1);
        const e = ease(pt);

        const x = bez(e, p.sx, p.cpx, p.ex);
        const y = bez(e, p.sy, p.cpy, p.ey);

        // Fade out in last 30% of particle life
        const alpha = pt < 0.7 ? 1 : (1 - pt) / 0.3;
        const r = Math.max(0.5, (1 - pt * 0.55) * 5);

        // Core dot
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${p.hue}, 100%, 62%)`;
        ctx.fill();

        // Soft glow
        ctx.globalAlpha = Math.max(0, alpha * 0.35);
        ctx.beginPath();
        ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${p.hue}, 100%, 75%)`;
        ctx.fill();
        ctx.restore();
      }

      if (globalT < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        // Done
        ctx.clearRect(0, 0, safeCanvas.width, safeCanvas.height);
        safeContainer.style.display = 'none';
        busyRef.current = false;
        rafRef.current = null;
        window.dispatchEvent(new CustomEvent('costComplete', { detail: { newTotal } }));
      }
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  }

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 pointer-events-none"
      style={{ display: 'none' }}
    >
      {/* Canvas for particles — covers full screen */}
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Centered overlay card */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/55 rounded-2xl px-10 py-6 flex flex-col items-center gap-2 backdrop-blur-[2px]">
        <p className="text-white/70 text-[10px] font-semibold tracking-[0.2em] uppercase">Task complete</p>
        <span ref={labelRef} className="text-amber-400 text-2xl font-bold tabular-nums">$0.0000</span>
      </div>
    </div>,
    document.body
  );
}

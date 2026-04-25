import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const DURATION = 2500;       // total animation ms
const MISSILE_COUNT = 20;
const MISSILE_TRAVEL = 1100; // ms each missile flies

export default function CostFlash() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    function handler(e: Event) {
      const { cost, prevTotal, newTotal } =
        (e as CustomEvent<{ cost: number; prevTotal: number; newTotal: number }>).detail;
      if (cost < 0.000001) return;
      if (busyRef.current) {
        window.dispatchEvent(new CustomEvent('costComplete', { detail: { newTotal } }));
        return;
      }
      start(cost, prevTotal, newTotal);
    }
    window.addEventListener('costIncurred', handler);
    return () => window.removeEventListener('costIncurred', handler);
  }, []);

  function addTrail(x: number, y: number) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;left:${x}px;top:${y}px;
      transform:translate(-50%,-50%);
      width:5px;height:5px;border-radius:50%;
      background:rgba(102,224,255,0.55);
      pointer-events:none;z-index:9999;
      transition:opacity 0.35s linear,transform 0.35s linear;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-50%) scale(0.3)';
    });
    setTimeout(() => el.remove(), 380);
  }

  function launchMissile(sx: number, sy: number, ex: number, ey: number, delay: number) {
    const tid = window.setTimeout(() => {
      const el = document.createElement('div');
      el.style.cssText = `
        position:fixed;left:${sx}px;top:${sy}px;
        transform:translate(-50%,-50%);
        width:7px;height:7px;border-radius:50%;
        background:#66e0ff;
        box-shadow:0 0 6px rgba(102,224,255,0.9),0 0 14px rgba(102,224,255,0.45);
        pointer-events:none;z-index:9999;
      `;
      document.body.appendChild(el);

      const dx = ex - sx;
      const dy = ey - sy;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const curve = (Math.random() - 0.5) * 300;
      const cpx = sx + dx * 0.5 + nx * curve;
      const cpy = sy + dy * 0.5 + ny * curve;

      const t0 = performance.now();
      let tick = 0;

      function animate(now: number) {
        const t = Math.min((now - t0) / MISSILE_TRAVEL, 1);
        const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cpx + t ** 2 * ex;
        const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cpy + t ** 2 * ey;

        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.opacity = t > 0.75 ? String(1 - (t - 0.75) / 0.25) : '1';

        tick++;
        if (tick % 2 === 0) addTrail(x, y);

        if (t < 1) requestAnimationFrame(animate);
        else el.remove();
      }
      requestAnimationFrame(animate);
    }, delay);
    timeoutsRef.current.push(tid);
  }

  function start(cost: number, prevTotal: number, newTotal: number) {
    const container = containerRef.current;
    if (!container) return;
    const safeContainer: HTMLDivElement = container;

    // Cancel any pending missiles from a previous (interrupted) run
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];

    busyRef.current = true;
    safeContainer.style.display = 'block';

    const sx = window.innerWidth / 2;
    const sy = window.innerHeight / 2;
    const ex = window.innerWidth - 90; // near header cost badge
    const ey = 22;

    // Stagger all missiles over the first 65% of the duration
    const spread = DURATION * 0.65;
    for (let i = 0; i < MISSILE_COUNT; i++) {
      const delay = MISSILE_COUNT === 1 ? 0 : (i / (MISSILE_COUNT - 1)) * spread;
      launchMissile(sx, sy, ex, ey, delay);
    }

    // Number countdown via RAF — also drives the header update
    let t0: number | null = null;
    function frame(ts: number) {
      if (!t0) t0 = ts;
      const globalT = Math.min((ts - t0) / DURATION, 1);

      if (labelRef.current) {
        labelRef.current.textContent = `$${(cost * (1 - globalT)).toFixed(4)}`;
      }
      window.dispatchEvent(new CustomEvent('costProgress', {
        detail: { value: prevTotal + cost * globalT },
      }));

      if (globalT < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
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
      {/* Centered overlay card */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/55 rounded-2xl px-10 py-6 flex flex-col items-center gap-2 backdrop-blur-[2px]">
        <p className="text-white/70 text-[10px] font-semibold tracking-[0.2em] uppercase">Task complete</p>
        <span ref={labelRef} className="text-cyan-400 text-2xl font-bold tabular-nums">$0.0000</span>
      </div>
    </div>,
    document.body
  );
}

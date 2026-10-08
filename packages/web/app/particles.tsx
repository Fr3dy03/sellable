'use client';

import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  phase: number;
  speed: number;
  base: number;
  color: string;
}

const COLORS = ['196,176,138', '214,196,158', '176,154,112', '255,255,255'];

export default function Particles() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let particles: Particle[] = [];
    let raf = 0;
    let w = 0;
    let h = 0;
    let t = 0;

    const spawn = (p: Particle, edgeOnly = false): void => {
      p.x = Math.random() * w;
      p.y = edgeOnly ? h + Math.random() * 40 : Math.random() * h;
      p.r = 0.6 + Math.random() * 1.7;
      p.vx = (Math.random() - 0.5) * 0.12;
      p.vy = -(0.04 + Math.random() * 0.14);
      p.phase = Math.random() * Math.PI * 2;
      p.speed = 0.004 + Math.random() * 0.008;
      p.base = 0.12 + Math.random() * 0.33;
      p.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(Math.round((w * h) / 20000), 110);
      particles = Array.from({ length: count }, () => {
        const p = {} as Particle;
        spawn(p);
        return p;
      });
    };

    const draw = (animate: boolean): void => {
      if (animate) t += 1;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        if (animate) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.y < -6 || p.x < -6 || p.x > w + 6) spawn(p, true);
        }
        const alpha = animate
          ? p.base * (0.55 + 0.45 * Math.sin(p.phase + t * p.speed))
          : p.base * 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color},${alpha.toFixed(3)})`;
        ctx.fill();
      }
    };

    const loop = (): void => {
      draw(true);
      raf = requestAnimationFrame(loop);
    };

    const onResize = (): void => {
      resize();
      if (reduced) draw(false);
    };

    resize();
    if (reduced) draw(false);
    else raf = requestAnimationFrame(loop);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className="particles" aria-hidden="true" />;
}

import * as THREE from 'three';
import type { MachineState } from '../../../shared/protocol';
import { officeFull } from '../../../shared/machine';

const FONT = 'Tahoma, Arial, sans-serif';
const INK = '#20342e';
const MUTED = '#b5c8bd';

/** Green while there's room, amber when it's getting full, red from where hiring gets a warning. */
export function loadColor(pct: number): string {
  return pct >= 90 ? '#ef476f' : pct >= 70 ? '#ffd166' : '#06d6a0';
}

export function fmtGb(bytes: number): string {
  const gb = bytes / 2 ** 30;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/**
 * The machine monitor on the west wall: how busy the CPU and memory are, with the last few minutes
 * of each, and how many workers the office runs of the most it takes.
 */
export class MachineTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    // The screen's own shape (MACHINE_MONITOR is 2.3 × 1.3 m).
    this.canvas.width = 920;
    this.canvas.height = 520;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(s: MachineState) {
    const key = JSON.stringify(s);
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = INK;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.direction = 'rtl';

    // Header: what this is, and whether there's room for another worker.
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = `900 40px ${FONT}`;
    g.fillText('وضعیت رایانه', 30, 62);
    const full = officeFull(s);
    const status = !s.memTotal ? ['…', MUTED] : s.pressure ? ['فشار بالا', '#ef476f'] : full ? ['ظرفیت تکمیل', '#ffd166'] : ['ظرفیت آزاد', '#06d6a0'];
    g.font = `800 30px ${FONT}`;
    const tw = g.measureText(status[0]).width;
    g.fillStyle = status[1];
    roundRect(g, W - 30 - tw - 32, 24, tw + 32, 50, 25);
    g.fill();
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.fillText(status[0], W - 30 - (tw + 32) / 2, 60);

    const memPct = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
    this.panel(30, 100, 415, 'CPU', s.cpu, s.cores ? `${s.cores.toLocaleString('fa-IR')} هسته` : '', s.history.map(([c]) => c));
    this.panel(475, 100, 415, 'حافظه', memPct, s.memTotal ? `${fmtGb(s.memUsed)} / ${fmtGb(s.memTotal)}` : '', s.history.map(([, m]) => m));

    // Footer: the workers, one pip each, against the limit.
    const y = 440;
    g.textAlign = 'left';
    g.font = `800 32px ${FONT}`;
    g.fillStyle = '#ffffff';
    const label = s.limit === undefined ? `${s.workers.toLocaleString('fa-IR')} ایجنت · بدون سقف` : `${s.workers.toLocaleString('fa-IR')} ایجنت از سقف ${s.limit.toLocaleString('fa-IR')}`;
    g.direction = 'rtl';
    g.fillText(label, 30, y + 12);
    if (s.limit !== undefined) {
      const x0 = 30 + g.measureText(label).width + 28;
      const room = W - 30 - x0;
      const pip = Math.min(34, room / Math.max(s.limit, s.workers));
      for (let i = 0; i < Math.max(s.limit, s.workers); i++) {
        g.fillStyle = i >= s.limit ? '#ef476f' : i < s.workers ? (full ? '#ffd166' : '#06d6a0') : '#3a3d55';
        roundRect(g, x0 + i * pip, y - 14, Math.max(2, pip - 6), 30, Math.min(8, pip / 3));
        g.fill();
      }
    }
    this.texture.needsUpdate = true;
  }

  /** One gauge: its name, the percent now, a line under it, and the last few minutes as a filled graph. */
  private panel(x: number, y: number, w: number, name: string, pct: number, sub: string, history: number[]) {
    const g = this.ctx;
    const color = loadColor(pct);
    g.fillStyle = '#2b443b';
    roundRect(g, x, y, w, 300, 18);
    g.fill();
    g.textAlign = 'left';
    g.fillStyle = MUTED;
    g.font = `800 28px ${FONT}`;
    g.direction = /[\u0600-\u06ff]/.test(name) ? 'rtl' : 'ltr';
    g.fillText(name, x + 20, y + 42);
    g.fillStyle = color;
    g.font = `900 84px ${FONT}`;
    g.direction = 'ltr';
    g.fillText(`${pct}%`, x + 20, y + 124);
    g.fillStyle = MUTED;
    g.font = `700 24px ${FONT}`;
    g.direction = /[\u0600-\u06ff]/.test(sub) ? 'rtl' : 'ltr';
    g.fillText(sub, x + 20, y + 160);
    // The graph: 0-100%, the newest reading on the right.
    const gx = x + 20;
    const gy = y + 180;
    const gw = w - 40;
    const gh = 100;
    // The 90% line: past it, hiring comes with a warning.
    g.strokeStyle = '#3a3d55';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(gx, gy + gh * 0.1);
    g.lineTo(gx + gw, gy + gh * 0.1);
    g.stroke();
    if (history.length < 2) return;
    const step = gw / (history.length - 1);
    const at = (i: number) => [gx + i * step, gy + gh - (Math.max(0, Math.min(100, history[i])) / 100) * gh] as const;
    g.beginPath();
    g.moveTo(gx, gy + gh);
    for (let i = 0; i < history.length; i++) g.lineTo(...at(i));
    g.lineTo(gx + gw, gy + gh);
    g.closePath();
    g.globalAlpha = 0.28;
    g.fillStyle = color;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    for (let i = 0; i < history.length; i++) (i ? g.lineTo : g.moveTo).call(g, ...at(i));
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.stroke();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

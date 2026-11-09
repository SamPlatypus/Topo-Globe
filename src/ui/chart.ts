/** Elevation profile chart (canvas), sized to its container, high contrast for daylight. */
import { fmtDist, fmtElev } from './format';

export interface ProfileData { dist: Float64Array; elev: Float64Array }

export function drawProfile(canvas: HTMLCanvasElement, p: ProfileData, marker: number | null = null): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 320;
  const H = canvas.clientHeight || 150;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  const n = p.dist.length;
  if (n < 2) return;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) { const e = p.elev[i]; if (e === e) { if (e < mn) mn = e; if (e > mx) mx = e; } }
  if (!Number.isFinite(mn)) {
    g.fillStyle = '#333';
    g.font = '16px sans-serif';
    g.fillText('No elevation data here (outside loaded regions)', 10, H / 2);
    return;
  }
  const span = Math.max(20, mx - mn);
  const lo = mn - span * 0.08, hi = mx + span * 0.12;
  const L = 52, R = 10, T = 10, B = 26;
  const total = p.dist[n - 1] || 1;
  const X = (d: number) => L + ((W - L - R) * d) / total;
  const Y = (e: number) => T + (H - T - B) * (1 - (e - lo) / (hi - lo));
  // grid lines
  g.strokeStyle = '#d0d0d0';
  g.lineWidth = 1;
  g.fillStyle = '#222';
  g.font = '13px sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Y(v);
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    g.fillText(`${Math.round(v)}`, L - 6, y);
  }
  // area
  g.beginPath();
  g.moveTo(X(0), Y(lo));
  for (let i = 0; i < n; i++) if (p.elev[i] === p.elev[i]) g.lineTo(X(p.dist[i]), Y(p.elev[i]));
  g.lineTo(X(total), Y(lo));
  g.closePath();
  g.fillStyle = '#c9b48f';
  g.fill();
  g.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    if (p.elev[i] !== p.elev[i]) { started = false; continue; }
    const x = X(p.dist[i]), y = Y(p.elev[i]);
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.strokeStyle = '#4a2c00';
  g.lineWidth = 2.5;
  g.stroke();
  // x axis labels
  g.fillStyle = '#222';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText('0', L, H - B + 6);
  g.textAlign = 'right';
  g.fillText(fmtDist(total), W - R, H - B + 6);
  g.textAlign = 'left';
  g.fillText('m', 4, T);
  if (marker !== null) {
    const x = X(p.dist[marker]);
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke();
    g.fillStyle = '#000';
    g.textAlign = x > W / 2 ? 'right' : 'left';
    g.fillText(`${fmtDist(p.dist[marker])} · ${fmtElev(p.elev[marker])}`, x + (x > W / 2 ? -6 : 6), T + 2);
  }
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/** index of the sample nearest to a chart x position */
export function profileIndexAt(canvas: HTMLCanvasElement, p: ProfileData, clientX: number): number {
  const r = canvas.getBoundingClientRect();
  const L = 52, R = 10;
  const total = p.dist[p.dist.length - 1] || 1;
  const d = ((clientX - r.left - L) / (r.width - L - R)) * total;
  let best = 0;
  for (let i = 1; i < p.dist.length; i++) if (Math.abs(p.dist[i] - d) < Math.abs(p.dist[best] - d)) best = i;
  return best;
}

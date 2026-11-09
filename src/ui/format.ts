import { gridRef, zoneFor } from '../shared/geo/mga';

export function fmtDist(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(2)} km`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function fmtElev(m: number): string {
  return Number.isFinite(m) ? `${Math.round(m)} m` : '–';
}

export function fmtArea(a: number): string {
  if (a < 10000) return `${Math.round(a).toLocaleString('en-AU')} m²`;
  if (a < 1e6) return `${(a / 10000).toFixed(2)} ha`;
  return `${(a / 1e6).toFixed(2)} km² (${Math.round(a / 10000).toLocaleString('en-AU')} ha)`;
}

export function deg360(a: number): number {
  const b = a % 360;
  return b < 0 ? b + 360 : b;
}

export function fmtBearing(trueAz: number, decl: number, conv?: number): string {
  const t = Math.round(deg360(trueAz)) % 360;
  const m = Math.round(deg360(trueAz - decl)) % 360;
  let s = `${pad3(t)}° true · ${pad3(m)}° magnetic`;
  if (conv !== undefined) s += ` · ${pad3(Math.round(deg360(trueAz - conv)) % 360)}° grid`;
  return s;
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}

export function fmtDecl(d: number): string {
  return `${Math.abs(d).toFixed(1)}° ${d >= 0 ? 'E' : 'W'}`;
}

export function dms(v: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mf = (a - d) * 60;
  const m = Math.floor(mf);
  const s = (mf - m) * 60;
  return `${d}°${m.toString().padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v < 0 ? neg : pos}`;
}

export function fmtLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
}

export function fmtDms(lat: number, lon: number): string {
  return `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}`;
}

export function fmtGrid(lat: number, lon: number, zoneSetting: 'auto' | 54 | 55): { full: string; ref: string; ref8: string; zone: number; convergence: number } {
  const zone = zoneSetting === 'auto' ? zoneFor(lon) : zoneSetting;
  const g = gridRef(lat, lon, zone);
  return { full: g.full, ref: g.ref6, ref8: g.ref8, zone, convergence: g.convergence };
}

export function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

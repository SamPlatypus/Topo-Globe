/**
 * Custom tile protocols.  MapLibre asks for topo-dem://z/x/y etc.; the request
 * is answered by our own workers from the loaded region files.  These URLs
 * never reach the network stack.
 */
import { addProtocol } from 'maplibre-gl';
import type { WorkerPool } from '../app/workers';

export function registerProtocols(pool: WorkerPool): void {
  const tileArgs = (url: string) => {
    const m = /^[a-z-]+:\/\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    if (!m) throw new Error('bad tile url ' + url);
    return { z: +m[1], x: +m[2], y: +m[3] };
  };
  const image = (kind: 'dem' | 'slope') => async (params: { url: string }, ac: AbortController) => {
    const t = tileArgs(params.url);
    const bmp = await pool.tile<ImageBitmap | null>({ type: 'tile', kind, ...t }, ac.signal);
    if (!bmp) throw new Error('cancelled');
    return { data: bmp };
  };
  const vector = (kind: 'contour' | 'vec') => async (params: { url: string }, ac: AbortController) => {
    const t = tileArgs(params.url);
    const buf = await pool.tile<ArrayBuffer | null>({ type: 'tile', kind, ...t }, ac.signal);
    return { data: buf ?? new ArrayBuffer(0) };
  };
  addProtocol('topo-dem', image('dem'));
  addProtocol('topo-slope', image('slope'));
  addProtocol('topo-contour', vector('contour'));
  addProtocol('topo-vec', vector('vec'));
}

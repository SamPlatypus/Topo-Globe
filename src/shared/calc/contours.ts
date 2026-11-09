/**
 * Marching squares contouring on a regular grid.
 *
 * Crossing points are linearly interpolated along cell edges (consistent with
 * bilinear interpolation of the grid) and saddle cells are resolved with the
 * cell-centre average (the bilinear "asymptotic decider" at the centre).
 * Segments are stitched into polylines through shared edge crossings, so
 * adjacent tiles that share grid samples produce lines that meet exactly.
 */
export interface ContourLine {
  level: number;
  /** grid coordinates (col, row) interleaved */
  pts: number[];
  closed: boolean;
}

/**
 * @param grid  row-major values (NaN = no data)
 * @param w,h   grid size
 * @param levels  contour levels (metres)
 */
export function marchingSquares(grid: Float32Array, w: number, h: number, levels: number[]): ContourLine[] {
  const out: ContourLine[] = [];
  // edge ids: horizontal edge (r, c)->(r, c+1): id = (r*w + c)*2; vertical (r,c)->(r+1,c): +1
  for (const level of levels) {
    const segA: number[] = []; // pairs of edge ids
    let any = false;
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const i = r * w + c;
        const tl = grid[i], tr = grid[i + 1], bl = grid[i + w], br = grid[i + w + 1];
        if (tl !== tl || tr !== tr || bl !== bl || br !== br) continue; // NaN
        let idx = 0;
        if (tl >= level) idx |= 8;
        if (tr >= level) idx |= 4;
        if (br >= level) idx |= 2;
        if (bl >= level) idx |= 1;
        if (idx === 0 || idx === 15) continue;
        any = true;
        const top = i * 2; // horizontal edge at row r
        const bottom = (i + w) * 2; // horizontal edge at row r+1
        const left = i * 2 + 1; // vertical edge at col c
        const right = (i + 1) * 2 + 1; // vertical edge at col c+1
        switch (idx) {
          case 1: case 14: segA.push(left, bottom); break;
          case 2: case 13: segA.push(bottom, right); break;
          case 3: case 12: segA.push(left, right); break;
          case 4: case 11: segA.push(top, right); break;
          case 6: case 9: segA.push(top, bottom); break;
          case 7: case 8: segA.push(left, top); break;
          case 5: case 10: {
            const centre = (tl + tr + bl + br) / 4;
            const centreHigh = centre >= level;
            // idx 5: tr & bl high; idx 10: tl & br high
            if ((idx === 5) === centreHigh) { segA.push(left, top, bottom, right); }
            else { segA.push(left, bottom, top, right); }
            break;
          }
        }
      }
    }
    if (!any) continue;
    // stitch: adjacency via edge ids (each edge id appears at most twice)
    const nseg = segA.length / 2;
    const first = new Map<number, number>();
    const second = new Map<number, number>();
    for (let s = 0; s < nseg; s++) {
      for (let k = 0; k < 2; k++) {
        const e = segA[s * 2 + k];
        if (first.has(e)) second.set(e, s); else first.set(e, s);
      }
    }
    const used = new Uint8Array(nseg);
    const point = (e: number, out: number[]) => {
      const cell = e >> 1;
      const r = Math.floor(cell / w);
      const c = cell - r * w;
      if ((e & 1) === 0) {
        const a = grid[cell], b = grid[cell + 1];
        const t = a === b ? 0.5 : (level - a) / (b - a);
        out.push(c + t, r);
      } else {
        const a = grid[cell], b = grid[cell + w];
        const t = a === b ? 0.5 : (level - a) / (b - a);
        out.push(c, r + t);
      }
    };
    const otherSeg = (e: number, s: number) => {
      const s1 = first.get(e);
      const s2 = second.get(e);
      return s1 === s ? (s2 ?? -1) : (s1 ?? -1);
    };
    const otherEdge = (s: number, e: number) => (segA[s * 2] === e ? segA[s * 2 + 1] : segA[s * 2]);
    for (let s0 = 0; s0 < nseg; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const e0 = segA[s0 * 2];
      const fwd = [e0, segA[s0 * 2 + 1]];
      let cur = s0;
      let e = fwd[1];
      for (;;) {
        const nx = otherSeg(e, cur);
        if (nx < 0 || used[nx]) break;
        used[nx] = 1;
        e = otherEdge(nx, e);
        fwd.push(e);
        cur = nx;
      }
      let edges = fwd;
      let closed = false;
      if (fwd.length > 2 && fwd[fwd.length - 1] === e0) closed = true;
      else if (fwd.length > 2 && otherSeg(fwd[fwd.length - 1], cur) === s0) {
        closed = true;
        fwd.push(e0);
      } else {
        const bwd: number[] = [];
        cur = s0;
        e = e0;
        for (;;) {
          const nx = otherSeg(e, cur);
          if (nx < 0 || used[nx]) break;
          used[nx] = 1;
          e = otherEdge(nx, e);
          bwd.push(e);
          cur = nx;
        }
        if (bwd.length) edges = bwd.reverse().concat(fwd);
      }
      const pts: number[] = [];
      for (const ed of edges) point(ed, pts);
      out.push({ level, pts, closed });
    }
  }
  return out;
}

/** Douglas-Peucker on interleaved coordinates (tolerance in the same units). */
export function simplifyLine(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 2 || tol <= 0) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = tol * tol;
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[2 * k] - ax, py = pts[2 * k + 1] - ay;
      let d2: number;
      if (L2 === 0) d2 = px * px + py * py;
      else {
        let t = (px * dx + py * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > best) { best = d2; bi = k; }
    }
    if (best > tol2) {
      keep[bi] = 1;
      stack.push(i, bi, bi, j);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[2 * k], pts[2 * k + 1]);
  return out;
}

/** Contour interval (minor) and index (major) interval for a map zoom. Minor lines drop out as you zoom out. */
export function contourIntervals(z: number): { minor: number; major: number } | null {
  if (z >= 14) return { minor: 10, major: 50 };
  if (z >= 13) return { minor: 20, major: 100 };
  if (z >= 12) return { minor: 50, major: 250 };
  if (z >= 11) return { minor: 100, major: 500 };
  if (z >= 10) return { minor: 200, major: 1000 };
  return null;
}

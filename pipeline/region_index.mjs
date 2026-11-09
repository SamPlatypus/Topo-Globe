// Write (or merge) a JSON index of region files: id, name, file, bytes, sha256.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--merge') {
  const a = JSON.parse(readFileSync(args[1], 'utf8'));
  const b = JSON.parse(readFileSync(args[2], 'utf8'));
  const map = new Map((a.regions ?? []).map((r) => [r.id, r]));
  for (const r of b.regions) map.set(r.id, r);
  console.log(JSON.stringify({ updated: new Date().toISOString(), regions: [...map.values()].sort((x, y) => x.id.localeCompare(y.id)) }, null, 2));
} else {
  const dir = args[0];
  const regions = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.topo')).sort()) {
    const buf = readFileSync(join(dir, f));
    const jsonLen = buf.readUInt32LE(8);
    const meta = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
    regions.push({
      id: meta.id, name: meta.name, file: f, bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'), created: meta.created,
      counts: meta.vec.counts, demMaxErrorM: meta.dem.maxErrorM, sources: meta.sources,
    });
  }
  console.log(JSON.stringify({ updated: new Date().toISOString(), regions }, null, 2));
}

/**
 * Builds the GitHub Pages download page (static HTML, no external resources).
 * Keeps the newest 8 test APKs and the newest 3 done-check reports.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const site = args.site;
mkdirSync(join(site, 'apk'), { recursive: true });
mkdirSync(join(site, 'donecheck'), { recursive: true });
const manifestPath = join(site, 'builds.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { builds: [] };

// ---- new APK
const apkSrcDir = args.apk;
const apkName = readdirSync(apkSrcDir).find((f) => f.endsWith('.apk'));
const apkBuf = readFileSync(join(apkSrcDir, apkName));
cpSync(join(apkSrcDir, apkName), join(site, 'apk', apkName));
const readResults = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).results; } catch { return null; }
};
const copyReport = (dir, kind) => {
  if (!dir || !existsSync(dir)) return [];
  const out = join(site, 'donecheck', args.version, kind);
  mkdirSync(out, { recursive: true });
  const shots = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  for (const f of [...shots, 'results.json']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(out, f));
  return shots.map((f) => `donecheck/${args.version}/${kind}/${f}`);
};
const build = {
  version: args.version, file: `apk/${apkName}`, bytes: apkBuf.length,
  sha256: createHash('sha256').update(apkBuf).digest('hex'), date: new Date().toISOString(),
  commit: args.commit, branch: args.branch, run: args.run,
  android: { status: args['android-status'], results: readResults(args.android), shots: copyReport(args.android, 'android') },
  browser: { status: args['browser-status'], results: readResults(args.browser), shots: copyReport(args.browser, 'browser') },
};
manifest.builds = [build, ...manifest.builds.filter((b) => b.version !== build.version)];
// prune
const keepApks = new Set(manifest.builds.slice(0, 8).map((b) => b.file));
for (const f of readdirSync(join(site, 'apk'))) if (!keepApks.has(`apk/${f}`)) rmSync(join(site, 'apk', f));
manifest.builds = manifest.builds.filter((b) => keepApks.has(b.file));
const keepReports = new Set(manifest.builds.slice(0, 3).map((b) => b.version));
for (const d of readdirSync(join(site, 'donecheck'))) if (!keepReports.has(d)) rmSync(join(site, 'donecheck', d), { recursive: true, force: true });
for (const b of manifest.builds) if (!keepReports.has(b.version)) { b.android.shots = []; b.browser.shots = []; }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---- regions
let regions = [];
try { regions = JSON.parse(readFileSync(args.regions, 'utf8')).regions ?? []; } catch { /* none yet */ }

// ---- HTML
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const latest = manifest.builds[0];
const resultList = (r) => r ? `<ul class="res">${r.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><b>${x.ok ? 'PASS' : 'FAIL'}</b> ${esc(x.name)}${x.detail ? `<br><small>${esc(x.detail)}</small>` : ''}</li>`).join('')}</ul>` : '<p>No results.</p>';
const shots = (list) => list.length ? `<div class="shots">${list.map((s) => `<a href="${s}"><img src="${s}" alt="${esc(basename(s))}" loading="lazy"><span>${esc(basename(s, '.png').replace(/^\d+-/, '').replace(/-/g, ' '))}</span></a>`).join('')}</div>` : '';
const relUrl = (f) => `https://github.com/${args.repo}/releases/download/${args.tag}/${f}`;
const html = `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Topo Globe – test builds</title>
<style>
:root{color-scheme:light}body{margin:0;font:18px/1.45 system-ui,Roboto,sans-serif;color:#111;background:#f4f1e8}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:28px;margin:8px 0}h2{margin:28px 0 8px;font-size:22px}
.card{background:#fff;border:3px solid #111;border-radius:16px;padding:14px 16px;margin:12px 0;overflow-wrap:anywhere}
.btn{display:block;text-align:center;background:#b23c00;color:#fff;font-weight:800;font-size:22px;padding:18px;border-radius:14px;text-decoration:none;border:3px solid #111}
small,.muted{color:#333;font-size:15px}code{font-size:14px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 4px;border-bottom:1px solid #ccc;vertical-align:top}
.res{list-style:none;padding:0;margin:0}.res li{padding:6px 0;border-bottom:1px solid #ddd}.ok b{color:#0a6b2d}.bad b{color:#b00020}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.shots a{color:#111;text-decoration:none;font-size:14px}
.shots img{width:100%;border:2px solid #111;border-radius:8px;background:#000}
ol li{margin:6px 0}
</style></head><body><main>
<h1>Topo Globe – offline topo maps of Victoria</h1>
<p class="muted">Android test builds. The app has no internet permission and makes no network calls. by @SamAndNinjaCat</p>
<div class="card">
<a class="btn" href="${latest.file}" download>Download test APK ${esc(latest.version)} (${mb(latest.bytes)})</a>
<p><small>Built ${esc(latest.date.slice(0, 16).replace('T', ' '))} UTC from <code>${esc(latest.branch)}</code> @ <code>${esc(latest.commit?.slice(0, 10))}</code> · <a href="${esc(latest.run)}">build log</a><br>SHA-256 <code>${latest.sha256}</code></small></p>
</div>
<h2>Region files</h2>
<div class="card">${regions.length ? `<table><tr><th>Region</th><th>Size</th></tr>${regions.map((r) => `<tr><td><a href="${relUrl(r.file)}">${esc(r.file)}</a><br><small>${esc(r.id)} · ${esc(r.name)} · built ${esc((r.created || '').slice(0, 10))}</small></td><td>${mb(r.bytes)}<br><small>${(r.bytes).toLocaleString('en-AU')} bytes</small></td></tr>`).join('')}</table>` : '<p>No region files released yet.</p>'}
<p><small>Each region covers 1° × 1° (about 88 × 111 km). Download it on the phone, then in Topo Globe tap the three dots → <b>Add region</b> and pick the file.</small></p></div>
<h2>Install and check</h2>
<div class="card"><ol>
<li>Download the APK above on the phone and open it (allow installing from your browser if Android asks). Newer test builds install over older ones and keep your regions and waypoints.</li>
<li>Download the region file(s) too.</li>
<li>Turn on <b>airplane mode</b>. Keep Location on (Quick Settings).</li>
<li>Open Topo Globe: it opens on the globe with the menu open; tap anywhere to fold it to the three dots.</li>
<li>Three dots → <b>Add region</b> → pick <code>vic_S38E145.topo</code>. Tap the orange square on the globe to fly into 3D terrain; 10 m contours appear as you zoom in.</li>
<li>Three dots → <b>My location</b>. Without phone signal the first fix can take several minutes outdoors.</li>
<li><b>Drop waypoint</b>, <b>Measure line &amp; profile</b> (tap points), <b>Plan walking route</b> (tap a destination).</li>
<li>Restart the phone, open Topo Globe: Three dots → Waypoints – your waypoint is still there.</li>
</ol></div>
<h2>Automated done-check for ${esc(latest.version)}</h2>
<div class="card"><h3>Android emulator (airplane mode, real file picker, reboot) – ${esc(latest.android.status || 'not run')}</h3>${resultList(latest.android.results)}${shots(latest.android.shots)}</div>
<div class="card"><h3>Desktop browser, phone-sized, all network blocked – ${esc(latest.browser.status || 'not run')}</h3>${resultList(latest.browser.results)}${shots(latest.browser.shots)}</div>
<h2>Earlier test builds</h2>
<div class="card"><table>${manifest.builds.slice(1).map((b) => `<tr><td><a href="${b.file}">${esc(b.version)}</a><br><small>${esc(b.date.slice(0, 10))} · ${esc(b.commit?.slice(0, 10))}</small></td><td>${mb(b.bytes)}</td><td><small>android: ${esc(b.android.status)}<br>browser: ${esc(b.browser.status)}</small></td></tr>`).join('') || '<tr><td>None yet.</td></tr>'}</table></div>
<h2>Data credits</h2>
<div class="card"><p><small>Roads, tracks, paths and POIs © OpenStreetMap contributors, Open Database Licence (ODbL) 1.0 – openstreetmap.org/copyright. Region files are a derived database, also under the ODbL.</small></p>
<p><small>Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</small></p>
<p><small>Vicmap Hydro © State of Victoria (Department of Transport and Planning), CC BY 4.0.</small></p>
<p><small>World Magnetic Model WMM2025 (NOAA NCEI / BGS). Natural Earth (public domain).</small></p></div>
</main></body></html>
`;
writeFileSync(join(site, 'index.html'), html);
console.log(`site: ${manifest.builds.length} builds, latest ${latest.version}, ${regions.length} regions`);

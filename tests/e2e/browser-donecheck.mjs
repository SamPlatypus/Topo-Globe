/**
 * Browser done-check (desktop Chromium, phone-sized, all non-local network blocked).
 *
 *   node tests/e2e/browser-donecheck.mjs <dist-url> <region.topo> <out-dir>
 *
 * Steps mirror the phone done-check: globe -> region loads -> terrain + 10 m
 * contours -> GPS fix -> waypoint -> measured line with elevation profile ->
 * walking route -> restart (persistent profile) -> waypoint still there.
 * Fails (exit 1) on any network request to another origin.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || import.meta.url);
const { chromium } = require('playwright');
const [url = 'http://127.0.0.1:4173/', regionFile, outDir = 'donecheck-browser'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const profileDir = join(outDir, 'profile');
rmSync(profileDir, { recursive: true, force: true });
const origin = new URL(url).origin;
const results = [];
const external = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' – ' + detail : ''}`);
};

async function open() {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: -37.8571, longitude: 145.3557, accuracy: 7 },
  });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    external.push(u);
    return route.abort();
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__map && window.__map.loaded !== undefined, null, { timeout: 60000 });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: join(outDir, name), timeout: 180000, animations: 'disabled' }).catch((e) => console.log('screenshot failed', name, e.message));
const tapMap = async (page, lon, lat) => {
  const p = await page.evaluate(([lo, la]) => { const q = window.__map.project([lo, la]); return { x: q.x, y: q.y }; }, [lon, lat]);
  await page.mouse.click(p.x, p.y);
};
const idle = (page, ms = 60000) => page.evaluate((t) => new Promise((res) => {
  const m = window.__map;
  const done = () => res(true);
  if (m.areTilesLoaded() && !m.isMoving()) setTimeout(done, 300); else m.once('idle', done);
  setTimeout(done, t);
}), ms);

let { ctx, page } = await open();
// 1. globe with welcome menu
await page.waitForTimeout(2500);
await shot(page, '01-welcome-menu.png');
check('menu open at launch with welcome line', await page.isVisible('.menu.open .welcome'));
await page.mouse.click(206, 200);
await page.waitForTimeout(800);
check('first tap folds the menu to the dots', !(await page.isVisible('.menu.open')) && (await page.isVisible('#dots')));
check('opens on the 3D globe', (await page.evaluate(() => window.__map.getProjection()?.type)) === 'globe' && (await page.evaluate(() => window.__map.getZoom())) < 3);
await shot(page, '02-globe.png');

// 2. add region through the file picker
await page.click('#dots');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="add-region"]')]);
await chooser.setFiles(regionFile);
await page.waitForFunction(() => window.__topo.regions.size > 0, null, { timeout: 120000 });
const reg = await page.evaluate(() => [...window.__topo.regions.values()].map((r) => `${r.id} ${r.name} ${(r.size / 1048576).toFixed(2)} MiB`));
check('region file loads', reg.length === 1, reg.join(', '));
await page.waitForTimeout(3000);
await shot(page, '03-region-loaded.png');

// 3. tap the region on the globe view -> flies into 3D terrain
await page.evaluate(() => window.__map.jumpTo({ center: [145.5, -37.5], zoom: 6.5, pitch: 0, bearing: 0 }));
await idle(page, 20000);
// software-rendered test browsers are slow: pin the quality level so the frame governor
// does not flatten the view to 2D during the flight (it would on a real slow phone)
await page.evaluate(() => window.__gov.pin(1));
await tapMap(page, 145.5, -37.5);
await page.waitForFunction(() => window.__map.getZoom() > 10.5 && !window.__map.isMoving(), null, { timeout: 60000 });
check('tapping the loaded region flies into the 3D map', (await page.evaluate(() => window.__map.getPitch())) > 40);
await page.evaluate(() => { window.__gov.pin(1); window.__map.jumpTo({ center: [145.355, -37.86], zoom: 14.2, pitch: 60, bearing: 30 }); });
await idle(page, 60000);
const t = await page.evaluate(() => {
  const m = window.__map;
  const contours = m.querySourceFeatures('contours', { sourceLayer: 'contours' });
  const levels = [...new Set(contours.map((f) => f.properties.ele))].sort((a, b) => a - b);
  return { terrain: !!m.getTerrain(), pitch: m.getPitch(), zoom: m.getZoom(), contours: contours.length, levels: levels.slice(0, 12), roads: m.querySourceFeatures('vec', { sourceLayer: 'roads' }).length };
});
check('3D terrain is on', t.terrain && t.pitch > 40, `pitch ${t.pitch.toFixed(0)}, zoom ${t.zoom.toFixed(1)}`);
const tenMetre = t.levels.length > 3 && t.levels.every((l) => l % 10 === 0) && t.levels.some((l) => l % 50 !== 0);
check('10 m contours drawn on the device', tenMetre, `${t.contours} contour features, levels ${t.levels.join(',')}`);
check('tracks and roads shown', t.roads > 0, `${t.roads} road/track features`);
await shot(page, '04-terrain-contours.png');

// 4. GPS fix – like a real receiver, the emulated GNSS reports a fix every second
let tick = 0;
const gnss = setInterval(() => {
  tick++;
  ctx.setGeolocation({ latitude: -37.8571 + (tick % 2) * 1e-7, longitude: 145.3557, accuracy: 7 }).catch(() => undefined);
}, 1000);
await page.click('#dots');
await page.click('[data-action="gps"]');
await page.waitForFunction(() => window.__topo.gps.fix && window.__topo.gps.fix.provider !== 'last-known', null, { timeout: 60000 });
const fix = await page.evaluate(() => window.__topo.gps.fix);
check('GPS gets a fix', !!fix, `±${Math.round(fix.accuracy)} m at ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`);
await page.waitForTimeout(3500);
const gpsFeatures = await page.evaluate(() => window.__map.getSource('gps')._data?.features?.length ?? window.__map.querySourceFeatures('gps').length);
check('accuracy circle and position drawn', gpsFeatures >= 2);
await shot(page, '05-gps-fix.png');

// 5. waypoint
await page.click('#dots');
await page.click('[data-action="waypoint"]');
await page.waitForFunction(() => window.__topo.waypoints.length === 1, null, { timeout: 20000 });
const wp = await page.evaluate(() => window.__topo.waypoints[0]);
check('waypoint drops', wp && wp.source === 'gps', `${wp.name} at ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}, ${wp.elev} m (${wp.source})`);
await page.waitForTimeout(1000);
await shot(page, '06-waypoint.png');

// 6. measured line with elevation profile
// (MapLibre zoom uses 512 px world tiles: at z12.6 one degree of longitude is ~8,800 px)
await page.evaluate(() => window.__map.jumpTo({ center: [145.355, -37.875], zoom: 12.6, pitch: 0, bearing: 0 }));
await idle(page, 30000);
await page.click('#dots');
await page.click('[data-action="measure"]');
await tapMap(page, 145.343, -37.858);
await page.waitForTimeout(500);
await tapMap(page, 145.355, -37.866);
await page.waitForTimeout(1500);
await tapMap(page, 145.367, -37.858);
await page.waitForFunction(() => {
  const m = window.__topo.measure;
  // wait for the profile of all three points (the previous two-point profile may still be showing)
  return m.pts.length === 3 && m.profile && m.profile.stats.distance > 2000;
}, null, { timeout: 60000 });
const prof = await page.evaluate(() => ({ n: window.__topo.measure.profile.dist.length, st: window.__topo.measure.profile.stats, text: document.querySelector('#sheet h2')?.textContent }));
check('measured line shows its elevation profile', prof.n > 50 && (await page.isVisible('#profile')),
  `${prof.text}; ${prof.n} samples; ↑${Math.round(prof.st.ascent)} m ↓${Math.round(prof.st.descent)} m; ${Math.round(prof.st.min)}–${Math.round(prof.st.max)} m`);
await shot(page, '07-measure-profile.png');
await page.click('[data-action="m-done"]');

// 7. walking route
await page.click('#dots');
await page.click('[data-action="route"]');
await page.waitForTimeout(500);
// start from GPS (pre-filled) and tap the destination
await tapMap(page, 145.3745, -37.8722);
await page.waitForFunction(() => window.__topo.route.result || document.querySelector('#sheet h2')?.textContent?.includes('No route'), null, { timeout: 120000 });
const route = await page.evaluate(() => ({ r: window.__topo.route.result && { pts: window.__topo.route.result.coords.length, s: window.__topo.route.result.seconds, legs: window.__topo.route.result.legs.slice(0, 5) }, h: document.querySelector('#sheet h2')?.textContent }));
check('walking route plans', !!route.r, `${route.h}; ${route.r?.pts} points; via ${route.r?.legs.map((l) => l.name || 'unnamed').join(' → ')}`);
await shot(page, '08-route.png');
await page.click('[data-action="r-done"]');

// 8. "reboot": close the browser profile completely and reopen it
clearInterval(gnss);
await ctx.close();
({ ctx, page } = await open());
await page.waitForTimeout(4000);
const after = await page.evaluate(() => ({ wps: window.__topo.waypoints.map((w) => w.name), regions: [...window.__topo.regions.keys()] }));
check('after a restart the waypoint is still there', after.wps.length === 1 && after.wps[0] === wp.name, `waypoints: ${after.wps.join(', ')}; regions: ${after.regions.join(', ')}`);
await page.mouse.click(206, 200); // first tap folds the welcome menu
await page.waitForTimeout(1200);
await page.click('#dots');
await page.click('[data-action="waypoints"]');
await page.waitForTimeout(500);
await shot(page, '09-after-restart-waypoints.png');
await ctx.close();

check('no network requests to other origins', external.length === 0, external.slice(0, 5).join(' '));
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, external }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);

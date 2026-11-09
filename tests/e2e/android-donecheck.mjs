/**
 * Android done-check on an emulator (run by GitHub Actions with KVM).
 *
 *   node tests/e2e/android-donecheck.mjs <app-debug.apk> <vic_S38E145.topo> <out-dir>
 *
 * With the phone in AIRPLANE MODE: the app opens to the globe, the region file
 * is chosen in the real Android file picker and loads, terrain and 10 m
 * contours show, GPS gets a fix (emulator GNSS), a waypoint drops, a measured
 * line shows its elevation profile, a walking route plans, and after a full
 * `adb reboot` the waypoint is still there.  Real touch input is sent with
 * `adb shell input tap`; the app state is read through the WebView's DevTools
 * protocol (debug build).  Screenshots are taken with screencap.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || import.meta.url);
const { _android: android } = require('playwright');
const [apk, region, outDir = 'donecheck-android'] = process.argv.slice(2);
const PKG = 'au.topoglobe.app';
mkdirSync(outDir, { recursive: true });
// whole-run watchdog: report what we have instead of hanging until the CI job timeout
setTimeout(() => {
  results.push({ name: 'done-check finished within 55 minutes', ok: false, detail: 'watchdog' });
  try { writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, when: new Date().toISOString() }, null, 2)); } catch { /* ignore */ }
  console.log('WATCHDOG: giving up after 55 minutes');
  process.exit(1);
}, 55 * 60 * 1000).unref();

const results = [];
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' – ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// every adb call is bounded so a hung command fails the step instead of stalling the job
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180000 }).trim();
const sh = (cmd) => adb('shell', cmd);
const log = (...a) => console.log(stamp(), '·', ...a);

function screencap(name) {
  try {
    const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20, timeout: 60000 });
    writeFileSync(join(outDir, name), png);
  } catch (e) {
    log('screencap failed', e.message);
  }
}

function uiDump() {
  try {
    sh('rm -f /sdcard/ui.xml; timeout 30 uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true');
    return sh('cat /sdcard/ui.xml 2>/dev/null || true');
  } catch {
    return '';
  }
}
function findNode(xml, pred) {
  const re = /<node [^>]*?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const n = m[0];
    const attr = (k) => (new RegExp(`${k}="([^"]*)"`).exec(n) || [])[1] ?? '';
    const node = { text: attr('text'), desc: attr('content-desc'), cls: attr('class'), id: attr('resource-id'), bounds: attr('bounds') };
    if (pred(node)) {
      const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(node.bounds);
      if (b) return { ...node, x: (+b[1] + +b[3]) / 2, y: (+b[2] + +b[4]) / 2, l: +b[1], t: +b[2], r: +b[3], b: +b[4] };
    }
  }
  return null;
}
const tapXY = (x, y) => sh(`input tap ${Math.round(x)} ${Math.round(y)}`);

const getprop = (k) => { try { return execFileSync('adb', ['shell', 'getprop', k], { encoding: 'utf8', timeout: 10000 }).trim(); } catch { return ''; } };
const bootId = () => { try { return execFileSync('adb', ['shell', 'cat /proc/sys/kernel/random/boot_id'], { encoding: 'utf8', timeout: 10000 }).trim(); } catch { return ''; } };

async function waitBoot(ms = 10 * 60 * 1000, notBootId = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getprop('sys.boot_completed') === '1') {
      const id = bootId();
      if (id && id !== notBootId) return id;
    }
    await sleep(3000);
  }
  return '';
}

/** Restart the phone; returns how it was restarted.  Proof of a real restart: the kernel boot id changes. */
async function rebootDevice(beforeId) {
  let avd = 'test';
  try { avd = execFileSync('adb', ['emu', 'avd', 'name'], { encoding: 'utf8', timeout: 10000 }).split(/\r?\n/)[0].trim() || avd; } catch { /* keep default */ }
  log('adb reboot (avd', avd + ')');
  try { execFileSync('adb', ['reboot'], { timeout: 60000 }); } catch (e) { log('adb reboot returned', e.message.split('\n')[0]); }
  let id = await waitBoot(7 * 60 * 1000, beforeId);
  if (id) return { how: 'adb reboot', id };
  // some emulator images never come back from a guest reboot: power-cycle the virtual device instead
  log('no boot after adb reboot – power-cycling the emulator (kill + cold boot)');
  try { execFileSync('adb', ['emu', 'kill'], { timeout: 30000 }); } catch { /* already gone */ }
  await sleep(15000);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk';
  const emu = spawn(`${sdk}/emulator/emulator`, ['-avd', avd, '-no-window', '-gpu', 'swiftshader_indirect', '-noaudio', '-no-boot-anim', '-no-snapshot'], { detached: true, stdio: 'ignore' });
  emu.unref();
  id = await waitBoot(12 * 60 * 1000, beforeId);
  if (id) return { how: 'emulator power cycle (cold boot)', id };
  throw new Error('the device did not boot again');
}

let device, page, view;
async function attach() {
  sh(`am start -W -n ${PKG}/.MainActivity`);
  [device] = await android.devices({ omitDriverInstall: true });
  const webview = await device.webView({ pkg: PKG }, { timeout: 180000 });
  page = await webview.page();
  page.setDefaultTimeout(120000);
  await page.waitForFunction(() => !!window.__topo, null, { timeout: 180000 });
  // WebView placement on screen (from the native side), to convert CSS px to touch coordinates
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const vp = await page.evaluate(() => window.__topoNative?.viewportInfo()).catch(() => null);
  if (vp) view = { dpr, left: vp.left, top: vp.top };
  else {
    const wv = findNode(uiDump(), (n) => n.cls === 'android.webkit.WebView');
    view = { dpr, left: wv ? wv.l : 0, top: wv ? wv.t : 0 };
  }
  log('webview', JSON.stringify({ ...view, vp }));
}
const tapCss = (x, y) => tapXY(view.left + x * view.dpr, view.top + y * view.dpr);
async function tapSel(sel) {
  const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
  if (!r) throw new Error('no element ' + sel);
  tapCss(r.x, r.y);
}
async function tapMap(lon, lat) {
  const p = await page.evaluate(([lo, la]) => { const q = window.__map.project([lo, la]); return { x: q.x, y: q.y }; }, [lon, lat]);
  tapCss(p.x, p.y);
}
async function idle(ms = 60000) {
  await page.evaluate((t) => new Promise((res) => {
    const m = window.__map;
    const done = () => res(true);
    if (m.areTilesLoaded() && !m.isMoving()) setTimeout(done, 500); else m.once('idle', done);
    setTimeout(done, t);
  }), ms).catch(() => undefined);
}

let geoTimer = null;
function startFakeGnss(lon, lat, alt) {
  // emulator GNSS: one NMEA fix per second, like a real receiver
  const send = () => { try { execFileSync('adb', ['emu', 'geo', 'fix', String(lon), String(lat), String(alt), '9'], { timeout: 10000 }); } catch { /* ignore */ } };
  send();
  geoTimer = setInterval(send, 1000);
}

try {
  // ------------------------------------------------------------ setup: airplane mode, install, region file in Downloads
  await waitBoot(5 * 60 * 1000);
  adb('install', '-r', '-g', apk);
  const perms = sh(`dumpsys package ${PKG}`);
  check('APK has no INTERNET permission', !/android\.permission\.INTERNET/.test(perms), 'requested: ' + (perms.match(/android\.permission\.[A-Z_]+/g) || []).filter((v, i, a) => a.indexOf(v) === i).join(', '));
  try { sh('cmd connectivity airplane-mode enable'); } catch { sh('settings put global airplane_mode_on 1'); }
  try { sh('cmd location set-location-enabled true'); } catch { /* older images */ }
  await sleep(3000);
  check('phone is in airplane mode', sh('settings get global airplane_mode_on') === '1');
  adb('push', region, `/sdcard/Download/${basename(region)}`);
  try { sh('content call --method scan_volume --uri content://media --arg external_primary'); } catch { /* best effort */ }

  // ------------------------------------------------------------ 1. opens to the globe
  await attach();
  await sleep(6000);
  screencap('01-launch-welcome-menu.png');
  check('menu open at launch with welcome line', await page.isVisible('.menu.open .welcome'));
  tapCss(view ? 200 : 200, 200);
  await sleep(1500);
  check('first tap folds the menu to the dots', !(await page.isVisible('.menu.open')));
  const globe = await page.evaluate(() => ({ p: window.__map?.getProjection()?.type, z: window.__map?.getZoom() }));
  check('app opens to the globe', globe.p === 'globe' && globe.z < 3, JSON.stringify(globe));
  screencap('02-globe.png');

  // ------------------------------------------------------------ 2. region file via the phone's file picker
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="add-region"]');
  const want = basename(region);
  let picked = false;
  for (let attempt = 0; attempt < 14 && !picked; attempt++) {
    await sleep(2500);
    const xml = uiDump();
    const file = findNode(xml, (n) => n.text === want);
    if (file) { tapXY(file.x, file.y); picked = true; break; }
    if (attempt === 0) writeFileSync(join(outDir, 'picker-ui.xml'), xml);
    const roots = findNode(xml, (n) => /show roots/i.test(n.desc));
    // root list entries live in the navigation drawer (resource-id .../roots_list or a TextView titled Downloads)
    const downloads = findNode(xml, (n) => /^Downloads$/.test(n.text) && !/toolbar|title/i.test(n.id));
    const internal = findNode(xml, (n) => /sdk_gphone|Internal storage|^Pixel/i.test(n.text));
    const dlFolder = findNode(xml, (n) => n.text === 'Download');
    log('picker', JSON.stringify({ attempt, downloads: !!downloads, roots: !!roots, internal: !!internal, dlFolder: !!dlFolder }));
    if (dlFolder) tapXY(dlFolder.x, dlFolder.y);
    else if (attempt >= 6 && internal) tapXY(internal.x, internal.y);
    else if (downloads && attempt < 6) tapXY(downloads.x, downloads.y);
    else if (roots) tapXY(roots.x, roots.y);
  }
  screencap('03-file-picker.png');
  check('region chosen in the Android file picker', picked);
  await page.waitForFunction(() => window.__topo.regions.size > 0, null, { timeout: 240000 });
  const reg = await page.evaluate(() => [...window.__topo.regions.values()].map((r) => `${r.id} ${r.name} ${(r.size / 1048576).toFixed(2)} MiB`));
  check('region file loads', reg.length === 1, reg.join(', '));
  await sleep(4000);
  screencap('04-region-loaded.png');

  // ------------------------------------------------------------ 3. tap region on globe view -> 3D terrain + contours
  await page.evaluate(() => { window.__gov.pin(1); window.__map.jumpTo({ center: [145.5, -37.5], zoom: 6.5, pitch: 0, bearing: 0 }); });
  await idle(30000);
  await tapMap(145.5, -37.5);
  await page.waitForFunction(() => window.__map.getZoom() > 10.5 && !window.__map.isMoving(), null, { timeout: 120000 });
  check('tapping the region flies into the 3D map', (await page.evaluate(() => window.__map.getPitch())) > 40);
  await page.evaluate(() => window.__map.jumpTo({ center: [145.355, -37.86], zoom: 14.2, pitch: 60, bearing: 30 }));
  await idle(120000);
  const t = await page.evaluate(() => {
    const m = window.__map;
    const c = m.querySourceFeatures('contours', { sourceLayer: 'contours' });
    const lv = [...new Set(c.map((f) => f.properties.ele))].sort((a, b) => a - b);
    return { terrain: !!m.getTerrain(), pitch: m.getPitch(), contours: c.length, levels: lv.slice(0, 12), roads: m.querySourceFeatures('vec', { sourceLayer: 'roads' }).length };
  });
  check('3D terrain shows', t.terrain && t.pitch > 40, `pitch ${Math.round(t.pitch)}`);
  check('10 m contours show', t.levels.length > 3 && t.levels.every((l) => l % 10 === 0) && t.levels.some((l) => l % 50 !== 0), `${t.contours} features, levels ${t.levels.join(',')}`);
  screencap('05-terrain-contours.png');

  // ------------------------------------------------------------ 4. GPS fix (no network: GNSS only)
  startFakeGnss(145.3557, -37.8571, 590);
  await page.evaluate(() => window.__map.jumpTo({ center: [145.355, -37.86], zoom: 13.5, pitch: 0, bearing: 0 }));
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="gps"]');
  await sleep(3000);
  const dlg = findNode(uiDump(), (n) => /While using the app|Only this time|Allow/i.test(n.text));
  if (dlg) tapXY(dlg.x, dlg.y);
  await page.waitForFunction(() => window.__topo.gps.fix && window.__topo.gps.fix.provider !== 'last-known', null, { timeout: 240000 });
  const fix = await page.evaluate(() => window.__topo.gps.fix);
  check('GPS gets a fix', !!fix, `±${Math.round(fix.accuracy)} m at ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (${fix.provider})`);
  await sleep(4000);
  screencap('06-gps-fix.png');

  // ------------------------------------------------------------ 5. waypoint
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="waypoint"]');
  await page.waitForFunction(() => window.__topo.waypoints.length === 1, null, { timeout: 60000 });
  const wp = await page.evaluate(() => window.__topo.waypoints[0]);
  check('waypoint drops', !!wp, `${wp.name} at ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}, ${wp.elev} m (${wp.source})`);
  await sleep(1500);
  screencap('07-waypoint.png');

  // ------------------------------------------------------------ 6. measured line with elevation profile
  await page.evaluate(() => window.__map.jumpTo({ center: [145.355, -37.875], zoom: 12.6, pitch: 0, bearing: 0 }));
  await idle(60000);
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="measure"]');
  await sleep(1000);
  await tapMap(145.343, -37.858);
  await sleep(1500);
  await tapMap(145.355, -37.866);
  await sleep(2500);
  await tapMap(145.367, -37.858);
  await page.waitForFunction(() => { const m = window.__topo.measure; return m.pts.length === 3 && m.profile && m.profile.stats.distance > 2000; }, null, { timeout: 120000 });
  const pr = await page.evaluate(() => ({ n: window.__topo.measure.profile.dist.length, st: window.__topo.measure.profile.stats, h: document.querySelector('#sheet h2')?.textContent }));
  check('measured line shows its elevation profile', pr.n > 50 && (await page.isVisible('#profile')), `${pr.h}; ↑${Math.round(pr.st.ascent)} m ↓${Math.round(pr.st.descent)} m`);
  screencap('08-measure-profile.png');
  await tapSel('[data-action="m-done"]');
  await sleep(800);

  // ------------------------------------------------------------ 7. walking route
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="route"]');
  await sleep(1500);
  await tapMap(145.3745, -37.8722);
  await page.waitForFunction(() => window.__topo.route.result || /No route/.test(document.querySelector('#sheet h2')?.textContent || ''), null, { timeout: 300000 });
  const rt = await page.evaluate(() => ({ ok: !!window.__topo.route.result, h: document.querySelector('#sheet h2')?.textContent, legs: window.__topo.route.result?.legs.slice(0, 5).map((l) => l.name) }));
  check('walking route plans', rt.ok, `${rt.h}; via ${(rt.legs || []).join(' → ')}`);
  screencap('09-route.png');

  // ------------------------------------------------------------ 8. reboot, waypoint still there
  clearInterval(geoTimer);
  try { await device.close(); } catch { /* ignore */ }
  const before = bootId();
  const rb = await rebootDevice(before);
  check('phone restarted', rb.id && rb.id !== before, `${rb.how}; kernel boot id ${before.slice(0, 8)}… → ${rb.id.slice(0, 8)}…`);
  await sleep(15000);
  // a freshly booted phone shows the (non-secure) lock screen: dismiss it like a user would
  try { sh('input keyevent 82'); sh('wm dismiss-keyguard'); } catch { /* best effort */ }
  await sleep(2000);
  check('still in airplane mode after reboot', sh('settings get global airplane_mode_on') === '1');
  await attach();
  await sleep(6000);
  const after = await page.evaluate(() => ({ wps: window.__topo.waypoints.map((w) => w.name), regions: [...window.__topo.regions.keys()] }));
  check('after a reboot the waypoint is still there', after.wps.includes(wp.name), `waypoints: ${after.wps.join(', ')}; regions: ${after.regions.join(', ')}`);
  tapCss(200, 200);
  await sleep(1500);
  await tapSel('#dots');
  await sleep(800);
  await tapSel('[data-action="waypoints"]');
  await sleep(1500);
  screencap('10-after-reboot-waypoints.png');
} catch (e) {
  check('done-check ran to completion', false, e.message.split('\n')[0]);
  screencap('99-failure.png');
  writeFileSync(join(outDir, 'failure-ui.xml'), uiDump());
} finally {
  clearInterval(geoTimer);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, when: new Date().toISOString() }, null, 2));
  try {
    const lc = execFileSync('adb', ['logcat', '-d', '-t', '4000'], { maxBuffer: 64 << 20, timeout: 60000, encoding: 'utf8' });
    writeFileSync(join(outDir, 'logcat.txt'), lc);
  } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);

// End-to-end smoke test in Chromium with all external services mocked.
// Run: npm run test:e2e   (needs Playwright; uses a global install if not in node_modules)
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return import(path.join(root, 'playwright', 'index.mjs'));
  }
}

const OVERPASS_FIXTURE = {
  elements: [
    { type: 'node', id: 101, lat: 38.336, lon: -75.085, tags: { name: 'Boardwalk Fries', amenity: 'fast_food', email: 'jobs@boardwalkfries.test', website: 'https://boardwalkfries.test', 'addr:housenumber': '5', 'addr:street': 'Boardwalk', 'addr:city': 'Ocean City', 'addr:state': 'MD' } },
    { type: 'node', id: 102, lat: 38.34, lon: -75.083, tags: { name: 'Ocean Breeze Hotel', tourism: 'hotel', website: 'https://oceanbreeze.test', phone: '+1 410 555 0100' } },
    { type: 'way', id: 103, center: { lat: 38.33, lon: -75.09 }, tags: { name: 'Sunny Day Care', amenity: 'restaurant' } },
    { type: 'node', id: 104, lat: 38.35, lon: -75.08, tags: { name: 'Salty Scoops', amenity: 'ice_cream' } },
  ],
};

const outDir = path.resolve('test-results');
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await loadPlaywright();
const server = createServer().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const errors = [];

async function newPage(viewport, { withServer = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('https://maps.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>map</p>' }));
  await page.route('**/api/overpass', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OVERPASS_FIXTURE) }));
  await page.route('https://overpass-api.de/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OVERPASS_FIXTURE) }));
  await page.route('**/api/emails?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ emails: ['hr@oceanbreeze.test'], pages: [] }) }));
  await page.route('https://photon.komoot.io/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [{ properties: { name: 'Ocean City', state: 'Maryland', countrycode: 'US', county: 'Worcester County' }, geometry: { coordinates: [-75.0849, 38.3365] } }] }) }));
  if (!withServer) await page.route('**/api/health', (r) => r.fulfill({ status: 404, body: 'nope' }));
  return page;
}

try {
  // ---- desktop flow with server ----
  const page = await newPage({ width: 1360, height: 900 });
  await page.goto(base);
  await page.waitForFunction(() => window.wt?.state.server.ok === true);
  assert.equal(await page.locator('#stateSelect option').count(), 52);

  // Hotspots → search Ocean City MD
  await page.click('.tab[data-tab="hotspots"]');
  assert.ok(await page.locator('.hs').count() > 80);
  await page.fill('#hsSearch', 'Ocean City');
  await page.locator('.hs', { hasText: 'Ocean City, MD' }).locator('[data-hs]').click();
  await page.waitForSelector('.lead');
  assert.equal(await page.locator('.lead').count(), 4);
  assert.match(await page.textContent('#resultsSummary'), /Найдено 4/);
  assert.equal(await page.locator('.leaflet-interactive').count() >= 4, true);
  // fit badges
  assert.equal(await page.locator('.lead.fit-bad').count(), 1);
  await page.screenshot({ path: path.join(outDir, 'search-desktop.png'), fullPage: false });

  // Google Maps link + embed modal
  const first = page.locator('.lead', { hasText: 'Boardwalk Fries' });
  assert.match(await first.locator('a', { hasText: 'Google Maps' }).getAttribute('href'), /google\.com\/maps\/search\/\?api=1&query=Boardwalk\+Fries/);
  await first.locator('[data-act="view"]').click();
  await page.waitForSelector('#placeModal[open]');
  assert.match(await page.getAttribute('#pmMap', 'src'), /maps\.google\.com\/maps\?q=Boardwalk/);
  await page.click('#placeModal [data-close]');

  // Profile
  await page.click('.tab[data-tab="letter"]');
  await page.fill('#profileForm [name="name"]', 'Test Student');
  await page.fill('#profileForm [name="university"]', 'Test University');
  await page.fill('#profileForm [name="resumeLink"]', 'https://drive.google.com/file/d/test');
  await page.click('#profileForm button[type="submit"]');
  assert.match(await page.textContent('#tplPreview'), /Test Student/);
  await page.screenshot({ path: path.join(outDir, 'letter.png') });
  await page.click('.tab[data-tab="search"]');

  // Compose via Gmail
  await first.locator('[data-act="compose"]').click();
  await page.waitForSelector('#composeModal[open]');
  const gmail = new URL(await page.getAttribute('#cmGmail', 'href'));
  assert.equal(gmail.hostname, 'mail.google.com');
  assert.equal(gmail.searchParams.get('to'), 'jobs@boardwalkfries.test');
  assert.match(gmail.searchParams.get('body'), /Dear Boardwalk Fries Hiring Team/);
  assert.match(gmail.searchParams.get('body'), /Test Student/);
  await page.screenshot({ path: path.join(outDir, 'compose.png') });
  await page.click('#cmMarkSent');
  assert.equal(await page.textContent('#trackerCount'), '1');

  // Enrich email from website (server)
  const hotel = page.locator('.lead', { hasText: 'Ocean Breeze Hotel' });
  await hotel.locator('[data-act="enrich"]').click();
  await page.locator('.lead', { hasText: 'Ocean Breeze Hotel' }).locator('.contact.email', { hasText: 'hr@oceanbreeze.test' }).waitFor();

  // Bulk save
  await page.check('#selectAll');
  await page.click('#bulkSave');
  assert.equal(await page.textContent('#trackerCount'), '4');

  // Tracker + queue
  await page.click('.tab[data-tab="tracker"]');
  assert.equal(await page.locator('.trow').count(), 4);
  assert.match(await page.textContent('#trackerStats'), /1<\/b>|1 отправлено|отправлено/);
  await page.click('#queueBtn');
  await page.waitForSelector('#composeModal[open]');
  assert.match(await page.textContent('#cmQueue'), /1.*из.*1/s); // only Ocean Breeze is new + has email + fits
  await page.click('#cmMarkSent');
  await page.waitForFunction(() => !document.querySelector('#composeModal').open);
  const statuses = await page.evaluate(() => [...window.wt.state.saved.values()].map((l) => `${l.name}:${l.status}`).sort());
  assert.deepEqual(statuses, ['Boardwalk Fries:emailed', 'Ocean Breeze Hotel:emailed', 'Salty Scoops:new', 'Sunny Day Care:new']);
  // status change + notes persist
  const row = page.locator('.trow', { hasText: 'Salty Scoops' });
  await row.locator('select[data-act="status"]').selectOption('replied');
  await page.reload();
  await page.click('.tab[data-tab="tracker"]');
  assert.equal(await page.locator('.trow', { hasText: 'Salty Scoops' }).locator('select').inputValue(), 'replied');
  await page.screenshot({ path: path.join(outDir, 'tracker.png') });

  // Rules tab
  await page.click('.tab[data-tab="rules"]');
  assert.match(await page.textContent('#tab-rules'), /22 CFR 62\.32/);

  // ---- mobile, static mode (no server), manual city via autocomplete ----
  const m = await newPage({ width: 390, height: 844 }, { withServer: false });
  await m.goto(base);
  await m.waitForTimeout(400);
  assert.match(await m.textContent('#searchHint'), /OpenStreetMap/);
  assert.equal(await m.isHidden('#bulkEnrich'), true);
  await m.selectOption('#stateSelect', 'MD');
  await m.fill('#cityInput', 'Ocean');
  await m.locator('#citySuggest li', { hasText: 'Worcester County' }).click();
  await m.click('#searchBtn');
  await m.waitForSelector('.lead');
  const hotelM = m.locator('.lead', { hasText: 'Ocean Breeze Hotel' });
  assert.match(await hotelM.locator('a', { hasText: 'Найти email' }).getAttribute('href'), /google\.com\/search\?q=site%3Aoceanbreeze\.test/);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await m.screenshot({ path: path.join(outDir, 'search-mobile.png'), fullPage: true });

  assert.deepEqual(errors, []);
  console.log('E2E OK — screenshots in test-results/');
} catch (e) {
  console.error('E2E FAILED:', e);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

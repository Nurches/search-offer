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

const CITY_FIXTURE = { elements: [
  { type: 'node', id: 1, lat: 61.2181, lon: -149.9003, tags: { name: 'Anchorage', place: 'city', population: '291247' } },
  { type: 'node', id: 2, lat: 64.8378, lon: -147.7164, tags: { name: 'Fairbanks', place: 'city', population: '32515' } },
  { type: 'node', id: 3, lat: 60.1042, lon: -149.4422, tags: { name: 'Seward', place: 'town', population: '2717' } },
] };
const overpassBody = (req) => (decodeURIComponent(req.postData() || '').includes('"place"~') ? CITY_FIXTURE : OVERPASS_FIXTURE);

const outDir = path.resolve('test-results');
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await loadPlaywright();
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
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
  await page.route('**/api/overpass', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpassBody(r.request())) }));
  await page.route('https://overpass-api.de/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpassBody(r.request())) }));
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

  // Bigger map, popup with actions, fullscreen
  const mapH = await page.evaluate(() => document.querySelector('#map').getBoundingClientRect().height);
  assert.ok(mapH >= 440, `map height ${mapH}`);
  await page.locator('.lead', { hasText: 'Boardwalk Fries' }).locator('[data-act="locate"]').click();
  await page.waitForSelector('.leaflet-popup .pop-title');
  assert.match(await page.textContent('.leaflet-popup'), /Boardwalk Fries/);
  await page.click('#mapFullBtn');
  assert.equal(await page.evaluate(() => document.querySelector('#map').classList.contains('map-full')), true);
  const fullRect = await page.evaluate(() => { const r = document.querySelector('#map').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  assert.deepEqual(fullRect.map(Math.round), [0, 0, 1360, 900]);
  assert.equal(await page.evaluate(() => !!document.elementFromPoint(100, 300).closest('#map')), true);
  await page.screenshot({ path: path.join(outDir, 'map-fullscreen.png') });
  await page.click('.leaflet-popup [data-pop="view"]');
  await page.waitForSelector('#placeModal[open]');
  await page.click('#placeModal [data-close]');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.querySelector('#map').classList.contains('map-full')), false);
  await page.evaluate(() => window.wt && document.querySelector('.leaflet-popup-close-button')?.click());

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
  // pair mode is the default: partner fields visible, joint resume label
  assert.equal(await page.isVisible('#partnerFields'), true);
  assert.match(await page.textContent('#resumeLabel'), /общее резюме/);
  assert.match(await page.inputValue('#profileForm [name="experience"]'), /^We are hardworking/);
  await page.fill('#profileForm [name="partnerName"]', 'Test Friend');
  await page.fill('#profileForm [name="partnerEmail"]', 'friend@example.org');
  await page.click('#profileForm button[type="submit"]');
  assert.match(await page.textContent('#tplPreview'), /Test Student and Test Friend/);
  assert.match(await page.textContent('#tplModeNote'), /вдвоём/);
  // switching to solo hides partner fields and changes templates
  await page.click('#profileForm .seg label:has(input[value="solo"])');
  assert.equal(await page.isVisible('#partnerFields'), false);
  await page.click('#profileForm button[type="submit"]');
  assert.doesNotMatch(await page.textContent('#tplPreview'), /Test Friend/);
  await page.click('#profileForm .seg label:has(input[value="pair"])');
  await page.click('#profileForm button[type="submit"]');
  await page.screenshot({ path: path.join(outDir, 'letter.png') });
  await page.click('.tab[data-tab="search"]');

  // Compose via Gmail
  await first.locator('[data-act="compose"]').click();
  await page.waitForSelector('#composeModal[open]');
  const gmail = new URL(await page.getAttribute('#cmGmail', 'href'));
  assert.equal(gmail.hostname, 'mail.google.com');
  assert.equal(gmail.searchParams.get('to'), 'jobs@boardwalkfries.test');
  assert.match(gmail.searchParams.get('body'), /Dear Boardwalk Fries Hiring Team/);
  assert.match(gmail.searchParams.get('body'), /together with my friend Test Friend/);
  assert.match(gmail.searchParams.get('body'), /Test Student and Test Friend/);
  assert.equal(gmail.searchParams.get('cc'), 'friend@example.org');
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
  assert.match(await page.textContent('#trackerStats'), /1 написали/);
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
  assert.equal(await page.locator('.trow', { hasText: 'Salty Scoops' }).locator('select[data-act="status"]').inputValue(), 'replied');
  await page.screenshot({ path: path.join(outDir, 'tracker.png') });

  // Housing in tracker
  const sRow = page.locator('.trow', { hasText: 'Salty Scoops' });
  await sRow.locator('select[data-act="housing"]').selectOption('provided');
  await page.locator('.trow', { hasText: 'Salty Scoops' }).locator('input[data-act="housingCost"]').fill('$150/нед');
  await page.locator('.trow', { hasText: 'Salty Scoops' }).locator('input[data-act="housingCost"]').press('Enter');
  await page.locator('.trow', { hasText: 'Salty Scoops' }).locator('input[data-act="housingCost"]').blur();
  await page.selectOption('#trackerHousing', 'provided');
  assert.equal(await page.locator('.trow').count(), 1);
  assert.match(await page.textContent('.trow'), /Даёт жильё · \$150\/нед/);
  await page.selectOption('#trackerHousing', '');

  // Rules tab
  await page.click('.tab[data-tab="rules"]');
  assert.match(await page.textContent('#tab-rules'), /22 CFR 62\.32/);
  assert.match(await page.textContent('#tab-rules'), /🏠 Жильё/);

  // Hotspots: housing filter
  await page.click('.tab[data-tab="hotspots"]');
  await page.fill('#hsSearch', '');
  await page.selectOption('#hsHousing', 'employer');
  const hsCount = await page.locator('.hs').count();
  assert.ok(hsCount >= 25 && hsCount < 60, `housing hotspots ${hsCount}`);
  assert.equal(await page.locator('.hs', { hasText: 'Ocean City, MD' }).count(), 0);
  assert.equal(await page.locator('.hs', { hasText: 'Mackinac Island' }).count(), 1);

  // City picker: Alaska shows its cities on focus, filters while typing, search works
  await page.click('.tab[data-tab="search"]');
  await page.selectOption('#stateSelect', 'AK');
  await page.click('#cityInput');
  await page.waitForSelector('#citySuggest li:has-text("Anchorage")');
  assert.match(await page.textContent('#citySuggest'), /Denali Park, AK · W&T курорт · 🏠/);
  await page.fill('#cityInput', 'fair');
  await page.waitForSelector('#citySuggest li:has-text("Fairbanks")');
  await page.locator('#citySuggest li', { hasText: 'Fairbanks' }).click();
  assert.equal(await page.inputValue('#cityInput'), 'Fairbanks');
  // Re-opening the field with a picked city lists the whole state again, not just that city
  await page.click('#mapFullBtn'); await page.click('#mapFullBtn'); // move focus away and back
  await page.click('#cityInput');
  await page.waitForSelector('#citySuggest li:has-text("Anchorage")');
  assert.match(await page.textContent('#citySuggest'), /всего 3 мест в штате/);
  await page.keyboard.press('Escape');
  await page.click('#searchBtn');
  await page.waitForSelector('.lead');
  // typed name without picking also resolves from the state list (no geocoder call)
  await page.fill('#cityInput', 'Anchorage');
  await page.click('#searchBtn');
  await page.waitForFunction(() => window.wt.state.city?.name === 'Anchorage');
  // housing filter in results
  await page.selectOption('#housingFilter', 'likely');
  const names = await page.locator('.lead h4').allTextContents();
  assert.ok(names.every((n) => /Hotel/.test(n)), names.join('|'));
  await page.selectOption('#housingFilter', 'all');
  await page.locator('.lead', { hasText: 'Ocean Breeze Hotel' }).locator('[data-act="view"]').click();
  assert.match(await page.textContent('#pmInfo'), /Жильё рядом с работой/);
  await page.click('#placeModal [data-close]');

  // ---- one-click Gmail campaign + reply tracking (Google sign-in and Gmail API mocked) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const g = await ctx.newPage();
    g.on('pageerror', (e) => errors.push(`pageerror(gmail): ${e.message}`));
    await ctx.addInitScript(() => {
      window.__wtTestIntervalSec = 0.05;
      if (!localStorage.getItem('wt.profile.v1')) {
        localStorage.setItem('wt.profile.v1', JSON.stringify({ name: 'Test Student', university: 'Test University', studyYear: '2nd-year', resumeLink: 'https://drive.google.com/joint', searchMode: 'pair', partnerName: 'Test Friend', partnerEmail: 'friend@example.org' }));
      }
      window.google = { accounts: { oauth2: {
        initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 10) }),
        hasGrantedAllScopes: () => true,
        revoke: () => {},
      } } };
    });
    const sent = [];
    await g.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204, body: '' }));
    await g.route('**/api/overpass', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpassBody(r.request())) }));
    await g.route('**/api/emails?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ emails: ['hr@oceanbreeze.test'], pages: [] }) }));
    await g.route('https://gmail.googleapis.com/**', async (r) => {
      const url = new URL(r.request().url());
      assert.equal(r.request().headers().authorization, 'Bearer tok');
      const json = (b) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'me@example.org' });
      if (url.pathname.endsWith('/messages/send')) {
        const raw = JSON.parse(r.request().postData()).raw;
        sent.push(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return json({ id: `m${sent.length}`, threadId: `t${sent.length}` });
      }
      const h = (from, subject = 'Re: Summer jobs') => ({ headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] });
      if (url.pathname.endsWith('/threads/t1')) {
        return json({ messages: [{ id: 'm1', labelIds: ['SENT'], payload: h('me@example.org') }, { id: 'r1', snippet: 'Hi! Can you do a Zoom call on Monday?', internalDate: String(Date.now()), payload: h('Kate <kate@boardwalkfries.test>') }] });
      }
      if (url.pathname.endsWith('/threads/t2')) {
        return json({ messages: [{ id: 'm2', labelIds: ['SENT'], payload: h('me@example.org') }, { id: 'b1', payload: h('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)') }] });
      }
      return json({ messages: [] });
    });

    await g.goto(base);
    await g.waitForFunction(() => window.wt?.state.server.oauthClientId);
    // Import a profile file with resumes (what the user gets from Claude)
    const importFile = path.join(outDir, 'profile-import.json');
    fs.writeFileSync(importFile, JSON.stringify({
      version: 1,
      profile: { searchMode: 'pair', name: 'Test Student', partnerName: 'Test Friend', partnerEmail: 'friend@example.org', university: 'Test University', studyYear: '3rd-year', english: 'B1+', partnerEnglish: 'B2', startDate: 'June 1, 2027', endDate: 'August 31, 2027', experience: 'We have three summer seasons of restaurant experience.' },
      attachments: [{ filename: 'Resume_Test_Student.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 a').toString('base64'), size: 10 },
        { filename: 'Resume_Test_Friend.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 b').toString('base64'), size: 10 }],
    }));
    await g.click('.tab[data-tab="letter"]');
    await g.setInputFiles('#profileImport', importFile);
    await g.waitForFunction(() => document.querySelector('#attachList').textContent.includes('Resume_Test_Friend.pdf'));
    assert.equal(await g.inputValue('#profileForm [name="partnerEnglish"]'), 'B2');
    assert.equal(await g.inputValue('#profileForm [name="endDate"]'), 'August 31, 2027');
    assert.match(await g.textContent('#tplPreview'), /Our resumes are attached to this email\./);
    await g.click('.tab[data-tab="hotspots"]');
    await g.fill('#hsSearch', 'Ocean City');
    await g.locator('.hs', { hasText: 'Ocean City, MD' }).locator('[data-hs]').click();
    await g.waitForSelector('.lead');
    await g.check('#selectAll');
    await g.click('#bulkCampaign');
    await g.waitForSelector('#campaignModal[open]');
    assert.equal(await g.isVisible('#cpSetup'), false);
    assert.match(await g.textContent('#cpSummary'), /Готово к отправке: 1/);
    assert.match(await g.textContent('#cpSummary'), /Не подходят под правила W&T, пропущены: 1/);
    await g.click('#cpEnrich');
    await g.waitForFunction(() => /Готово к отправке: 2/.test(document.querySelector('#cpSummary').textContent));
    assert.match(await g.textContent('#cpPreview'), /Копия: friend@example\.org/);
    await g.click('#cpStart');
    assert.equal(sent.length, 0, 'must not send without confirmation');
    await g.check('#cpConfirm');
    await g.click('#cpStart');
    await g.waitForFunction(() => /Готово: отправлено 2/.test(document.querySelector('#cpStatus').textContent), null, { timeout: 15000 });
    assert.equal(sent.length, 2);
    assert.match(sent[0], /^To: jobs@boardwalkfries\.test\r\nCc: friend@example\.org\r\nSubject: Summer 2027 Seasonal Jobs for Two/);
    const textPart = sent[0].split(/--wt_[a-z0-9]+/)[1];
    const body0 = Buffer.from(textPart.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');
    assert.match(body0, /Dear Boardwalk Fries Hiring Team/);
    assert.match(body0, /Test Student and Test Friend/);
    assert.match(body0, /Our resumes are attached to this email\./);
    assert.match(body0, /Test Student – B1\+, Test Friend – B2/);
    assert.doesNotMatch(body0, /\[(University|Your Name|link to resume)\]/);
    assert.match(sent[0], /Content-Type: multipart\/mixed/);
    assert.match(sent[0], /filename="Resume_Test_Student\.pdf"/);
    assert.match(sent[0], /filename="Resume_Test_Friend\.pdf"/);
    assert.match(sent[1], /^To: hr@oceanbreeze\.test/);
    await g.screenshot({ path: path.join(outDir, 'campaign.png') });
    await g.click('#campaignModal [data-close]');

    // Reply check from the tracker
    await g.click('.tab[data-tab="tracker"]');
    assert.match(await g.textContent('#gmailBar'), /Gmail: me@example\.org/);
    // Test email to self: goes to own address, with attachments, not tracked
    const before = sent.length;
    await g.click('#gmailBar [data-gm="test"]');
    await g.waitForFunction((n) => document.querySelector('#toast').textContent.includes('Тестовое письмо'), before);
    assert.equal(sent.length, before + 1);
    assert.match(sent[before], /^To: me@example\.org\r\nSubject: =\?UTF-8\?B\?/);
    assert.match(sent[before], /filename="Resume_Test_Friend\.pdf"/);
    await g.click('#gmailBar [data-gm="check"]');
    await g.waitForFunction(() => [...window.wt.state.saved.values()].some((l) => l.reply));
    const st = await g.evaluate(() => Object.fromEntries([...window.wt.state.saved.values()].filter((l) => l.gmail).map((l) => [l.name, l.status])));
    assert.deepEqual(st, { 'Boardwalk Fries': 'replied', 'Ocean Breeze Hotel': 'bounced' });
    const row = g.locator('.trow', { hasText: 'Boardwalk Fries' });
    assert.match(await row.locator('.reply-box').textContent(), /Новый ответ!.*Kate.*Zoom call on Monday/s);
    assert.match(await row.locator('a', { hasText: 'Переписка в Gmail' }).getAttribute('href'), /#all\/t1$/);
    assert.match(await g.locator('.trow', { hasText: 'Ocean Breeze Hotel' }).textContent(), /Письмо не дошло/);
    assert.match(await g.textContent('#replyBadge'), /💬 1/);
    await g.screenshot({ path: path.join(outDir, 'replies.png') });
    // Visiting the tracker marks replies as seen
    await g.click('.tab[data-tab="search"]');
    await g.click('.tab[data-tab="tracker"]');
    assert.equal(await g.isHidden('#replyBadge'), true);
    // Daily counter
    assert.equal(await g.evaluate(() => JSON.parse(localStorage.getItem('wt.sendLog.v1')).count), 2);
    await ctx.close();
  }

  // ---- mobile, static mode (no server), manual city via autocomplete ----
  const m = await newPage({ width: 390, height: 844 }, { withServer: false });
  await m.goto(base);
  await m.waitForTimeout(400);
  assert.match(await m.textContent('#searchHint'), /OpenStreetMap/);
  assert.equal(await m.isHidden('#bulkEnrich'), true);
  await m.selectOption('#stateSelect', 'MD');
  await m.fill('#cityInput', 'Ocean');
  await m.locator('#citySuggest li', { hasText: 'Ocean City, MD' }).first().click();
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

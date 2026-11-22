// Browser test for tools/interexchange-collector.js against a fake job-listings site (no real InterExchange calls).
// Two layouts: server-rendered pages (?page=N, collected with fetch) and a single-page app (collected by clicking).
import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return import(path.join(root, 'playwright', 'index.mjs'));
  }
}

const SCRIPT = fs.readFileSync(path.resolve('tools/interexchange-collector.js'), 'utf8');
const outDir = path.resolve('test-results');
fs.mkdirSync(outDir, { recursive: true });

const POS = ['Housekeeper', 'Lifeguard', 'Server', 'Barista'];
const CITY = [['Ocean City', 'MD'], ['Seward', 'AK'], ['Wisconsin Dells', 'WI'], ['Bar Harbor', 'ME']];
const HOUSING = ['Housing Provided', 'Housing Assistance', '', 'Housing Provided'];
const PER_PAGE = 10;
const PAGES = 3;
const TOTAL = 25;
const job = (i) => ({
  id: 1000 + i, employer: `Employer ${i}`, pos: POS[i % 4], city: CITY[i % 4], housing: HOUSING[i % 4],
  wage: 14 + (i % 5), hours: 30 + (i % 3) * 5,
});
const card = (j) => `<div class="card listing"><div class="card-body">
  <h5 class="card-title"><a href="/job_listings/${j.id}">${j.employer}</a></h5>
  <div>${j.pos}</div><div>${j.city[0]}, ${j.city[1]}</div>
  <dl><dt>Wage per hour</dt><dd>$${j.wage}.00</dd><dt>Average Hours per week</dt><dd>${j.hours}</dd>
  <dt>Preferred Work Dates</dt><dd>06/0${1 + (j.id % 3)}/2027 - 09/15/2027</dd></dl>
  ${j.housing ? `<span class="badge">${j.housing}</span>` : ''}${j.housing === 'Housing Provided' ? '<div>Housing cost: $140/week</div>' : ''}
  <a class="btn" href="/job_listings/${j.id}">View</a></div></div>`;
const filters = `<form class="filters"><h6>Position</h6><div>${POS.map((p, i) => `<label><input type="checkbox" id="p${i}"> ${p}</label>`).join('')}</div>
  <h6>Housing</h6><div><label><input type="checkbox"> Housing Assistance</label><label><input type="checkbox"> Housing Provided</label></div></form>`;
const pager = (cur, spa) => `<ul class="pagination">${Array.from({ length: PAGES }, (_, k) => k + 1)
  .map((n) => `<li class="page-item${n === cur ? ' active' : ''}"><a class="page-link" href="${spa ? '#' : `/job_listings?page=${n}`}">${n}</a></li>`).join('')}</ul>`;
const jobsOn = (p) => Array.from({ length: TOTAL }, (_, i) => job(i)).slice((p - 1) * PER_PAGE, p * PER_PAGE);
const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Job Listings</title></head><body>
  <nav><a href="/dashboard">Dashboard</a><a href="/job_listings">Job Listings</a><a href="/users/7">Me</a></nav>
  <main><h2>Job Listings <small>${TOTAL}</small></h2>${filters}${body}</main></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (u.pathname === '/job_listings') {
    const p = +(u.searchParams.get('page') || 1);
    return res.end(shell(`${pager(p)}<div id="list">${jobsOn(p).map(card).join('')}</div>${pager(p)}`));
  }
  if (u.pathname === '/spa') {
    // List rendered by JS; pagination links are "#", so the collector must click through.
    return res.end(shell(`<div id="pg"></div><div id="list"></div><script>
      const ALL=${JSON.stringify(Array.from({ length: TOTAL }, (_, i) => job(i)))};
      const card=${card.toString()};
      function show(p){setTimeout(()=>{document.getElementById('list').innerHTML=ALL.slice((p-1)*${PER_PAGE},p*${PER_PAGE}).map(card).join('');
        document.getElementById('pg').innerHTML=${JSON.stringify(pager(1, true))};
        document.querySelectorAll('#pg a').forEach(a=>a.onclick=(e)=>{e.preventDefault();show(+a.textContent)});},150)}
      show(1);</script>`));
  }
  res.statusCode = 404;
  return res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];

async function collect(url) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#list .card');
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForFunction(() => Array.isArray(window.__ixOffers), null, { timeout: 30000 });
  return page;
}

try {
  // 1) Server-rendered pagination → fetch mode
  const page = await collect(`${base}/job_listings`);
  const rows = await page.evaluate(() => window.__ixOffers);
  assert.equal(rows.length, TOTAL, 'all listings across pages');
  const r0 = rows.find((r) => r.employer === 'Employer 0');
  assert.equal(r0.url, `${base}/job_listings/1000`);
  assert.equal(r0.position, 'Housekeeper');
  assert.deepEqual([r0.city, r0.state, r0.wage, r0.hours, r0.weekly, r0.housing], ['Ocean City', 'MD', 14, 30, 420, 'provided']);
  assert.match(r0.housingCost, /\$140/);
  assert.equal(r0.start, '2027-06-02');
  assert.equal(rows.find((r) => r.employer === 'Employer 1').housing, 'assistance');
  assert.equal(rows.find((r) => r.employer === 'Employer 2').housing, '');
  assert.match(await page.textContent('#ix-collector'), /Готово: 25/);
  await page.screenshot({ path: path.join(outDir, 'ix-panel.png') });

  // Report: opens in a new tab, filters work, CSV downloads
  const [report] = await Promise.all([ctx.waitForEvent('page'), page.click('#ix-collector >> text=Открыть отчёт')]);
  report.on('pageerror', (e) => errors.push(e.message));
  await report.waitForSelector('#tb tr');
  assert.match(await report.textContent('#cnt'), /Подходит: 25/);
  await report.selectOption('#hs', 'provided');
  await report.check('#strict');
  const provided = rows.filter((r) => r.housing === 'provided').length;
  assert.match(await report.textContent('#cnt'), new RegExp(`Подходит: ${provided}$`));
  await report.fill('#w', '17');
  const strong = rows.filter((r) => r.housing === 'provided' && r.wage >= 17).length;
  assert.match(await report.textContent('#cnt'), new RegExp(`Подходит: ${strong}$`));
  const firstWeekly = await report.textContent('#tb tr td:nth-child(7)');
  assert.equal(firstWeekly, `$${Math.max(...rows.filter((r) => r.housing === 'provided' && r.wage >= 17).map((r) => r.weekly))}`);
  await report.click('#tb tr .star');
  await report.check('#fav');
  assert.match(await report.textContent('#cnt'), /Подходит: 1$/);
  await report.uncheck('#fav');
  const [dl] = await Promise.all([report.waitForEvent('download'), report.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, strong + 1, 'CSV has the shown rows');
  await report.screenshot({ path: path.join(outDir, 'ix-report.png'), fullPage: true });
  await page.close();
  await report.close();

  // 2) Single-page app → click mode
  const spa = await collect(`${base}/spa`);
  const spaRows = await spa.evaluate(() => window.__ixOffers);
  assert.equal(spaRows.length, TOTAL, 'all listings by clicking through pages');
  await spa.close();

  assert.deepEqual(errors, []);
  console.log('interexchange e2e: ok');
} finally {
  await browser.close();
  server.close();
}

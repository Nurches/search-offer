// Browser test for tools/interexchange-collector.js against fake listing sites (no real InterExchange calls).
// 1) Same markup as the InterExchange participant "Job Listings" page (server-rendered, ?page=N) + host profiles.
// 2) A generic single-page app (fallback parser, collected by clicking the pager).
// All employers and people here are made up.
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

// ── InterExchange-like fixture ──
const EMPLOYERS = [
  { e: 11, p: 501, name: 'Seaside Fun Pier', type: 'Amusement Park', loc: 'Seaside Hgts, NJ', region: 'Mid-Atlantic', start: 'May 20 2027 - Jun 15 2027', rent: '$150.00/week', bedroom: 3 },
  { e: 12, p: 502, name: 'Harbor Lodge', type: 'Hotel', loc: 'KITTERY, ME', region: 'New England', start: 'Jun 01 2027 - Jun 30 2027', rent: '$120.00/week', bedroom: 2 },
  { e: 13, p: 503, name: 'Glacier Diner', type: 'Restaurant', loc: 'Healy, AK', region: 'Alaska', start: 'May 10 2027 - May 31 2027', rent: '$0.00/week', bedroom: 4 },
];
const POSITIONS = ['Ride Operator', 'Housekeeping', 'Server', 'Dishwasher', 'Lifeguard'];
const HOUSING = ['Housing Provided', 'Housing Assistance', '', 'Housing Provided'];
const TOTAL = 23;
const PER_PAGE = 10;
const PAGES = Math.ceil(TOTAL / PER_PAGE);
const listing = (i) => {
  const emp = EMPLOYERS[i % EMPLOYERS.length];
  return {
    id: `0000${i}aaa-1111-2222-3333-44445555${String(i).padStart(4, '0')}`,
    emp, pos: POSITIONS[i % POSITIONS.length], housing: HOUSING[i % HOUSING.length],
    wage: (14 + (i % 5)).toFixed(2), hours: 30 + (i % 3) * 5, tipped: i % 4 === 2, rent: i % 6 === 0 ? '$140.00' : '',
    openings: 1 + (i % 7), age21: i % 5 === 0,
  };
};
const ALL = Array.from({ length: TOTAL }, (_, i) => listing(i));
const ixCard = (j, interview) => `
    <div id="job_listing_${j.id}" class="card job_listing">
    <div class="card-header">
      <a class="h5 m-0 d-flex align-items-center" href="/wt/employers/${j.emp.e}/enrollment_profiles/${j.emp.p}"><strong class="mr-auto" style="text-decoration: underline;">${j.pos}</strong><i class="fas fa-camera ml-1"></i></a>
</div>
  <div class="card-body"><div class="row"><div class="col-6"><strong>${j.openings} Position${j.openings > 1 ? 's' : ''}</strong><br>${j.tipped ? '<span class="mr-1 badge badge-success">Tipped</span>' : ''}<span class="mr-1 badge badge-primary">Maybe Overtime</span>${j.housing ? `<span class="badge badge-success">${j.housing}</span>` : ''}<div class="row show-row-view printing-avoid-page-break"><div class="col"><h5>Host Employer</h5><span class="value">${j.emp.name}</span></div></div><div class="row show-row-view printing-avoid-page-break"><div class="col"><h5>Type of Business</h5><span class="value">${j.emp.type}</span></div></div><div class="row show-row-view printing-avoid-page-break"><div class="col"><h5>Location</h5>${j.emp.loc}<br>${j.emp.region}</div></div><div class="row show-row-view printing-avoid-page-break"><div class="col"><h5>Last Visited</h5><span class="value">Nov 2${j.emp.e % 3} 2026</span></div></div></div><div class="col-6 text-right"><strong>$${j.wage}</strong>${j.tipped ? '<strong> + tips</strong>' : ''}<small> /hour</small><br><strong>${j.hours} hours</strong><small> /week</small><br>${j.rent ? `<strong>${j.rent} rent</strong><small> /week</small><br>` : ''}<strong>Overtime Wage </strong><span data-html="true" data-toggle="tooltip" title="This is your wage if you work over the average number of hours per week"><i class="fas fa-question-circle"></i></span><br>$24.00<small> /hour</small><br><div class="row show-row-view printing-avoid-page-break"><div class="col"><h5>Preferred Finish Dates</h5><span class="value">Sep 06 2027 - Sep 27 2027</span></div></div></div></div><p class="mt-2"><strong>Position Description</strong><br>Do the job well. $500 bonus at the end of season.</p><p class="mt-2 mb-0"><strong>Additional Description</strong></p><div>${j.age21 ? '<strong>Must be 21 years old by your arrival date to apply.</strong> ' : ''}Friendly team.</div></div>
    <div class="card-footer clearfix">
      <div class="d-flex justify-content-end">${interview ? '<div class="mr-2"><small class="text-muted">Interviewing On</small><br><strong>Dec 10</strong></div>' : ''}<div class="my-auto"><a class="btn btn-primary" href="/wt/employers/${j.emp.e}/enrollment_profiles/${j.emp.p}"><strong>View Host Profile</strong></a></div></div>
</div></div>`;
const ixPager = (cur) => `<div class="pagination-wrapper"><nav><ul class="pagination m-0">${Array.from({ length: PAGES }, (_, k) => k + 1)
  .map((n) => (n === cur
    ? `<li class="page-item active"><a data-remote="false" class="page-link">${n}</a></li>`
    : `<li class="page-item"><a class="page-link" href="/wt/job_listings?page=${n}">${n}</a></li>`)).join('')}</ul></nav></div>`;
const ixFilters = `<form id="job_listing_search_index_search" action="/wt/job_listings" method="get"><div id="search-filters" class="filters"><div class="row"><div class="col-12 col-lg-3">
  <div class="form-group clearfix"><label>Position</label><div class="checkboxes-filterable"><input type="search" placeholder="Filter..." class="form-control search-field" /><div class="checkboxes list-group">
  ${POSITIONS.map((p, i) => `<label class="list-group-item" for="q_position_id_in_${i}"><input type="checkbox" value="${i}" name="q[position_id_in][]" id="q_position_id_in_${i}" />${p}</label>`).join('')}</div></div></div>
  <div class="form-group clearfix"><label>Housing</label><div class="checkboxes list-group"><label class="list-group-item"><input type="checkbox" value="Assistance" /><span>Housing Assistance</span></label><label class="list-group-item"><input type="checkbox" value="Provided" /><span>Housing Provided</span></label></div></div>
  </div></div></div></form>`;
const ixPage = (p) => {
  const items = ALL.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  // page 1 also has the "Interviews Available" section; listing 0 shows up in both sections (deduped by id)
  const interviews = p === 1 ? `<section><h3>Interviews Available</h3>${ixCard(ALL[0], true)}</section><hr />` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Job Listings</title></head><body class="logged-in">
  <nav class="navbar"><ul id="navbar"><li><a href="/wt/participant_applications/1/dashboard">Dashboard</a></li><li><a href="/wt/job_listings">Job Listings</a></li></ul></nav>
  <div id="primary-header"><h1 class="page-title">Job Listings <small>${TOTAL}</small></h1><div id="primary-actions">${ixPager(p)}</div></div>
  <div id="search-banner">${ixFilters}</div>
  <div id="primary-content"><div class="job-listings row card-columns"><div class="col">${interviews}<section><h3>Job Listings</h3>${items.map((j) => ixCard(j)).join('')}</section></div></div></div>
  </body></html>`;
};
const ixProfile = (emp) => `<!doctype html><html><head><meta charset="utf-8"><title>Host Profile</title></head><body>
  <nav class="navbar"><a href="/wt/job_listings">Job Listings</a></nav>
  <div id="primary-content" class="container-lg"><div class="row"><div class="col"><h2>${emp.name} <span class="text-muted">- 2027 Summer</span></h2></div></div>
  <div class="row"><div class="col-12 col-lg-8">
  <section><h3>Preferred Dates</h3><div class="row"><div class="col-12 col-lg-6"><h5>Start</h5>${emp.start}</div><div class="col-12 col-lg-6"><h5>Finish</h5>Aug 31 2027 - Sep 30 2027</div></div></section>
  <section><h3>Business</h3><div class="row show-row-view"><div class="col"><h5>Meals Included</h5><span class="value"><p class="value">1 free meal per shift.</p></span></div></div>
  <div class="row show-row-view"><div class="col"><h5>Drug Testing Requirements</h5><span class="value">No</span></div></div></section>
  <section><h3>Housing</h3><div class="row show-row-view"><div class="col"><h5>Housing Type</h5><span class="value">Provided</span></div></div>
  <div class="row show-row-view"><div class="col"><h5>Rent</h5><span class="value">${emp.rent}</span></div></div>
  <div class="row show-row-view"><div class="col"><h5>Housing Deposit</h5><span class="value">$100.00</span></div></div>
  <div class="row show-row-view"><div class="col"><h5>Number of people sharing a bedroom</h5><span class="value">${emp.bedroom}</span></div></div>
  <div class="row show-row-view"><div class="col"><h5>Estimated Transportation Cost</h5><span class="value">$20.00/week</span></div></div></section>
  </div><div class="col-12 col-lg-4"><div class="card"><div class="card-body"><p class="card-text"><a target="blank" href="https://www.google.com/maps?q=x">1 Test Rd, ${emp.loc}</a></p></div></div></div></div></div></body></html>`;

// ── generic single-page app fixture ──
const spaJob = (i) => ({ id: 1000 + i, employer: `Employer ${i}`, city: ['Ocean City', 'MD'], wage: 14 + (i % 5), hours: 30 + (i % 3) * 5 });
const spaCard = (j) => `<div class="card listing"><div class="card-body"><h5 class="card-title"><a href="/jobs/${j.id}">${j.employer}</a></h5>
  <div>${j.city[0]}, ${j.city[1]}</div><dl><dt>Wage per hour</dt><dd>$${j.wage}.00</dd><dt>Average Hours per week</dt><dd>${j.hours}</dd></dl>
  <a class="btn" href="/jobs/${j.id}">View</a></div></div>`;
const SPA_TOTAL = 25;

let profileHits = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (u.pathname === '/wt/job_listings') return res.end(ixPage(+(u.searchParams.get('page') || 1)));
  const pm = u.pathname.match(/^\/wt\/employers\/(\d+)\/enrollment_profiles\/(\d+)$/);
  if (pm) {
    const emp = EMPLOYERS.find((e) => e.e === +pm[1]);
    if (emp) { profileHits += 1; return res.end(ixProfile(emp)); }
  }
  if (u.pathname === '/spa') {
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Jobs</title></head><body><h2>Job Listings ${SPA_TOTAL}</h2>
      <ul class="pagination" id="pg"></ul><div id="list"></div><script>
      const ALL=${JSON.stringify(Array.from({ length: SPA_TOTAL }, (_, i) => spaJob(i)))};
      const card=${spaCard.toString()};
      function show(p){setTimeout(()=>{document.getElementById('list').innerHTML=ALL.slice((p-1)*10,p*10).map(card).join('');
        document.getElementById('pg').innerHTML=[1,2,3].map(n=>'<li><a href="#">'+n+'</a></li>').join('');
        document.querySelectorAll('#pg a').forEach(a=>a.onclick=(e)=>{e.preventDefault();show(+a.textContent)});},150)}
      show(1);</script></body></html>`);
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

async function collect(url, ready) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector(ready);
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForFunction(() => Array.isArray(window.__ixOffers), null, { timeout: 30000 });
  return page;
}

try {
  // 1) InterExchange markup
  const page = await collect(`${base}/wt/job_listings`, '.job_listing');
  let rows = await page.evaluate(() => window.__ixOffers);
  assert.equal(rows.length, TOTAL, 'every listing once (same employer link ≠ same listing, interview duplicate merged)');
  const r0 = rows.find((r) => r.key === ALL[0].id);
  assert.equal(r0.url, `${base}/wt/employers/11/enrollment_profiles/501`);
  assert.deepEqual([r0.position, r0.employer, r0.business, r0.city, r0.state, r0.region], ['Ride Operator', 'Seaside Fun Pier', 'Amusement Park', 'Seaside Hgts', 'NJ', 'Mid-Atlantic']);
  assert.deepEqual([r0.wage, r0.hours, r0.weekly, r0.rent, r0.net, r0.housing, r0.overtime], [14, 30, 420, 140, 280, 'provided', 'maybe']);
  assert.deepEqual([r0.finishFrom, r0.finishTo, r0.interviews, r0.interviewOn, r0.age21, r0.openings], ['2027-09-06', '2027-09-27', true, 'Dec 10', true, 1]);
  const r1 = rows.find((r) => r.key === ALL[1].id);
  assert.deepEqual([r1.city, r1.state, r1.housing, r1.interviews, r1.wage], ['Kittery', 'ME', 'assistance', false, 15]);
  const r2 = rows.find((r) => r.key === ALL[2].id);
  assert.deepEqual([r2.housing, r2.tipped, r2.wage], ['none', true, 16]);
  assert.match(await page.textContent('#ix-collector'), /Готово: 23/);

  // Host profiles: one request per employer, start dates + rent filled in
  await page.click('#ix-collector >> text=Догрузить профили');
  await page.waitForFunction(() => /Готово:.*Профили работодателей: 3\./.test(document.querySelector('#ix-collector').textContent), null, { timeout: 30000 });
  assert.equal(profileHits, EMPLOYERS.length);
  rows = await page.evaluate(() => window.__ixOffers);
  const p0 = rows.find((r) => r.key === ALL[0].id);
  assert.deepEqual([p0.startFrom, p0.startTo, p0.rent, p0.shareBedroom, p0.deposit, p0.transportCost], ['2027-05-20', '2027-06-15', 140, 3, 100, 20]);
  const p1 = rows.find((r) => r.key === ALL[1].id);
  assert.deepEqual([p1.rent, p1.net, p1.startFrom], [120, p1.weekly - 120, '2027-06-01']);
  await page.screenshot({ path: path.join(outDir, 'ix-panel.png') });

  // Report: filters, arrival-date window, 21+, favourites, CSV
  const [report] = await Promise.all([ctx.waitForEvent('page'), page.click('#ix-collector >> text=Открыть отчёт')]);
  report.on('pageerror', (e) => errors.push(e.message));
  await report.waitForSelector('#tb tr');
  const count = async () => +(await report.textContent('#cnt')).match(/\d+/)[0];
  assert.equal(await count(), TOTAL);
  await report.selectOption('#hs', 'provided');
  const provided = rows.filter((r) => r.housing === 'provided');
  assert.equal(await count(), provided.length);
  await report.fill('#arr', '2027-06-10'); // only Seaside (May 20–Jun 15) and Harbor (Jun 1–30) windows contain it
  const arriving = provided.filter((r) => r.startFrom <= '2027-06-10' && '2027-06-10' <= r.startTo);
  assert.equal(await count(), arriving.length);
  assert.ok(arriving.length > 0 && arriving.length < provided.length);
  await report.check('#no21');
  const final = arriving.filter((r) => !r.age21);
  assert.equal(await count(), final.length);
  const top = Math.max(...final.map((r) => r.weekly));
  assert.equal((await report.textContent('#tb tr td:nth-child(6)')).trim(), `$${top}`);
  await report.click('#tb tr .star');
  await report.check('#fav');
  assert.equal(await count(), 1);
  await report.uncheck('#fav');
  const [dl] = await Promise.all([report.waitForEvent('download'), report.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, final.length + 1, 'CSV has the shown rows');
  await report.screenshot({ path: path.join(outDir, 'ix-report.png'), fullPage: true });
  await page.close();
  await report.close();

  // 2) Generic single-page app → fallback parser + click mode
  const spa = await collect(`${base}/spa`, '#list .card');
  const spaRows = await spa.evaluate(() => window.__ixOffers);
  assert.equal(spaRows.length, SPA_TOTAL, 'all listings by clicking through pages');
  assert.deepEqual([spaRows[0].wage, spaRows[0].hours, spaRows[0].state], [14, 30, 'MD']);
  await spa.close();

  assert.deepEqual(errors, []);
  console.log('interexchange e2e: ok');
} finally {
  await browser.close();
  server.close();
}

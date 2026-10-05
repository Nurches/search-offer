import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  agoToIso, clearJobsCache, fetchBoard, jobsConfig, matchesQuery, parseBoard, searchAdzuna, searchGoogleJobs, searchJobs, searchJooble, stripHtml,
} from '../../server/jobs.js';
import { createServer } from '../../server/index.js';
import {
  analyzeJob, dedupeJobs, filterJobs, guessCategory, isUsLocation, jobToLead, parseJobLocation, safeUrl, sortJobs, vacancySearchLinks,
} from '../../public/js/jobs.js';
import { toSavedLead } from '../../public/js/store.js';
import { buildVars } from '../../public/js/outreach.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake fetch: routes by URL prefix, records every call. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) return json({ message: 'not found' }, 404);
    const r = routes[key];
    return typeof r === 'function' ? r(String(url), opts) : json(r);
  };
  impl.calls = calls;
  return impl;
}

const SERP = {
  jobs_results: [{
    title: 'Seasonal Housekeeper', company_name: 'Ocean Breeze Hotel', location: 'Ocean City, MD', via: 'via LinkedIn',
    description: 'Summer 2027 season. J-1 students welcome. Employee housing available.',
    detected_extensions: { posted_at: '3 days ago', schedule_type: 'Full-time', salary: '15–17 an hour' },
    job_id: 'eyJqb2JfdGl0bGUiOiJIb3VzZWtlZXBlciJ9',
    apply_options: [{ title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/1' }, { title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=2' }],
  }],
  serpapi_pagination: { next_page_token: 'NEXT1' },
};

test('html, dates and query matching helpers', () => {
  assert.equal(stripHtml('&lt;p&gt;Hello&amp;nbsp;&lt;b&gt;world&lt;/b&gt;&lt;/p&gt;'), 'Hello world');
  assert.equal(stripHtml('<ul><li>Pool</li><li>Beach</li></ul><script>x()</script>'), 'Pool Beach');
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(agoToIso('3 days ago', now), '2026-10-02T12:00:00.000Z');
  assert.equal(agoToIso('Posted 30+ Days Ago', now), '2026-09-05T12:00:00.000Z');
  assert.equal(agoToIso('Posted Today', now), '2026-10-05T12:00:00.000Z');
  assert.equal(agoToIso('soon', now), '');
  assert.ok(matchesQuery('Seasonal Line Cook', 'J-1 seasonal summer'));
  assert.ok(matchesQuery('We hire J1 students', 'J-1 seasonal summer'));
  assert.ok(!matchesQuery('Senior Software Engineer', 'J-1 seasonal summer'));
  assert.ok(matchesQuery('anything', ''));
  assert.ok(!matchesQuery('Summary of benefits', 'summer jobs'), 'whole word start only');
});

test('parseBoard understands career page links and rejects others', () => {
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/seaside'), { kind: 'greenhouse', token: 'seaside', name: '' });
  assert.deepEqual(parseBoard('https://job-boards.greenhouse.io/seaside/jobs/123'), { kind: 'greenhouse', token: 'seaside', name: '' });
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/embed/job_board?for=seaside'), { kind: 'greenhouse', token: 'seaside', name: '' });
  assert.deepEqual(parseBoard('Seaside Resort | jobs.lever.co/seaside-resort'), { kind: 'lever', token: 'seaside-resort', name: 'Seaside Resort' });
  assert.deepEqual(parseBoard('https://jobs.smartrecruiters.com/BeachCo'), { kind: 'smartrecruiters', token: 'BeachCo', name: '' });
  assert.deepEqual(parseBoard('https://jobs.ashbyhq.com/parkco'), { kind: 'ashby', token: 'parkco', name: '' });
  assert.deepEqual(parseBoard('greenhouse:seaside'), { kind: 'greenhouse', token: 'seaside', name: '' });
  assert.deepEqual(parseBoard('https://lodges.wd5.myworkdayjobs.com/en-US/Seasonal'), { kind: 'workday', token: 'lodges', host: 'lodges.wd5.myworkdayjobs.com', site: 'Seasonal', name: '' });
  assert.equal(parseBoard('https://lodges.wd5.myworkdayjobs.com/'), null);
  assert.equal(parseBoard('https://evil.example.com/jobs'), null);
  assert.equal(parseBoard('https://169.254.169.254/latest'), null);
  assert.equal(parseBoard('greenhouse:../../etc'), null);
  assert.equal(parseBoard(''), null);
});

test('Google Jobs via SerpApi: request and normalization', async () => {
  const f = fakeFetch({ 'https://serpapi.com/search.json': SERP });
  const r = await searchGoogleJobs({ q: 'seasonal', where: 'Maryland', key: 'K', fetchImpl: f });
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('engine'), 'google_jobs');
  assert.equal(u.searchParams.get('location'), 'Maryland, United States');
  assert.equal(u.searchParams.get('api_key'), 'K');
  assert.equal(r.next, 'NEXT1');
  const j = r.jobs[0];
  assert.match(j.id, /^google:[0-9a-f]{16}$/);
  assert.equal(j.company, 'Ocean Breeze Hotel');
  assert.equal(j.url, 'https://www.linkedin.com/jobs/view/1');
  assert.equal(j.via, 'LinkedIn');
  assert.equal(j.applyOptions.length, 2);
  assert.ok(j.postedAt);
  await searchGoogleJobs({ q: 'x', where: '', cursor: 'NEXT1', key: 'K', fetchImpl: f });
  const u2 = new URL(f.calls[1].url);
  assert.equal(u2.searchParams.get('location'), 'United States');
  assert.equal(u2.searchParams.get('next_page_token'), 'NEXT1');
  const empty = fakeFetch({ 'https://serpapi.com/': { error: "Google hasn't returned any results for this query." } });
  assert.deepEqual(await searchGoogleJobs({ q: 'zzz', key: 'K', fetchImpl: empty }), { jobs: [], next: null });
});

test('Adzuna and Jooble normalization and paging', async () => {
  const adz = fakeFetch({
    'https://api.adzuna.com/': {
      count: 120,
      results: Array.from({ length: 50 }, (_, i) => ({
        id: String(i), title: '<strong>Seasonal</strong> Server', company: { display_name: 'Crab Shack' }, created: '2026-09-30T10:00:00Z',
        location: { display_name: 'Ocean City, Worcester County', area: ['US', 'Maryland', 'Worcester County', 'Ocean City'] },
        redirect_url: `https://www.adzuna.com/details/${i}`, description: 'Summer job', salary_min: 31200, salary_max: 35000, contract_time: 'full_time',
      })),
    },
  });
  const a = await searchAdzuna({ q: 'seasonal', where: 'Maryland', appId: 'I', appKey: 'K', fetchImpl: adz });
  assert.match(adz.calls[0].url, /\/jobs\/us\/search\/1\?/);
  assert.equal(new URL(adz.calls[0].url).searchParams.get('where'), 'Maryland');
  assert.equal(a.jobs[0].title, 'Seasonal Server');
  assert.equal(a.jobs[0].location, 'Ocean City, Maryland');
  assert.equal(a.jobs[0].salary, '$31,200–35,000');
  assert.equal(a.jobs[0].type, 'full-time');
  assert.equal(a.next, '2');

  const joo = fakeFetch({ 'https://jooble.org/api/': { totalCount: 2, jobs: [{ id: 7, title: 'Lifeguard', company: 'Splash Park', location: 'Wildwood, NJ', snippet: '&nbsp;<b>Seasonal</b> lifeguard', link: 'https://jooble.org/desc/7', updated: '2026-10-01T00:00:00.000', source: 'snagajob.com' }] } });
  const b = await searchJooble({ q: 'lifeguard', where: '', key: 'SECRET', fetchImpl: joo });
  assert.equal(joo.calls[0].method, 'POST');
  assert.deepEqual(joo.calls[0].body, { keywords: 'lifeguard', location: 'USA', page: '1', ResultOnPage: '50' });
  assert.equal(b.jobs[0].description, 'Seasonal lifeguard');
  assert.equal(b.jobs[0].via, 'snagajob.com');
  assert.equal(b.next, null);
});

test('career boards: Greenhouse, Lever, SmartRecruiters, Ashby, Workday', async () => {
  const f = fakeFetch({
    'https://boards-api.greenhouse.io/v1/boards/seaside/jobs': { jobs: [
      { id: 1, title: 'Seasonal Housekeeper', absolute_url: 'https://boards.greenhouse.io/seaside/jobs/1', location: { name: 'Bar Harbor, ME' }, updated_at: '2026-09-01T00:00:00Z', content: '&lt;p&gt;Housing provided&lt;/p&gt;' },
      { id: 2, title: 'Senior Accountant', absolute_url: 'https://boards.greenhouse.io/seaside/jobs/2', location: { name: 'Boston, MA' }, content: 'Year-round role' },
    ] },
    'https://api.lever.co/v0/postings/parkco': [{ id: 'a', text: 'Ride Operator', hostedUrl: 'https://jobs.lever.co/parkco/a', categories: { location: 'Sandusky, OH', commitment: 'Seasonal' }, createdAt: 1790000000000, descriptionPlain: 'Summer' }],
    'https://api.smartrecruiters.com/v1/companies/BeachCo/postings': { content: [
      { id: '9', name: 'Summer Cashier', location: { city: 'Myrtle Beach', region: 'sc', country: 'us' }, releasedDate: '2026-09-20T00:00:00Z' },
      { id: '10', name: 'Summer Cashier', location: { city: 'Toronto', region: 'on', country: 'ca' } },
    ] },
    'https://api.ashbyhq.com/posting-api/job-board/lodge': { jobs: [{ id: 'z', title: 'Seasonal Server', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/lodge/z', address: { postalAddress: { addressLocality: 'Jackson', addressRegion: 'WY' } }, descriptionPlain: 'Dorms available' }] },
    'https://lodges.wd5.myworkdayjobs.com/wday/cxs/lodges/Seasonal/jobs': { total: 1, jobPostings: [{ title: 'Seasonal Front Desk', externalPath: '/job/Yellowstone/Front-Desk_R1', locationsText: 'Yellowstone National Park, WY', postedOn: 'Posted 2 Days Ago' }] },
  });
  const q = 'seasonal summer';
  const gh = await fetchBoard(parseBoard('Seaside Inn | boards.greenhouse.io/seaside'), { q, fetchImpl: f });
  assert.equal(gh.length, 1, 'non-matching posting filtered out');
  assert.equal(gh[0].company, 'Seaside Inn');
  assert.equal(gh[0].description, 'Housing provided');
  const lv = await fetchBoard(parseBoard('jobs.lever.co/parkco'), { q, fetchImpl: f });
  assert.equal(lv[0].company, 'Parkco');
  assert.equal(lv[0].type, 'Seasonal');
  const sr = await fetchBoard(parseBoard('jobs.smartrecruiters.com/BeachCo'), { q, fetchImpl: f });
  assert.deepEqual(sr.map((x) => x.location), ['Myrtle Beach, SC']);
  assert.equal(sr[0].url, 'https://jobs.smartrecruiters.com/BeachCo/9');
  const ab = await fetchBoard(parseBoard('jobs.ashbyhq.com/lodge'), { q, fetchImpl: f });
  assert.equal(ab[0].location, 'Jackson, WY');
  const wd = await fetchBoard(parseBoard('https://lodges.wd5.myworkdayjobs.com/en-US/Seasonal'), { q, fetchImpl: f });
  assert.equal(wd[0].url, 'https://lodges.wd5.myworkdayjobs.com/en-US/Seasonal/job/Yellowstone/Front-Desk_R1');
  const wdCall = f.calls.find((c) => c.url.includes('myworkdayjobs'));
  assert.equal(wdCall.method, 'POST');
  assert.equal(wdCall.body.searchText, q);
});

test('searchJobs runs configured sources in parallel, reports errors and caches', async () => {
  clearJobsCache();
  const env = { SERPAPI_KEY: 'S', JOOBLE_API_KEY: 'J', JOB_BOARDS: 'greenhouse:seaside, greenhouse:missing' };
  assert.deepEqual(jobsConfig(env), { google: true, adzuna: false, jooble: true, boards: 2 });
  const f = fakeFetch({
    'https://serpapi.com/': SERP,
    'https://jooble.org/api/': () => json({ message: 'Invalid key' }, 403),
    'https://boards-api.greenhouse.io/v1/boards/seaside/': { jobs: [{ id: 1, title: 'Seasonal Busser', absolute_url: 'https://x.test/1', location: { name: 'Ocean City, MD' } }] },
  });
  const r = await searchJobs({ q: 'seasonal', where: 'Maryland', boards: ['javascript:alert(1)', 'greenhouse:seaside'], env, fetchImpl: f });
  const by = Object.fromEntries(r.sources.map((s) => [s.id, s]));
  assert.equal(by.google.count, 1);
  assert.equal(by.google.next, 'NEXT1');
  assert.equal(by.adzuna.configured, false);
  assert.equal(by.jooble.ok, false);
  assert.match(by.jooble.error, /Invalid key/);
  assert.equal(by.boards.boards, 2, 'duplicates and junk links dropped');
  assert.equal(by.boards.count, 1);
  assert.match(by.boards.error, /missing.*не найдена/);
  assert.equal(r.jobs.length, 2);

  const before = f.calls.length;
  await searchJobs({ q: 'seasonal', where: 'Maryland', boards: [], env, fetchImpl: f });
  assert.equal(f.calls.filter((c) => c.url.includes('serpapi')).length, 1, 'Google result came from cache');
  assert.ok(f.calls.length > before, 'failed sources are retried');

  const more = await searchJobs({ q: 'seasonal', where: 'Maryland', cursors: { google: 'NEXT1' }, more: true, env, fetchImpl: f });
  const m = Object.fromEntries(more.sources.map((s) => [s.id, s]));
  assert.equal(m.jooble.skipped, true);
  assert.equal(m.boards.skipped, true);
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('next_page_token'), 'NEXT1');
});

test('/api/jobs route: POST only, JSON body, health exposes sources', async () => {
  const server = createServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const req = (method, path, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  try {
    assert.equal((await req('GET', '/api/jobs')).status, 405);
    assert.equal((await req('POST', '/api/jobs', '{bad')).status, 400);
    const ok = await req('POST', '/api/jobs', JSON.stringify({ q: 'seasonal', boards: [] }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.jobs, []);
    assert.deepEqual(ok.body.sources.map((s) => s.id), ['google', 'adzuna', 'jooble', 'boards']);
    const health = await req('GET', '/api/health');
    assert.equal(typeof health.body.jobs.google, 'boolean');
  } finally {
    server.close();
  }
});

test('job locations: US states, cities, abroad', () => {
  assert.deepEqual(parseJobLocation('Ocean City, MD 21842'), { city: 'Ocean City', state: 'MD' });
  assert.deepEqual(parseJobLocation('Ocean City, Maryland, United States'), { city: 'Ocean City', state: 'MD' });
  assert.deepEqual(parseJobLocation('Charleston, West Virginia'), { city: 'Charleston', state: 'WV' });
  assert.deepEqual(parseJobLocation('Yellowstone National Park, Wyoming area'), { city: '', state: 'WY' });
  assert.deepEqual(parseJobLocation('Remote'), { city: '', state: '' });
  assert.ok(isUsLocation('Multiple Locations'));
  assert.ok(isUsLocation('London, KY'));
  assert.ok(!isUsLocation('Toronto, ON'));
  assert.ok(!isUsLocation('London, United Kingdom'));
});

test('analyzeJob: J-1, housing, seasonal signals and W&T rule checks', () => {
  const good = analyzeJob({ title: 'Seasonal Housekeeper', company: 'Ocean Breeze Hotel', location: 'Ocean City, MD', description: 'J-1 students welcome! Employee housing available May–Sept.', type: '' });
  assert.equal(good.j1, true);
  assert.equal(good.housing, true);
  assert.equal(good.seasonal, true);
  assert.equal(good.state, 'MD');
  assert.equal(good.category, 'lodging');
  assert.equal(good.fit.level, 'ok');

  assert.equal(analyzeJob({ title: 'Delivery Driver', company: 'Pizza Co', location: 'Dover, DE', description: '' }).fit.level, 'bad');
  assert.equal(analyzeJob({ title: 'General Manager', company: 'Beach Grill', location: 'Destin, FL', description: '' }).fit.level, 'bad');
  assert.equal(analyzeJob({ title: 'Summer Camp Counselor', company: 'Camp Pine', location: 'ME', description: '' }).fit.level, 'bad');
  assert.equal(analyzeJob({ title: 'Housekeeper', company: 'Staffing Solutions Inc', location: 'Austin, TX', description: '' }).fit.level, 'bad');
  assert.equal(analyzeJob({ title: 'Cashier', company: 'Mart', location: 'Reno, NV', description: 'Must be a U.S. citizen' }).fit.level, 'bad');
  const sponsor = analyzeJob({ title: 'Server', company: 'Diner', location: 'Reno, NV', description: 'We do not provide visa sponsorship.' });
  assert.equal(sponsor.fit.level, 'check');
  assert.match(sponsor.fit.notes[0], /спонсор/);
  assert.equal(analyzeJob({ title: 'Lifeguard', company: 'Splash', location: 'Wildwood, NJ', description: '' }).fit.level, 'check');
  assert.equal(analyzeJob({ title: 'Barista', company: 'Cafe', location: 'Toronto, ON', description: '' }).fit.level, 'bad');
  assert.equal(guessCategory('Ride Operator'), 'amusement');
  assert.equal(guessCategory('Line Cook'), 'restaurant');
});

test('dedupe, filter, sort and saving a vacancy as a contact', () => {
  const a = analyzeJob({ id: 'google:1', source: 'google', title: 'Seasonal Server', company: 'Crab Shack', location: 'Ocean City, MD', description: 'short', url: 'https://g.test/1', postedAt: '2026-09-01T00:00:00Z' });
  const b = analyzeJob({ id: 'adzuna:1', source: 'adzuna', title: 'Seasonal Server', company: 'Crab Shack', location: 'Ocean City, Maryland', description: 'A longer description: J-1 welcome, housing', url: 'https://a.test/1', postedAt: '2026-09-20T00:00:00Z' });
  const c = analyzeJob({ id: 'jooble:1', source: 'jooble', title: 'Cashier', company: 'Mart', location: 'Reno, NV', description: '', url: 'javascript:alert(1)', postedAt: '2026-10-01T00:00:00Z' });
  const d = analyzeJob({ id: 'boards:1', source: 'boards', title: 'Engineer', company: 'Tech', location: '', description: '' });
  const list = dedupeJobs([a, b, c, d]);
  assert.equal(list.length, 3);
  const merged = list.find((x) => x.company === 'Crab Shack');
  assert.equal(merged.id, 'google:1');
  assert.deepEqual(merged.sources, ['google', 'adzuna']);
  assert.ok(merged.j1 && merged.housing);
  assert.equal(merged.postedAt, '2026-09-20T00:00:00Z');
  assert.ok(merged.applyOptions.some((o) => o.url === 'https://a.test/1'));

  assert.deepEqual(filterJobs(list, { state: 'MD' }).map((x) => x.company), ['Crab Shack', 'Tech'], 'unknown state kept');
  assert.deepEqual(filterJobs(list, { j1Only: true }).map((x) => x.company), ['Crab Shack']);
  assert.deepEqual(filterJobs(list, { source: 'adzuna' }).map((x) => x.company), ['Crab Shack']);
  assert.deepEqual(filterJobs(list, { fit: 'bad' }).map((x) => x.company), ['Tech']);
  assert.deepEqual(sortJobs(list).map((x) => x.company), ['Crab Shack', 'Mart', 'Tech']);
  assert.deepEqual(sortJobs(list, 'date').map((x) => x.company), ['Mart', 'Crab Shack', 'Tech']);

  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl(' https://x.test/a '), 'https://x.test/a');
  const lead = jobToLead(c);
  assert.equal(lead.jobUrl, '');
  const saved = toSavedLead(jobToLead(merged));
  assert.equal(saved.id, 'job:crab-shack:MD');
  assert.equal(saved.jobTitle, 'Seasonal Server');
  assert.equal(saved.jobUrl, 'https://g.test/1');
  assert.match(saved.notes, /Вакансия: Seasonal Server/);
  assert.equal(buildVars({}, saved).positionTitle, 'Seasonal Server');
  assert.equal(buildVars({}, saved, { positionTitle: 'Busser' }).positionTitle, 'Busser');
});

test('vacancy search links for platforms without an API', () => {
  const links = vacancySearchLinks('seasonal housekeeper', 'ME');
  assert.ok(links.length >= 10);
  const indeed = new URL(links.find((l) => l.label === 'Indeed').url);
  assert.equal(indeed.searchParams.get('q'), 'seasonal housekeeper');
  assert.equal(indeed.searchParams.get('l'), 'Maine');
  assert.ok(links.every((l) => l.url.startsWith('https://')));
  assert.match(vacancySearchLinks('', '').find((l) => l.label === 'LinkedIn').url, /location=United%20States/);
});

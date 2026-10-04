import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmails, cleanEmail, rankEmails, pickContactLinks, isPrivateIp, decodeCfEmail, safeFetchText, findEmailsOnSite } from '../../server/emails.js';
import { parseUsAddress, placeToLead, searchPlaces } from '../../server/places.js';
import { createServer } from '../../server/index.js';
import http from 'node:http';

const rawStatus = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

function cfEncode(email, key = 0x42) {
  return key.toString(16).padStart(2, '0') + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

test('extractEmails handles mailto, text, entities, obfuscation and Cloudflare', () => {
  const html = `
    <a href="mailto:Jobs@SeaHotel.com?subject=hi">Email us</a>
    <p>Reach us: info&#64;seahotel.com or hr [at] seahotel [dot] com</p>
    <span class="__cf_email__" data-cfemail="${cfEncode('manager@seahotel.com')}">[email protected]</span>
    <img src="logo@2x.png"> <script>dsn="https://abcdef0123456789abcdef@sentry.io/1"</script>
    <p>user@example.com, noreply@seahotel.com</p>`;
  const emails = extractEmails(html).sort();
  assert.deepEqual(emails, ['hr@seahotel.com', 'info@seahotel.com', 'jobs@seahotel.com', 'manager@seahotel.com']);
  assert.equal(decodeCfEmail(cfEncode('a@b.co')), 'a@b.co');
});

test('cleanEmail rejects junk', () => {
  assert.equal(cleanEmail('u003einfo@x.com'), 'info@x.com');
  assert.equal(cleanEmail('%20info@x.com.'), 'info@x.com');
  assert.equal(cleanEmail('image@2x.jpg'), null);
  assert.equal(cleanEmail('test@wixpress.com'), null);
  assert.equal(cleanEmail('20west@x.com'), '20west@x.com');
});

test('rankEmails prefers HR on own domain', () => {
  const r = rankEmails(['someone.else@gmail.com', 'info@seahotel.com', 'careers@seahotel.com'], 'www.seahotel.com');
  assert.deepEqual(r, ['careers@seahotel.com', 'info@seahotel.com', 'someone.else@gmail.com']);
});

test('pickContactLinks finds same-site contact/careers pages', () => {
  const html = `
    <a href="/about-us">About</a><a href="https://seahotel.com/employment">Jobs</a>
    <a href="/contact">Contact Us</a><a href="https://facebook.com/contact">FB</a>
    <a href="/menu.pdf">Menu</a><a href="mailto:x@y.com">mail</a><a href="/rooms">Rooms</a>`;
  const links = pickContactLinks(html, 'https://www.seahotel.com/');
  assert.deepEqual(links, ['https://seahotel.com/employment', 'https://www.seahotel.com/contact', 'https://www.seahotel.com/about-us']);
});

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

function fakeFetch(routes) {
  return async (url) => {
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    if (r.redirect) return new Response(null, { status: 301, headers: { location: r.redirect } });
    return new Response(r.html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

test('safeFetchText re-checks every redirect hop', async () => {
  const checked = [];
  const checkUrl = async (u) => {
    checked.push(u.href);
    if (u.hostname === '169.254.169.254') throw new Error('Адрес недоступен');
  };
  const fetchImpl = fakeFetch({ 'https://evil.com/': { redirect: 'http://169.254.169.254/latest' } });
  await assert.rejects(safeFetchText('https://evil.com/', { fetchImpl, checkUrl }), /недоступен/);
  assert.deepEqual(checked, ['https://evil.com/', 'http://169.254.169.254/latest']);
});

test('findEmailsOnSite crawls homepage and contact pages', async () => {
  const fetchImpl = fakeFetch({
    'https://seahotel.test/': { html: '<a href="/careers">Careers</a><a href="/contact">Contact</a><footer>info@seahotel.test</footer>' },
    'https://seahotel.test/careers': { html: '<a href="mailto:jobs@seahotel.test">Apply</a>' },
    'https://seahotel.test/contact': { html: 'Call us' },
  });
  const r = await findEmailsOnSite('seahotel.test', { fetchImpl, checkUrl: async () => {} });
  assert.deepEqual(r.emails, ['jobs@seahotel.test', 'info@seahotel.test']);
  assert.equal(r.pages.length, 3);
});

test('places parsing and request shape', async () => {
  assert.deepEqual(parseUsAddress('123 Main St, Ocean City, MD 21842, USA'), { city: 'Ocean City', state: 'MD' });
  const lead = placeToLead({ id: 'abc', displayName: { text: 'Sea Hotel' }, formattedAddress: '1 Boardwalk, Ocean City, MD 21842, USA', location: { latitude: 38.3, longitude: -75.1 }, googleMapsUri: 'https://maps.google.com/?cid=1', rating: 4.5 });
  assert.equal(lead.id, 'g:abc');
  assert.equal(lead.state, 'MD');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const page = calls.length;
    return new Response(JSON.stringify({
      places: [{ id: `p${page}`, displayName: { text: `Place ${page}` }, formattedAddress: 'X, Ocean City, MD 21842, USA', location: { latitude: 38, longitude: -75 } },
        { id: 'closed', businessStatus: 'CLOSED_PERMANENTLY', displayName: { text: 'Closed' }, location: { latitude: 38, longitude: -75 } }],
      nextPageToken: page < 2 ? 'tok' : undefined,
    }), { status: 200 });
  };
  const places = await searchPlaces({ apiKey: 'k', query: 'hotels in Ocean City, MD', lat: 38.3, lon: -75.1, radius: 8000, fetchImpl });
  assert.equal(places.length, 2);
  assert.equal(calls[1].pageToken, 'tok');
  assert.equal(calls[0].locationBias.circle.radius, 8000);
});

test('server: health, static, traversal, unknown api', async () => {
  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.app, 'wt-job-finder');
    assert.equal(h.emails, true);
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /W&amp;T Job Finder/);
    const js = await fetch(`${base}/js/app.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(await rawStatus(srv.address().port, '/..%2f..%2fpackage.json'), 403);
    assert.equal(await rawStatus(srv.address().port, '/../server/index.js'), 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/emails`)).status, 400);
    const bad = await fetch(`${base}/api/emails?url=${encodeURIComponent('http://127.0.0.1:22/')}`);
    assert.equal(bad.status, 500);
    assert.equal((await fetch(`${base}/api/places?q=x`)).status, 501);
  } finally {
    srv.close();
  }
});

// Vercel calls api/*.js with Node req/res, plus a lazily parsed req.body.
function fakeRes() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b ?? ''; },
  };
}

test('vercel functions: health, parsed form body, methods, missing key', async () => {
  const { default: health } = await import('../../api/health.js');
  const { default: overpass } = await import('../../api/overpass.js');
  const { default: places } = await import('../../api/places.js');
  const { default: emails } = await import('../../api/emails.js');
  const base = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };

  let res = fakeRes();
  await health({ ...base, method: 'GET', url: '/api/health' }, res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).app, 'wt-job-finder');

  res = fakeRes();
  await overpass({ ...base, method: 'POST', url: '/api/overpass', body: { data: 'not a query' } }, res);
  assert.equal(res.status, 400);

  res = fakeRes();
  await overpass({ ...base, method: 'POST', url: '/api/overpass', body: 'data=nope' }, res);
  assert.equal(res.status, 400);

  res = fakeRes();
  await overpass({ ...base, method: 'GET', url: '/api/overpass' }, res);
  assert.equal(res.status, 405);

  res = fakeRes();
  await emails({ ...base, method: 'OPTIONS', url: '/api/emails' }, res);
  assert.equal(res.status, 204);

  const prev = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  res = fakeRes();
  await places({ ...base, method: 'GET', url: '/api/places?q=x' }, res);
  assert.equal(res.status, 501);
  if (prev !== undefined) process.env.GOOGLE_MAPS_API_KEY = prev;
});

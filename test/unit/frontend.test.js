import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverpassQuery, parseOverpass, assessFit, classify, normalizeUrl, splitEmails, sortLeads } from '../../public/js/search.js';
import { composeEmail, gmailComposeUrl, googleMapsUrl, googleMapsEmbedUrl, DEFAULT_TEMPLATES, jobBoardLinks } from '../../public/js/outreach.js';
import { leadsToCsv, toSavedLead } from '../../public/js/store.js';
import { HOTSPOTS, STATE_BY_CODE, CATEGORIES } from '../../public/js/data.js';

test('around query includes categories, radius and name filter', () => {
  const q = buildOverpassQuery({ lat: 38.3365, lon: -75.0849, radiusM: 8000, categoryIds: ['lodging', 'cafe'] });
  assert.match(q, /^\[out:json\]\[timeout:60\];/);
  assert.match(q, /nwr\["tourism"~"\^\(hotel\|motel\|resort\|hostel\|guest_house\|apartment\)\$"\]\["name"\]\(around:8000,38\.33650,-75\.08490\);/);
  assert.match(q, /nwr\["amenity"~"\^\(cafe\|ice_cream\)\$"\]/);
  assert.doesNotMatch(q, /restaurant/);
  assert.match(q, /out center 400;$/);
});

test('state query uses ISO area and contact filters', () => {
  const q = buildOverpassQuery({ mode: 'state', stateCode: 'ME', categoryIds: ['lodging'], contacts: 'email', limit: 600 });
  assert.match(q, /area\["ISO3166-2"="US-ME"\]\["admin_level"="4"\]->\.st;/);
  assert.match(q, /\["email"\]\(area\.st\);/);
  assert.match(q, /\["contact:email"\]\(area\.st\);/);
  assert.match(q, /out center 600;/);
});

test('query validation errors', () => {
  assert.throws(() => buildOverpassQuery({ lat: NaN, lon: 1, categoryIds: ['lodging'] }), /город/);
  assert.throws(() => buildOverpassQuery({ mode: 'state', stateCode: 'XX', categoryIds: ['lodging'] }), /штат/);
});

test('parseOverpass builds leads, dedupes and reads contacts', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 38.33, lon: -75.08, tags: { name: 'Sea Hotel', tourism: 'hotel', email: 'Info@SeaHotel.com; jobs@seahotel.com', website: 'seahotel.com', 'addr:housenumber': '1', 'addr:street': 'Boardwalk', 'addr:city': 'Ocean City', 'addr:state': 'MD' } },
      { type: 'way', id: 2, center: { lat: 38.3301, lon: -75.0801 }, tags: { name: 'Sea Hotel', tourism: 'hotel' } },
      { type: 'node', id: 3, lat: 38.34, lon: -75.09, tags: { name: 'Fun Staffing LLC', amenity: 'restaurant' } },
      { type: 'node', id: 4, lat: 38.34, lon: -75.09, tags: { amenity: 'restaurant' } },
      { type: 'node', id: 5, lat: 38.34, lon: -75.09, tags: { name: 'Bank', amenity: 'bank' } },
    ],
  };
  const leads = parseOverpass(json, { center: { lat: 38.3365, lon: -75.0849 }, city: 'Ocean City', state: 'MD' });
  assert.equal(leads.length, 2);
  const hotel = leads.find((l) => l.name === 'Sea Hotel');
  assert.equal(hotel.id, 'osm:node/1');
  assert.deepEqual(hotel.emails, ['info@seahotel.com', 'jobs@seahotel.com']);
  assert.equal(hotel.website, 'https://seahotel.com');
  assert.equal(hotel.address, '1 Boardwalk, Ocean City, MD');
  assert.equal(hotel.fit.level, 'ok');
  assert.ok(hotel.distanceKm < 2);
  const agency = leads.find((l) => l.name.includes('Staffing'));
  assert.equal(agency.fit.level, 'bad');
});

test('fit assessment flags rule-breaking businesses', () => {
  assert.equal(assessFit('Sunny Day Care Center', 'restaurant').level, 'bad');
  assert.equal(assessFit('Golden Nugget Casino', 'lodging').level, 'check');
  assert.equal(assessFit('Joe\'s Pub', 'bars').level, 'check');
  assert.equal(assessFit('Dumser\'s Dairyland', 'cafe').level, 'ok');
  assert.equal(classify({ shop: 'souvenir' }), 'retail');
  assert.equal(classify({ shop: 'car_repair' }), null);
});

test('helpers', () => {
  assert.equal(normalizeUrl('www.x.com;www.y.com'), 'https://www.x.com');
  assert.equal(normalizeUrl('http://x.com'), 'http://x.com');
  assert.deepEqual(splitEmails('a@b.co, A@B.co'), ['a@b.co']);
  const sorted = sortLeads([{ name: 'B', emails: [], distanceKm: 1 }, { name: 'A', emails: ['x@y.z'], distanceKm: 5 }]);
  assert.equal(sorted[0].name, 'A');
});

test('email composition fills profile and business', () => {
  const profile = { name: 'Test Student', university: 'Satbayev University', studyYear: '2nd-year', resumeLink: 'https://drive.google.com/x' };
  const lead = { name: 'Sea Hotel', category: 'lodging', city: 'Ocean City', state: 'MD' };
  const { subject, body } = composeEmail(DEFAULT_TEMPLATES, 'cold', profile, lead);
  assert.match(subject, /Summer 2027/);
  assert.match(subject, /Kazakhstan/);
  assert.match(body, /Dear Sea Hotel Hiring Team/);
  assert.match(body, /Ocean City, MD/);
  assert.match(body, /housekeeper/);
  assert.match(body, /InterExchange/);
  assert.doesNotMatch(body, /\{\{/);
  const v = composeEmail(DEFAULT_TEMPLATES, 'vacancy', profile, lead, { positionTitle: 'Housekeeper' });
  assert.match(v.subject, /Application for Housekeeper/);
});

test('gmail and maps links', () => {
  const g = new URL(gmailComposeUrl({ to: 'a@b.com', subject: 'Hi there', body: 'Line1\nLine2', authuser: 'me@gmail.com' }));
  assert.equal(g.hostname, 'mail.google.com');
  assert.equal(g.searchParams.get('view'), 'cm');
  assert.equal(g.searchParams.get('to'), 'a@b.com');
  assert.equal(g.searchParams.get('body'), 'Line1\nLine2');
  assert.equal(g.searchParams.get('authuser'), 'me@gmail.com');
  const m = new URL(googleMapsUrl({ name: 'Sea Hotel', address: '1 Boardwalk, Ocean City, MD' }));
  assert.equal(m.searchParams.get('query'), 'Sea Hotel, 1 Boardwalk, Ocean City, MD');
  assert.equal(googleMapsUrl({ name: 'X', gmapsUrl: 'https://maps.google.com/?cid=1' }), 'https://maps.google.com/?cid=1');
  const e = new URL(googleMapsEmbedUrl({ name: 'Sea Hotel', city: 'Ocean City', state: 'MD', lat: 38.3, lon: -75 }));
  assert.equal(e.searchParams.get('output'), 'embed');
  assert.equal(e.searchParams.get('ll'), '38.3,-75');
  assert.ok(jobBoardLinks('Ocean City', 'MD').every((l) => l.url.startsWith('https://')));
});

test('saved lead + csv', () => {
  const s = toSavedLead({ id: 'osm:node/1', name: 'A, "B"', emails: ['x@y.com'], extra: 1 });
  assert.equal(s.status, 'new');
  assert.equal(s.extra, undefined);
  const csv = leadsToCsv([s]);
  assert.match(csv, /"A, ""B"""/);
});

test('data integrity', () => {
  const ids = new Set();
  for (const h of HOTSPOTS) {
    assert.ok(STATE_BY_CODE[h.state], `${h.id} state`);
    assert.ok(!ids.has(h.id), `${h.id} duplicate`);
    ids.add(h.id);
    assert.ok(h.lat > 18 && h.lat < 72 && h.lon > -180 && h.lon < -66, `${h.id} coords`);
  }
  assert.equal(Object.keys(STATE_BY_CODE).length, 51);
  for (const c of CATEGORIES) for (const [, re] of c.selectors) new RegExp(re);
});

test('pair mode: "we" templates, both names and contacts, partner CC', async () => {
  const { DEFAULT_TEMPLATES_PAIR, partnerCc, mailtoUrl } = await import('../../public/js/outreach.js');
  const profile = {
    searchMode: 'pair', name: 'Student One', partnerName: 'Student Two', university: 'Test University',
    phone: '+7 700 000 0001', email: 'one@example.org', partnerEmail: 'two@example.org', resumeLink: 'https://drive.google.com/joint',
  };
  const lead = { name: 'Sea Hotel', category: 'lodging', city: 'Ocean City', state: 'MD' };
  const { subject, body } = composeEmail(DEFAULT_TEMPLATES_PAIR, 'cold', profile, lead);
  assert.match(subject, /Two J-1/);
  assert.match(body, /together with my friend Student Two we are both students at Test University/);
  assert.match(body, /Upper-Intermediate \(B2\) \(both\)/);
  assert.match(body, /we both have experience/);
  assert.match(body, /job offer for each of us/);
  assert.match(body, /Student One and Student Two\nStudent One: \+7 700 000 0001, one@example\.org\nStudent Two: two@example\.org$/);
  assert.doesNotMatch(body, /\{\{/);
  const diff = composeEmail(DEFAULT_TEMPLATES_PAIR, 'cold', { ...profile, partnerUniversity: 'Other Uni', partnerEnglish: 'B1' }, lead).body;
  assert.match(diff, /students at Test University and Other Uni/);
  assert.match(diff, /Student One – Upper-Intermediate \(B2\), Student Two – B1/);
  assert.equal(partnerCc(profile), 'two@example.org');
  assert.equal(partnerCc({ ...profile, ccPartner: 'no' }), '');
  assert.equal(partnerCc({ ...profile, searchMode: 'solo' }), '');
  assert.equal(new URL(gmailComposeUrl({ to: 'a@b.com', cc: 'two@example.org' })).searchParams.get('cc'), 'two@example.org');
  assert.match(mailtoUrl({ to: 'a@b.com', cc: 'c@d.com' }), /\?cc=c%40d\.com&subject=/);
  // solo templates untouched
  assert.match(composeEmail(DEFAULT_TEMPLATES, 'cold', { ...profile, searchMode: 'solo' }, lead).body, /^Dear Sea Hotel Hiring Team,\n\nMy name is Student One, and I am/);
});

test('merging a friend\'s backup keeps the furthest status and all history', async () => {
  const { mergeLeads } = await import('../../public/js/store.js');
  const mine = { id: 'osm:node/1', name: 'Sea Hotel', status: 'emailed', emails: ['a@x.com'], notes: 'my note', history: [{ at: '2026-10-05T10:00:00Z', action: 'cold' }], lastContactAt: '2026-10-05T10:00:00Z', addedAt: '2026-10-04T00:00:00Z' };
  const hers = { id: 'osm:node/1', name: 'Sea Hotel', status: 'replied', emails: ['hr@x.com'], notes: 'manager Kate', history: [{ at: '2026-10-05T10:00:00Z', action: 'cold' }, { at: '2026-10-08T09:00:00Z', action: 'status:replied' }], lastContactAt: '2026-10-05T10:00:00Z', addedAt: '2026-10-03T00:00:00Z' };
  const m = mergeLeads(mine, hers);
  assert.equal(m.status, 'replied');
  assert.deepEqual(m.emails, ['a@x.com', 'hr@x.com']);
  assert.equal(m.history.length, 2);
  assert.equal(m.notes, 'my note | manager Kate');
  assert.equal(m.addedAt, '2026-10-03T00:00:00Z');
  assert.equal(mergeLeads(hers, mine).status, 'replied');
});

test('state city list: query, parsing and matching', async () => {
  const { buildCityListQuery, parseCityList, matchCities } = await import('../../public/js/search.js');
  const q = buildCityListQuery('AK');
  assert.match(q, /area\["ISO3166-2"="US-AK"\]/);
  assert.match(q, /node\["place"~"\^\(city\|town\|village\)\$"\]\["name"\]\(area\.st\);/);
  const list = parseCityList({ elements: [
    { type: 'node', lat: 61.2, lon: -149.9, tags: { name: 'Anchorage', place: 'city', population: '291,247' } },
    { type: 'node', lat: 64.8, lon: -147.7, tags: { name: 'Fairbanks', place: 'city', population: '32515' } },
    { type: 'node', lat: 60.1, lon: -149.4, tags: { name: 'Seward', place: 'town', population: '2717' } },
    { type: 'node', lat: 59.6, lon: -151.5, tags: { name: 'Homer', place: 'town' } },
    { type: 'node', lat: 59.6, lon: -151.5, tags: { name: 'Homer', place: 'village' } },
    { type: 'node', tags: { name: 'NoCoords', place: 'town' } },
  ] }, 'AK');
  assert.deepEqual(list.map((c) => c.name), ['Anchorage', 'Fairbanks', 'Seward', 'Homer']);
  assert.equal(list[0].pop, 291247);
  assert.deepEqual(matchCities(list, 'an').map((c) => c.name), ['Anchorage', 'Fairbanks']);
  assert.deepEqual(matchCities(list, 'SEW').map((c) => c.name), ['Seward']);
  assert.equal(matchCities(list, '', 2).length, 2);
});

test('housing: question in emails can be switched off, housing links', async () => {
  const { DEFAULT_TEMPLATES_PAIR, housingLinks } = await import('../../public/js/outreach.js');
  const lead = { name: 'Sea Hotel', category: 'lodging', city: 'Ocean City', state: 'MD', address: '1 Boardwalk, Ocean City, MD' };
  const pair = composeEmail(DEFAULT_TEMPLATES_PAIR, 'cold', { searchMode: 'pair', name: 'A', partnerName: 'B' }, lead).body;
  assert.match(pair, /employee housing for two people/);
  const solo = composeEmail(DEFAULT_TEMPLATES, 'cold', { searchMode: 'solo', name: 'A' }, lead).body;
  assert.match(solo, /do you provide employee housing, or could you help me/);
  const off = composeEmail(DEFAULT_TEMPLATES, 'cold', { searchMode: 'solo', name: 'A', housingNeed: 'no' }, lead).body;
  assert.doesNotMatch(off, /housing, or could/);
  assert.doesNotMatch(off, /\n{3,}/);
  const links = housingLinks(lead);
  assert.ok(links.length >= 5);
  assert.match(links[0].url, /google\.com\/maps\/search\/apartments%20for%20rent%20near%201%20Boardwalk/);
});

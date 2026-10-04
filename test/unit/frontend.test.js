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

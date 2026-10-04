// Finding businesses: OpenStreetMap (Overpass), optional Google Places via our server,
// and city geocoding (Photon autocomplete, Nominatim fallback).
import { CATEGORIES, CATEGORY_BY_ID, NAME_FLAGS, STATE_BY_CODE, STATE_BY_NAME } from './data.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const CONTACT_FILTERS = {
  any: [''],
  website: ['["website"]', '["contact:website"]', '["email"]', '["contact:email"]'],
  email: ['["email"]', '["contact:email"]'],
};

/**
 * Builds an Overpass QL query.
 * mode 'around': lat/lon/radiusM required. mode 'state': stateCode required (whole state).
 */
export function buildOverpassQuery({ mode = 'around', lat, lon, radiusM = 8000, stateCode, categoryIds, contacts = 'any', limit = 400 }) {
  const cats = (categoryIds?.length ? categoryIds : CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id))
    .map((id) => CATEGORY_BY_ID[id]).filter(Boolean);
  if (!cats.length) throw new Error('Выбери хотя бы одну категорию');
  const selectors = cats.flatMap((cat) => cat.selectors);

  if (mode === 'state') {
    if (!STATE_BY_CODE[stateCode]) throw new Error('Выбери штат');
    // Whole state: one index lookup for places that have contacts, then cheap in-memory category
    // filters. Scanning every category across a whole state times out on public Overpass servers.
    const keys = contacts === 'website'
      ? ['email', 'contact:email', 'website', 'contact:website']
      : ['email', 'contact:email'];
    return `[out:json][timeout:170][maxsize:536870912];
area["ISO3166-2"="US-${stateCode}"]["admin_level"="4"]->.st;
(
${keys.map((k) => `  nwr["${k}"]["name"](area.st);`).join('\n')}
)->.c;
(
${selectors.map(([key, re]) => `  nwr.c["${key}"~"${re}"];`).join('\n')}
);
out center ${limit};`;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Выбери город');
  const scope = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const contactFilters = CONTACT_FILTERS[contacts] || CONTACT_FILTERS.any;
  const lines = [];
  for (const [key, re] of selectors) {
    for (const cf of contactFilters) lines.push(`  nwr["${key}"~"${re}"]["name"]${cf}${scope};`);
  }
  return `[out:json][timeout:60];\n(\n${lines.join('\n')}\n);\nout center ${limit};`;
}

export function classify(tags) {
  for (const cat of CATEGORIES) {
    for (const [key, re] of cat.selectors) {
      if (tags[key] && new RegExp(re).test(tags[key])) return cat.id;
    }
  }
  return null;
}

/** W&T eligibility estimate from category + name keywords. level: ok | check | bad */
export function assessFit(name, categoryId) {
  const notes = [];
  let level = 'ok';
  const rank = { ok: 0, check: 1, bad: 2 };
  const bump = (l, note) => {
    if (rank[l] > rank[level]) level = l;
    if (note && !notes.includes(note)) notes.push(note);
  };
  const cat = CATEGORY_BY_ID[categoryId];
  if (cat?.fit) bump(cat.fit.level, cat.fit.note);
  for (const flag of NAME_FLAGS) {
    if (flag.re.test(name || '')) bump(flag.level, flag.note);
  }
  return { level, notes };
}

export function normalizeUrl(u) {
  if (!u) return '';
  const s = String(u).trim().split(/[;\s]/)[0];
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function splitEmails(v) {
  if (!v) return [];
  return [...new Set((String(v).match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
}

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatAddress(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const cityLine = [tags['addr:city'], [tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, cityLine].filter(Boolean).join(', ');
}

/** Converts an Overpass response to lead objects. ctx: { center, city, state } */
export function parseOverpass(json, ctx = {}) {
  const seen = new Map();
  for (const el of json?.elements || []) {
    const tags = el.tags || {};
    const name = (tags.name || '').trim();
    if (!name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const category = classify(tags);
    if (!category) continue;

    const emails = splitEmails([tags.email, tags['contact:email']].filter(Boolean).join(';'));
    const lead = {
      id: `osm:${el.type}/${el.id}`,
      source: 'osm',
      name,
      category,
      brand: tags.brand || '',
      address: formatAddress(tags),
      city: tags['addr:city'] || ctx.city || '',
      state: (tags['addr:state'] || ctx.state || '').toUpperCase().slice(0, 2),
      lat, lon,
      phone: tags.phone || tags['contact:phone'] || '',
      website: normalizeUrl(tags.website || tags['contact:website'] || tags.url),
      emails,
      facebook: normalizeUrl(tags['contact:facebook'] || ''),
      hours: tags.opening_hours || '',
      fit: assessFit(name, category),
      distanceKm: ctx.center ? haversineKm(ctx.center, { lat, lon }) : null,
    };
    // Same business mapped as both node and building: keep the richer record.
    const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    const prev = seen.get(key);
    if (!prev || richness(lead) > richness(prev)) seen.set(key, lead);
  }
  return [...seen.values()];
}

function richness(l) {
  return (l.emails.length ? 4 : 0) + (l.website ? 2 : 0) + (l.phone ? 1 : 0) + (l.address ? 1 : 0);
}

export function sortLeads(leads, by = 'contacts') {
  const arr = [...leads];
  if (by === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (by === 'distance') arr.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  else if (by === 'rating') arr.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  else arr.sort((a, b) => richness(b) - richness(a) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return arr;
}

async function fetchWithTimeout(url, opts = {}, ms = 90000) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const outer = opts.signal;
  if (outer) outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new Error(`не успел ответить за ${Math.round(ms / 1000)} сек`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs an Overpass query via our server (if any) or directly against public mirrors.
 * endpoints/perTryMs/maxTries let heavy queries skip the server (60 s limit on Vercel) and fail fast.
 */
export async function runOverpass(query, {
  apiBase = null, signal, onAttempt, endpoints = OVERPASS_ENDPOINTS, perTryMs = 90000, maxTries = Infinity,
} = {}) {
  const targets = (apiBase ? [`${apiBase}api/overpass`, ...endpoints] : endpoints).slice(0, maxTries);
  let lastErr;
  for (const [i, url] of targets.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onAttempt?.(url, i + 1, targets.length);
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      }, perTryMs);
      if (!res.ok) throw new Error(res.status === 429 ? 'сервер перегружен (429)' : res.status === 504 ? 'сервер не успел (504)' : `HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark) && !json.elements?.length) {
        throw new Error('запрос слишком большой для сервера');
      }
      return json;
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      lastErr = e;
    }
  }
  throw new Error(`OpenStreetMap не ответил: ${lastErr?.message || 'ошибка сети'}.`);
}

/** Google Places search through our server (needs GOOGLE_MAPS_API_KEY on the server). */
export async function searchGooglePlaces({ apiBase, query, lat, lon, radiusM, signal }) {
  const params = new URLSearchParams({ q: query });
  if (Number.isFinite(lat)) {
    params.set('lat', lat);
    params.set('lon', lon);
    params.set('radius', Math.round(radiusM || 8000));
  }
  const res = await fetchWithTimeout(`${apiBase}api/places?${params}`, { signal }, 60000);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Google Places: HTTP ${res.status}`);
  return json.places || [];
}

export function stateFromName(nameOrCode) {
  if (!nameOrCode) return '';
  const s = String(nameOrCode).trim();
  if (STATE_BY_CODE[s.toUpperCase()]) return s.toUpperCase();
  return STATE_BY_NAME[s.toLowerCase()]?.code || '';
}

/** City autocomplete via Photon (komoot). Returns [{name, state, lat, lon, label}] */
export async function suggestCities(q, { stateCode, signal } = {}) {
  if (!q || q.trim().length < 2) return [];
  const params = new URLSearchParams({ q: stateCode ? `${q}, ${STATE_BY_CODE[stateCode]?.name || ''}` : q, limit: '10', lang: 'en' });
  ['place:city', 'place:town', 'place:village', 'place:hamlet', 'place:suburb', 'place:island'].forEach((t) => params.append('osm_tag', t));
  params.set('bbox', '-179.9,18.5,-66.5,71.5');
  const res = await fetchWithTimeout(`https://photon.komoot.io/api/?${params}`, { signal }, 15000);
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const json = await res.json();
  return (json.features || [])
    .filter((f) => (f.properties?.countrycode || '').toUpperCase() === 'US')
    .map((f) => {
      const st = stateFromName(f.properties.state);
      return {
        name: f.properties.name,
        state: st,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        label: `${f.properties.name}${st ? `, ${st}` : ''}${f.properties.county ? ` · ${f.properties.county}` : ''}`,
      };
    })
    .filter((c) => !stateCode || c.state === stateCode);
}

/** One-shot geocode via Nominatim. */
export async function geocodeCity(city, stateCode, { signal } = {}) {
  const q = [city, STATE_BY_CODE[stateCode]?.name].filter(Boolean).join(', ');
  const params = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'us', limit: '1', addressdetails: '1' });
  const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?${params}`, { signal, headers: { 'Accept-Language': 'en' } }, 15000);
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit) return null;
  return {
    name: hit.address?.city || hit.address?.town || hit.address?.village || hit.name || city,
    state: stateFromName(hit.address?.state) || stateCode,
    lat: Number(hit.lat),
    lon: Number(hit.lon),
  };
}

// ---------- per-state city list (for the city picker) ----------
export function buildCityListQuery(stateCode) {
  if (!STATE_BY_CODE[stateCode]) throw new Error('Выбери штат');
  return `[out:json][timeout:90];\narea["ISO3166-2"="US-${stateCode}"]["admin_level"="4"]->.st;\nnode["place"~"^(city|town|village)$"]["name"](area.st);\nout 4000;`;
}

/** Overpass places → [{name, state, lat, lon, pop}] sorted by population. */
export function parseCityList(json, stateCode) {
  const seen = new Set();
  const out = [];
  for (const el of json?.elements || []) {
    const name = (el.tags?.['name:en'] || el.tags?.name || '').trim();
    if (!name || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const pop = parseInt(String(el.tags.population || '').replace(/[^\d]/g, ''), 10) || 0;
    const rank = { city: 2, town: 1, village: 0 }[el.tags.place] ?? 0;
    out.push({ name, state: stateCode, lat: el.lat, lon: el.lon, pop, rank });
  }
  return out.sort((a, b) => b.pop - a.pop || b.rank - a.rank || a.name.localeCompare(b.name));
}

/** Filters a city list by typed text: prefix matches first, then contains; bigger places first. */
export function matchCities(list, q, limit = 12) {
  const s = q.trim().toLowerCase();
  if (!s) return list.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    if (n.startsWith(s)) starts.push(c);
    else if (n.includes(s)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

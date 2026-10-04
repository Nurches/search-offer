// Google Places API (New) Text Search → lead objects. Needs GOOGLE_MAPS_API_KEY.
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.googleMapsUri', 'places.rating', 'places.userRatingCount',
  'places.businessStatus', 'nextPageToken',
].join(',');

export function parseUsAddress(formatted = '') {
  // "123 Main St, Ocean City, MD 21842, USA"
  const parts = formatted.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts[parts.length - 1] && /^(USA|United States)$/i.test(parts[parts.length - 1])) parts.pop();
  const stZip = parts.pop() || '';
  const state = (stZip.match(/\b([A-Z]{2})\b/) || [])[1] || '';
  const city = parts.pop() || '';
  return { city, state };
}

export function placeToLead(p) {
  const { city, state } = parseUsAddress(p.formattedAddress);
  return {
    id: `g:${p.id}`,
    source: 'google',
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    city,
    state,
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    phone: p.nationalPhoneNumber || '',
    website: p.websiteUri || '',
    emails: [],
    placeId: p.id,
    gmapsUrl: p.googleMapsUri || '',
    rating: p.rating || null,
    ratingCount: p.userRatingCount || 0,
  };
}

export async function searchPlaces({ apiKey, query, lat, lon, radius, maxPages = 3, fetchImpl = fetch }) {
  const out = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const body = { textQuery: query, pageSize: 20, languageCode: 'en', regionCode: 'US' };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(Math.max(radius || 8000, 500), 50000) } };
    }
    if (pageToken) body.pageToken = pageToken;
    const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Google Places HTTP ${res.status}`);
    for (const p of json.places || []) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      const lead = placeToLead(p);
      if (lead.name && Number.isFinite(lead.lat)) out.push(lead);
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

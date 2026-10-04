// Persistent state in localStorage (per browser). Everything is wrapped in try/catch so
// private mode / blocked storage degrades to in-memory state instead of crashing.
const mem = {};

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch { /* storage unavailable */ }
  return key in mem ? mem[key] : structuredClone(fallback);
}

export function save(key, value) {
  mem[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export const KEYS = {
  leads: 'wt.leads.v1',
  profile: 'wt.profile.v1',
  templates: 'wt.templates.v1',
  templatesPair: 'wt.templates.pair.v1',
  settings: 'wt.settings.v1',
  lastSearch: 'wt.lastSearch.v1',
  sendLog: 'wt.sendLog.v1',
};

const LEAD_FIELDS = ['id', 'source', 'name', 'category', 'address', 'city', 'state', 'lat', 'lon', 'phone',
  'website', 'emails', 'facebook', 'placeId', 'gmapsUrl', 'rating', 'ratingCount', 'fit', 'gmail', 'reply', 'replySeen', 'housing', 'housingCost', 'housingMentioned'];

export function toSavedLead(lead) {
  const out = {};
  for (const f of LEAD_FIELDS) if (lead[f] !== undefined) out[f] = lead[f];
  out.emails = [...(lead.emails || [])];
  out.status = lead.status || 'new';
  out.notes = lead.notes || '';
  out.history = lead.history || [];
  out.addedAt = lead.addedAt || new Date().toISOString();
  out.lastContactAt = lead.lastContactAt || null;
  return out;
}

const STATUS_RANK = { new: 0, skip: 1, emailed: 2, bounced: 2, followup: 3, rejected: 4, replied: 5, interview: 6, offer: 7 };

/** Merges two copies of the same lead (e.g. a friend's backup): furthest status wins, history/emails/notes combine. */
export function mergeLeads(a, b) {
  if (!a) return toSavedLead(b);
  if (!b) return toSavedLead(a);
  const status = (STATUS_RANK[b.status] ?? 0) > (STATUS_RANK[a.status] ?? 0) ? b.status : a.status;
  const seen = new Set();
  const history = [...(a.history || []), ...(b.history || [])]
    .filter((h) => { const k = `${h.at}|${h.action}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const notes = [a.notes, b.notes].map((n) => (n || '').trim()).filter(Boolean)
    .filter((n, i, arr) => arr.indexOf(n) === i).join(' | ');
  const last = [a.lastContactAt, b.lastContactAt].filter(Boolean).sort().pop() || null;
  const first = [a.addedAt, b.addedAt].filter(Boolean).sort()[0];
  return toSavedLead({
    ...a, ...b,
    status, history, notes,
    emails: [...new Set([...(a.emails || []), ...(b.emails || [])])],
    lastContactAt: last,
    addedAt: first,
  });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leadsToCsv(leads, statusLabel = (s) => s) {
  const head = ['Name', 'Category', 'Status', 'Housing', 'Housing $/week', 'Emails', 'Phone', 'Website', 'Address', 'City', 'State', 'Last contact', 'Notes', 'Google Maps'];
  const rows = leads.map((l) => [
    l.name, l.category, statusLabel(l.status), l.housingLabel || l.housing || '', l.housingCost || '', (l.emails || []).join(' '), l.phone, l.website, l.address,
    l.city, l.state, l.lastContactAt ? l.lastContactAt.slice(0, 10) : '', l.notes, l.gmaps || '',
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

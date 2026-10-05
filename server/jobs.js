// Vacancies from many platforms → one normalized list for /api/jobs.
//  - Google Jobs via SerpApi (SERPAPI_KEY): Google's index of Indeed, LinkedIn, Glassdoor, ZipRecruiter,
//    CoolWorks, Snagajob and employers' own career pages
//  - Adzuna (ADZUNA_APP_ID + ADZUNA_APP_KEY) and Jooble (JOOBLE_API_KEY): job aggregators with free keys
//  - Employer career boards on Greenhouse, Lever, SmartRecruiters, Ashby and Workday: public JSON, no key.
//    Boards come from JOB_BOARDS (server) and from the browser. API hosts are fixed, so a board link
//    can never make the server fetch an arbitrary URL.
import crypto from 'node:crypto';

const UA = 'wt-job-finder/1.0';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML (possibly entity-escaped, like Greenhouse content) → plain text. */
export function stripHtml(s) {
  const html = decodeEntities(s);
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/?(p|div|li|br|h\d|ul|ol)[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export const clip = (s, n = 700) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);
const shortId = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const prettyToken = (t) => String(t).replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** "3 days ago" / "Posted 30+ Days Ago" / "Posted Today" → ISO date (approximate). */
export function agoToIso(text, now = Date.now()) {
  const s = String(text || '').toLowerCase();
  if (/\b(today|just posted|just now)\b/.test(s)) return new Date(now).toISOString();
  if (/\byesterday\b/.test(s)) return new Date(now - 864e5).toISOString();
  const m = s.match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/);
  if (!m) return '';
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }[m[2]];
  return new Date(now - Number(m[1]) * unit).toISOString();
}

const isoOrEmpty = (v) => {
  if (v == null || v === '') return '';
  const d = new Date(typeof v === 'number' || /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

function job(fields) {
  return {
    id: fields.id,
    source: fields.source,
    title: stripHtml(fields.title),
    company: stripHtml(fields.company),
    location: stripHtml(fields.location),
    url: fields.url || '',
    description: clip(stripHtml(fields.description)),
    postedAt: fields.postedAt || '',
    salary: fields.salary || '',
    type: fields.type || '',
    via: fields.via || '',
    applyOptions: fields.applyOptions || [],
  };
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 20000, method = 'GET', body, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { Accept: 'application/json', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(String(msg).slice(0, 200)), { status: res.status });
  }
  if (json == null) throw new Error('Ответ не JSON');
  return json;
}

// ---------- aggregators (need keys) ----------

export async function searchGoogleJobs({ q, where, cursor, key, fetchImpl }) {
  const params = new URLSearchParams({
    engine: 'google_jobs', q, location: where ? `${where}, United States` : 'United States',
    google_domain: 'google.com', gl: 'us', hl: 'en', api_key: key,
  });
  if (cursor) params.set('next_page_token', cursor);
  const j = await getJson(`https://serpapi.com/search.json?${params}`, { fetchImpl, timeoutMs: 30000 });
  if (j.error) {
    if (/hasn't returned any results/i.test(j.error)) return { jobs: [], next: null };
    throw new Error(j.error);
  }
  const jobs = (j.jobs_results || []).map((r) => {
    const ext = r.detected_extensions || {};
    const apply = (r.apply_options || []).filter((o) => o?.link).slice(0, 5).map((o) => ({ title: String(o.title || '').slice(0, 60), url: o.link }));
    return job({
      id: `google:${shortId(r.job_id || `${r.title}|${r.company_name}|${r.location}`)}`,
      source: 'google',
      title: r.title,
      company: r.company_name,
      location: r.location,
      url: apply[0]?.url || r.share_link || '',
      description: r.description,
      postedAt: agoToIso(ext.posted_at),
      salary: ext.salary || '',
      type: ext.schedule_type || '',
      via: String(r.via || '').replace(/^via\s+/i, ''),
      applyOptions: apply,
    });
  });
  return { jobs, next: j.serpapi_pagination?.next_page_token || null };
}

export async function searchAdzuna({ q, where, cursor, appId, appKey, fetchImpl }) {
  const page = Math.max(Number(cursor) || 1, 1);
  const perPage = 50;
  const params = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: String(perPage), what: q, sort_by: 'date' });
  if (where) params.set('where', where);
  const j = await getJson(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${params}`, { fetchImpl });
  const jobs = (j.results || []).map((r) => {
    const area = r.location?.area || [];
    const location = area.length > 1 ? [area.length > 2 ? area[area.length - 1] : '', area[1]].filter(Boolean).join(', ') : (r.location?.display_name || '');
    const salary = r.salary_min ? `$${Math.round(r.salary_min).toLocaleString('en-US')}${r.salary_max && r.salary_max !== r.salary_min ? `–${Math.round(r.salary_max).toLocaleString('en-US')}` : ''}${r.salary_is_predicted === '1' ? ' (оценка)' : ''}` : '';
    return job({
      id: `adzuna:${r.id}`,
      source: 'adzuna',
      title: r.title,
      company: r.company?.display_name,
      location,
      url: r.redirect_url,
      description: r.description,
      postedAt: isoOrEmpty(r.created),
      salary,
      type: [r.contract_time, r.contract_type].filter(Boolean).join(', ').replace(/_/g, '-'),
    });
  });
  const total = Number(j.count) || 0;
  return { jobs, next: jobs.length === perPage && page * perPage < total && page < 20 ? String(page + 1) : null };
}

export async function searchJooble({ q, where, cursor, key, fetchImpl }) {
  const page = Math.max(Number(cursor) || 1, 1);
  const j = await getJson(`https://jooble.org/api/${encodeURIComponent(key)}`, {
    fetchImpl, method: 'POST', body: { keywords: q, location: where || 'USA', page: String(page), ResultOnPage: '50' },
  });
  const jobs = (j.jobs || []).map((r) => job({
    id: `jooble:${r.id || shortId(r.link)}`,
    source: 'jooble',
    title: r.title,
    company: r.company,
    location: r.location,
    url: r.link,
    description: r.snippet,
    postedAt: isoOrEmpty(r.updated),
    salary: r.salary || '',
    type: r.type || '',
    via: r.source || '',
  }));
  const total = Number(j.totalCount) || 0;
  return { jobs, next: jobs.length && page * 50 < total && page < 20 ? String(page + 1) : null };
}

// ---------- employer career boards (keyless) ----------

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const LOCALE_RE = /^[a-z]{2}-[a-z]{2}$/i;

/**
 * Career page link → board descriptor. Accepts "Name | URL" to set the company name, and short forms
 * like "greenhouse:token". Returns null for anything that is not a supported board.
 */
export function parseBoard(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  let name = '';
  const named = s.match(/^(.+?)\s*\|\s*(\S+)$/);
  if (named) { name = named[1].trim().slice(0, 80); s = named[2]; }
  const short = s.match(/^(greenhouse|lever|smartrecruiters|ashby):([\w.-]+)$/i);
  if (short) return TOKEN_RE.test(short[2]) ? { kind: short[1].toLowerCase(), token: short[2], name } : null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let out = null;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const token = u.searchParams.get('for') || (host.startsWith('boards-api.') ? parts[2] : parts[0] === 'embed' ? '' : parts[0]);
    out = { kind: 'greenhouse', token };
  } else if (host === 'jobs.lever.co' || host === 'api.lever.co') {
    out = { kind: 'lever', token: host === 'api.lever.co' ? parts[2] : parts[0] };
  } else if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    out = { kind: 'smartrecruiters', token: host.startsWith('api.') ? parts[2] : parts[0] };
  } else if (host === 'jobs.ashbyhq.com' || host === 'api.ashbyhq.com') {
    out = { kind: 'ashby', token: host === 'api.ashbyhq.com' ? parts[2] : parts[0] };
  } else {
    const wd = host.match(/^([a-z0-9-]+)\.(wd\d{1,3})\.myworkdayjobs\.com$/);
    if (wd) {
      const site = parts[0] === 'wday' ? parts[3] : parts.find((p) => !LOCALE_RE.test(p));
      out = { kind: 'workday', token: wd[1], host, site };
      if (!site || !TOKEN_RE.test(site)) return null;
    }
  }
  if (!out || !out.token || !TOKEN_RE.test(out.token)) return null;
  return { ...out, name };
}

export const boardKey = (b) => `${b.kind}:${b.token}${b.site ? `/${b.site}` : ''}`;

/** Any word of the query (ignoring filler) in the title or description. Empty query → everything. */
export function matchesQuery(text, q) {
  const stop = new Set(['jobs', 'job', 'work', 'the', 'and', 'or', 'in', 'for', 'usa', 'us', 'of', 'a', 'to', 'with']);
  const words = String(q || '').toLowerCase().replace(/["()]/g, ' ').split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter((w) => w.length > 1 && !stop.has(w));
  if (!words.length) return true;
  const hay = String(text || '').toLowerCase();
  return words.some((w) => {
    const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?')}`, 'i');
    return re.test(hay);
  });
}

export async function fetchBoard(board, { q, fetchImpl = fetch, deadline = Date.now() + 45000 } = {}) {
  const company = board.name || prettyToken(board.token);
  const left = () => Math.max(1000, Math.min(15000, deadline - Date.now()));
  const t = encodeURIComponent(board.token);
  let jobs = [];
  if (board.kind === 'greenhouse') {
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`, { fetchImpl, timeoutMs: left() });
    jobs = (j.jobs || []).map((r) => job({
      id: `gh:${board.token}:${r.id}`, source: 'boards', title: r.title, company: board.name || r.company_name || company,
      location: r.location?.name, url: r.absolute_url, description: r.content, postedAt: isoOrEmpty(r.first_published || r.updated_at), via: 'Greenhouse',
    }));
  } else if (board.kind === 'lever') {
    const j = await getJson(`https://api.lever.co/v0/postings/${t}?mode=json`, { fetchImpl, timeoutMs: left() });
    jobs = (Array.isArray(j) ? j : []).map((r) => job({
      id: `lever:${board.token}:${r.id}`, source: 'boards', title: r.text, company,
      location: r.categories?.location || (r.categories?.allLocations || []).join('; '), url: r.hostedUrl,
      description: r.descriptionPlain || r.description, postedAt: isoOrEmpty(r.createdAt), type: r.categories?.commitment || '', via: 'Lever',
    }));
  } else if (board.kind === 'smartrecruiters') {
    const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100&country=us`, { fetchImpl, timeoutMs: left() });
    jobs = (j.content || []).filter((r) => !r.location?.country || r.location.country.toLowerCase() === 'us').map((r) => job({
      id: `sr:${board.token}:${r.id}`, source: 'boards', title: r.name, company: board.name || r.company?.name || company,
      location: [r.location?.city, (r.location?.region || '').toUpperCase()].filter(Boolean).join(', '),
      url: `https://jobs.smartrecruiters.com/${t}/${encodeURIComponent(r.id)}`, postedAt: isoOrEmpty(r.releasedDate),
      type: r.typeOfEmployment?.label || '', via: 'SmartRecruiters',
    }));
  } else if (board.kind === 'ashby') {
    const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`, { fetchImpl, timeoutMs: left() });
    jobs = (j.jobs || []).filter((r) => r.isListed !== false).map((r) => {
      const addr = r.address?.postalAddress || {};
      return job({
        id: `ashby:${board.token}:${r.id}`, source: 'boards', title: r.title, company,
        location: [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') || r.location, url: r.jobUrl,
        description: r.descriptionPlain || r.descriptionHtml, postedAt: isoOrEmpty(r.publishedAt), type: r.employmentType || '',
        salary: r.compensation?.compensationTierSummary || '', via: 'Ashby',
      });
    });
  } else if (board.kind === 'workday') {
    const api = `https://${board.host}/wday/cxs/${t}/${encodeURIComponent(board.site)}/jobs`;
    for (let offset = 0; offset < 60 && (offset === 0 || left() > 5000); offset += 20) {
      const j = await getJson(api, { fetchImpl, timeoutMs: left(), method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText: q || '' } });
      const page = j.jobPostings || [];
      jobs.push(...page.filter((r) => r.externalPath).map((r) => job({
        id: `wd:${board.token}:${shortId(r.externalPath)}`, source: 'boards', title: r.title, company,
        location: r.locationsText, url: `https://${board.host}/en-US/${board.site}${r.externalPath}`,
        postedAt: agoToIso(r.postedOn), via: 'Workday',
      })));
      if (page.length < 20 || offset + 20 >= (Number(j.total) || 0)) break;
    }
    return jobs; // Workday already searched by text
  }
  return jobs.filter((x) => matchesQuery(`${x.title} ${x.type} ${x.description}`, q));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i; i += 1; out[k] = await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- orchestration ----------

export const SOURCES = [
  { id: 'google', label: 'Google Jobs (Indeed, LinkedIn, Glassdoor, ZipRecruiter, CoolWorks…)', env: 'SERPAPI_KEY' },
  { id: 'adzuna', label: 'Adzuna', env: 'ADZUNA_APP_ID + ADZUNA_APP_KEY' },
  { id: 'jooble', label: 'Jooble', env: 'JOOBLE_API_KEY' },
  { id: 'boards', label: 'Карьерные сайты работодателей (Greenhouse, Lever, Workday…)', env: 'JOB_BOARDS' },
];

export function jobsConfig(env = process.env) {
  return {
    google: Boolean(env.SERPAPI_KEY),
    adzuna: Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
    jooble: Boolean(env.JOOBLE_API_KEY),
    boards: splitBoards(env.JOB_BOARDS).length,
  };
}

export const splitBoards = (v) => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

const cache = new Map();
const CACHE_MS = 3 * 3600_000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
export const clearJobsCache = () => cache.clear();

/**
 * Runs every configured source in parallel. `cursors` holds next-page tokens from a previous response;
 * when `more` is set only sources with a cursor run (boards return everything on the first page).
 */
export async function searchJobs({ q = '', where = '', cursors = {}, boards = [], more = false, env = process.env, fetchImpl = fetch }) {
  const query = String(q).trim().slice(0, 150) || 'seasonal summer';
  const loc = String(where).trim().slice(0, 60);
  const cfg = jobsConfig(env);
  const runners = {
    google: cfg.google && ((c) => searchGoogleJobs({ q: query, where: loc, cursor: c, key: env.SERPAPI_KEY, fetchImpl })),
    adzuna: cfg.adzuna && ((c) => searchAdzuna({ q: query, where: loc, cursor: c, appId: env.ADZUNA_APP_ID, appKey: env.ADZUNA_APP_KEY, fetchImpl })),
    jooble: cfg.jooble && ((c) => searchJooble({ q: query, where: loc, cursor: c, key: env.JOOBLE_API_KEY, fetchImpl })),
  };

  const boardList = [];
  const seen = new Set();
  for (const raw of [...splitBoards(env.JOB_BOARDS), ...boards].slice(0, 60)) {
    const b = parseBoard(raw);
    if (!b || seen.has(boardKey(b))) continue;
    seen.add(boardKey(b));
    boardList.push(b);
  }

  const tasks = Object.entries(runners).map(async ([id, run]) => {
    const src = SOURCES.find((s) => s.id === id);
    const base = { id, label: src.label, env: src.env, configured: Boolean(run) };
    if (!run) return { ...base, ok: false, count: 0, jobs: [] };
    const cursor = cursors?.[id] ? String(cursors[id]).slice(0, 2000) : '';
    if (more && !cursor) return { ...base, ok: true, count: 0, jobs: [], next: null, skipped: true };
    try {
      const r = await cached(`${id}|${query}|${loc}|${cursor}`, () => run(cursor));
      return { ...base, ok: true, count: r.jobs.length, jobs: r.jobs, next: r.next };
    } catch (e) {
      return { ...base, ok: false, count: 0, jobs: [], error: e.message || String(e) };
    }
  });

  tasks.push((async () => {
    const src = SOURCES.find((s) => s.id === 'boards');
    const base = { id: 'boards', label: src.label, env: src.env, configured: boardList.length > 0, boards: boardList.length };
    if (!boardList.length || more) return { ...base, ok: true, count: 0, jobs: [], skipped: more };
    const errors = [];
    // Vercel stops functions at 60 s: boards that don't fit before the deadline are skipped.
    const deadline = Date.now() + 45000;
    let late = 0;
    const lists = await mapLimit(boardList, 6, async (b) => {
      if (deadline - Date.now() < 4000) { late += 1; return []; }
      try {
        return await cached(`board|${boardKey(b)}|${b.name}|${query}`, () => fetchBoard(b, { q: query, fetchImpl, deadline }));
      } catch (e) {
        errors.push(`${b.name || b.token} (${b.kind}): ${e.status === 404 ? 'страница не найдена' : e.message}`);
        return [];
      }
    });
    const jobs = lists.flat();
    if (late) errors.push(`не успели проверить ${late} сайт(ов), повтори поиск`);
    return { ...base, ok: errors.length < boardList.length, count: jobs.length, jobs, error: errors.length ? errors.join('; ') : undefined };
  })());

  const results = await Promise.all(tasks);
  const jobs = [];
  const ids = new Set();
  for (const r of results) for (const j of r.jobs) if (!ids.has(j.id)) { ids.add(j.id); jobs.push(j); }
  return {
    query,
    where: loc,
    jobs,
    sources: results.map(({ jobs: _drop, ...rest }) => rest),
  };
}

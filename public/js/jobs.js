// Vacancies tab: pure helpers for job postings returned by /api/jobs (no DOM here).
import { CATEGORY_BY_ID, NAME_FLAGS, STATES, STATE_BY_CODE } from './data.js';
import { googleSearchUrl } from './outreach.js';

export const JOB_PRESETS = [
  { id: 'j1', label: '🌎 J-1 / Work and Travel', q: 'J-1 seasonal summer' },
  { id: 'seasonal', label: '☀️ Сезонная, лето 2027', q: 'seasonal summer 2027' },
  { id: 'housing', label: '🏠 С жильём', q: 'seasonal summer employee housing provided' },
  { id: 'housekeeping', label: '🛏️ Housekeeping', q: 'seasonal housekeeper' },
  { id: 'food', label: '🍽️ Рестораны', q: 'seasonal summer server busser line cook' },
  { id: 'amusement', label: '🎢 Парки развлечений', q: 'amusement park seasonal' },
  { id: 'parks', label: '🏔️ Нацпарки, лоджи', q: 'national park lodge seasonal' },
  { id: 'lifeguard', label: '🏊 Lifeguard', q: 'seasonal lifeguard' },
  { id: 'retail', label: '🛍️ Магазины на курортах', q: 'seasonal summer retail sales associate' },
];

export const JOB_SOURCE_LABEL = { google: 'Google Jobs', adzuna: 'Adzuna', jooble: 'Jooble', boards: 'Сайт работодателя' };

const STATE_NAMES = [...STATES].sort((a, b) => b.name.length - a.name.length);
const FOREIGN_RE = /\b(canada|mexico|united kingdom|uk|england|scotland|ireland|germany|france|spain|italy|portugal|greece|australia|new zealand|india|philippines|china|japan|singapore|brazil|netherlands|poland|ontario|british columbia|quebec|alberta|toronto|vancouver|montreal|london|dublin|sydney)\b/i;

/** "Ocean City, MD 21842" / "Ocean City, Maryland, United States" / "Maryland" → { city, state }. */
export function parseJobLocation(loc) {
  const text = String(loc || '').split(/;|\bor\b|\|/)[0].trim();
  if (!text) return { city: '', state: '' };
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i].replace(/\b\d{5}(-\d{4})?\b/, '').trim();
    const code = p.match(/^([A-Z]{2})$/)?.[1];
    let st = code && STATE_BY_CODE[code] ? code : '';
    if (!st) st = STATE_NAMES.find((s) => s.name.toLowerCase() === p.toLowerCase())?.code || '';
    if (st) return { city: i > 0 ? parts[i - 1] : '', state: st };
  }
  // "Yellowstone National Park, Wyoming area", "Remote in Florida"
  const named = STATE_NAMES.find((s) => new RegExp(`\\b${s.name}\\b`, 'i').test(text));
  return { city: '', state: named?.code || '' };
}

/** False only for places that are clearly abroad ("Toronto, ON", "London, UK"); "Multiple Locations" stays. */
export const isUsLocation = (loc) => Boolean(parseJobLocation(loc).state) || !FOREIGN_RE.test(String(loc || ''));

const J1_RE = /\bJ-?1\b|work\s*(and|&)\s*travel|\bSWT\b|exchange visitors?|international students?|cultural exchange|j1 visa|students from abroad/i;
const HOUSING_RE = /\bhousing\b|dormitor(y|ies)|\bdorms?\b|room and board|accommodations? (is |are )?(provided|available|offered)|lodging (is )?(provided|available)/i;
const SEASONAL_RE = /\bseasonal\b|\bsummer\b|\btemporary\b|\b(20\d\d )?season\b|memorial day|labor day|may\s*[-–]\s*(sept|oct)/i;
const CITIZEN_RE = /\bU\.?S\.? citizens? only\b|must be a U\.?S\.? citizen|security clearance|green card required/i;
const NO_SPONSOR_RE = /(not|unable to|won'?t|will not|cannot|no) (provide |offer )?(visa )?sponsor|without (the need for )?(visa )?sponsorship/i;

// Title-based checks for J-1 Summer Work and Travel (22 CFR 62.32): unskilled, seasonal, in person.
const TITLE_FLAGS = [
  { re: /\b(manager|director|engineer|developer|nurse|rn|lpn|cna|physician|pharmac\w*|accountant|analyst|attorney|teacher|therapist|technician|electrician|plumber|mechanic)\b/i, level: 'bad',
    note: 'Нужна квалификация или опыт: в Summer W&T берут на неквалифицированную работу.' },
  { re: /\b(driver|cdl|chauffeur|valet|truck|forklift|captain|deckhand)\b/i, level: 'bad',
    note: 'Вождение машин, лодок и погрузчиков запрещено.' },
  { re: /\b(camp counselor|counselor|nanny|babysitter|au pair)\b/i, level: 'bad',
    note: 'Вожатые и работа с детьми — это другие J-1 категории, не Summer W&T.' },
  { re: /\b(remote|work from home|wfh)\b/i, level: 'bad', note: 'Удалённая работа не подходит: нужна работа на месте с общением с американцами.' },
  { re: /\b(overnight|night (shift|auditor)|graveyard)\b/i, level: 'check', note: 'Работа преимущественно с 22:00 до 6:00 запрещена.' },
  { re: /\b(supervisor|lead|assistant manager)\b/i, level: 'check', note: 'Руководящая должность: спонсор может не одобрить.' },
  { re: /\blifeguard\b/i, level: 'check', note: 'Lifeguard — только с сертификатом.' },
  { re: /\b(year[- ]round|permanent|career opportunity)\b/i, level: 'check', note: 'Похоже на постоянную работу. Для W&T нужна сезонная — уточни, берут ли на лето.' },
  { re: /\b(commission only|100% commission)\b/i, level: 'bad', note: 'Оплата только комиссией запрещена.' },
];

const CATEGORY_HINTS = [
  ['lodging', /\b(housekeep\w*|room attendant|front desk|guest service agent|bellhop|bell ?person|laundry|houseperson|hotel|resort|motel|inn)\b/i],
  ['amusement', /\b(ride operator|amusement|theme park|water ?park|games? (host|attendant)|attractions? (host|attendant))\b/i],
  ['camp', /\b(campground|rv park|lodge|national park)\b/i],
  ['fastfood', /\b(crew member|fast food|cashier|food prep)\b/i],
  ['cafe', /\b(barista|ice cream|scooper|coffee|bakery)\b/i],
  ['restaurant', /\b(server|busser|bus ?person|host(ess)?|dishwasher|line cook|prep cook|cook|food runner|restaurant|kitchen)\b/i],
  ['retail', /\b(sales associate|retail|gift shop|souvenir|stock associate)\b/i],
  ['grocery', /\b(grocery|supermarket|deli|stocker)\b/i],
  ['recreation', /\b(golf|marina|bowling|rental (desk|associate)|dock ?hand)\b/i],
  ['attraction', /\b(zoo|aquarium|museum|ticket|tour guide)\b/i],
];

export function guessCategory(text) {
  return CATEGORY_HINTS.find(([, re]) => re.test(text || ''))?.[0] || '';
}

/** Adds location, J-1/housing/seasonal signals, a category guess and a rule check to a posting. */
export function analyzeJob(job) {
  const text = `${job.title} ${job.type} ${job.description}`;
  const { city, state } = parseJobLocation(job.location);
  const notes = [];
  let level = 'ok';
  const rank = { ok: 0, check: 1, bad: 2 };
  const bump = (l, note) => { if (rank[l] > rank[level]) level = l; if (note && !notes.includes(note)) notes.push(note); };
  for (const f of NAME_FLAGS) if (f.re.test(`${job.company} ${job.title}`)) bump(f.level, f.note);
  for (const f of TITLE_FLAGS) if (f.re.test(job.title || '')) bump(f.level, f.note);
  if (CITIZEN_RE.test(text)) bump('bad', 'Только для граждан США.');
  else if (NO_SPONSOR_RE.test(text)) bump('check', 'Пишут «визу не спонсируем». Для J-1 визу даёт спонсор программы, но уточни у работодателя, берут ли J-1.');
  const category = guessCategory(`${job.title} ${job.company}`);
  if (CATEGORY_BY_ID[category]?.fit) bump(CATEGORY_BY_ID[category].fit.level, CATEGORY_BY_ID[category].fit.note);
  const j1 = J1_RE.test(text);
  const housing = HOUSING_RE.test(text);
  const seasonal = SEASONAL_RE.test(text);
  const us = isUsLocation(job.location);
  if (!us) bump('bad', 'Работа не в США.');
  return { ...job, city, state, us, j1, housing, seasonal, category, fit: { level, notes } };
}

export function jobScore(j) {
  const ts = Date.parse(j.postedAt) || 0;
  const fresh = ts ? Math.max(0, 1 - (Date.now() - ts) / (90 * 864e5)) : 0;
  return (j.j1 ? 4 : 0) + (j.housing ? 2 : 0) + (j.seasonal ? 1.5 : 0) + fresh - (j.fit?.level === 'bad' ? 6 : j.fit?.level === 'check' ? 1 : 0);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const applyLinks = (j) => [
  ...(j.url ? [{ title: j.via || JOB_SOURCE_LABEL[j.source] || j.source, url: j.url }] : []),
  ...(j.applyOptions || []),
];

/** Same vacancy from several platforms → one card listing every platform. */
export function dedupeJobs(list) {
  const out = new Map();
  for (const j of list) {
    const key = `${norm(j.title)}|${norm(j.company)}|${j.state || norm(j.location)}`;
    const prev = out.get(key);
    if (!prev) { out.set(key, { ...j, sources: [...new Set([j.source, ...(j.sources || [])])] }); continue; }
    const richer = (j.description || '').length > (prev.description || '').length ? j : prev;
    out.set(key, {
      ...prev,
      ...richer,
      id: prev.id,
      url: prev.url || j.url,
      sources: [...new Set([...prev.sources, j.source])],
      applyOptions: [...applyLinks(prev), ...applyLinks(j)]
        .filter((o, i, arr) => arr.findIndex((x) => x.url === o.url) === i).slice(0, 6),
      salary: prev.salary || j.salary,
      postedAt: [prev.postedAt, j.postedAt].filter(Boolean).sort().pop() || '',
      j1: prev.j1 || j.j1,
      housing: prev.housing || j.housing,
      seasonal: prev.seasonal || j.seasonal,
    });
  }
  return [...out.values()];
}

export function filterJobs(list, { text = '', state = '', fit = 'all', source = '', j1Only = false, housingOnly = false, usOnly = true } = {}) {
  const q = text.trim().toLowerCase();
  return list.filter((j) => (!q || `${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase().includes(q))
    && (!state || j.state === state || !j.state)
    && (fit === 'all' || j.fit?.level === fit)
    && (!source || (j.sources || [j.source]).includes(source))
    && (!j1Only || j.j1)
    && (!housingOnly || j.housing)
    && (!usOnly || j.us !== false));
}

export function sortJobs(list, by = 'relevance') {
  const arr = [...list];
  if (by === 'date') arr.sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
  else if (by === 'company') arr.sort((a, b) => (a.company || '').localeCompare(b.company || ''));
  else arr.sort((a, b) => jobScore(b) - jobScore(a));
  return arr;
}

/** Only http(s) links from job APIs go into href (no javascript: and the like). */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');

const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 60);

/** Vacancy → saved contact (one per employer and state), so it can be emailed and tracked. */
export function jobToLead(j) {
  return {
    id: `job:${slug(j.company || j.title)}:${j.state || ''}`,
    source: 'job',
    name: j.company || j.title,
    category: j.category || '',
    address: j.location || '',
    city: j.city || '',
    state: j.state || '',
    emails: [],
    fit: j.fit,
    jobTitle: j.title,
    jobUrl: safeUrl(j.url),
    notes: `Вакансия: ${j.title}${safeUrl(j.url) ? ` — ${j.url}` : ''}`,
  };
}

/** Search links for platforms without an open API (opened in a new tab). */
export function vacancySearchLinks(q, stateCode) {
  const stateName = STATE_BY_CODE[stateCode]?.name || '';
  const loc = stateName || 'United States';
  const enc = encodeURIComponent;
  const query = q || 'seasonal summer';
  return [
    { label: 'Indeed', url: `https://www.indeed.com/jobs?q=${enc(query)}&l=${enc(stateName)}` },
    { label: 'Google Jobs', url: `https://www.google.com/search?q=${enc(`${query} jobs ${loc}`)}&ibp=htl;jobs` },
    { label: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${enc(query)}&location=${enc(loc)}` },
    { label: 'Glassdoor', url: googleSearchUrl(`site:glassdoor.com ${query} ${stateName}`) },
    { label: 'ZipRecruiter', url: `https://www.ziprecruiter.com/jobs-search?search=${enc(query)}&location=${enc(loc)}` },
    { label: 'SimplyHired', url: `https://www.simplyhired.com/search?q=${enc(query)}&l=${enc(stateName)}` },
    { label: 'Snagajob', url: googleSearchUrl(`site:snagajob.com ${query} ${stateName}`) },
    { label: 'CoolWorks (J-1 friendly)', url: googleSearchUrl(`site:coolworks.com "J-1" ${stateName} summer`) },
    { label: 'Backdoor Jobs', url: googleSearchUrl(`site:backdoorjobs.com ${stateName} summer`) },
    { label: 'Craigslist', url: googleSearchUrl(`site:craigslist.org ${stateName} ${query}`) },
    { label: '“J-1 housing provided”', url: googleSearchUrl(`"J-1" "housing provided" seasonal jobs ${stateName} 2027`) },
    { label: 'Facebook-группы W&T', url: googleSearchUrl(`facebook group "work and travel" ${stateName} jobs 2027`) },
  ];
}

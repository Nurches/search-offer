/*
 * InterExchange → список офферов.
 *
 * Как пользоваться:
 *   1. Войдите в InterExchange и откройте вкладку «Job Listings» (фильтры сайта можно оставить пустыми —
 *      если какие-то выставить, скрипт соберёт только то, что они показывают).
 *   2. Откройте консоль браузера: Cmd+Option+J (Mac) / Ctrl+Shift+J (Windows), вкладка Console.
 *      Chrome может попросить сначала ввести `allow pasting` — введите и нажмите Enter.
 *   3. Вставьте весь этот файл и нажмите Enter.
 *   4. Внизу слева появится панель с прогрессом (~1 мин на 51 страницу). Потом:
 *      «Догрузить профили» — даты начала, аренда, залог, соседи (по одному запросу на работодателя, несколько минут);
 *      «Открыть отчёт» — фильтры (жильё, ставка, часы, аренда, штат, регион, даты приезда/отъезда, 21+, интервью),
 *      сортировка по ≈$ в неделю (и после аренды), ★ избранное, экспорт в CSV.
 *
 * Скрипт только читает страницы, которые вам и так видны (те же запросы, что при листании вручную),
 * с паузой между страницами. Ничего не отправляет и никуда не сохраняет, кроме файлов, которые вы скачаете сами.
 */
(() => {
  'use strict';

  const CONFIG = {
    pauseMs: 700, // пауза между страницами списка
    deep: false, // true — сразу догрузить профили работодателей (иначе — кнопкой на панели)
    deepConcurrency: 3,
    deepPauseMs: 500,
    maxPages: 300,
  };

  // ───────────────────────── text helpers (pure, unit-tested) ─────────────────────────

  const STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam',
  };
  const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n) => String(n).padStart(2, '0');

  const yesNo = (v) => (/^(yes|y|true|✓|✔)\b/i.test(v) ? true : /^(no|n|false|none|✗|✘)\b/i.test(v) ? false : null);

  /** Text → array of trimmed non-empty lines. */
  const toLines = (text) => String(text || '').split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  /**
   * Value next to a label: "Wage: $15" → "$15"; "Wage $15" → "$15"; a line that is only the label → the next line.
   * Returns '' when nothing found.
   */
  function labelValue(lines, re, { sameLine = false } = {}) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = line.match(re);
      if (!m) continue;
      const after = line.slice(m.index + m[0].length).replace(/^[\s:?–—-]+/, '').trim();
      if (after) return after;
      const before = line.slice(0, m.index).trim();
      if (!sameLine && !before && i + 1 < lines.length && !re.test(lines[i + 1])) return lines[i + 1];
    }
    return '';
  }

  /** Every date in a string → ISO yyyy-mm-dd. Understands "May 15, 2027", "15 May 2027", "05/15/2027", "2027-05-15". */
  function findDates(text) {
    const out = [];
    const s = String(text || '');
    const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
    let m;
    const re1 = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'gi');
    while ((m = re1.exec(s))) out.push(`${m[3]}-${pad(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1)}-${pad(m[2])}`);
    const re2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(\\d{4})`, 'gi');
    while ((m = re2.exec(s))) out.push(`${m[3]}-${pad(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1)}-${pad(m[1])}`);
    const re3 = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g;
    while ((m = re3.exec(s))) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      if (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) out.push(`${y}-${pad(m[1])}-${pad(m[2])}`);
    }
    const re4 = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
    while ((m = re4.exec(s))) out.push(`${m[1]}-${m[2]}-${m[3]}`);
    return out;
  }

  const MONEY = /\$\s*(\d{1,3}(?:\.\d{1,2})?)(?:\s*(?:-|–|—|to)\s*\$?\s*(\d{1,3}(?:\.\d{1,2})?))?/g;

  /**
   * Hourly wage (and upper bound of a range). Every $ amount is scored by its neighbourhood, so
   * "$120/week housing" or "$50 deposit" never wins over "$15.50/hr".
   */
  function parseWage(lines) {
    const found = [];
    const scan = (line, bonus) => {
      for (const m of String(line).matchAll(MONEY)) {
        const wage = +m[1];
        if (wage < 5 || wage > 80) continue;
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 20);
        const before = line.slice(Math.max(0, m.index - 30), m.index);
        let score = bonus;
        if (/^\s*(\/|per|an?|each)?\s*(hour|hr)s?\b/i.test(after)) score += 3;
        if (/^\s*(\/|per|an?|each)?\s*(week|wk|month|mo|night|day|season|year)\b/i.test(after)) score -= 5;
        if (/(housing|rent|deposit|fee|cost|bike|uniform|transport|insurance|deduct|bonus|tips?)[^$]*$/i.test(before)) score -= 4;
        if (/(wage|pay|rate|salary|earn)[^$]*$/i.test(before)) score += 2;
        found.push({ wage, wageMax: m[2] ? +m[2] : null, score });
      }
    };
    const labelled = labelValue(lines, /\b(wage|pay rate|hourly rate|rate of pay)\b(?:\s*per\s*hour)?/i);
    const bare = labelled.match(/^(\d{1,2}(?:\.\d{1,2})?)(?:\s*(?:-|–|to)\s*(\d{1,2}(?:\.\d{1,2})?))?\s*(usd|\/|per|$)/i);
    if (bare && +bare[1] >= 5) found.push({ wage: +bare[1], wageMax: bare[2] ? +bare[2] : null, score: 5 });
    if (labelled) scan(labelled, 3);
    lines.forEach((l) => scan(l, 0));
    const best = found.filter((f) => f.score > 0 || (f.score === 0 && f.wage <= 40))
      .reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    return best ? { wage: best.wage, wageMax: best.wageMax } : { wage: null, wageMax: null };
  }

  /** Hours per week. "Average Hours per week: 40", "32-40 hrs/week", "40+ hours". */
  function parseHours(lines) {
    const num = (str) => {
      const s = String(str).replace(/\$\s*[\d.,]+/g, ' ');
      let m = s.match(/(\d{1,2}(?:\.\d)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?)/);
      if (m) return { hours: +m[1], hoursMax: +m[2] };
      m = s.match(/(\d{1,2}(?:\.\d)?)\s*\+?/);
      return m ? { hours: +m[1], hoursMax: null } : null;
    };
    const ok = (r) => r && r.hours >= 5 && r.hours <= 80;
    const labelled = labelValue(lines, /\b(avg\.?|average)?\s*hours?(\s*(per|\/|a)\s*(week|wk))?\b/i);
    if (labelled) { const r = num(labelled); if (ok(r)) return r; }
    for (const l of lines) {
      const s = l.replace(/\$\s*[\d.,]+\s*(?:\/|per|an?)?\s*(?:hour|hr)s?/gi, ' ');
      const m = s.match(/(\d{1,2}(?:\.\d)?)(?:\s*(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?))?\s*\+?\s*(?:hrs?|hours)\b/i);
      if (m) { const r = { hours: +m[1], hoursMax: m[2] ? +m[2] : null }; if (ok(r)) return r; }
    }
    return { hours: null, hoursMax: null };
  }

  /** 'provided' | 'assistance' | 'none' | '' and the weekly housing cost when one is shown. */
  function parseHousing(lines) {
    const text = lines.join('\n');
    const prov = yesNo(labelValue(lines, /housing\s*provided\b/i, { sameLine: true }));
    const asst = yesNo(labelValue(lines, /housing\s*assistance\b/i, { sameLine: true }));
    let housing = '';
    if (prov === true) housing = 'provided';
    else if (asst === true) housing = 'assistance';
    else if (prov === false && asst === false) housing = 'none';
    else {
      if (/no housing|housing\s*(is\s*)?not\s*(provided|available)|does not (provide|offer) housing|housing\s*[:\-–]\s*(none|no)\b/i.test(text)) housing = 'none';
      if (asst !== false && /housing\s*[:\-–]?\s*assist|assist(s|ance)?\s*(with|in)\s*(finding\s*)?housing|help(s)?\s*(with|find)\s*housing/i.test(text)) housing = 'assistance';
      if (prov !== false && /housing\s*(is\s*)?provided|employer[- ]provided housing|provides? housing|housing\s*[:\-–]\s*(yes|provided)|company housing|staff housing|employee housing/i.test(text)) housing = 'provided';
    }
    let housingCost = null;
    for (const l of lines) {
      if (/(housing|rent)[^$]*\$\s*\d{2,4}/i.test(l)) { housingCost = l.slice(0, 160); break; }
    }
    return { housing, housingCost };
  }

  /** First "City, ST" (or "City, State name") in the text. */
  function parseLocation(lines) {
    const fromLabel = labelValue(lines, /\b(location|city)\b/i);
    const tryOne = (s) => {
      const m = String(s).match(/([A-Z][A-Za-z.'’\- ]{1,40}?),\s*([A-Z]{2})\b/);
      if (m && STATES[m[2]]) return { city: m[1].trim(), state: m[2] };
      const n = String(s).match(/([A-Z][A-Za-z.'’\- ]{1,40}?),\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
      if (n && STATE_BY_NAME[n[2].toLowerCase()]) return { city: n[1].trim(), state: STATE_BY_NAME[n[2].toLowerCase()] };
      return null;
    };
    return tryOne(fromLabel) || lines.map(tryOne).find(Boolean) || { city: '', state: '' };
  }

  /** Start = earliest, end = latest date on the card, ignoring "posted/updated/deadline" lines. */
  function parseDates(lines) {
    const all = [];
    for (const l of lines) {
      if (/posted|updated|created|deadline|apply by|birth|expires?/i.test(l)) continue;
      all.push(...findDates(l));
    }
    all.sort();
    return { start: all[0] || '', end: all.length > 1 ? all[all.length - 1] : '' };
  }

  /**
   * Fields of one listing from its text. `known` = lists harvested from the site's filters
   * ({ positions: [...] }) so the position is matched against real names.
   */
  function parseListing(text, known = {}) {
    const lines = toLines(text);
    const joined = lines.join('\n');
    const loc = parseLocation(lines);
    const { wage, wageMax } = parseWage(lines);
    const { hours, hoursMax } = parseHours(lines);
    const { housing, housingCost } = parseHousing(lines);
    const { start, end } = parseDates(lines);

    let positions = [];
    const labelledPos = labelValue(lines.filter((l) => !/available|openings/i.test(l)), /\b(position|job title|role)s?\b/i);
    for (const p of known.positions || []) {
      const re = new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z]|$)`, 'i');
      if (re.test(joined)) positions.push(p);
    }
    positions = positions.filter((p) => !positions.some((q) => q !== p && q.length > p.length && q.toLowerCase().includes(p.toLowerCase())));
    if (!positions.length && labelledPos) positions = [labelledPos];

    const tippedRaw = labelValue(lines, /\btipped\b|\btips\b/i);
    let tipped = yesNo(tippedRaw);
    if (tipped === null && /\b(tipped position|plus tips|\+\s*tips|gratuit(y|ies))\b/i.test(joined)) tipped = true;

    const avail = labelValue(lines, /positions?\s*available|openings|number of (positions|openings)/i);
    let openings = null;
    const am = (avail || '').match(/\d+/) || joined.match(/(\d{1,3})\s*(?:positions?|openings?|spots?)\s*(?:available|left|open)/i);
    if (am) openings = +(am[1] || am[0]);

    return {
      position: positions.join(', '),
      city: loc.city,
      state: loc.state,
      wage,
      wageMax,
      hours,
      hoursMax,
      weekly: wage && hours ? Math.round(wage * hours) : null,
      housing,
      housingCost,
      tipped,
      start,
      end,
      interviews: labelValue(lines, /\binterviews?\b/i).slice(0, 120),
      employerType: labelValue(lines, /employer type|industry/i).slice(0, 80),
      openings,
    };
  }

  // ───────────────────────── InterExchange card / host profile (pure) ─────────────────────────

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const money = (s) => {
    const m = String(s == null ? '' : s).match(/\$\s*([\d,]+(?:\.\d+)?)/);
    return m ? +m[1].replace(/,/g, '') : null;
  };
  const titleCase = (s) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s);
  const weeklyRent = (line) => {
    const v = money(line);
    return v != null && /month/i.test(line) ? Math.round(v / 4.33) : v;
  };

  /**
   * One InterExchange listing card → record. `raw` is what readIxCard() takes from the DOM:
   * { id, position, profileUrl, fields: {h5 label: text}, badges, leftLines, rightLines, bodyLines, interviewOn, section }.
   */
  function normalizeIx(raw) {
    const f = raw.fields || {};
    const badges = (raw.badges || []).map((b) => clean(b).toLowerCase());
    const loc = toLines(f.Location || '');
    const cs = (loc[0] || '').match(/^(.*?),\s*([A-Za-z]{2})$/);
    const R = raw.rightLines || [];
    const otIdx = R.findIndex((l) => /^overtime wage/i.test(l));
    const beforeOt = otIdx >= 0 ? R.slice(0, otIdx) : R;
    const wageLine = beforeOt.find((l) => /^\$\s*[\d.,]+/.test(l) && !/rent/i.test(l)) || '';
    const wage = money(wageLine);
    const hoursLine = R.find((l) => /\d\s*hours?\b/i.test(l) && !l.includes('$'));
    const hours = hoursLine ? +hoursLine.match(/([\d.]+)\s*hours?/i)[1] : null;
    const rentLine = R.find((l) => /rent/i.test(l) && l.includes('$'));
    const rent = rentLine ? weeklyRent(rentLine) : null;
    const otLine = otIdx >= 0 ? R.slice(otIdx + 1).find((l) => /^\$/.test(l)) : null;
    const fin = findDates(f['Preferred Finish Dates'] || '');
    const body = raw.bodyLines || [];
    const d = body.findIndex((l) => /^position description$/i.test(l));
    const description = d >= 0 ? body.slice(d).join('\n') : '';
    const op = (raw.leftLines || []).join(' ').match(/(\d+)\s+positions?\b/i);
    const weekly = wage != null && hours != null ? Math.round(wage * hours) : null;
    return {
      key: raw.id,
      url: raw.profileUrl || '',
      employer: clean(f['Host Employer']),
      position: clean(raw.position),
      business: clean(f['Type of Business']),
      city: cs ? titleCase(cs[1].trim()) : (loc[0] || ''),
      state: cs ? cs[2].toUpperCase() : '',
      region: loc[1] || '',
      wage,
      wageMax: null,
      overtimeWage: otLine ? money(otLine) : null,
      tipped: badges.includes('tipped') || /\+\s*tips/i.test(wageLine),
      tipsSometimes: R.some((l) => /tips are sometimes/i.test(l)),
      hours,
      hoursMax: null,
      weekly,
      rent,
      net: weekly != null && rent != null ? weekly - rent : null,
      housing: badges.includes('housing provided') ? 'provided' : badges.includes('housing assistance') ? 'assistance' : 'none',
      overtime: badges.includes('overtime') ? 'yes' : badges.includes('maybe overtime') ? 'maybe' : '',
      startFrom: '',
      startTo: '',
      finishFrom: fin[0] || '',
      finishTo: fin[1] || fin[0] || '',
      openings: op ? +op[1] : null,
      interviews: /interview/i.test(raw.section || '') || Boolean(raw.interviewOn),
      interviewOn: clean(raw.interviewOn),
      lastVisited: findDates(f['Last Visited'] || '')[0] || '',
      age21: /must be (at least )?21\b|\b21 years (of age|old)|\b21\+/i.test(description),
      photos: Boolean(raw.hasPhotos),
      video: Boolean(raw.hasVideo),
      profile: false,
      text: description.slice(0, 1500),
    };
  }

  /** Host profile page fields ({h5 label: text}) → dates window, rent, roommates, transport… */
  function normalizeProfile({ fields: f = {}, address = '' } = {}) {
    const st = findDates(f.Start || '');
    const fi = findDates(f.Finish || '');
    const int = (s) => { const m = String(s || '').match(/\d+/); return m ? +m[0] : null; };
    return {
      startFrom: st[0] || '',
      startTo: st[1] || st[0] || '',
      finishFrom: fi[0] || '',
      finishTo: fi[1] || fi[0] || '',
      housingType: clean(f['Housing Type']),
      rent: f.Rent ? weeklyRent(f.Rent) : null,
      deposit: money(f['Housing Deposit']),
      rentDeducted: clean(f['Rent deducted from wages']),
      shareHousing: int(f['Number of people sharing housing']),
      shareBedroom: int(f['Number of people sharing a bedroom']),
      transportCost: money(f['Estimated Transportation Cost']),
      distance: clean(f['Distance from work']).slice(0, 120),
      meals: clean(f['Meals Included']).slice(0, 160),
      drugTest: clean(f['Drug Testing Requirements']).slice(0, 80),
      bonuses: clean(f['Bonuses Available']).slice(0, 160),
      address: clean(address),
    };
  }

  /** Adds profile data to a listing. The card's own rent / finish dates win when present. */
  function mergeProfile(r, p) {
    for (const [k, v] of Object.entries(p)) {
      if (v == null || v === '') continue;
      if ((k === 'rent' || k === 'finishFrom' || k === 'finishTo') && r[k] != null && r[k] !== '') continue;
      r[k] = v;
    }
    r.net = r.weekly != null && r.rent != null ? r.weekly - r.rent : null;
    r.profile = true;
    return r;
  }

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const HOUSING_RU = { provided: 'предоставляется', assistance: 'помощь с поиском', none: 'нет', '': '' };
  const CSV_COLUMNS = [
    ['employer', 'Работодатель'], ['position', 'Должность'], ['business', 'Тип бизнеса'], ['city', 'Город'], ['state', 'Штат'],
    ['region', 'Регион'], ['wage', 'Ставка $/ч'], ['tipped', 'Чаевые'], ['hours', 'Часов/нед'], ['weekly', '≈$/нед'],
    ['rent', 'Аренда $/нед'], ['net', '≈$/нед после аренды'], ['housing', 'Жильё'], ['startFrom', 'Начало с'],
    ['startTo', 'Начало по'], ['finishFrom', 'Конец с'], ['finishTo', 'Конец по'], ['openings', 'Мест'],
    ['interviewOn', 'Интервью'], ['age21', 'Только 21+'], ['overtime', 'Сверхурочные'], ['shareBedroom', 'Человек в комнате'],
    ['deposit', 'Залог $'], ['transportCost', 'Транспорт $/нед'], ['lastVisited', 'Работодатель заходил'], ['url', 'Ссылка'],
  ];
  const csvValue = (r, k) => {
    if (k === 'housing') return HOUSING_RU[r.housing || ''];
    if (k === 'tipped' || k === 'age21') return r[k] == null ? '' : r[k] ? 'да' : 'нет';
    if (k === 'overtime') return { yes: 'да', maybe: 'возможно' }[r.overtime] || '';
    return r[k];
  };
  function toCsv(rows) {
    return `﻿${[CSV_COLUMNS.map((c) => c[1]), ...rows.map((r) => CSV_COLUMNS.map(([k]) => csvValue(r, k)))]
      .map((r) => r.map(csvCell).join(';')).join('\r\n')}`;
  }

  const IX = {
    toLines, labelValue, findDates, parseWage, parseHours, parseHousing, parseLocation, parseDates, parseListing,
    normalizeIx, normalizeProfile, mergeProfile, toCsv,
  };

  // Loaded by unit tests (no browser DOM) → expose helpers and stop here.
  if (typeof document === 'undefined' || typeof window === 'undefined') { globalThis.__IX = IX; return; }

  // ───────────────────────── DOM side ─────────────────────────

  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL|LABEL|BUTTON)$/;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|SELECT|OPTION|INPUT|TEXTAREA)$/;

  /** textContent with line breaks at block boundaries (works on DOMParser documents, unlike innerText). */
  function blockText(root) {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || SKIP.test(n.tagName)) return;
      const block = BLOCK.test(n.tagName);
      if (block) parts.push('\n');
      for (const c of n.childNodes) walk(c);
      if (block) parts.push('\n');
    };
    walk(root);
    return toLines(parts.join('')).join('\n');
  }

  /** <h5>Label</h5> value pairs inside `root`. */
  function h5Fields(root) {
    const out = {};
    for (const h of root.querySelectorAll('h5')) {
      const label = clean(h.textContent);
      if (!label || label in out || !h.parentElement) continue;
      const lines = toLines(blockText(h.parentElement));
      const i = lines.indexOf(label);
      out[label] = (i >= 0 ? lines.slice(i + 1) : lines).join('\n');
    }
    return out;
  }

  function readIxCard(card, base) {
    const head = card.querySelector('.card-header a[href]');
    const body = card.querySelector('.card-body') || card;
    const cols = [...body.querySelectorAll('.col-6')];
    const right = cols.find((c) => c.classList.contains('text-right')) || cols[1];
    const footer = card.querySelector('.card-footer');
    const foot = footer ? toLines(blockText(footer)) : [];
    const iv = foot.findIndex((l) => /^interviewing on$/i.test(l));
    const section = card.closest('section');
    const strong = card.querySelector('.card-header strong');
    return {
      id: card.id.replace(/^job_listing_/, '') || (head && head.getAttribute('href')) || '',
      position: strong ? strong.textContent : head ? head.textContent : '',
      profileUrl: head ? new URL(head.getAttribute('href'), base).href : '',
      fields: h5Fields(card),
      badges: [...card.querySelectorAll('.badge')].map((b) => b.textContent),
      leftLines: cols[0] ? toLines(blockText(cols[0])) : [],
      rightLines: right ? toLines(blockText(right)) : [],
      bodyLines: toLines(blockText(body)),
      interviewOn: iv >= 0 ? foot[iv + 1] || '' : '',
      section: section && section.querySelector('h3') ? section.querySelector('h3').textContent : '',
      hasPhotos: Boolean(card.querySelector('.card-header .fa-camera')),
      hasVideo: Boolean(card.querySelector('.card-header .fa-video')),
    };
  }

  function readProfile(doc) {
    const main = doc.querySelector('#primary-content') || doc.body;
    const addr = main.querySelector('.card-text a[href*="maps"]');
    return { fields: h5Fields(main), address: addr ? addr.textContent : '' };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abs = (href, base) => { try { return href ? new URL(href, base) : null; } catch { return null; } };
  const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{5,})$/i;
  const template = (u) => u.pathname.split('/').map((s) => (ID_SEG.test(s) ? ':id' : s)).join('/');

  /** Checkbox labels under a filter heading ("Position", "State", ...). */
  function harvestFilter(doc, title) {
    const heads = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,label,legend,strong,b,div,span,p')]
      .filter((el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === title.toLowerCase());
    const sig = (el) => `${el.tagName}.${el.className}`;
    for (const h of heads) {
      let box = h.parentElement;
      for (let up = 0; box && up < 4; up += 1, box = box.parentElement) {
        // checkboxes after this heading and before the next heading of the same kind
        const boxes = [];
        let after = false;
        for (const el of box.querySelectorAll('*')) {
          if (el === h) { after = true; continue; }
          if (!after) continue;
          if (el.children.length === 0 && el.tagName !== 'INPUT' && sig(el) === sig(h) && !el.closest('label')) break;
          if (el.matches('input[type=checkbox]')) boxes.push(el);
        }
        if (boxes.length >= 3) {
          return boxes.map((cb) => {
            const lab = (cb.id && doc.querySelector(`label[for="${CSS.escape(cb.id)}"]`)) || cb.closest('label') || cb.parentElement;
            return (lab ? lab.textContent : cb.value || '').replace(/\s+/g, ' ').trim();
          }).filter((t) => t && t.length > 1 && t.length < 60);
        }
      }
    }
    return [];
  }

  /** Listing links on a page, grouped by URL template; the biggest group (or the remembered one) wins. */
  function listingLinks(doc, base, wanted) {
    const groups = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      if (a.closest('nav,header,footer,.pagination,[class*=paginat]')) continue;
      const u = abs(a.getAttribute('href'), base);
      if (!u || u.origin !== new URL(base).origin) continue;
      const t = template(u);
      if (!t.includes(':id')) continue;
      if (!groups.has(t)) groups.set(t, new Map());
      const g = groups.get(t);
      const key = u.pathname;
      if (!g.has(key)) g.set(key, { url: u.href, anchors: [] });
      g.get(key).anchors.push(a);
    }
    let best = wanted && groups.get(wanted) ? wanted : null;
    if (!best) {
      let max = 0;
      for (const [t, g] of groups) if (g.size > max) { max = g.size; best = t; }
      if (max < 3) best = null;
    }
    return { template: best, links: best ? [...groups.get(best).values()] : [] };
  }

  /** The biggest ancestor of `a` that holds no other listing. */
  function cardOf(a, otherAnchors) {
    let el = a;
    while (el.parentElement && el.parentElement.tagName !== 'BODY') {
      const p = el.parentElement;
      if (otherAnchors.some((o) => p.contains(o))) break;
      el = p;
    }
    return el;
  }

  /** Fallback when listings are not links: the container with the most look-alike children. */
  function repeatedBlocks(doc) {
    let best = null; let bestN = 0;
    for (const el of doc.querySelectorAll('body *')) {
      if (el.children.length < 5 || el.closest('nav,header,footer,form')) continue;
      const sig = (c) => `${c.tagName}.${[...c.classList].sort().join('.')}`;
      const counts = new Map();
      for (const c of el.children) counts.set(sig(c), (counts.get(sig(c)) || 0) + 1);
      const [s, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      const items = [...el.children].filter((c) => sig(c) === s);
      const rich = items.filter((c) => /\$\s*\d|housing|,\s*[A-Z]{2}\b/i.test(c.textContent)).length;
      if (rich >= Math.min(5, n) && n > bestN && !items.some((c) => c.querySelector('input[type=checkbox]'))) { best = items; bestN = n; }
    }
    return best || [];
  }

  function employerOf(card, linkEl) {
    const h = card.querySelector('h1,h2,h3,h4,h5,h6,.card-title,[class*=title],[class*=employer],strong,b');
    const t = (h && h.textContent.trim()) || (linkEl && linkEl.textContent.trim()) || '';
    return t.replace(/\s+/g, ' ').slice(0, 120) || toLines(blockText(card))[0] || '';
  }

  let LISTING_TEMPLATE = null;
  const known = { positions: harvestFilter(document, 'Position') };

  /** Generic fallback for pages that are not InterExchange cards. */
  function genericRecords(doc, base) {
    const { template: t, links } = listingLinks(doc, base, LISTING_TEMPLATE);
    let cards;
    if (links.length) {
      LISTING_TEMPLATE = LISTING_TEMPLATE || t;
      const allAnchors = links.flatMap((l) => l.anchors);
      cards = links.map((l) => {
        const card = cardOf(l.anchors[0], allAnchors.filter((x) => !l.anchors.includes(x)));
        const textLink = l.anchors.find((x) => x.textContent.trim()) || l.anchors[0];
        return { key: new URL(l.url).pathname, url: l.url, employer: employerOf(card, textLink), text: blockText(card) };
      });
    } else {
      cards = repeatedBlocks(doc).map((card, i) => {
        const text = blockText(card);
        const a = card.querySelector('a[href]');
        const u = a ? abs(a.getAttribute('href'), base) : null;
        return { key: card.getAttribute('data-id') || (u && u.href) || `${i}:${text.slice(0, 80)}`, url: u ? u.href : '', employer: employerOf(card, a), text };
      });
    }
    return cards.map((c) => {
      const p = parseListing(c.text, known);
      return { ...c, ...p, startFrom: p.start, finishTo: p.end, rent: null, net: null, region: '', business: '', text: c.text.slice(0, 1500) };
    });
  }

  /** All listings in a document → records. */
  function extractRecords(doc, base) {
    const cards = doc.querySelectorAll('.card.job_listing, div[id^="job_listing_"].job_listing');
    if (cards.length) return [...cards].map((c) => normalizeIx(readIxCard(c, base)));
    return genericRecords(doc, base);
  }

  /** Pagination: URL builder for page N and the last page number, from the links on the page. */
  function pagination(doc, base) {
    const isNum = (el) => /^\d{1,4}$/.test(el.textContent.trim());
    const all = [...doc.querySelectorAll('a,button,li,span')].filter(isNum);
    let nums = all.filter((el) => el.closest('.pagination,[class*=paginat],[aria-label*=agination i]'));
    if (!nums.length) nums = all.filter((el) => el.closest('nav,ul'));
    const last = Math.max(1, ...nums.map((el) => +el.textContent.trim()));
    for (const a of nums) {
      if (a.tagName !== 'A') continue;
      const n = a.textContent.trim();
      const href = a.getAttribute('href');
      const u = abs(href, base);
      if (!u || href === '#' || /^javascript:/i.test(href)) continue;
      for (const [k, v] of u.searchParams) {
        if (v === n) return { last, url: (p) => { const x = new URL(u); x.searchParams.set(k, String(p)); return x.href; } };
      }
      const segs = u.pathname.split('/');
      if (segs[segs.length - 1] === n) return { last, url: (p) => { const x = new URL(u); segs[segs.length - 1] = String(p); x.pathname = segs.join('/'); return x.href; } };
    }
    return { last, url: null };
  }

  const totalCount = () => {
    const m = document.body.innerText.match(/Job Listings\s*([\d,]+)/i);
    return m ? +m[1].replace(/,/g, '') : null;
  };

  // ───────────────────────── panel ─────────────────────────

  document.getElementById('ix-collector')?.remove();
  const panel = document.createElement('div');
  panel.id = 'ix-collector';
  panel.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:360px;max-width:calc(100vw - 32px);'
    + 'background:#fff;color:#1b1f24;border:1px solid #c9d1d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.2);'
    + 'font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;padding:14px';
  panel.innerHTML = '<div style="font-weight:600;margin-bottom:6px">Сбор офферов InterExchange</div>'
    + '<div data-s style="min-height:2.8em"></div>'
    + '<div style="height:6px;background:#eef1f4;border-radius:3px;margin:8px 0"><div data-bar style="height:100%;width:0;background:#1f6feb;border-radius:3px;transition:width .2s"></div></div>'
    + '<div data-b style="display:flex;flex-wrap:wrap;gap:6px"></div>';
  document.body.appendChild(panel);
  const $s = panel.querySelector('[data-s]');
  const $bar = panel.querySelector('[data-bar]');
  const $b = panel.querySelector('[data-b]');
  const status = (t, frac) => { $s.textContent = t; if (frac != null) $bar.style.width = `${Math.min(100, Math.round(frac * 100))}%`; };
  const buttons = (list) => {
    $b.innerHTML = '';
    for (const [label, fn, primary] of list) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit;border:1px solid ${primary ? '#1f6feb' : '#c9d1d9'};`
        + `background:${primary ? '#1f6feb' : '#f6f8fa'};color:${primary ? '#fff' : '#1b1f24'}`;
      b.onclick = fn;
      $b.appendChild(b);
    }
  };
  const download = (name, content, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };

  let stopped = false;
  const stoppable = () => {
    stopped = false;
    buttons([['Стоп', () => { stopped = true; status('Останавливаю… отчёт будет из того, что уже есть.'); }]]);
  };

  // ───────────────────────── collect ─────────────────────────

  const results = new Map();
  const add = (records) => {
    let fresh = 0;
    for (const r of records) {
      const old = results.get(r.key);
      if (old) { if (r.interviews) { old.interviews = true; old.interviewOn = old.interviewOn || r.interviewOn; } continue; }
      results.set(r.key, r);
      fresh += 1;
    }
    return fresh;
  };

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'include', headers: { accept: 'text/html' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} на ${url}`);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  }

  async function viaFetch(pg) {
    const total = totalCount();
    const lastPage = Math.min(pg.last > 1 ? pg.last : CONFIG.maxPages, CONFIG.maxPages);
    let emptyStreak = 0;
    for (let p = 1; p <= lastPage && !stopped; p += 1) {
      const url = pg.url(p);
      const fresh = add(extractRecords(await fetchDoc(url), url));
      status(`Страница ${p}${pg.last > 1 ? ` из ${pg.last}` : ''} · собрано ${results.size}${total ? ` из ${total}` : ''}`, pg.last > 1 ? p / pg.last : null);
      emptyStreak = fresh ? 0 : emptyStreak + 1;
      if (pg.last <= 1 && emptyStreak >= 2) break; // unknown page count: stop when pages repeat
      await sleep(CONFIG.pauseMs + Math.random() * 300);
    }
  }

  /** Pagination without real links (single-page app): click "next" and wait for the list to change. */
  async function viaClicks() {
    const total = totalCount();
    let page = 1;
    const firstKey = () => (extractRecords(document, location.href)[0] || {}).key;
    for (;;) {
      add(extractRecords(document, location.href));
      status(`Страница ${page} · собрано ${results.size}${total ? ` из ${total}` : ''}`, total ? results.size / total : null);
      if (stopped || page >= CONFIG.maxPages) break;
      const want = String(page + 1);
      const next = [...document.querySelectorAll('a,button')].find((el) => el.textContent.trim() === want && el.closest('.pagination,[class*=paginat],nav,ul'))
        || [...document.querySelectorAll('a,button')].find((el) => /^(next|›|»|→|>)$/i.test(el.textContent.trim()) || /next/i.test(el.getAttribute('aria-label') || ''));
      if (!next || next.disabled || next.closest('.disabled')) break;
      const before = firstKey();
      next.click();
      let changed = false;
      for (let t = 0; t < 60 && !changed; t += 1) { await sleep(250); changed = firstKey() !== before; }
      if (!changed) break;
      page += 1;
      await sleep(CONFIG.pauseMs);
    }
  }

  let profilesLoaded = 0;
  const profileUrls = () => [...new Set([...results.values()].map((r) => r.url).filter(Boolean))];

  /** Host profiles: start-date window, rent, deposit, roommates, transport. One request per employer profile. */
  async function loadProfiles() {
    const urls = profileUrls();
    const queue = [...urls];
    const byUrl = new Map();
    let done = 0;
    const worker = async () => {
      while (queue.length && !stopped) {
        const u = queue.shift();
        try { byUrl.set(u, normalizeProfile(readProfile(await fetchDoc(u)))); } catch { /* keep the card data */ }
        done += 1;
        status(`Профили работодателей: ${done} из ${urls.length}`, done / urls.length);
        await sleep(CONFIG.deepPauseMs + Math.random() * 300);
      }
    };
    await Promise.all(Array.from({ length: CONFIG.deepConcurrency }, worker));
    for (const r of results.values()) { const p = byUrl.get(r.url); if (p) mergeProfile(r, p); }
    profilesLoaded = byUrl.size;
  }

  // ───────────────────────── report ─────────────────────────

  /** Runs inside the report page (serialized with toString) — must not use anything from the outer scope. */
  function reportApp(ROWS, COLS, META) {
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const safe = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
    const HRU = { provided: 'предоставляется', assistance: 'помощь с поиском', none: 'нет', '': '—' };
    const store = {
      get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    };
    const fav = new Set(store.get('ix-fav', []));
    const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
    const fill = (id, values) => $(id).insertAdjacentHTML('beforeend', values.map((v) => `<option>${esc(v)}</option>`).join(''));
    fill('st', uniq(ROWS.map((r) => r.state)));
    fill('rg', uniq(ROWS.map((r) => r.region)));
    fill('pos', uniq(ROWS.map((r) => r.position)));
    const IDS = ['q', 'st', 'rg', 'pos', 'hs', 'w', 'hr', 'rent', 'arr', 'dep', 'tp', 'so', 'strict', 'fav', 'no21', 'intv'];
    const saved = store.get('ix-filters', {});
    IDS.forEach((i) => { const el = $(i); if (saved[i] == null) return; if (el.type === 'checkbox') el.checked = saved[i]; else el.value = saved[i]; });
    if (!META.profiles) $('dates-note').hidden = false;

    const miss = (v) => v == null || v === '';
    const read = () => Object.fromEntries(IDS.map((i) => [i, $(i).type === 'checkbox' ? $(i).checked : $(i).value]));
    function pass(r, v) {
      const need = (val, ok) => (miss(val) ? !v.strict : ok(val));
      if (v.fav && !fav.has(r.key)) return false;
      if (v.q) {
        const hay = `${r.employer} ${r.position} ${r.city} ${r.state} ${r.business} ${r.text}`.toLowerCase();
        if (!hay.includes(v.q.trim().toLowerCase())) return false;
      }
      if (v.st && r.state !== v.st) return false;
      if (v.rg && r.region !== v.rg) return false;
      if (v.pos && r.position !== v.pos) return false;
      if (v.hs === 'provided' && r.housing !== 'provided') return false;
      if (v.hs === 'any' && r.housing !== 'provided' && r.housing !== 'assistance') return false;
      if (v.w !== '' && !need(r.wage, (x) => (r.wageMax || x) >= +v.w)) return false;
      if (v.hr !== '' && !need(r.hours, (x) => (r.hoursMax || x) >= +v.hr)) return false;
      if (v.rent !== '' && !need(r.rent, (x) => x <= +v.rent)) return false;
      if (v.arr && !need(r.startFrom, (s) => s <= v.arr && (!r.startTo || v.arr <= r.startTo))) return false;
      if (v.dep && !need(r.finishFrom, (f) => f <= v.dep)) return false;
      if (v.tp === '1' && !r.tipped) return false;
      if (v.tp === '0' && r.tipped) return false;
      if (v.no21 && r.age21) return false;
      if (v.intv && !r.interviews) return false;
      return true;
    }
    const DESC = { weekly: 1, net: 1, wage: 1, hours: 1, openings: 1, lastVisited: 1 };
    let shown = [];
    function render() {
      const v = read();
      store.set('ix-filters', v);
      shown = ROWS.filter((r) => pass(r, v));
      const k = v.so;
      shown.sort((a, b) => {
        const x = a[k]; const y = b[k];
        if (miss(x) && miss(y)) return 0;
        if (miss(x)) return 1;
        if (miss(y)) return -1;
        if (typeof x === 'number') return DESC[k] ? y - x : x - y;
        return DESC[k] ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
      });
      const cnt = (f) => ROWS.filter(f).length;
      $('sum').textContent = `Всего: ${ROWS.length} · жильё предоставляется: ${cnt((r) => r.housing === 'provided')}`
        + ` · помощь с жильём: ${cnt((r) => r.housing === 'assistance')} · с интервью: ${cnt((r) => r.interviews)}`
        + ` · ★ ${fav.size} · собрано ${META.date}`;
      $('cnt').textContent = `Подходит: ${shown.length}`;
      const money = (a) => (a == null ? '—' : `$${a}`);
      const range = (a, b) => (a ? esc(a) + (b && b !== a ? ` → ${esc(b)}` : '') : '—');
      $('tb').innerHTML = shown.slice(0, 1500).map((r) => {
        const flags = [
          r.interviews ? `<span class="chip ok">интервью${r.interviewOn ? ` ${esc(r.interviewOn)}` : ''}</span>` : '',
          r.age21 ? '<span class="chip warn">21+</span>' : '',
          r.overtime === 'yes' ? '<span class="chip">overtime</span>' : '',
          r.drugTest && /^yes/i.test(r.drugTest) ? '<span class="chip warn">drug test</span>' : '',
        ].join('');
        const housingExtra = [
          r.rent != null ? `$${r.rent}/нед` : '',
          r.shareBedroom ? `${r.shareBedroom} в комнате` : '',
          r.deposit ? `залог $${r.deposit}` : '',
        ].filter(Boolean).join(' · ');
        return `<tr>
          <td><button class="star${fav.has(r.key) ? ' on' : ''}" data-f="${esc(r.key)}" title="В избранное">★</button></td>
          <td><b>${esc(r.position || '—')}</b><div>${esc(r.employer)}</div><div class="mut">${esc(r.business)}</div>
            <div>${flags}</div><details><summary>описание</summary><pre>${esc(r.text)}${r.address ? `\n\nАдрес: ${esc(r.address)}` : ''}${r.meals ? `\nЕда: ${esc(r.meals)}` : ''}${r.transportCost != null ? `\nТранспорт: $${r.transportCost}/нед ${esc(r.distance || '')}` : ''}</pre></details></td>
          <td>${esc([r.city, r.state].filter(Boolean).join(', ') || '—')}<div class="mut">${esc(r.region)}</div></td>
          <td class="n">${money(r.wage)}${r.tipped ? '<div class="mut">+ чаевые</div>' : r.tipsSometimes ? '<div class="mut">иногда чаевые</div>' : ''}</td>
          <td class="n">${r.hours == null ? '—' : esc(r.hours)}</td>
          <td class="n"><b>${money(r.weekly)}</b></td>
          <td class="n">${money(r.net)}</td>
          <td><span class="h-${esc(r.housing)}">${esc(HRU[r.housing || ''])}</span>${housingExtra ? `<div class="mut">${housingExtra}</div>` : ''}</td>
          <td class="d">${range(r.startFrom, r.startTo)}</td>
          <td class="d">${range(r.finishFrom, r.finishTo)}</td>
          <td class="n">${r.openings == null ? '—' : esc(r.openings)}</td>
          <td>${safe(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Профиль</a>` : ''}</td></tr>`;
      }).join('') + (shown.length > 1500 ? '<tr><td colspan="12" class="mut">Показаны первые 1500 — уточните фильтры или скачайте CSV.</td></tr>' : '');
    }
    document.addEventListener('input', (e) => { if (IDS.includes(e.target.id)) render(); });
    document.addEventListener('click', (e) => {
      const f = e.target.closest('[data-f]');
      if (f) { const k = f.dataset.f; if (fav.has(k)) fav.delete(k); else fav.add(k); store.set('ix-fav', [...fav]); render(); return; }
      const th = e.target.closest('th[data-k]');
      if (th) { $('so').value = th.dataset.k; render(); }
    });
    $('reset').onclick = () => { IDS.forEach((i) => { const el = $(i); if (el.type === 'checkbox') el.checked = false; else el.value = i === 'so' ? 'weekly' : ''; }); render(); };
    $('csv').onclick = () => {
      const cell = (x) => { const s = x == null ? '' : String(x); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const val = (r, k) => {
        if (k === 'housing') return HRU[r.housing || ''];
        if (k === 'tipped' || k === 'age21') return r[k] == null ? '' : r[k] ? 'да' : 'нет';
        if (k === 'overtime') return { yes: 'да', maybe: 'возможно' }[r.overtime] || '';
        return r[k];
      };
      const csv = `﻿${[COLS.map((c) => c[1]), ...shown.map((r) => COLS.map(([k]) => val(r, k)))].map((row) => row.map(cell).join(';')).join('\r\n')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'interexchange-offers.csv';
      a.click();
    };
    render();
  }

  const REPORT_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#5b6470;--line:#dde2e8;--acc:#1f6feb;--good:#1a7f37;--warn:#9a6700;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--fg:#e6e9ee;--mut:#9aa4b2;--line:#2a313b;--acc:#4c8dff;--good:#3fb950;--warn:#d29922;--chip:#222934}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 16px 8px;max-width:1500px;margin:auto}h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut);font-size:12px}
.f{max-width:1500px;margin:auto;padding:8px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.f label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
.f input,.f select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.f .cb{flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--fg)}
.note{max-width:1500px;margin:0 auto;padding:0 16px;color:var(--warn);font-size:13px}
.bar{max-width:1500px;margin:auto;padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.p{background:var(--acc);border-color:var(--acc);color:#fff}
.wrap{max-width:1500px;margin:auto;padding:0 16px 40px;overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line)}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600;white-space:nowrap;position:sticky;top:0;background:var(--card)}th[data-k]{cursor:pointer}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td.d{white-space:nowrap;font-size:13px}
.chip{display:inline-block;padding:1px 7px;margin:2px 4px 0 0;border-radius:10px;background:var(--chip);font-size:11px;white-space:nowrap}
.chip.ok{color:var(--good)}.chip.warn{color:var(--warn)}
.h-provided{color:var(--good);font-weight:600}.h-assistance{color:var(--warn)}
.star{background:none;border:0;font-size:18px;padding:0 4px;color:var(--mut)}.star.on{color:#e3a008}
details summary{cursor:pointer;color:var(--acc);font-size:12px}details pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace;max-width:560px;color:var(--mut)}
a{color:var(--acc)}`;

  function reportHtml(rows) {
    const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
    const meta = { date: new Date().toISOString().slice(0, 10), profiles: profilesLoaded };
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Офферы InterExchange</title><style>${REPORT_CSS}</style></head><body>
<header><h1>Офферы InterExchange</h1><div class="mut" id="sum"></div></header>
<div class="f">
<label>Поиск<input id="q" placeholder="работодатель, город, слово…"></label>
<label>Штат<select id="st"><option value="">Все</option></select></label>
<label>Регион<select id="rg"><option value="">Все</option></select></label>
<label>Должность<select id="pos"><option value="">Все</option></select></label>
<label>Жильё<select id="hs"><option value="">Любое</option><option value="provided">Предоставляется</option><option value="any">Предоставляется или помощь</option></select></label>
<label>Ставка от, $/ч<input id="w" type="number" step="0.5" min="0"></label>
<label>Часов в неделю от<input id="hr" type="number" min="0"></label>
<label>Аренда до, $/нед<input id="rent" type="number" min="0"></label>
<label>Я приезжаю (окно начала)<input id="arr" type="date"></label>
<label>Мне уезжать не позже<input id="dep" type="date"></label>
<label>Чаевые<select id="tp"><option value="">Неважно</option><option value="1">Только с чаевыми</option><option value="0">Без чаевых</option></select></label>
<label>Сортировка<select id="so"><option value="weekly">≈$ в неделю</option><option value="net">≈$ после аренды</option><option value="wage">Ставка</option><option value="hours">Часы</option><option value="startFrom">Дата начала</option><option value="openings">Мест больше</option><option value="lastVisited">Работодатель активнее</option><option value="employer">Работодатель</option><option value="state">Штат</option></select></label>
<label class="cb"><input id="intv" type="checkbox">Только с интервью</label>
<label class="cb"><input id="no21" type="checkbox">Скрыть «только 21+»</label>
<label class="cb"><input id="strict" type="checkbox">Строго: прятать, если поле не указано</label>
<label class="cb"><input id="fav" type="checkbox">Только ★</label>
</div>
<p class="note" id="dates-note" hidden>Даты начала, аренда и соседи есть только в профилях работодателей — нажмите «Догрузить профили» на панели и откройте отчёт заново.</p>
<div class="bar"><b id="cnt"></b><span style="flex:1"></span><button id="reset">Сбросить фильтры</button><button class="p" id="csv">Скачать CSV (показанные)</button></div>
<div class="wrap"><table><thead><tr><th></th><th data-k="employer">Должность / работодатель</th><th data-k="state">Город</th><th data-k="wage">$/ч</th><th data-k="hours">Ч/нед</th><th data-k="weekly">≈$/нед</th><th data-k="net">После аренды</th><th>Жильё</th><th data-k="startFrom">Начало</th><th>Конец</th><th data-k="openings">Мест</th><th></th></tr></thead><tbody id="tb"></tbody></table></div>
<script>(${reportApp.toString()})(${json(rows)}, ${json(CSV_COLUMNS)}, ${json(meta)});</script>
</body></html>`;
  }

  function finish() {
    const rows = [...results.values()];
    window.__ixOffers = rows;
    if (!rows.length) {
      status('Не нашёл вакансий на странице. Сохраните страницу (Cmd/Ctrl+S → «Веб-страница, только HTML») и пришлите файл — подстрою скрипт.', 0);
      buttons([['Закрыть', () => panel.remove()]]);
      return;
    }
    const hp = rows.filter((r) => r.housing === 'provided').length;
    const urls = profileUrls();
    status(`Готово: ${rows.length} вакансий, жильё предоставляется у ${hp}.`
      + (profilesLoaded ? ` Профили работодателей: ${profilesLoaded}.` : ` Даты начала и аренда — в профилях (${urls.length} шт., ~${Math.max(1, Math.ceil(urls.length * 0.35 / 60))} мин).`), 1);
    const stamp = new Date().toISOString().slice(0, 10);
    const list = [
      ['Открыть отчёт', () => {
        const html = reportHtml([...results.values()]);
        const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
        if (!w) download(`interexchange-offers-${stamp}.html`, html, 'text/html');
      }, true],
    ];
    if (!profilesLoaded && urls.length) list.push(['Догрузить профили', async () => { stoppable(); await loadProfiles(); finish(); }]);
    list.push(
      ['Скачать отчёт', () => download(`interexchange-offers-${stamp}.html`, reportHtml([...results.values()]), 'text/html')],
      ['CSV', () => download(`interexchange-offers-${stamp}.csv`, toCsv([...results.values()]), 'text/csv')],
      ['Закрыть', () => panel.remove()],
    );
    buttons(list);
    console.log(`[InterExchange] собрано ${rows.length}. Данные: window.__ixOffers`);
  }

  (async () => {
    stoppable();
    try {
      status('Смотрю, как устроен список…');
      const pg = pagination(document, location.href);
      let mode = 'clicks';
      if (pg.url) {
        try {
          const probeUrl = pg.url(pg.last > 1 ? 2 : 1);
          if (extractRecords(await fetchDoc(probeUrl), probeUrl).length) mode = 'fetch';
        } catch { /* fall back to clicking */ }
      }
      if (mode === 'fetch') await viaFetch(pg);
      else await viaClicks();
      if (CONFIG.deep && !stopped) await loadProfiles();
    } catch (e) {
      console.error(e);
      status(`Ошибка: ${e.message}. Отчёт — из того, что успел собрать.`);
    }
    finish();
  })();
})();

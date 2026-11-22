/*
 * InterExchange → список офферов.
 *
 * Как пользоваться:
 *   1. Войдите в InterExchange и откройте вкладку «Job Listings» (фильтры сайта можно оставить пустыми —
 *      если какие-то выставить, скрипт соберёт только то, что они показывают).
 *   2. Откройте консоль браузера: Cmd+Option+J (Mac) / Ctrl+Shift+J (Windows), вкладка Console.
 *      Chrome может попросить сначала ввести `allow pasting` — введите и нажмите Enter.
 *   3. Вставьте весь этот файл и нажмите Enter.
 *   4. Внизу слева появится панель с прогрессом. Когда сбор закончится — «Открыть отчёт»:
 *      там фильтры (жильё, ставка, часы, штат, даты, должность), сортировка по ≈$ в неделю, ★ избранное,
 *      экспорт в CSV.
 *
 * Скрипт только читает страницы, которые вам и так видны (те же запросы, что при листании вручную),
 * с паузой между страницами. Ничего не отправляет и никуда не сохраняет, кроме файлов, которые вы скачаете сами.
 */
(() => {
  'use strict';

  const CONFIG = {
    pauseMs: 700, // пауза между страницами списка
    deep: false, // true — дополнительно открыть страницу каждой вакансии (дольше, но больше данных)
    deepConcurrency: 3,
    deepPauseMs: 400,
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

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const HOUSING_RU = { provided: 'предоставляется', assistance: 'помощь с поиском', none: 'нет', '': '' };
  const CSV_COLUMNS = [
    ['employer', 'Работодатель'], ['position', 'Должность'], ['city', 'Город'], ['state', 'Штат'], ['wage', 'Ставка $/ч'],
    ['hours', 'Часов в неделю'], ['weekly', '≈$ в неделю'], ['housing', 'Жильё'], ['housingCost', 'Стоимость жилья'],
    ['tipped', 'Чаевые'], ['start', 'Начало'], ['end', 'Конец'], ['interviews', 'Интервью'], ['openings', 'Мест'],
    ['url', 'Ссылка'],
  ];
  function toCsv(rows) {
    const val = (r, k) => (k === 'housing' ? HOUSING_RU[r.housing || ''] : k === 'tipped' ? (r.tipped == null ? '' : r.tipped ? 'да' : 'нет') : r[k]);
    return `﻿${[CSV_COLUMNS.map((c) => c[1]), ...rows.map((r) => CSV_COLUMNS.map(([k]) => val(r, k)))]
      .map((r) => r.map(csvCell).join(';')).join('\r\n')}`;
  }

  const IX = { toLines, labelValue, findDates, parseWage, parseHours, parseHousing, parseLocation, parseDates, parseListing, toCsv };

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abs = (href, base) => { try { return new URL(href, base); } catch { return null; } };
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
      if ([...otherAnchors].some((o) => p.contains(o))) break;
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

  /** All listings in a document → [{ key, url, employer, text }]. */
  function extractCards(doc, base) {
    const { template: t, links } = listingLinks(doc, base, LISTING_TEMPLATE);
    if (links.length) {
      LISTING_TEMPLATE = LISTING_TEMPLATE || t;
      const allAnchors = links.flatMap((l) => l.anchors);
      return links.map((l) => {
        const others = allAnchors.filter((x) => !l.anchors.includes(x));
        const card = cardOf(l.anchors[0], others);
        const textLink = l.anchors.find((x) => x.textContent.trim()) || l.anchors[0];
        return { key: new URL(l.url).pathname, url: l.url, employer: employerOf(card, textLink), text: blockText(card) };
      });
    }
    return repeatedBlocks(doc).map((card, i) => {
      const text = blockText(card);
      const a = card.querySelector('a[href]');
      const url = a ? (abs(a.getAttribute('href'), base) || {}).href || '' : '';
      return { key: card.getAttribute('data-id') || url || `${i}:${text.slice(0, 80)}`, url, employer: employerOf(card, a), text };
    });
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
      const u = abs(a.getAttribute('href'), base);
      if (!u || u.href.startsWith('javascript') || a.getAttribute('href') === '#') continue;
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
  panel.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:340px;max-width:calc(100vw - 32px);'
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
  const button = (label, fn, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit;border:1px solid ${primary ? '#1f6feb' : '#c9d1d9'};`
      + `background:${primary ? '#1f6feb' : '#f6f8fa'};color:${primary ? '#fff' : '#1b1f24'}`;
    b.onclick = fn;
    $b.appendChild(b);
    return b;
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
  const stopBtn = button('Стоп', () => { stopped = true; stopBtn.disabled = true; status('Останавливаю… соберу отчёт из того, что уже есть.'); });

  // ───────────────────────── collect ─────────────────────────

  const known = { positions: harvestFilter(document, 'Position') };
  const results = new Map();
  const add = (cards) => {
    let fresh = 0;
    for (const c of cards) {
      if (results.has(c.key)) continue;
      results.set(c.key, { ...c, ...parseListing(c.text, known) });
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
    let emptyStreak = 0;
    for (let p = 1; p <= Math.min(pg.last > 1 ? pg.last : CONFIG.maxPages, CONFIG.maxPages) && !stopped; p += 1) {
      const doc = await fetchDoc(pg.url(p));
      const fresh = add(extractCards(doc, pg.url(p)));
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
    const firstKey = () => (extractCards(document, location.href)[0] || {}).key;
    for (;;) {
      add(extractCards(document, location.href));
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

  async function deepen() {
    const list = [...results.values()].filter((r) => r.url);
    let done = 0;
    const worker = async () => {
      while (list.length && !stopped) {
        const r = list.shift();
        try {
          const doc = await fetchDoc(r.url);
          doc.querySelectorAll('nav,header,footer,script,style,form').forEach((n) => n.remove());
          const text = blockText(doc.querySelector('main') || doc.body);
          const more = parseListing(text, known);
          for (const [k, v] of Object.entries(more)) if (v != null && v !== '' && (r[k] == null || r[k] === '')) r[k] = v;
          r.text = `${r.text}\n\n${text}`.slice(0, 6000);
        } catch { /* keep the card data */ }
        done += 1;
        status(`Подробности: ${done} из ${results.size}`, done / results.size);
        await sleep(CONFIG.deepPauseMs);
      }
    };
    await Promise.all(Array.from({ length: CONFIG.deepConcurrency }, worker));
  }

  // ───────────────────────── report ─────────────────────────

  function reportHtml(rows) {
    const data = JSON.stringify(rows.map((r) => ({ ...r, text: r.text.slice(0, 4000) }))).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Офферы InterExchange</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#5b6470;--line:#dde2e8;--acc:#1f6feb;--good:#1a7f37;--warn:#9a6700;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--fg:#e6e9ee;--mut:#9aa4b2;--line:#2a313b;--acc:#4c8dff;--good:#3fb950;--warn:#d29922;--chip:#222934}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 16px 8px;max-width:1400px;margin:auto}h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}
.f{max-width:1400px;margin:auto;padding:8px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.f label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
.f input,.f select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.f .cb{flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--fg)}
.bar{max-width:1400px;margin:auto;padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.p{background:var(--acc);border-color:var(--acc);color:#fff}
.wrap{max-width:1400px;margin:auto;padding:0 16px 40px;overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600;white-space:nowrap;cursor:pointer;position:sticky;top:0;background:var(--card)}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.chip{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--chip);font-size:12px;white-space:nowrap}
.h-provided{color:var(--good);font-weight:600}.h-assistance{color:var(--warn)}
.star{background:none;border:0;font-size:18px;padding:0 4px;color:var(--mut)}.star.on{color:#e3a008}
details summary{cursor:pointer;color:var(--acc);font-size:12px}details pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace;max-width:520px;color:var(--mut)}
a{color:var(--acc)}
</style></head><body>
<header><h1>Офферы InterExchange</h1><div class="mut" id="sum"></div></header>
<div class="f">
<label>Поиск<input id="q" placeholder="работодатель, город, слово…"></label>
<label>Штат<select id="st"><option value="">Все</option></select></label>
<label>Должность<select id="pos"><option value="">Все</option></select></label>
<label>Жильё<select id="hs"><option value="">Любое</option><option value="provided">Предоставляется</option><option value="any">Предоставляется или помощь</option></select></label>
<label>Ставка от, $/ч<input id="w" type="number" step="0.5" min="0"></label>
<label>Часов в неделю от<input id="hr" type="number" min="0"></label>
<label>Начало не раньше<input id="ds" type="date"></label>
<label>Конец не позже<input id="de" type="date"></label>
<label>Чаевые<select id="tp"><option value="">Неважно</option><option value="1">Только с чаевыми</option><option value="0">Без чаевых</option></select></label>
<label>Сортировка<select id="so"><option value="weekly">≈$ в неделю</option><option value="wage">Ставка</option><option value="hours">Часы</option><option value="start">Дата начала</option><option value="employer">Работодатель</option><option value="state">Штат</option></select></label>
<label class="cb"><input id="strict" type="checkbox">Строго: прятать, если поле не указано</label>
<label class="cb"><input id="fav" type="checkbox">Только ★</label>
</div>
<div class="bar"><b id="cnt"></b><span style="flex:1"></span><button id="reset">Сбросить фильтры</button><button class="p" id="csv">Скачать CSV (показанные)</button></div>
<div class="wrap"><table><thead><tr><th></th><th data-k="employer">Работодатель</th><th data-k="position">Должность</th><th data-k="state">Город</th><th data-k="wage">$/ч</th><th data-k="hours">Ч/нед</th><th data-k="weekly">≈$/нед</th><th>Жильё</th><th data-k="start">Даты</th><th>Чаевые</th><th>Интервью</th><th></th></tr></thead><tbody id="tb"></tbody></table></div>
<script>
const ROWS=${data};
const CSV_COLUMNS=${JSON.stringify(CSV_COLUMNS)};
const HRU={provided:'предоставляется',assistance:'помощь с поиском',none:'нет','':''};
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safe=(u)=>/^https?:\\/\\//i.test(u||'')?u:'';
let fav=new Set();try{fav=new Set(JSON.parse(localStorage.getItem('ix-fav')||'[]'))}catch{}
const saveFav=()=>{try{localStorage.setItem('ix-fav',JSON.stringify([...fav]))}catch{}};
const ids=['q','st','pos','hs','w','hr','ds','de','tp','so','strict','fav'];
try{const s=JSON.parse(localStorage.getItem('ix-filters')||'{}');ids.forEach((i)=>{if(s[i]!=null){const el=$(i);el.type==='checkbox'?el.checked=s[i]:el.value=s[i]}})}catch{}
const states=[...new Set(ROWS.map(r=>r.state).filter(Boolean))].sort();
$('st').insertAdjacentHTML('beforeend',states.map(s=>'<option>'+esc(s)+'</option>').join(''));
const poss=[...new Set(ROWS.flatMap(r=>(r.position||'').split(', ')).filter(Boolean))].sort();
$('pos').insertAdjacentHTML('beforeend',poss.map(s=>'<option>'+esc(s)+'</option>').join(''));
ids.forEach(i=>{try{const s=JSON.parse(localStorage.getItem('ix-filters')||'{}');if(s[i]!=null&&(i==='st'||i==='pos'))$(i).value=s[i]}catch{}});
let shown=[];
function render(){
  const v={};ids.forEach(i=>{const el=$(i);v[i]=el.type==='checkbox'?el.checked:el.value});
  try{localStorage.setItem('ix-filters',JSON.stringify(v))}catch{}
  const q=v.q.trim().toLowerCase(),w=parseFloat(v.w),hr=parseFloat(v.hr),strict=v.strict;
  const miss=(x)=>x==null||x==='';
  shown=ROWS.filter(r=>{
    if(v.fav&&!fav.has(r.key))return false;
    if(q&&!(r.employer+' '+r.position+' '+r.city+' '+r.state+' '+r.text).toLowerCase().includes(q))return false;
    if(v.st&&r.state!==v.st)return false;
    if(v.pos&&!(r.position||'').split(', ').includes(v.pos))return false;
    if(v.hs==='provided'&&!(r.housing==='provided'||(!strict&&!r.housing)))return false;
    if(v.hs==='any'&&!(r.housing==='provided'||r.housing==='assistance'||(!strict&&!r.housing)))return false;
    if(!isNaN(w)&&(miss(r.wage)?strict:(r.wageMax||r.wage)<w))return false;
    if(!isNaN(hr)&&(miss(r.hours)?strict:(r.hoursMax||r.hours)<hr))return false;
    if(v.ds&&(miss(r.start)?strict:r.start<v.ds))return false;
    if(v.de&&(miss(r.end)?strict:r.end>v.de))return false;
    if(v.tp==='1'&&(r.tipped==null?strict:!r.tipped))return false;
    if(v.tp==='0'&&(r.tipped==null?strict:r.tipped))return false;
    return true;
  });
  const k=v.so,num=['weekly','wage','hours'].includes(k);
  shown.sort((a,b)=>{const x=a[k],y=b[k];if(miss(x)&&miss(y))return 0;if(miss(x))return 1;if(miss(y))return -1;return num?y-x:String(x).localeCompare(String(y))});
  const hp=ROWS.filter(r=>r.housing==='provided').length,ha=ROWS.filter(r=>r.housing==='assistance').length;
  $('sum').textContent='Всего собрано: '+ROWS.length+' · жильё предоставляется: '+hp+' · помощь с жильём: '+ha+' · ★ '+fav.size;
  $('cnt').textContent='Подходит: '+shown.length;
  $('tb').innerHTML=shown.slice(0,1500).map(r=>{
    const money=(a,b)=>a==null?'—':'$'+a+(b?'–'+b:'');
    const dates=r.start?esc(r.start)+(r.end?' → '+esc(r.end):''):'—';
    return '<tr><td><button class="star'+(fav.has(r.key)?' on':'')+'" data-f="'+esc(r.key)+'" title="В избранное">★</button></td>'
      +'<td><b>'+esc(r.employer)+'</b><details><summary>текст</summary><pre>'+esc(r.text)+'</pre></details></td>'
      +'<td>'+esc(r.position||'—')+'</td><td>'+esc([r.city,r.state].filter(Boolean).join(', ')||'—')+'</td>'
      +'<td class="n">'+money(r.wage,r.wageMax)+'</td><td class="n">'+(r.hours==null?'—':esc(r.hours)+(r.hoursMax?'–'+esc(r.hoursMax):''))+'</td>'
      +'<td class="n"><b>'+(r.weekly==null?'—':'$'+r.weekly)+'</b></td>'
      +'<td><span class="h-'+esc(r.housing)+'">'+esc(HRU[r.housing||'']||'—')+'</span>'+(r.housingCost?'<div class="mut" style="font-size:12px">'+esc(r.housingCost)+'</div>':'')+'</td>'
      +'<td style="white-space:nowrap">'+dates+'</td><td>'+(r.tipped==null?'—':r.tipped?'да':'нет')+'</td>'
      +'<td style="font-size:12px">'+esc(r.interviews||'—')+'</td>'
      +'<td>'+(safe(r.url)?'<a href="'+esc(r.url)+'" target="_blank" rel="noopener">Открыть</a>':'')+'</td></tr>';
  }).join('')+(shown.length>1500?'<tr><td colspan="12" class="mut">Показаны первые 1500 — уточните фильтры или скачайте CSV.</td></tr>':'');
}
document.addEventListener('input',(e)=>{if(ids.includes(e.target.id))render()});
document.addEventListener('click',(e)=>{
  const f=e.target.closest('[data-f]');if(f){const k=f.dataset.f;fav.has(k)?fav.delete(k):fav.add(k);saveFav();render();return}
  const th=e.target.closest('th[data-k]');if(th){$('so').value=th.dataset.k;render()}
});
$('reset').onclick=()=>{ids.forEach(i=>{const el=$(i);if(el.type==='checkbox')el.checked=false;else el.value=i==='so'?'weekly':''});render()};
$('csv').onclick=()=>{
  const cell=(v)=>{const s=v==null?'':String(v);return /[",;\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const val=(r,k)=>k==='housing'?HRU[r.housing||'']:k==='tipped'?(r.tipped==null?'':r.tipped?'да':'нет'):r[k];
  const csv='\\uFEFF'+[CSV_COLUMNS.map(c=>c[1]),...shown.map(r=>CSV_COLUMNS.map(([k])=>val(r,k)))].map(r=>r.map(cell).join(';')).join('\\r\\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='interexchange-offers.csv';a.click();
};
render();
</script></body></html>`;
  }

  function finish() {
    const rows = [...results.values()];
    window.__ixOffers = rows;
    stopBtn.remove();
    if (!rows.length) {
      status('Не нашёл вакансий на странице. Сохраните страницу (Cmd/Ctrl+S → «Веб-страница, только HTML») и пришлите файл — подстрою скрипт под разметку.', 0);
      return;
    }
    const hp = rows.filter((r) => r.housing === 'provided').length;
    const wage = rows.filter((r) => r.wage != null).length;
    status(`Готово: ${rows.length} вакансий (жильё предоставляется: ${hp}; ставка распознана у ${wage}).`, 1);
    const stamp = new Date().toISOString().slice(0, 10);
    const html = reportHtml(rows);
    button('Открыть отчёт', () => {
      const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
      if (!w) download(`interexchange-offers-${stamp}.html`, html, 'text/html');
    }, true);
    button('Скачать отчёт', () => download(`interexchange-offers-${stamp}.html`, html, 'text/html'));
    button('CSV', () => download(`interexchange-offers-${stamp}.csv`, toCsv(rows), 'text/csv'));
    button('JSON', () => download(`interexchange-offers-${stamp}.json`, JSON.stringify(rows, null, 2), 'application/json'));
    button('Закрыть', () => panel.remove());
    console.log(`[InterExchange] собрано ${rows.length}. Данные: window.__ixOffers`);
    console.table(rows.filter((r) => r.weekly).sort((a, b) => b.weekly - a.weekly).slice(0, 20)
      .map((r) => ({ employer: r.employer, position: r.position, city: `${r.city}, ${r.state}`, wage: r.wage, hours: r.hours, weekly: r.weekly, housing: r.housing })));
  }

  (async () => {
    try {
      status('Смотрю, как устроен список…');
      const pg = pagination(document, location.href);
      let mode = 'clicks';
      if (pg.url) {
        try {
          const probe = await fetchDoc(pg.url(pg.last > 1 ? 2 : 1));
          if (extractCards(probe, pg.url(2)).length) mode = 'fetch';
        } catch { /* fall back to clicking */ }
      }
      if (mode === 'fetch') await viaFetch(pg);
      else await viaClicks();
      if (CONFIG.deep && !stopped) await deepen();
    } catch (e) {
      console.error(e);
      status(`Ошибка: ${e.message}. Отчёт — из того, что успел собрать.`);
    }
    finish();
  })();
})();

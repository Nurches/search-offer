import {
  CATEGORIES, CATEGORY_BY_ID, HOTSPOTS, HOTSPOT_TYPES, HOUSING_INFO, HOUSING_LIKELY_CATEGORIES, STATES, STATE_BY_CODE,
} from './data.js';
import {
  buildOverpassQuery, geocodeCity, parseOverpass, runOverpass, searchGooglePlaces, sortLeads, suggestCities,
  buildCityListQuery, parseCityList, matchCities,
  assessFit, haversineKm,
} from './search.js';
import {
  DEFAULT_PROFILE, DEFAULT_TEMPLATES, DEFAULT_TEMPLATES_PAIR, defaultTemplatesFor, partnerCc, SOLO_EXPERIENCE, PAIR_EXPERIENCE, STATUSES, STATUS_BY_ID, composeEmail, emailSearchUrl, gmailComposeUrl,
  googleMapsEmbedUrl, googleMapsSearchUrl, googleMapsUrl, jobBoardLinks, mailtoUrl, housingLinks,
} from './outreach.js';
import { GmailClient, analyzeThread, gmailThreadUrl } from './gmail.js';
import { KEYS, download, leadsToCsv, load, mergeLeads as mergeSavedLeads, save, toSavedLead } from './store.js';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const FOLLOWUP_DAYS = 7;
const HOUSING_STATUS = {
  provided: { label: '🏠 Даёт жильё', color: 'green' },
  help: { label: '🏠 Помогает найти', color: 'amber' },
  none: { label: '🔑 Жильё ищем сами', color: 'gray' },
};
const HOUSING_RE = /\b(housing|dorm(itor(y|ies))?|apartments?|accommodations?|lodging for (staff|employees)|room and board|rent)\b/i;
const hotspotFor = (city, st) => HOTSPOTS.find((h) => h.state === st && city && h.name.toLowerCase() === String(city).toLowerCase());
const FIT_LABEL = { ok: '✓ Подходит', check: '⚠ Уточнить', bad: '✕ Не подходит' };

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ---------- state ----------
const state = {
  settings: load(KEYS.settings, { apiBase: '' }),
  profile: { ...DEFAULT_PROFILE, ...load(KEYS.profile, {}) },
  tpl: {
    solo: { ...structuredClone(DEFAULT_TEMPLATES), ...load(KEYS.templates, {}) },
    pair: { ...structuredClone(DEFAULT_TEMPLATES_PAIR), ...load(KEYS.templatesPair, {}) },
  },
  saved: new Map(load(KEYS.leads, []).map((l) => [l.id, l])),
  attachments: load(KEYS.attachments, []), // [{ filename, mimeType, data(base64), size }]
  results: [],
  selected: new Set(),
  city: null, // {name, state, lat, lon}
  server: { ok: false, places: false, emails: false, base: null },
  searchAbort: null,
  lastCtx: null,
};

const mode = () => (state.profile.searchMode === 'pair' ? 'pair' : 'solo');
const tpls = () => state.tpl[mode()];
const saveTemplates = () => save(mode() === 'pair' ? KEYS.templatesPair : KEYS.templates, tpls());

function persistLeads() {
  save(KEYS.leads, [...state.saved.values()]);
  $('#trackerCount').textContent = state.saved.size;
}

// ---------- server detection ----------
function apiBaseCandidates() {
  const custom = (state.settings.apiBase || '').trim();
  if (custom) return [custom.endsWith('/') ? custom : `${custom}/`];
  return [new URL('./', location.href).href];
}

async function detectServer() {
  for (const base of apiBaseCandidates()) {
    try {
      const res = await fetch(`${base}api/health`, { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (j?.app === 'wt-job-finder') {
        state.server = { ok: true, places: !!j.places, emails: !!j.emails, base, oauthClientId: j.oauthClientId || '' };
        break;
      }
    } catch { /* static hosting: no server */ }
  }
  const s = state.server;
  $('#sourceField').hidden = !s.places;
  $('#bulkEnrich').hidden = !s.emails;
  $('#enrichAllBtn').hidden = !s.emails;
  $('#searchHint').textContent = s.ok
    ? `Сервер подключён${s.emails ? ': email ищутся на сайтах заведений' : ''}${s.places ? ', доступен Google Places' : ''}.`
    : 'Данные: OpenStreetMap. Каждое место можно сразу открыть в Google Maps. Поиск email на сайтах работает, если запущен сервер (см. README).';
  renderServerStatus();
  renderGmailBar();
  $('#cmSendApi').hidden = !oauthClientId();
}

// ---------- tabs ----------
function showTab(id) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${id}`));
  if (id === 'search') setTimeout(() => map?.invalidateSize(), 50);
  if (id === 'tracker') { renderTracker(); markRepliesSeen(); }
  if (id === 'letter') renderTemplateEditor();
  history.replaceState(null, '', `#${id}`);
}

function initTabs() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  const initial = location.hash.replace('#', '');
  if (initial && $(`#tab-${initial}`)) showTab(initial);
}

// ---------- map ----------
let map; let markerLayer; let centerLayer;
const markers = new Map();

function initMap() {
  if (typeof L === 'undefined') { $('#map').textContent = 'Карта не загрузилась'; return; }
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView([39.5, -98.35], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  centerLayer = L.layerGroup().addTo(map);

  // Fullscreen toggle
  const FullCtl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar map-ctl');
      box.innerHTML = '<a href="#" role="button" id="mapFullBtn" title="Карта на весь экран" aria-label="Карта на весь экран">⛶</a>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(box.firstChild, 'click', (e) => { L.DomEvent.preventDefault(e); toggleMapFull(); });
      return box;
    },
  });
  new FullCtl().addTo(map);

  // Legend
  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-legend');
      box.innerHTML = `<span><i style="background:${FIT_COLOR.ok}"></i>подходит</span>
        <span><i style="background:${FIT_COLOR.check}"></i>уточнить</span>
        <span><i style="background:${FIT_COLOR.bad}"></i>нельзя</span>
        <span><i class="big"></i>есть email</span>`;
      return box;
    },
  });
  new Legend().addTo(map);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#map').classList.contains('map-full') && !document.querySelector('dialog[open]')) toggleMapFull(false);
  });

  // Popup buttons
  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    el.querySelectorAll('[data-pop]').forEach((b) => b.addEventListener('click', () => {
      const lead = state.results.find((l) => l.id === b.dataset.id);
      if (!lead) return;
      const act = b.dataset.pop;
      if (act === 'view') openPlace(lead);
      if (act === 'compose') openCompose(lead);
      if (act === 'save') { saveLead(lead); renderResults(); b.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: '✓ сохранено' })); toast('Сохранено в «Мои контакты»'); }
      if (act === 'list') { toggleMapFull(false); focusCard(lead.id); }
    }));
  });
}

function toggleMapFull(force) {
  const el = $('#map');
  const on = typeof force === 'boolean' ? force : !el.classList.contains('map-full');
  el.classList.toggle('map-full', on);
  document.body.classList.toggle('no-scroll', on);
  const btn = $('#mapFullBtn');
  if (btn) {
    btn.textContent = on ? '✕' : '⛶';
    btn.title = on ? 'Свернуть карту (Esc)' : 'Карта на весь экран';
  }
  setTimeout(() => map?.invalidateSize(), 60);
}

function popupHtml(l) {
  const cat = CATEGORY_BY_ID[l.category];
  const saved = state.saved.has(l.id);
  const id = esc(l.id);
  return `<div class="pop">
    <div class="pop-title">${cat?.icon || ''} ${esc(l.name)}</div>
    <div class="pop-meta"><span class="badge fit-${l.fit?.level}">${FIT_LABEL[l.fit?.level] || ''}</span> ${esc(cat?.label || '')}</div>
    ${l.address ? `<div class="pop-addr">📍 ${esc(l.address)}</div>` : ''}
    ${(l.emails || []).length ? `<div class="pop-addr">✉️ ${esc(l.emails[0])}</div>` : ''}
    <div class="pop-actions">
      <a class="btn sm" href="${esc(googleMapsUrl(l))}" target="_blank" rel="noopener">🗺️ Google Maps</a>
      <button class="btn sm" data-pop="view" data-id="${id}">👁️ Посмотреть</button>
      ${(l.emails || []).length ? `<button class="btn sm primary" data-pop="compose" data-id="${id}">✉️ Написать</button>` : ''}
      ${saved ? '' : `<button class="btn sm" data-pop="save" data-id="${id}">➕ Сохранить</button>`}
      <button class="btn sm ghost" data-pop="list" data-id="${id}">≡ В списке</button>
    </div>
  </div>`;
}

function showOnMap(id) {
  const m = markers.get(id);
  if (!m || !map) return;
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
  m.openPopup();
}

const FIT_COLOR = { ok: '#16a34a', check: '#d97706', bad: '#dc2626' };

function renderMarkers(leads) {
  if (!map) return;
  markerLayer.clearLayers();
  markers.clear();
  const pts = [];
  for (const l of leads) {
    const m = L.circleMarker([l.lat, l.lon], {
      radius: l.emails?.length ? 8 : 6,
      color: '#fff', weight: 1.5,
      fillColor: FIT_COLOR[l.fit?.level] || '#2563eb', fillOpacity: 0.9,
    });
    m.bindTooltip(`${CATEGORY_BY_ID[l.category]?.icon || ''} ${esc(l.name)}`);
    m.bindPopup(() => popupHtml(l), { maxWidth: 320, minWidth: 240 });
    m.addTo(markerLayer);
    markers.set(l.id, m);
    pts.push([l.lat, l.lon]);
  }
  if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
}

function focusCard(id) {
  const card = document.querySelector(`.lead[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
}

function showCenter(lat, lon, radiusM) {
  if (!map) return;
  centerLayer.clearLayers();
  if (radiusM) L.circle([lat, lon], { radius: radiusM, color: '#2563eb', weight: 1, fillOpacity: 0.04 }).addTo(centerLayer);
}

// ---------- state city lists (city picker) ----------
const stateCities = new Map();
const cityLoads = new Map();
let cityPickerRefresh = () => {};
const CITY_CACHE_DAYS = 30;

async function loadStateCities(code) {
  if (!code || stateCities.has(code)) return stateCities.get(code);
  if (cityLoads.has(code)) return cityLoads.get(code);
  const key = `wt.cities.${code}.v1`;
  const cached = load(key, null);
  if (cached?.list && Date.now() - cached.at < CITY_CACHE_DAYS * 864e5) {
    const list = cached.list.map(([name, lat, lon, pop]) => ({ name, state: code, lat, lon, pop }));
    stateCities.set(code, list);
    return list;
  }
  const p = (async () => {
    try {
      const json = await runOverpass(buildCityListQuery(code), { apiBase: state.server.ok ? state.server.base : null });
      const list = parseCityList(json, code);
      stateCities.set(code, list);
      save(key, { at: Date.now(), list: list.map((c) => [c.name, c.lat, c.lon, c.pop]) });
      return list;
    } catch {
      stateCities.set(code, []);
      return [];
    } finally {
      cityLoads.delete(code);
      cityPickerRefresh();
    }
  })();
  cityLoads.set(code, p);
  return p;
}

// ---------- search form ----------
function initSearchForm() {
  const stateSel = $('#stateSelect');
  stateSel.innerHTML = `<option value="">— выбери штат —</option>${STATES.map((s) => `<option value="${s.code}">${esc(s.name)} (${s.code})</option>`).join('')}`;

  $('#categoryList').innerHTML = CATEGORIES.map((c) => `
    <label class="check"><input type="checkbox" name="cat" value="${c.id}" ${c.defaultOn ? 'checked' : ''}> ${c.icon} ${esc(c.label)}</label>`).join('');

  const radius = $('#radiusInput');
  const updateRadius = () => {
    const km = Number(radius.value);
    $('#radiusLabel').textContent = `${km} км (~${Math.round(km * 0.621)} миль)`;
    if (state.city) showCenter(state.city.lat, state.city.lon, km * 1000);
  };
  radius.addEventListener('input', updateRadius);
  updateRadius();

  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', syncMode));

  stateSel.addEventListener('change', () => {
    const st = STATE_BY_CODE[stateSel.value];
    if (state.city && state.city.state !== stateSel.value) { state.city = null; $('#cityInput').value = ''; }
    renderHotspotChips();
    renderLaunchers();
    if (st && map && !state.city) map.setView([st.lat, st.lon], st.zoom);
    if (st) loadStateCities(st.code);
  });

  const cityInput = $('#cityInput');
  const sugg = $('#citySuggest');
  let suggAbort;
  let suggItems = [];
  let suggActive = -1;

  const localCityMatches = (q) => {
    const st = stateSel.value;
    const hs = HOTSPOTS.filter((h) => (!st || h.state === st) && (!q || h.name.toLowerCase().includes(q.toLowerCase())))
      .map((h) => ({ name: h.name, state: h.state, lat: h.lat, lon: h.lon, label: `🏖️ ${h.name}, ${h.state} · W&T курорт${h.housing === 'employer' ? ' · 🏠' : ''}` }));
    const list = st ? (stateCities.get(st) || []) : [];
    const cities = matchCities(list, q, 14)
      .filter((c) => !hs.some((h) => h.name.toLowerCase() === c.name.toLowerCase()))
      .map((c) => ({ ...c, label: `${c.name}, ${c.state}${c.pop ? ` · ${c.pop.toLocaleString('ru-RU')} жит.` : ''}` }));
    return [...hs, ...cities];
  };

  const showSuggest = debounce(async () => {
    const q = cityInput.value.trim();
    suggAbort?.abort();
    const st = stateSel.value;
    if (!st && q.length < 2) { renderSuggest([], { hint: 'Сначала выбери штат — покажу его города.' }); return; }
    const local = localCityMatches(q);
    const loadingList = st && !stateCities.has(st);
    renderSuggest(local, { loading: loadingList || q.length >= 2, title: q ? '' : 'Популярные места штата' });
    if (q.length < 2) return;
    suggAbort = new AbortController();
    try {
      const remote = await suggestCities(q, { stateCode: st, signal: suggAbort.signal });
      const merged = [...localCityMatches(cityInput.value.trim())];
      for (const r of remote) if (!merged.some((m) => m.name.toLowerCase() === r.name.toLowerCase() && m.state === r.state)) merged.push(r);
      renderSuggest(merged.slice(0, 16), {});
    } catch (e) {
      if (e.name !== 'AbortError') renderSuggest(localCityMatches(cityInput.value.trim()), {});
    }
  }, 200);
  showSuggest.refresh = () => { if (document.activeElement === cityInput) showSuggest(); };

  function renderSuggest(items, { loading = false, title = '', hint = '' } = {}) {
    suggItems = items;
    suggActive = -1;
    if (hint) { sugg.innerHTML = `<li class="muted">${esc(hint)}</li>`; sugg.hidden = false; return; }
    if (!items.length && !loading) {
      sugg.innerHTML = '<li class="muted">Не нашёл в списке. Проверь написание (латиницей) или нажми «Найти»: поищу по карте.</li>';
      sugg.hidden = false;
      return;
    }
    sugg.innerHTML = (title ? `<li class="muted small">${esc(title)}</li>` : '')
      + items.map((c, i) => `<li data-i="${i}" tabindex="-1">${esc(c.label)}</li>`).join('')
      + (loading ? '<li class="muted">Загружаю города…</li>' : '');
    sugg.hidden = false;
    $$('li[data-i]', sugg).forEach((li) => li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickCity(suggItems[Number(li.dataset.i)]);
      sugg.hidden = true;
    }));
  }

  cityInput.addEventListener('input', () => { state.city = null; showSuggest(); });
  cityInput.addEventListener('focus', () => showSuggest());
  cityInput.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 150));
  cityInput.addEventListener('keydown', (e) => {
    const lis = $$('li[data-i]', sugg);
    if (e.key === 'Escape') { sugg.hidden = true; return; }
    if (sugg.hidden || !lis.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggActive = (suggActive + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((li, i) => li.classList.toggle('active', i === suggActive));
      lis[suggActive].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && suggActive >= 0) {
      e.preventDefault();
      pickCity(suggItems[suggActive]);
      sugg.hidden = true;
    }
  });
  cityPickerRefresh = showSuggest.refresh;

  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#filterInput').addEventListener('input', debounce(renderResults, 150));
  $('#fitFilter').addEventListener('change', renderResults);
  $('#housingFilter').addEventListener('change', renderResults);
  $('#sortSelect').addEventListener('change', renderResults);
  $('#selectAll').addEventListener('change', (e) => {
    visibleResults().forEach((l) => (e.target.checked ? state.selected.add(l.id) : state.selected.delete(l.id)));
    renderResults();
  });
  $('#bulkSave').addEventListener('click', bulkSave);
  $('#bulkEnrich').addEventListener('click', () => enrichMany(state.results.filter((l) => state.selected.has(l.id))));

  // restore last search params
  const last = load(KEYS.lastSearch, null);
  if (last) {
    stateSel.value = last.state || '';
    if (last.city) { state.city = last.city; cityInput.value = last.city.name; }
    if (last.radiusKm) { radius.value = last.radiusKm; updateRadius(); }
    if (last.categories) $$('input[name="cat"]').forEach((c) => { c.checked = last.categories.includes(c.value); });
    if (last.contacts) $('#contactsSelect').value = last.contacts;
    if (last.mode) $(`input[name="mode"][value="${last.mode}"]`).checked = true;
  }
  syncMode();
  renderHotspotChips();
  renderLaunchers();
  if (stateSel.value) loadStateCities(stateSel.value);
}

function syncMode() {
  const mode = $('input[name="mode"]:checked').value;
  $('#cityField').hidden = mode === 'state';
  $('#radiusField').hidden = mode === 'state';
  if (mode === 'state' && $('#contactsSelect').value === 'any') $('#contactsSelect').value = 'email';
}

function pickCity(c) {
  state.city = { name: c.name, state: c.state, lat: c.lat, lon: c.lon };
  $('#cityInput').value = c.name;
  if (c.state) $('#stateSelect').value = c.state;
  renderHotspotChips();
  renderLaunchers();
  if (map) map.setView([c.lat, c.lon], 12);
  showCenter(c.lat, c.lon, Number($('#radiusInput').value) * 1000);
}

function renderHotspotChips() {
  const st = $('#stateSelect').value;
  const list = HOTSPOTS.filter((h) => h.state === st);
  $('#hotspotChips').innerHTML = list.length
    ? `<span class="muted small">W&T курорты:</span>${list.map((h) => `<button type="button" class="chip ${state.city?.name === h.name ? 'on' : ''}" data-id="${h.id}" ${h.housing === 'employer' ? 'title="Часто жильё от работодателя"' : ''}>${esc(h.name)}${h.housing === 'employer' ? ' 🏠' : ''}</button>`).join('')}`
    : '';
  $$('.chip', $('#hotspotChips')).forEach((b) => b.addEventListener('click', () => {
    const h = HOTSPOTS.find((x) => x.id === b.dataset.id);
    pickCity(h);
  }));
}

function renderLaunchers() {
  const st = $('#stateSelect').value;
  const city = state.city?.name || $('#cityInput').value.trim();
  if (!st) { $('#launchers').hidden = true; return; }
  $('#launchers').hidden = false;
  const where = city || STATE_BY_CODE[st].name;
  const cats = selectedCategoryIds().map((id) => CATEGORY_BY_ID[id]);
  $('#gmapsLaunchers').innerHTML = cats.map((c) => `<a class="link-chip" target="_blank" rel="noopener" href="${googleMapsSearchUrl(c.gmaps, where, st)}">${c.icon} ${esc(c.gmaps)}</a>`).join('');
  $('#jobBoards').innerHTML = jobBoardLinks(city, st).map((j) => `<a class="link-chip" target="_blank" rel="noopener" href="${esc(j.url)}">${esc(j.label)}</a>`).join('');
}

function selectedCategoryIds() {
  return $$('input[name="cat"]:checked').map((c) => c.value);
}

function setStatus(html, kind = '') {
  const el = $('#status');
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

async function doSearch() {
  const mode = $('input[name="mode"]:checked').value;
  const st = $('#stateSelect').value;
  const categoryIds = selectedCategoryIds();
  const contacts = $('#contactsSelect').value;
  const radiusKm = Number($('#radiusInput').value);
  const source = state.server.places ? $('#sourceSelect').value : 'osm';

  if (!st) { setStatus('Выбери штат.', 'warn'); return; }
  if (!categoryIds.length) { setStatus('Выбери хотя бы один тип работы.', 'warn'); return; }

  state.searchAbort?.abort();
  const ctrl = new AbortController();
  state.searchAbort = ctrl;
  $('#searchBtn').disabled = true;
  setStatus('<span class="spinner"></span> Ищу…');

  try {
    if (mode === 'around' && !state.city) {
      const name = $('#cityInput').value.trim();
      if (!name) throw new Error('Выбери город: нажми на поле «Город» — появится список городов штата, или нажми на W&T курорт.');
      setStatus('<span class="spinner"></span> Ищу город на карте…');
      const exact = [...HOTSPOTS.filter((h) => h.state === st), ...(stateCities.get(st) || [])]
        .find((c) => c.name.toLowerCase() === name.toLowerCase());
      const hit = exact ? { name: exact.name, state: st, lat: exact.lat, lon: exact.lon } : await geocodeCity(name, st, { signal: ctrl.signal });
      if (!hit) throw new Error(`Город «${name}» не найден в штате ${st}.`);
      pickCity(hit);
    }
    const city = mode === 'around' ? state.city : null;
    save(KEYS.lastSearch, { mode, state: st, city, radiusKm, categories: categoryIds, contacts });
    renderLaunchers();

    const ctx = { center: city ? { lat: city.lat, lon: city.lon } : null, city: city?.name || '', state: city?.state || st };
    state.lastCtx = ctx;
    let leads = [];

    if (source === 'osm' || source === 'both') {
      setStatus('<span class="spinner"></span> Запрашиваю OpenStreetMap… (до 1 минуты, для штата дольше)');
      const q = buildOverpassQuery({
        mode, lat: city?.lat, lon: city?.lon, radiusM: radiusKm * 1000, stateCode: st, categoryIds, contacts,
        limit: mode === 'state' ? 600 : 400,
      });
      const json = await runOverpass(q, { apiBase: state.server.ok ? state.server.base : null, signal: ctrl.signal });
      leads = parseOverpass(json, ctx);
    }

    if (source === 'google' || source === 'both') {
      const where = city ? `${city.name}, ${city.state || st}` : STATE_BY_CODE[st].name;
      const gLeads = [];
      for (const id of categoryIds) {
        const cat = CATEGORY_BY_ID[id];
        setStatus(`<span class="spinner"></span> Google Maps: ${esc(cat.gmaps)}…`);
        const places = await searchGooglePlaces({
          apiBase: state.server.base, query: `${cat.gmaps} in ${where}`,
          lat: city?.lat, lon: city?.lon, radiusM: radiusKm * 1000, signal: ctrl.signal,
        });
        for (const p of places) {
          p.category = id;
          p.fit = assessFit(p.name, id);
          p.distanceKm = ctx.center ? haversineKm(ctx.center, p) : null;
          gLeads.push(p);
        }
      }
      leads = mergeLeads(leads, gLeads);
    }

    if (contacts === 'email') leads = leads.filter((l) => l.emails.length);
    else if (contacts === 'website') leads = leads.filter((l) => l.emails.length || l.website);

    // Saved leads keep their found emails/status.
    leads = leads.map((l) => {
      const s = state.saved.get(l.id);
      return s ? { ...l, emails: [...new Set([...l.emails, ...(s.emails || [])])] } : l;
    });

    state.results = leads;
    state.selected.clear();
    $('#selectAll').checked = false;
    $('#filterInput').value = '';
    if (city) showCenter(city.lat, city.lon, radiusKm * 1000); else centerLayer?.clearLayers();
    renderResults(true);
    if (!leads.length) {
      setStatus('Ничего не найдено. Увеличь радиус, добавь категории или выбери «Все заведения». Также попробуй кнопки Google Maps слева.', 'warn');
    } else {
      setStatus('');
      if (window.matchMedia('(max-width: 980px)').matches) $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus(esc(e.message || String(e)), 'error');
  } finally {
    if (state.searchAbort === ctrl) $('#searchBtn').disabled = false;
  }
}

function mergeLeads(a, b) {
  const out = [...a];
  for (const g of b) {
    const dup = out.find((o) => o.name.toLowerCase() === g.name.toLowerCase() && haversineKm(o, g) < 0.25);
    if (dup) {
      dup.placeId = g.placeId; dup.gmapsUrl = g.gmapsUrl; dup.rating = g.rating; dup.ratingCount = g.ratingCount;
      dup.website ||= g.website; dup.phone ||= g.phone; dup.address ||= g.address;
    } else if (!out.some((o) => o.id === g.id)) {
      out.push(g);
    }
  }
  return out;
}

function visibleResults() {
  const q = $('#filterInput').value.trim().toLowerCase();
  const fit = $('#fitFilter').value;
  const housing = $('#housingFilter').value;
  return sortLeads(state.results, $('#sortSelect').value).filter((l) => (!q || l.name.toLowerCase().includes(q) || (l.address || '').toLowerCase().includes(q))
    && (fit === 'all' || l.fit?.level === fit)
    && (housing === 'all' || HOUSING_LIKELY_CATEGORIES.includes(l.category)));
}

function renderResults(updateMap = false) {
  const list = visibleResults();
  const all = state.results;
  $('#resultsBar').hidden = !all.length;
  const withEmail = all.filter((l) => l.emails.length).length;
  const withSite = all.filter((l) => l.website).length;
  const hs = state.lastCtx?.center ? hotspotFor(state.lastCtx.city, state.lastCtx.state) : null;
  $('#resultsSummary').innerHTML = `Найдено <b>${all.length}</b> · с email <b>${withEmail}</b> · с сайтом <b>${withSite}</b>${list.length !== all.length ? ` · показано ${list.length}` : ''}${hs?.housing === 'employer' ? ' · <span class="badge st-green">🏠 здесь работодатели часто дают жильё</span>' : ''}`;
  $('#results').innerHTML = list.map(leadCard).join('');
  bindCards($('#results'), (id) => state.results.find((l) => l.id === id));
  if (updateMap === true) renderMarkers(all);
}

function leadCard(l) {
  const cat = CATEGORY_BY_ID[l.category];
  const saved = state.saved.get(l.id);
  const status = saved ? STATUS_BY_ID[saved.status] : null;
  const emails = l.emails || [];
  return `
  <article class="lead fit-${l.fit?.level || 'ok'}" data-id="${esc(l.id)}">
    <label class="lead-select"><input type="checkbox" data-act="select" ${state.selected.has(l.id) ? 'checked' : ''} aria-label="Выбрать"></label>
    <div class="lead-main">
      <div class="lead-top">
        <h4>${cat?.icon || ''} ${esc(l.name)}</h4>
        <span class="badge fit-${l.fit?.level}" title="${esc((l.fit?.notes || []).join(' '))}">${FIT_LABEL[l.fit?.level] || ''}</span>
        ${status ? `<span class="badge st-${status.color}">${esc(status.label)}</span>` : ''}
      </div>
      <div class="lead-meta">
        <span>${esc(cat?.label || '')}</span>
        ${l.distanceKm != null ? `<span>${l.distanceKm.toFixed(1)} км от центра</span>` : ''}
        ${l.rating ? `<span>★ ${l.rating} (${l.ratingCount || 0})</span>` : ''}
        ${l.source === 'google' ? '<span>Google</span>' : ''}
        ${HOUSING_LIKELY_CATEGORIES.includes(l.category) ? '<span title="Отели, курорты, кемпинги и парки чаще других дают сотрудникам жильё. Спроси в письме.">🏠 часто дают жильё</span>' : ''}
      </div>
      ${l.address ? `<div class="lead-addr">📍 ${esc(l.address)}</div>` : ''}
      ${l.fit?.notes?.length ? `<div class="lead-note">${esc(l.fit.notes.join(' '))}</div>` : ''}
      <div class="lead-contacts">
        ${emails.map((e) => `<a class="contact email" href="${esc(mailtoUrl({ to: e }))}">✉️ ${esc(e)}</a>`).join('')}
        ${l.phone ? `<a class="contact" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(l.phone)}</a>` : ''}
        ${l.website ? `<a class="contact" href="${esc(l.website)}" target="_blank" rel="noopener">🌐 ${esc(hostOf(l.website))}</a>` : ''}
        ${l.facebook ? `<a class="contact" href="${esc(l.facebook)}" target="_blank" rel="noopener">Facebook</a>` : ''}
      </div>
      <div class="lead-actions">
        <a class="btn sm" href="${esc(googleMapsUrl(l))}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        <button class="btn sm" data-act="view">👁️ Посмотреть</button>
        <button class="btn sm" data-act="locate">📍 На карте</button>
        ${emails.length
          ? '<button class="btn sm primary" data-act="compose">✉️ Написать в Gmail</button>'
          : (state.server.emails && l.website
            ? '<button class="btn sm" data-act="enrich">📧 Найти email</button>'
            : `<a class="btn sm" href="${esc(emailSearchUrl(l))}" target="_blank" rel="noopener">📧 Найти email в Google</a>`)}
        ${saved ? '<button class="btn sm ghost" data-act="tracker">📋 В трекере</button>' : '<button class="btn sm" data-act="save">➕ Сохранить</button>'}
      </div>
    </div>
  </article>`;
}

function bindCards(root, getLead) {
  root.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-id]');
    const lead = getLead(card.dataset.id);
    if (!lead) return;
    const act = btn.dataset.act;
    if (act === 'select') {
      btn.checked ? state.selected.add(lead.id) : state.selected.delete(lead.id);
      return;
    }
    if (act === 'view') openPlace(lead);
    if (act === 'locate') showOnMap(lead.id);
    if (act === 'compose') openCompose(lead);
    if (act === 'save') { saveLead(lead); renderResults(); toast('Сохранено в «Мои контакты»'); }
    if (act === 'tracker') showTab('tracker');
    if (act === 'enrich') {
      btn.disabled = true; btn.textContent = 'Ищу…';
      await enrichLead(lead);
      renderResults();
      renderTrackerIfVisible();
    }
  };
}

function saveLead(lead, patch = {}) {
  const existing = state.saved.get(lead.id);
  const merged = toSavedLead({ ...(existing || {}), ...lead, ...patch, emails: [...new Set([...(existing?.emails || []), ...(lead.emails || [])])] });
  if (existing) Object.assign(merged, { status: existing.status, notes: existing.notes, history: existing.history, addedAt: existing.addedAt, lastContactAt: existing.lastContactAt }, patch);
  state.saved.set(lead.id, merged);
  persistLeads();
  return merged;
}

function bulkSave() {
  const picked = state.results.filter((l) => state.selected.has(l.id));
  if (!picked.length) { toast('Отметь заведения галочками'); return; }
  picked.forEach((l) => saveLead(l));
  state.selected.clear();
  $('#selectAll').checked = false;
  renderResults();
  toast(`Добавлено в контакты: ${picked.length}`);
}

// ---------- email enrichment (server) ----------
async function enrichLead(lead) {
  if (!state.server.emails || !lead.website) return [];
  try {
    const res = await fetch(`${state.server.base}api/emails?url=${encodeURIComponent(lead.website)}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    const found = j.emails || [];
    lead.emails = [...new Set([...(lead.emails || []), ...found])];
    lead.enrichedAt = new Date().toISOString();
    const saved = state.saved.get(lead.id);
    if (saved) { saved.emails = [...new Set([...(saved.emails || []), ...found])]; persistLeads(); }
    if (!found.length) toast(`На сайте ${hostOf(lead.website)} email не найден`);
    return found;
  } catch (e) {
    toast(`Не удалось проверить сайт: ${e.message}`);
    return [];
  }
}

async function enrichMany(leads) {
  const todo = leads.filter((l) => l.website && !(l.emails || []).length);
  if (!todo.length) { toast('Нет выбранных заведений с сайтом и без email'); return; }
  let done = 0; let found = 0;
  setStatus(`<span class="spinner"></span> Проверяю сайты: 0/${todo.length}`);
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      const r = await enrichLead(l).catch(() => []);
      if (r.length) found += 1;
      done += 1;
      setStatus(`<span class="spinner"></span> Проверяю сайты: ${done}/${todo.length} · найдено email: ${found}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  setStatus(`Готово: email найден у ${found} из ${todo.length}.`, found ? 'ok' : 'warn');
  renderResults();
  renderTrackerIfVisible();
}

// ---------- place modal ----------
function openPlace(lead) {
  $('#pmTitle').textContent = lead.name;
  $('#pmMap').src = googleMapsEmbedUrl(lead);
  const cat = CATEGORY_BY_ID[lead.category];
  $('#pmInfo').innerHTML = `
    <p><b>${esc(cat?.label || '')}</b> · <span class="badge fit-${lead.fit?.level}">${FIT_LABEL[lead.fit?.level] || ''}</span></p>
    ${lead.address ? `<p>📍 ${esc(lead.address)}</p>` : ''}
    ${lead.hours ? `<p>🕒 ${esc(lead.hours)}</p>` : ''}
    ${lead.fit?.notes?.length ? `<p class="lead-note">${esc(lead.fit.notes.join(' '))}</p>` : ''}
    <p class="muted small">Типичные позиции: ${esc(cat?.positions || '')}</p>
    <div class="row wrap">
      <a class="btn primary" href="${esc(googleMapsUrl(lead))}" target="_blank" rel="noopener">Открыть в Google Maps (отзывы, фото)</a>
      ${lead.website ? `<a class="btn" href="${esc(lead.website)}" target="_blank" rel="noopener">Сайт</a>` : ''}
      <a class="btn" href="${esc(emailSearchUrl(lead))}" target="_blank" rel="noopener">Найти контакты в Google</a>
    </div>
    <h4 class="pm-sub">🏠 Жильё рядом с работой</h4>
    <div class="link-grid">${housingLinks(lead).map((h) => `<a class="link-chip" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.label)}</a>`).join('')}</div>`;
  $('#placeModal').showModal();
}

// ---------- compose modal ----------
const compose = { lead: null, queue: null, queueIndex: 0, queueKind: 'cold' };

function initComposeTemplates() {
  $('#cmTemplate').innerHTML = Object.entries(tpls()).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join('');
}

function initCompose() {
  const sel = $('#cmTemplate');
  initComposeTemplates();
  sel.addEventListener('change', fillCompose);
  $('#cmPosition').addEventListener('input', debounce(fillCompose, 200));
  ['cmTo', 'cmCc', 'cmSubject', 'cmBody'].forEach((id) => $(`#${id}`).addEventListener('input', updateComposeLinks));
  $('#cmCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${$('#cmSubject').value}\n\n${$('#cmBody').value}`); toast('Скопировано'); } catch { toast('Не удалось скопировать'); }
  });
  $('#cmMarkSent').addEventListener('click', markSent);
  $('#cmSendApi').addEventListener('click', sendFromCompose);
  $('#cmSkip').addEventListener('click', () => {
    if (compose.lead && state.saved.has(compose.lead.id)) {
      const s = state.saved.get(compose.lead.id);
      if (s.status === 'new') { s.status = 'skip'; persistLeads(); }
    }
    nextInQueue();
  });
  $('#composeModal').addEventListener('close', () => { compose.queue = null; renderTrackerIfVisible(); });
}

function openCompose(lead, { templateId, queue, queueKind } = {}) {
  compose.lead = lead;
  if (queue) { compose.queue = queue; compose.queueIndex = 0; compose.queueKind = queueKind; }
  const saved = state.saved.get(lead.id);
  const tid = templateId || (saved && ['emailed', 'followup'].includes(saved.status) ? 'followup' : 'cold');
  $('#cmTemplate').value = tid;
  $('#cmTitle').textContent = `Письмо: ${lead.name}`;
  $('#cmTo').value = (lead.emails || []).join(', ');
  $('#cmCc').value = partnerCc(state.profile);
  $('#cmCcField').hidden = mode() !== 'pair';
  fillCompose();
  renderQueueInfo();
  if (!$('#composeModal').open) $('#composeModal').showModal();
}

function fillCompose() {
  const tid = $('#cmTemplate').value;
  $('#cmPositionField').hidden = tid !== 'vacancy';
  const extra = tid === 'vacancy' && $('#cmPosition').value.trim() ? { positionTitle: $('#cmPosition').value.trim() } : {};
  const { subject, body } = composeEmail(tpls(), tid, state.profile, compose.lead, { ...extra, attachments: apiAttachCount() });
  $('#cmAttachNote').hidden = !apiAttachCount();
  $('#cmAttachNote').textContent = `📎 «Отправить сразу» прикрепит резюме (${state.attachments.map((a) => a.filename).join(', ')}). В «Открыть в Gmail» вложения не переносятся: прикрепи PDF вручную.`;
  $('#cmSubject').value = subject;
  $('#cmBody').value = body;
  updateComposeLinks();
}

function updateComposeLinks() {
  const msg = { to: $('#cmTo').value.trim(), cc: $('#cmCc').value.trim(), subject: $('#cmSubject').value, body: $('#cmBody').value };
  $('#cmGmail').href = gmailComposeUrl({ ...msg, authuser: state.profile.gmailAccount });
  $('#cmMailto').href = mailtoUrl(msg);
}

function renderQueueInfo() {
  const q = compose.queue;
  $('#cmQueue').hidden = !q;
  $('#cmSkip').hidden = !q;
  if (q) $('#cmQueue').innerHTML = `Рассылка по очереди: <b>${compose.queueIndex + 1}</b> из <b>${q.length}</b>. Открой Gmail → Отправить → вернись и нажми «✓ Отметить как отправлено». Откроется следующее.`;
}

function markSent() {
  const lead = compose.lead;
  if (!lead) return;
  const tid = $('#cmTemplate').value;
  const now = new Date().toISOString();
  const s = saveLead(lead);
  s.status = tid === 'followup' ? 'followup' : 'emailed';
  s.lastContactAt = now;
  s.history = [...(s.history || []), { at: now, action: tid, to: $('#cmTo').value.trim() }];
  persistLeads();
  toast('Отмечено как отправлено ✓');
  renderResults();
  if (compose.queue) nextInQueue(); else $('#composeModal').close();
}

function nextInQueue() {
  if (!compose.queue) { $('#composeModal').close(); return; }
  compose.queueIndex += 1;
  if (compose.queueIndex >= compose.queue.length) {
    toast('Очередь закончилась 🎉');
    $('#composeModal').close();
    return;
  }
  const lead = state.saved.get(compose.queue[compose.queueIndex]);
  if (!lead) { nextInQueue(); return; }
  openCompose(lead, { templateId: compose.queueKind });
}

// ---------- tracker ----------
function initTracker() {
  $('#trackerStatus').innerHTML += STATUSES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  $('#trackerFilter').addEventListener('input', debounce(renderTracker, 150));
  $('#trackerStatus').addEventListener('change', renderTracker);
  $('#trackerState').addEventListener('change', renderTracker);
  $('#trackerHousing').addEventListener('change', renderTracker);
  $('#queueBtn').addEventListener('click', () => startQueue('cold'));
  $('#followupBtn').addEventListener('click', () => startQueue('followup'));
  $('#enrichAllBtn').addEventListener('click', async () => {
    await enrichMany(filteredTracker());
    renderTracker();
  });
  $('#exportCsv').addEventListener('click', () => {
    const rows = filteredTracker().map((l) => ({ ...l, gmaps: googleMapsUrl(l), housingLabel: HOUSING_STATUS[l.housing]?.label.replace(/^\S+\s/, '') || '' }));
    download(`wt-contacts-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${leadsToCsv(rows, (s) => STATUS_BY_ID[s]?.label || s)}`, 'text/csv');
  });
  $('#exportJson').addEventListener('click', () => {
    download(`wt-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), leads: [...state.saved.values()], profile: state.profile, templates: state.tpl, attachments: state.attachments,
    }, null, 2), 'application/json');
  });
  $('#importJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importBackupFile(file);
    e.target.value = '';
  });
}

/** Imports a backup / profile JSON: leads (merged), profile, templates, resume attachments. */
async function importBackupFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const leads = Array.isArray(data) ? data : data.leads || [];
    let n = 0;
    for (const l of leads) {
      if (!l?.id || !l?.name) continue;
      state.saved.set(l.id, mergeSavedLeads(state.saved.get(l.id), l));
      n += 1;
    }
    const parts = [];
    if (data.profile) {
      const prevMode = mode();
      state.profile = { ...DEFAULT_PROFILE, ...data.profile };
      save(KEYS.profile, state.profile);
      fillProfileForm();
      if (prevMode !== mode()) initComposeTemplates();
      parts.push('профиль');
    }
    if (data.templates) {
      const t = data.templates.solo || data.templates.pair ? data.templates : { solo: data.templates };
      if (t.solo) { state.tpl.solo = { ...structuredClone(DEFAULT_TEMPLATES), ...t.solo }; save(KEYS.templates, state.tpl.solo); }
      if (t.pair) { state.tpl.pair = { ...structuredClone(DEFAULT_TEMPLATES_PAIR), ...t.pair }; save(KEYS.templatesPair, state.tpl.pair); }
      parts.push('шаблоны');
    }
    if (Array.isArray(data.attachments)) {
      state.attachments = data.attachments.filter((a) => a?.filename && a?.data);
      save(KEYS.attachments, state.attachments);
      renderAttachments();
      parts.push(`резюме: ${state.attachments.length}`);
    }
    if (n) parts.push(`контактов: ${n}`);
    persistLeads();
    renderTrackerIfVisible();
    renderTemplatePreview();
    toast(`Импортировано: ${parts.join(', ') || 'ничего'}`, 4000);
  } catch (err) {
    toast(`Ошибка импорта: ${err.message}`);
  }
}

// ---------- resume attachments ----------
const MAX_ATTACH_BYTES = 1.5 * 1024 * 1024;
const apiAttachCount = () => (oauthClientId() ? state.attachments.length : 0);

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function renderAttachments() {
  const box = $('#attachList');
  if (!box) return;
  box.innerHTML = state.attachments.length
    ? state.attachments.map((a, i) => `<span class="contact">📎 ${esc(a.filename)} <span class="muted small">${Math.max(1, Math.round((a.size || a.data.length * 0.75) / 1024))} КБ</span> <button type="button" class="icon-btn sm" data-rm="${i}" title="Убрать">✕</button></span>`).join('')
    : '<span class="muted small">Резюме не добавлены.</span>';
}

function initAttachments() {
  renderAttachments();
  $('#attachList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    state.attachments.splice(Number(b.dataset.rm), 1);
    save(KEYS.attachments, state.attachments);
    renderAttachments();
    renderTemplatePreview();
  });
  $('#attachInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      if (f.size > MAX_ATTACH_BYTES) { toast(`${f.name}: больше 1,5 МБ. Сожми PDF или дай ссылку на Google Drive`, 6000); continue; }
      state.attachments.push({ filename: f.name, mimeType: f.type || 'application/pdf', data: await fileToBase64(f), size: f.size });
    }
    save(KEYS.attachments, state.attachments);
    renderAttachments();
    renderTemplatePreview();
    e.target.value = '';
  });
  $('#profileImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importBackupFile(file);
    e.target.value = '';
  });
}

const emailCount = (l) => (l.history || []).filter((h) => !String(h.action).startsWith('status:')).length;

function isFollowupDue(l) {
  if (!['emailed', 'followup'].includes(l.status) || !l.lastContactAt) return false;
  return (Date.now() - new Date(l.lastContactAt).getTime()) / 864e5 >= FOLLOWUP_DAYS;
}

function filteredTracker() {
  const q = $('#trackerFilter').value.trim().toLowerCase();
  const st = $('#trackerStatus').value;
  const stateCode = $('#trackerState').value;
  const housing = $('#trackerHousing').value;
  const housingOk = (l) => !housing
    || (housing === 'unknown' ? !l.housing : housing === 'mentioned' ? l.housingMentioned : l.housing === housing);
  return [...state.saved.values()]
    .filter((l) => (!q || `${l.name} ${l.city} ${l.notes} ${(l.emails || []).join(' ')}`.toLowerCase().includes(q))
      && (!st || l.status === st) && (!stateCode || l.state === stateCode) && housingOk(l))
    .sort((a, b) => (isFollowupDue(b) - isFollowupDue(a)) || (b.addedAt || '').localeCompare(a.addedAt || ''));
}

function startQueue(kind) {
  const list = filteredTracker().filter((l) => l.emails?.length && l.fit?.level !== 'bad'
    && (kind === 'followup' ? isFollowupDue(l) : l.status === 'new'));
  if (!list.length) {
    toast(kind === 'followup' ? `Пока некому напоминать (через ${FOLLOWUP_DAYS} дней после письма)` : 'Нет новых контактов с email. Сохрани заведения из поиска.');
    return;
  }
  openCompose(list[0], { templateId: kind, queue: list.map((l) => l.id), queueKind: kind });
}

function renderTrackerIfVisible() {
  if ($('#tab-tracker').classList.contains('active')) renderTracker();
}

function renderTracker() {
  const all = [...state.saved.values()];
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
  all.forEach((l) => { counts[l.status] = (counts[l.status] || 0) + 1; });
  const due = all.filter(isFollowupDue).length;
  $('#trackerStats').innerHTML = `
    <span class="stat"><b>${all.length}</b> всего</span>
    <span class="stat"><b>${all.filter((l) => l.emails?.length).length}</b> с email</span>
    <span class="stat"><b>${all.filter((l) => emailCount(l) > 0).length}</b> написали</span>
    <span class="stat"><b>${counts.replied + counts.interview}</b> ответили</span>
    ${counts.bounced ? `<span class="stat warn"><b>${counts.bounced}</b> не дошло</span>` : ''}
    <span class="stat good"><b>${counts.offer}</b> офферов</span>
    ${due ? `<span class="stat warn"><b>${due}</b> пора напомнить</span>` : ''}`;

  const statesUsed = [...new Set(all.map((l) => l.state).filter(Boolean))].sort();
  const stSel = $('#trackerState');
  const cur = stSel.value;
  stSel.innerHTML = `<option value="">Все штаты</option>${statesUsed.map((s) => `<option value="${s}">${s}</option>`).join('')}`;
  stSel.value = statesUsed.includes(cur) ? cur : '';

  const list = filteredTracker();
  if (!all.length) {
    $('#trackerList').innerHTML = '<div class="empty">Пока пусто. Найди заведения во вкладке «Поиск» и нажми «➕ Сохранить».</div>';
    return;
  }
  $('#trackerList').innerHTML = list.map((l) => {
    const cat = CATEGORY_BY_ID[l.category];
    const dueNow = isFollowupDue(l);
    return `
    <div class="trow fit-${l.fit?.level || 'ok'} ${dueNow ? 'due' : ''} ${l.reply && !l.replySeen ? 'has-new-reply' : ''}" data-id="${esc(l.id)}">
      <div class="trow-main">
        <div class="lead-top">
          <h4>${cat?.icon || ''} ${esc(l.name)}</h4>
          <span class="badge fit-${l.fit?.level}">${FIT_LABEL[l.fit?.level] || ''}</span>
          ${dueNow ? '<span class="badge st-amber">Пора напомнить</span>' : ''}
          ${l.housing ? `<span class="badge st-${HOUSING_STATUS[l.housing].color}">${esc(HOUSING_STATUS[l.housing].label)}${l.housingCost ? ` · ${esc(l.housingCost)}` : ''}</span>` : ''}
          ${l.housingMentioned && !l.housing ? '<span class="badge st-amber">🏠 Упомянули жильё в ответе</span>' : ''}
          ${l.status && l.status !== 'new' ? `<span class="badge st-${STATUS_BY_ID[l.status]?.color || 'gray'}">${esc(STATUS_BY_ID[l.status]?.label || l.status)}</span>` : ''}
        </div>
        <div class="lead-meta">
          <span>${esc([l.city, l.state].filter(Boolean).join(', '))}</span>
          ${l.lastContactAt ? `<span>Последнее письмо: ${new Date(l.lastContactAt).toLocaleDateString('ru-RU')}</span>` : ''}
          ${emailCount(l) ? `<span>Писем: ${emailCount(l)}</span>` : ''}
          ${l.gmail?.threadId ? `<a href="${esc(gmailThreadUrl(l.gmail.threadId, l.gmail.account))}" target="_blank" rel="noopener">Переписка в Gmail ↗</a>` : ''}
        </div>
        ${l.reply ? `<div class="reply-box ${l.replySeen ? '' : 'new'}">💬 <b>${l.replySeen ? 'Ответ' : 'Новый ответ!'}</b> от ${esc(l.reply.from)}${l.reply.date ? ` · ${new Date(l.reply.date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}<br>«${esc(l.reply.snippet)}»</div>` : ''}
        ${l.status === 'bounced' ? '<div class="lead-note">Письмо не дошло: адрес неверный или ящик закрыт. Найди другой email (сайт, Facebook) или позвони.</div>' : ''}
        <div class="lead-contacts">
          ${(l.emails || []).map((e) => `<span class="contact email">✉️ ${esc(e)}</span>`).join('') || '<span class="muted small">email нет</span>'}
          ${l.phone ? `<a class="contact" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(l.phone)}</a>` : ''}
          ${l.website ? `<a class="contact" href="${esc(l.website)}" target="_blank" rel="noopener">🌐 ${esc(hostOf(l.website))}</a>` : ''}
        </div>
        <div class="trow-edit">
          <select data-act="status">${STATUSES.map((s) => `<option value="${s.id}" ${s.id === l.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          <input data-act="emails" placeholder="Добавить email вручную" value="">
          <input data-act="notes" placeholder="Заметки: ставка, имя менеджера…" value="${esc(l.notes || '')}">
          <select data-act="housing" title="Жильё">
            <option value="" ${!l.housing ? 'selected' : ''}>🏠 Жильё: ещё не знаем</option>
            ${Object.entries(HOUSING_STATUS).map(([k, v]) => `<option value="${k}" ${l.housing === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
          </select>
          <input data-act="housingCost" placeholder="Цена жилья, напр. $150/нед" value="${esc(l.housingCost || '')}">
        </div>
      </div>
      <div class="trow-actions">
        ${(l.emails || []).length ? '<button class="btn sm primary" data-act="compose">✉️ Написать</button>' : (state.server.emails && l.website ? '<button class="btn sm" data-act="enrich">📧 Найти email</button>' : `<a class="btn sm" href="${esc(emailSearchUrl(l))}" target="_blank" rel="noopener">📧 Найти email</a>`)}
        <a class="btn sm" href="${esc(googleMapsUrl(l))}" target="_blank" rel="noopener">🗺️ Maps</a>
        <button class="btn sm" data-act="view">👁️</button>
        <button class="btn sm ghost" data-act="remove" title="Удалить">🗑️</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Под фильтр ничего не попало.</div>';

  const root = $('#trackerList');
  root.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const lead = state.saved.get(btn.closest('[data-id]').dataset.id);
    if (!lead) return;
    const act = btn.dataset.act;
    if (act === 'compose') openCompose(lead);
    if (act === 'view') openPlace(lead);
    if (act === 'enrich') { btn.disabled = true; btn.textContent = 'Ищу…'; await enrichLead(lead); renderTracker(); }
    if (act === 'remove' && confirm(`Удалить «${lead.name}» из контактов?`)) { state.saved.delete(lead.id); persistLeads(); renderTracker(); renderResults(); }
  };
  root.onchange = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const lead = state.saved.get(el.closest('[data-id]').dataset.id);
    if (!lead) return;
    if (el.dataset.act === 'status') {
      lead.status = el.value;
      lead.history = [...(lead.history || []), { at: new Date().toISOString(), action: `status:${el.value}` }];
      persistLeads(); renderTracker(); renderResults();
    }
    if (el.dataset.act === 'notes') { lead.notes = el.value; persistLeads(); }
    if (el.dataset.act === 'housing') { lead.housing = el.value; persistLeads(); renderTracker(); }
    if (el.dataset.act === 'housingCost') { lead.housingCost = el.value.trim(); persistLeads(); renderTracker(); }
    if (el.dataset.act === 'emails') {
      const add = (el.value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase());
      if (add.length) { lead.emails = [...new Set([...(lead.emails || []), ...add])]; persistLeads(); renderTracker(); toast('Email добавлен'); }
    }
  };
}

// ---------- profile & templates ----------
function fillProfileForm() {
  const f = $('#profileForm');
  Object.entries(state.profile).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v ?? ''; });
  syncPairFields();
}

function syncPairFields() {
  const f = $('#profileForm');
  const pair = f.elements.searchMode.value === 'pair';
  const exp = f.elements.experience;
  if (pair && (!exp.value.trim() || exp.value.trim() === SOLO_EXPERIENCE)) exp.value = PAIR_EXPERIENCE;
  if (!pair && (!exp.value.trim() || exp.value.trim() === PAIR_EXPERIENCE)) exp.value = SOLO_EXPERIENCE;
  $('#partnerFields').hidden = !pair;
  $('#resumeLabel').textContent = pair ? 'Ссылка на общее резюме (Google Drive, «доступ по ссылке»)' : 'Ссылка на резюме (Google Drive, «доступ по ссылке»)';
  $('#experienceLabel').textContent = pair ? 'О вас обоих: опыт, качества (1–2 предложения на английском, от «we»)' : 'Опыт / о себе (1–2 предложения на английском)';
}

function initProfile() {
  fillProfileForm();
  $$('#profileForm input[name="searchMode"]').forEach((r) => r.addEventListener('change', syncPairFields));
  $('#profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const prevMode = mode();
    Object.keys(DEFAULT_PROFILE).forEach((k) => { if (f.elements[k]) state.profile[k] = f.elements[k].value.trim(); });
    save(KEYS.profile, state.profile);
    if (prevMode !== mode()) { initComposeTemplates(); renderTemplateEditor(); }
    $('#profileSaved').hidden = false;
    setTimeout(() => { $('#profileSaved').hidden = true; }, 2000);
    renderTemplatePreview();
  });

  let current = 'cold';
  const tabs = $('#tplTabs');
  tabs.innerHTML = Object.entries(DEFAULT_TEMPLATES).map(([id, t], i) => `<label><input type="radio" name="tpl" value="${id}" ${i === 0 ? 'checked' : ''}> ${esc(t.label)}</label>`).join('');
  tabs.addEventListener('change', (e) => { current = e.target.value; renderTemplateEditor(current); });
  $('#tplSubject').addEventListener('input', renderTemplatePreview);
  $('#tplBody').addEventListener('input', renderTemplatePreview);
  $('#tplSave').addEventListener('click', () => {
    tpls()[current] = { ...tpls()[current], subject: $('#tplSubject').value, body: $('#tplBody').value };
    saveTemplates();
    $('#tplSaved').hidden = false;
    setTimeout(() => { $('#tplSaved').hidden = true; }, 2000);
  });
  $('#tplReset').addEventListener('click', () => {
    if (!confirm('Вернуть стандартный текст шаблона?')) return;
    tpls()[current] = structuredClone(defaultTemplatesFor(mode())[current]);
    saveTemplates();
    renderTemplateEditor(current);
  });
  renderTemplateEditor.current = () => current;
}

function renderTemplateEditor(id) {
  const tid = id || renderTemplateEditor.current?.() || 'cold';
  const t = tpls()[tid];
  $('#tplModeNote').textContent = mode() === 'pair'
    ? 'Сейчас режим «вдвоём»: письма пишутся от «we», подписаны обоими именами.'
    : 'Сейчас режим «один»: письма от первого лица.';
  $('#tplSubject').value = t.subject;
  $('#tplBody').value = t.body;
  renderTemplatePreview();
}

function renderTemplatePreview() {
  const sample = state.results.find((l) => l.emails?.length) || state.results[0]
    || { name: "Thrasher's French Fries", category: 'fastfood', city: 'Ocean City', state: 'MD' };
  const tmp = { preview: { subject: $('#tplSubject').value, body: $('#tplBody').value } };
  const { subject, body } = composeEmail(tmp, 'preview', state.profile, sample, { attachments: apiAttachCount() });
  $('#tplPreview').innerHTML = `<div class="pv-subject"><b>Тема:</b> ${esc(subject)}</div><pre>${esc(body)}</pre>`;
}

// ---------- settings (server URL) ----------
function renderServerStatus() {
  const el = $('#serverStatus');
  if (!el) return;
  const s = state.server;
  el.innerHTML = s.ok
    ? `✅ Сервер подключён (${esc(s.base)}). Поиск email на сайтах: ${s.emails ? 'да' : 'нет'}. Google Places: ${s.places ? 'да' : 'нет (нет ключа)'}.`
    : '⚪ Сервер не найден, сайт работает в статическом режиме (OpenStreetMap + ссылки Google).';
}

function initSettings() {
  const oauthInput = $('#oauthClientInput');
  oauthInput.value = state.settings.oauthClientId || '';
  $('#oauthClientSave').addEventListener('click', () => {
    state.settings.oauthClientId = oauthInput.value.trim();
    save(KEYS.settings, state.settings);
    gmail.clientId = oauthClientId();
    renderGmailBar();
    $('#cmSendApi').hidden = !oauthClientId();
    toast(oauthClientId() ? 'Client ID сохранён. Подключи Gmail во вкладке «Мои контакты»' : 'Client ID очищен');
  });
  const input = $('#apiBaseInput');
  if (!input) return;
  input.value = state.settings.apiBase || '';
  $('#apiBaseSave').addEventListener('click', async () => {
    state.settings.apiBase = input.value.trim();
    save(KEYS.settings, state.settings);
    state.server = { ok: false, places: false, emails: false, base: null };
    await detectServer();
    renderResults();
    toast(state.server.ok ? 'Сервер подключён' : 'Сервер не отвечает');
  });
}

// ---------- hotspots ----------
function initHotspots() {
  const regions = [...new Set(HOTSPOTS.map((h) => h.region))];
  $('#hsRegion').innerHTML += regions.map((r) => `<option>${esc(r)}</option>`).join('');
  $('#hsType').innerHTML += Object.entries(HOTSPOT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  ['hsRegion', 'hsType', 'hsHousing'].forEach((id) => $(`#${id}`).addEventListener('change', renderHotspots));
  $('#hsSearch').addEventListener('input', debounce(renderHotspots, 150));
  renderHotspots();
  $('#hotspotGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-hs]');
    if (!btn) return;
    const h = HOTSPOTS.find((x) => x.id === btn.dataset.hs);
    $('input[name="mode"][value="around"]').checked = true;
    syncMode();
    $('#stateSelect').value = h.state;
    pickCity(h);
    showTab('search');
    doSearch();
  });
}

function renderHotspots() {
  const region = $('#hsRegion').value;
  const type = $('#hsType').value;
  const q = $('#hsSearch').value.trim().toLowerCase();
  const housing = $('#hsHousing').value;
  const list = HOTSPOTS.filter((h) => (!region || h.region === region) && (!type || h.type === type) && (!housing || h.housing === housing)
    && (!q || `${h.name} ${h.state} ${STATE_BY_CODE[h.state].name} ${h.employers.join(' ')}`.toLowerCase().includes(q)));
  const savedByCity = {};
  for (const l of state.saved.values()) savedByCity[`${l.city}|${l.state}`] = (savedByCity[`${l.city}|${l.state}`] || 0) + 1;
  $('#hotspotGrid').innerHTML = list.map((h) => `
    <article class="hs card">
      <div class="hs-top"><span class="hs-type">${esc(HOTSPOT_TYPES[h.type] || '')}</span><span class="muted small">${esc(h.region)}</span></div>
      <h3>${esc(h.name)}, ${h.state}</h3>
      <p class="muted small">${esc(STATE_BY_CODE[h.state].name)}</p>
      <p>${esc(h.note)}</p>
      ${h.housing ? `<p><span class="badge st-green">${esc(HOUSING_INFO[h.housing].label)}</span></p>` : ''}
      ${h.employers.length ? `<p class="small"><b>Известные работодатели:</b> ${h.employers.map(esc).join(', ')}</p>` : ''}
      <div class="row wrap">
        <button class="btn sm primary" data-hs="${h.id}">🔎 Искать здесь</button>
        <a class="btn sm" target="_blank" rel="noopener" href="${googleMapsSearchUrl('hotels restaurants', h.name, h.state)}">🗺️ Google Maps</a>
        <a class="btn sm" target="_blank" rel="noopener" href="https://www.indeed.com/jobs?q=seasonal&l=${encodeURIComponent(`${h.name.replace(/ \(.*\)/, '')}, ${h.state}`)}">Indeed</a>
      </div>
    </article>`).join('') || '<div class="empty">Ничего не найдено.</div>';
}


// ---------- Gmail API: one-click sending + reply tracking ----------
const gmail = new GmailClient({ onChange: () => renderGmailBar() });
const camp = { running: false, paused: false, stop: false, ids: [], index: 0, kind: 'cold', done: 0, failed: 0 };
const REPLY_CHECK_MS = 10 * 60 * 1000;
let replyTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oauthClientId = () => (state.settings.oauthClientId || '').trim() || state.server.oauthClientId || '';
const todayKey = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local day
function sentToday() { const log = load(KEYS.sendLog, {}); return log.date === todayKey() ? log.count : 0; }
function bumpSent() { save(KEYS.sendLog, { date: todayKey(), count: sentToday() + 1 }); }
const ownAddresses = () => [gmail.email, state.profile.email, state.profile.partnerEmail, state.profile.gmailAccount];

async function connectGmail() {
  gmail.clientId = oauthClientId();
  if (!gmail.clientId) { openCampaign('cold'); return false; }
  try {
    const email = await gmail.connect({ hint: state.profile.gmailAccount || state.profile.email || undefined });
    toast(`Gmail подключён: ${email}`);
    if (!replyTimer) replyTimer = setInterval(() => { if (gmail.connected && !camp.running) checkReplies({ quiet: true }); }, REPLY_CHECK_MS);
    checkReplies({ quiet: true });
    return true;
  } catch (e) {
    toast(`Gmail: ${e.message}`, 6000);
    return false;
  }
}

function renderGmailBar() {
  const bar = $('#gmailBar');
  if (!bar) return;
  const configured = Boolean(oauthClientId());
  const unseen = [...state.saved.values()].filter((l) => l.reply && !l.replySeen).length;
  bar.innerHTML = `
    <span class="gm-status ${gmail.connected ? 'on' : ''}">${gmail.connected ? `✅ Gmail: ${esc(gmail.email)}` : configured ? '⚪ Gmail не подключён' : '⚪ Gmail API не настроен'}</span>
    ${gmail.connected ? '' : '<button class="btn sm" data-gm="connect" type="button">🔐 Подключить Gmail</button>'}
    <button class="btn sm primary" data-gm="campaign" type="button">📨 Отправить всем</button>
    <button class="btn sm" data-gm="followups" type="button">🔁 Напомнить всем</button>
    <button class="btn sm" data-gm="check" type="button">🔄 Проверить ответы</button>
    <button class="btn sm ghost" data-gm="test" type="button" title="Отправить пример письма на свой адрес">✉️ Тестовое письмо себе</button>
    ${state.lastReplyCheck ? `<span class="muted small">проверено в ${new Date(state.lastReplyCheck).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
    ${camp.running ? `<span class="badge st-blue">Идёт рассылка: ${camp.done} из ${camp.ids.length}</span>` : ''}`;
  const badge = $('#replyBadge');
  badge.hidden = !unseen;
  badge.textContent = `💬 ${unseen}`;
}

function initGmail() {
  $('#gmailBar').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gm]');
    if (!b) return;
    const act = b.dataset.gm;
    if (act === 'connect') await connectGmail();
    if (act === 'campaign') openCampaign('cold');
    if (act === 'followups') openCampaign('followup');
    if (act === 'check') await checkReplies();
    if (act === 'test') { b.disabled = true; await sendTestEmail(); b.disabled = false; }
  });
  $('#bulkCampaign').addEventListener('click', () => {
    const picked = state.results.filter((l) => state.selected.has(l.id));
    if (!picked.length) { toast('Отметь заведения галочками или нажми «Выбрать все»'); return; }
    picked.forEach((l) => saveLead(l));
    renderResults();
    openCampaign('cold', picked.map((l) => l.id));
  });
  $('#cpTemplate').addEventListener('change', renderCampaignPreview);
  $('#cpStart').addEventListener('click', startCampaign);
  $('#cpPause').addEventListener('click', async () => {
    if (camp.paused) {
      if (!gmail.connected && !(await connectGmail())) return;
      camp.paused = false;
    } else camp.paused = true;
    renderCampaignControls();
  });
  $('#cpStop').addEventListener('click', () => { camp.stop = true; camp.paused = false; renderCampaignControls(); });
  $('#cpOrigin').textContent = location.origin;
  renderGmailBar();
}

function campaignPool(kind, onlyIds) {
  const pool = onlyIds ? onlyIds.map((id) => state.saved.get(id)).filter(Boolean) : [...state.saved.values()];
  const ready = pool.filter((l) => l.emails?.length && l.fit?.level !== 'bad'
    && (kind === 'followup' ? isFollowupDue(l) : l.status === 'new' && !l.gmail?.threadId));
  return {
    pool,
    ready,
    noEmail: pool.filter((l) => !l.emails?.length && l.status === 'new'),
    bad: pool.filter((l) => l.fit?.level === 'bad'),
    already: pool.filter((l) => l.status !== 'new' && kind !== 'followup'),
  };
}

function openCampaign(kind, onlyIds) {
  const modal = $('#campaignModal');
  if (camp.running) { renderCampaignControls(); if (!modal.open) modal.showModal(); return; }
  const configured = Boolean(oauthClientId());
  $('#cpSetup').hidden = configured;
  $('#cpMain').hidden = !configured;
  camp.kind = kind;
  camp.onlyIds = onlyIds || null;
  $('#cpTitle').textContent = kind === 'followup' ? '🔁 Напоминания через Gmail' : '📨 Рассылка через Gmail';
  $('#cpTemplate').innerHTML = Object.entries(tpls()).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join('');
  $('#cpTemplate').value = kind === 'followup' ? 'followup' : 'cold';
  $('#cpToday').value = sentToday();
  $('#cpConfirm').checked = false;
  $('#cpProgress').hidden = true;
  $('#cpLog').innerHTML = '';
  renderCampaignSummary();
  renderCampaignControls();
  if (!modal.open) modal.showModal();
}

function renderCampaignSummary() {
  const { ready, noEmail, bad, already } = campaignPool(camp.kind, camp.onlyIds);
  camp.ids = ready.map((l) => l.id);
  const left = Math.max(0, (Number($('#cpDaily').value) || 40) - sentToday());
  $('#cpSummary').innerHTML = camp.kind === 'followup'
    ? `Напоминание получат <b>${ready.length}</b>: тем, кому писали ${FOLLOWUP_DAYS}+ дней назад и кто не ответил. Письмо уйдёт ответом в ту же ветку.`
    : `<b>Готово к отправке: ${ready.length}</b> (есть email, ещё не писали, подходят под W&amp;T).
      <ul>
        ${noEmail.length ? `<li>Без email: ${noEmail.length}. ${state.server.emails ? '<button class="btn sm" type="button" id="cpEnrich">📧 Найти email на их сайтах</button>' : 'Найди email вручную (кнопка «Найти email»).'}</li>` : ''}
        ${bad.length ? `<li>Не подходят под правила W&amp;T, пропущены: ${bad.length}</li>` : ''}
        ${already.length ? `<li>Уже писали раньше, пропущены: ${already.length}</li>` : ''}
        ${ready.length > left ? `<li>Сегодня можно ещё <b>${left}</b>, остальные отправятся завтра той же кнопкой.</li>` : ''}
      </ul>`;
  $('#cpEnrich')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Ищу…';
    await enrichMany(noEmail);
    renderCampaignSummary();
    renderCampaignPreview();
  });
  renderCampaignPreview();
}

function renderCampaignPreview() {
  const lead = state.saved.get(camp.ids[0]);
  if (!lead) { $('#cpPreview').innerHTML = '<span class="muted">Некому отправлять.</span>'; return; }
  const { subject, body } = composeEmail(tpls(), $('#cpTemplate').value, state.profile, lead, { attachments: state.attachments.length });
  const cc = partnerCc(state.profile);
  $('#cpPreview').innerHTML = `<div class="pv-subject"><b>Кому:</b> ${esc(lead.emails[0])}${cc ? ` · <b>Копия:</b> ${esc(cc)}` : ''}</div><div class="pv-subject"><b>Тема:</b> ${esc(subject)}</div><pre>${esc(body)}</pre>`;
}

function renderCampaignControls() {
  $('#cpStart').hidden = camp.running;
  $('#cpPause').hidden = !camp.running;
  $('#cpStop').hidden = !camp.running;
  $('#cpPause').textContent = camp.paused ? '▶️ Продолжить' : '⏸ Пауза';
  $('#cpTemplate').disabled = camp.running;
  const total = camp.ids.length || 1;
  $('#cpBar').style.width = `${Math.min(100, Math.round(((camp.done + camp.failed) / total) * 100))}%`;
  renderGmailBar();
}

function campaignStatus(text) { $('#cpStatus').innerHTML = text; }
function campaignLog(text, err = false) {
  const li = document.createElement('li');
  li.textContent = text;
  if (err) li.className = 'err';
  $('#cpLog').prepend(li);
}

async function startCampaign() {
  if (!camp.ids.length) { toast('Некому отправлять'); return; }
  if (!$('#cpConfirm').checked) { toast('Поставь галочку, что проверил(а) письмо'); return; }
  const first = composeEmail(tpls(), $('#cpTemplate').value, state.profile, state.saved.get(camp.ids[0]), { attachments: state.attachments.length });
  const missing = [...new Set(`${first.subject}\n${first.body}`.match(/\[(Your Name|University|2nd-year|link to resume|Friend's Name)\]/g) || [])];
  if (missing.length) { toast(`В письме не заполнено: ${missing.join(', ')}. Заполни во вкладке «Письмо и профиль»`, 7000); return; }
  if (!gmail.connected && !(await connectGmail())) return;
  Object.assign(camp, { running: true, paused: false, stop: false, index: 0, done: 0, failed: 0, templateId: $('#cpTemplate').value });
  $('#cpProgress').hidden = false;
  renderCampaignControls();
  try {
    await runCampaign();
  } finally {
    camp.running = false;
    $('#cpSummary').innerHTML = `Отправлено писем: <b>${camp.done}</b>${camp.failed ? `, ошибок: ${camp.failed}` : ''}. Окно можно закрыть: ответы появятся во вкладке «Мои контакты» (проверка каждые 10 минут, пока сайт открыт, или кнопкой «🔄 Проверить ответы»).`;
    $('#cpToday').value = sentToday();
    renderCampaignControls();
    renderTrackerIfVisible();
    renderResults();
  }
}

async function runCampaign() {
  const base = window.__wtTestIntervalSec ?? (Number($('#cpInterval').value) || 60);
  const daily = Number($('#cpDaily').value) || 40;
  while (camp.index < camp.ids.length) {
    if (camp.stop) { campaignStatus(`Остановлено. Отправлено ${camp.done}.`); return; }
    if (camp.paused) { campaignStatus(`⏸ Пауза. Отправлено ${camp.done} из ${camp.ids.length}.`); await sleep(500); continue; }
    if (sentToday() >= daily) {
      campaignStatus(`Дневной лимит ${daily} писем достигнут. Отправлено ${camp.done}. Остальные (${camp.ids.length - camp.index}) отправь завтра той же кнопкой.`);
      return;
    }
    const lead = state.saved.get(camp.ids[camp.index]);
    if (!lead?.emails?.length) { camp.index += 1; continue; }
    campaignStatus(`Отправляю ${camp.index + 1} из ${camp.ids.length}: ${esc(lead.name)}…`);
    try {
      await sendLeadEmail(lead, camp.templateId);
      camp.done += 1;
      camp.index += 1;
      campaignLog(`✓ ${lead.name} → ${lead.emails[0]}`);
    } catch (e) {
      if (e.code === 'auth') { camp.paused = true; renderCampaignControls(); campaignLog(`⏸ ${e.message}`, true); continue; }
      if (e.code === 'limit') { campaignLog(`⛔ Gmail ограничил отправку: ${e.message}`, true); campaignStatus('Gmail временно ограничил отправку. Продолжи завтра.'); return; }
      camp.failed += 1;
      camp.index += 1;
      campaignLog(`✕ ${lead.name}: ${e.message}`, true);
    }
    renderCampaignControls();
    if (camp.index < camp.ids.length) {
      const waitMs = (base + Math.random() * base * 0.5) * 1000;
      const until = Date.now() + waitMs;
      while (Date.now() < until && !camp.stop) {
        if (!camp.paused) campaignStatus(`Отправлено ${camp.done} из ${camp.ids.length}. Следующее через ${Math.ceil((until - Date.now()) / 1000)} сек…`);
        await sleep(camp.paused ? 500 : 1000);
        if (camp.paused) break;
      }
    }
  }
  campaignStatus(`✅ Готово: отправлено ${camp.done}${camp.failed ? `, ошибок ${camp.failed}` : ''}. Ответы будут появляться во вкладке «Мои контакты».`);
  toast(`Рассылка завершена: ${camp.done} писем`);
}

/** Sends one email through the Gmail API and records the thread on the lead. */
async function sendLeadEmail(lead, templateId, override = null) {
  const composed = override || composeEmail(tpls(), templateId, state.profile, lead, { attachments: state.attachments.length });
  const to = override?.to || lead.emails[0];
  const cc = override ? override.cc : partnerCc(state.profile);
  let { subject } = composed;
  let threadId;
  let inReplyTo;
  if (templateId === 'followup' && lead.gmail?.threadId) {
    threadId = lead.gmail.threadId;
    inReplyTo = await gmail.messageIdHeader(lead.gmail.messageId).catch(() => '');
    if (lead.gmail.subject) subject = /^re:/i.test(lead.gmail.subject) ? lead.gmail.subject : `Re: ${lead.gmail.subject}`;
  }
  const r = await gmail.send({ to, cc, subject, body: composed.body, threadId, inReplyTo, attachments: state.attachments });
  bumpSent();
  const now = new Date().toISOString();
  const saved = saveLead(lead);
  saved.gmail = threadId
    ? { ...saved.gmail, threadId: r.threadId }
    : { threadId: r.threadId, messageId: r.id, subject, account: gmail.email };
  saved.status = templateId === 'followup' ? 'followup' : 'emailed';
  saved.lastContactAt = now;
  saved.history = [...(saved.history || []), { at: now, action: templateId, to, via: 'gmail-api' }];
  Object.assign(lead, { gmail: saved.gmail, status: saved.status });
  persistLeads();
  return saved;
}

async function sendFromCompose() {
  const lead = compose.lead;
  if (!lead) return;
  const to = $('#cmTo').value.trim();
  if (!to) { toast('Укажи email получателя'); return; }
  if (!gmail.connected && !(await connectGmail())) return;
  const btn = $('#cmSendApi');
  btn.disabled = true;
  btn.textContent = 'Отправляю…';
  try {
    await sendLeadEmail(lead, $('#cmTemplate').value, { to, cc: $('#cmCc').value.trim(), subject: $('#cmSubject').value, body: $('#cmBody').value });
    toast(`Отправлено: ${lead.name} ✓`);
    renderResults();
    if (compose.queue) nextInQueue(); else $('#composeModal').close();
  } catch (e) {
    toast(`Не отправлено: ${e.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📨 Отправить сразу';
  }
}

/** Sends a sample email (with attachments) to the user's own address. Not recorded in the tracker. */
async function sendTestEmail() {
  if (!gmail.connected && !(await connectGmail())) return;
  const sample = [...state.saved.values()].find((l) => l.emails?.length)
    || { name: "Thrasher's French Fries", category: 'fastfood', city: 'Ocean City', state: 'MD' };
  const { subject, body } = composeEmail(tpls(), 'cold', state.profile, sample, { attachments: state.attachments.length });
  try {
    await gmail.send({ to: gmail.email, subject: `[ТЕСТ] ${subject}`, body, attachments: state.attachments });
    toast(`Тестовое письмо отправлено на ${gmail.email}${state.attachments.length ? ` с ${state.attachments.length} вложениями` : ''}. Проверь «Входящие».`, 6000);
  } catch (e) {
    toast(`Не отправлено: ${e.message}`, 8000);
  }
}

async function checkReplies({ quiet = false } = {}) {
  if (!gmail.connected) {
    if (quiet || !(await connectGmail())) return;
  }
  const leads = [...state.saved.values()].filter((l) => l.gmail?.threadId && !['offer', 'rejected', 'skip'].includes(l.status));
  let fresh = 0;
  let bounced = 0;
  const queue = [...leads];
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      try {
        const a = analyzeThread(await gmail.thread(l.gmail.threadId), ownAddresses());
        const now = new Date().toISOString();
        if (a.replied && l.reply?.messageId !== a.reply.messageId) {
          l.reply = a.reply;
          if (HOUSING_RE.test(a.reply.snippet || '')) l.housingMentioned = true;
          l.replySeen = false;
          if (['new', 'emailed', 'followup', 'bounced'].includes(l.status)) l.status = 'replied';
          l.history = [...(l.history || []), { at: now, action: 'status:replied', via: 'gmail-check' }];
          fresh += 1;
        } else if (a.bounced && l.status !== 'bounced' && !l.reply) {
          l.status = 'bounced';
          l.history = [...(l.history || []), { at: now, action: 'status:bounced', via: 'gmail-check' }];
          bounced += 1;
        }
      } catch (e) {
        if (e.code === 'auth') { queue.length = 0; if (!quiet) toast(e.message); }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  state.lastReplyCheck = Date.now();
  persistLeads();
  renderTrackerIfVisible();
  renderResults();
  renderGmailBar();
  if (fresh) {
    toast(`💬 Новых ответов: ${fresh}! Смотри «Мои контакты»`, 6000);
    document.title = `(${fresh}) 💬 W&T Job Finder`;
  } else if (!quiet) {
    toast(bounced ? `Новых ответов нет. Не дошло писем: ${bounced}` : `Новых ответов нет (проверено ${leads.length})`);
  }
}

function markRepliesSeen() {
  let changed = false;
  for (const l of state.saved.values()) if (l.reply && !l.replySeen) { l.replySeen = true; changed = true; }
  if (changed) { persistLeads(); renderGmailBar(); }
  document.title = 'W&T Job Finder';
}

// ---------- boot ----------
function boot() {
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  $('#placeModal').addEventListener('close', () => { $('#pmMap').src = 'about:blank'; });
  initMap();
  initSearchForm();
  initCompose();
  initTracker();
  initProfile();
  initSettings();
  initHotspots();
  initGmail();
  initAttachments();
  initTabs();
  persistLeads();
  detectServer();
  // Re-render launchers when categories change.
  $('#categoryList').addEventListener('change', renderLaunchers);
}

boot();

// Exposed for debugging in the console.
window.wt = { state };

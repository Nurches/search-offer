import { CATEGORIES, CATEGORY_BY_ID, HOTSPOTS, HOTSPOT_TYPES, STATES, STATE_BY_CODE } from './data.js';
import {
  buildOverpassQuery, geocodeCity, parseOverpass, runOverpass, searchGooglePlaces, sortLeads, suggestCities,
  assessFit, haversineKm,
} from './search.js';
import {
  DEFAULT_PROFILE, DEFAULT_TEMPLATES, DEFAULT_TEMPLATES_PAIR, defaultTemplatesFor, partnerCc, SOLO_EXPERIENCE, PAIR_EXPERIENCE, STATUSES, STATUS_BY_ID, composeEmail, emailSearchUrl, gmailComposeUrl,
  googleMapsEmbedUrl, googleMapsSearchUrl, googleMapsUrl, jobBoardLinks, mailtoUrl,
} from './outreach.js';
import { KEYS, download, leadsToCsv, load, mergeLeads as mergeSavedLeads, save, toSavedLead } from './store.js';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const FOLLOWUP_DAYS = 7;
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
        state.server = { ok: true, places: !!j.places, emails: !!j.emails, base };
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
}

// ---------- tabs ----------
function showTab(id) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${id}`));
  if (id === 'search') setTimeout(() => map?.invalidateSize(), 50);
  if (id === 'tracker') renderTracker();
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
  });

  const cityInput = $('#cityInput');
  const sugg = $('#citySuggest');
  let suggAbort;
  const runSuggest = debounce(async () => {
    const q = cityInput.value.trim();
    suggAbort?.abort();
    if (q.length < 2) { sugg.hidden = true; return; }
    suggAbort = new AbortController();
    try {
      const local = HOTSPOTS.filter((h) => h.name.toLowerCase().includes(q.toLowerCase()) && (!stateSel.value || h.state === stateSel.value))
        .map((h) => ({ name: h.name, state: h.state, lat: h.lat, lon: h.lon, label: `${h.name}, ${h.state} · W&T курорт` }));
      renderSuggest(local, true);
      const remote = await suggestCities(q, { stateCode: stateSel.value, signal: suggAbort.signal });
      renderSuggest([...local, ...remote].slice(0, 10), false);
    } catch (e) {
      if (e.name !== 'AbortError') renderSuggest([], false);
    }
  }, 300);

  function renderSuggest(items, loading) {
    if (!items.length && !loading) { sugg.innerHTML = '<li class="muted">Ничего не найдено. Нажми «Найти» — попробуем найти город так.</li>'; sugg.hidden = false; return; }
    sugg.innerHTML = items.map((c, i) => `<li data-i="${i}" tabindex="-1">${esc(c.label)}</li>`).join('') + (loading ? '<li class="muted">Ищу…</li>' : '');
    sugg.hidden = false;
    $$('li[data-i]', sugg).forEach((li) => li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickCity(items[Number(li.dataset.i)]);
      sugg.hidden = true;
    }));
  }

  cityInput.addEventListener('input', () => { state.city = null; runSuggest(); });
  cityInput.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 150));
  cityInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') sugg.hidden = true; });

  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#filterInput').addEventListener('input', debounce(renderResults, 150));
  $('#fitFilter').addEventListener('change', renderResults);
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
    ? `<span class="muted small">W&T курорты:</span>${list.map((h) => `<button type="button" class="chip ${state.city?.name === h.name ? 'on' : ''}" data-id="${h.id}">${esc(h.name)}</button>`).join('')}`
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
      if (!name) throw new Error('Введи город или выбери W&T курорт.');
      setStatus('<span class="spinner"></span> Ищу город на карте…');
      const hit = await geocodeCity(name, st, { signal: ctrl.signal });
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
  return sortLeads(state.results, $('#sortSelect').value).filter((l) => (!q || l.name.toLowerCase().includes(q) || (l.address || '').toLowerCase().includes(q))
    && (fit === 'all' || l.fit?.level === fit));
}

function renderResults(updateMap = false) {
  const list = visibleResults();
  const all = state.results;
  $('#resultsBar').hidden = !all.length;
  const withEmail = all.filter((l) => l.emails.length).length;
  const withSite = all.filter((l) => l.website).length;
  $('#resultsSummary').innerHTML = `Найдено <b>${all.length}</b> · с email <b>${withEmail}</b> · с сайтом <b>${withSite}</b>${list.length !== all.length ? ` · показано ${list.length}` : ''}`;
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
    </div>`;
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
  const { subject, body } = composeEmail(tpls(), tid, state.profile, compose.lead, extra);
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
  $('#queueBtn').addEventListener('click', () => startQueue('cold'));
  $('#followupBtn').addEventListener('click', () => startQueue('followup'));
  $('#enrichAllBtn').addEventListener('click', async () => {
    await enrichMany(filteredTracker());
    renderTracker();
  });
  $('#exportCsv').addEventListener('click', () => {
    const rows = filteredTracker().map((l) => ({ ...l, gmaps: googleMapsUrl(l) }));
    download(`wt-contacts-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${leadsToCsv(rows, (s) => STATUS_BY_ID[s]?.label || s)}`, 'text/csv');
  });
  $('#exportJson').addEventListener('click', () => {
    download(`wt-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), leads: [...state.saved.values()], profile: state.profile, templates: state.tpl,
    }, null, 2), 'application/json');
  });
  $('#importJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const leads = Array.isArray(data) ? data : data.leads || [];
      let n = 0;
      for (const l of leads) {
        if (!l?.id || !l?.name) continue;
        state.saved.set(l.id, mergeSavedLeads(state.saved.get(l.id), l));
        n += 1;
      }
      if (data.profile) { state.profile = { ...DEFAULT_PROFILE, ...data.profile }; save(KEYS.profile, state.profile); fillProfileForm(); }
      if (data.templates) {
        const t = data.templates.solo || data.templates.pair ? data.templates : { solo: data.templates };
        if (t.solo) { state.tpl.solo = { ...structuredClone(DEFAULT_TEMPLATES), ...t.solo }; save(KEYS.templates, state.tpl.solo); }
        if (t.pair) { state.tpl.pair = { ...structuredClone(DEFAULT_TEMPLATES_PAIR), ...t.pair }; save(KEYS.templatesPair, state.tpl.pair); }
      }
      persistLeads();
      renderTracker();
      toast(`Импортировано контактов: ${n}`);
    } catch (err) {
      toast(`Ошибка импорта: ${err.message}`);
    }
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
  return [...state.saved.values()]
    .filter((l) => (!q || `${l.name} ${l.city} ${l.notes} ${(l.emails || []).join(' ')}`.toLowerCase().includes(q))
      && (!st || l.status === st) && (!stateCode || l.state === stateCode))
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
    <span class="stat"><b>${counts.emailed + counts.followup}</b> отправлено</span>
    <span class="stat"><b>${counts.replied + counts.interview}</b> ответили</span>
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
    <div class="trow fit-${l.fit?.level || 'ok'} ${dueNow ? 'due' : ''}" data-id="${esc(l.id)}">
      <div class="trow-main">
        <div class="lead-top">
          <h4>${cat?.icon || ''} ${esc(l.name)}</h4>
          <span class="badge fit-${l.fit?.level}">${FIT_LABEL[l.fit?.level] || ''}</span>
          ${dueNow ? '<span class="badge st-amber">Пора напомнить</span>' : ''}
        </div>
        <div class="lead-meta">
          <span>${esc([l.city, l.state].filter(Boolean).join(', '))}</span>
          ${l.lastContactAt ? `<span>Последнее письмо: ${new Date(l.lastContactAt).toLocaleDateString('ru-RU')}</span>` : ''}
          ${emailCount(l) ? `<span>Писем: ${emailCount(l)}</span>` : ''}
        </div>
        <div class="lead-contacts">
          ${(l.emails || []).map((e) => `<span class="contact email">✉️ ${esc(e)}</span>`).join('') || '<span class="muted small">email нет</span>'}
          ${l.phone ? `<a class="contact" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(l.phone)}</a>` : ''}
          ${l.website ? `<a class="contact" href="${esc(l.website)}" target="_blank" rel="noopener">🌐 ${esc(hostOf(l.website))}</a>` : ''}
        </div>
        <div class="trow-edit">
          <select data-act="status">${STATUSES.map((s) => `<option value="${s.id}" ${s.id === l.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          <input data-act="emails" placeholder="Добавить email вручную" value="">
          <input data-act="notes" placeholder="Заметки: ставка, жильё, имя менеджера…" value="${esc(l.notes || '')}">
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
  const { subject, body } = composeEmail(tmp, 'preview', state.profile, sample);
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
  ['hsRegion', 'hsType'].forEach((id) => $(`#${id}`).addEventListener('change', renderHotspots));
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
  const list = HOTSPOTS.filter((h) => (!region || h.region === region) && (!type || h.type === type)
    && (!q || `${h.name} ${h.state} ${STATE_BY_CODE[h.state].name} ${h.employers.join(' ')}`.toLowerCase().includes(q)));
  const savedByCity = {};
  for (const l of state.saved.values()) savedByCity[`${l.city}|${l.state}`] = (savedByCity[`${l.city}|${l.state}`] || 0) + 1;
  $('#hotspotGrid').innerHTML = list.map((h) => `
    <article class="hs card">
      <div class="hs-top"><span class="hs-type">${esc(HOTSPOT_TYPES[h.type] || '')}</span><span class="muted small">${esc(h.region)}</span></div>
      <h3>${esc(h.name)}, ${h.state}</h3>
      <p class="muted small">${esc(STATE_BY_CODE[h.state].name)}</p>
      <p>${esc(h.note)}</p>
      ${h.employers.length ? `<p class="small"><b>Известные работодатели:</b> ${h.employers.map(esc).join(', ')}</p>` : ''}
      <div class="row wrap">
        <button class="btn sm primary" data-hs="${h.id}">🔎 Искать здесь</button>
        <a class="btn sm" target="_blank" rel="noopener" href="${googleMapsSearchUrl('hotels restaurants', h.name, h.state)}">🗺️ Google Maps</a>
        <a class="btn sm" target="_blank" rel="noopener" href="https://www.indeed.com/jobs?q=seasonal&l=${encodeURIComponent(`${h.name.replace(/ \(.*\)/, '')}, ${h.state}`)}">Indeed</a>
      </div>
    </article>`).join('') || '<div class="empty">Ничего не найдено.</div>';
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
  initTabs();
  persistLeads();
  detectServer();
  // Re-render launchers when categories change.
  $('#categoryList').addEventListener('change', renderLaunchers);
}

boot();

// Exposed for debugging in the console.
window.wt = { state };

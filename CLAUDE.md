# W&T Job Finder — notes for Claude

Website for finding Summer Work and Travel (J-1) employers across the USA, emailing them through
Gmail and tracking replies. UI is in Russian, emails are in English. Deployed on Vercel from this
repo (auto-deploy on push); production URL is set by the owner in Vercel.

## Privacy rule (important)
The repo is **public**. Never commit names, emails, phone numbers, resumes or any profile data.
User data lives only in the browser (localStorage) and is loaded via "Импорт профиля из файла"
(JSON with `profile`, `templates`, `attachments`, `leads`). Generate such files in the scratchpad
and hand them to the user; do not put them in the repo.

## Layout
- `public/` — static site, no build step, native ES modules
  - `js/data.js` — states, job categories (W&T-eligible, OSM selectors), resort hotspots (`housing: 'employer'` marks
    places where staff housing is common), name-based rule flags (22 CFR 62.32)
  - `js/search.js` — Overpass query building/parsing, whole-state query (contacts first, then `nwr.c[...]` filters),
    per-state city list, Photon/Nominatim geocoding, eligibility (`assessFit`)
  - `js/outreach.js` — profile defaults, solo and pair ("we") email templates, `{{resumeLine}}`, `{{housingLine}}`,
    Gmail compose / Google Maps / job-board / housing links
  - `js/gmail.js` — Gmail API in the browser (GIS token model, `gmail.send` + `gmail.readonly`), MIME with attachments,
    From header, thread analysis (replies/bounces), inbox bounce scan, friendly Google errors
  - `js/store.js` — localStorage keys, saved-lead shape, `mergeLeads` (backup import), `applyBounce`, CSV
  - `js/app.js` — all UI: search, map (Leaflet, fullscreen, popups), city picker, results, tracker, profile,
    attachments, campaign runner (jittered pause, daily cap), reply checking
  - `vendor/leaflet/` — vendored Leaflet 1.9.4
- `server/handlers.js` — API shared by local server and Vercel: `/api/health` (also exposes
  `GOOGLE_OAUTH_CLIENT_ID`), `/api/emails` (website email discovery), `/api/overpass` (cached proxy, stays under
  Vercel's 60 s), `/api/places` (Google Places API (New), `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAX_PAGES`)
- `server/emails.js` — crawler with SSRF protection (checks every redirect hop), Cloudflare email decoding, ranking
- `server/index.js` — local Node server (static + routes), no dependencies
- `api/*.js` — thin Vercel function wrappers; `vercel.json` serves `public/` and sets `maxDuration: 60`

## Commands
- `npm start` — local server on http://localhost:3000
- `npm test` — unit tests (`node --test test/unit/*.test.js`)
- `npm run test:e2e` — Chromium end-to-end test with every external service mocked (Overpass, Photon, Google
  sign-in, Gmail API); uses the global Playwright install. Screenshots go to `test-results/` (gitignored)

The cloud sandbox cannot reach Overpass, Photon, Nominatim, Google or Vercel, so verify behaviour with the
mocked e2e test, not live calls. Run both test suites before every push.

## Conventions
- Match existing style: small pure functions in `search.js` / `outreach.js` / `gmail.js` / `store.js` with unit
  tests; DOM code only in `app.js`; escape all OSM/website text with `esc()` before inserting HTML
- Leaflet sets an inline `position: relative` on the map — fullscreen CSS needs `!important`
- Saved-lead fields must be listed in `LEAD_FIELDS` (store.js) or they are dropped on save
- Campaign must refuse to start while placeholders like `[University]` remain in the email

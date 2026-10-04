// Email templates, Gmail compose links, Google Maps links, job-board links.
import { CATEGORY_BY_ID, STATE_BY_CODE } from './data.js';

export const DEFAULT_PROFILE = {
  name: '',
  email: '',
  phone: '',
  country: 'Kazakhstan',
  university: '',
  major: '',
  studyYear: '',
  english: 'Upper-Intermediate (B2)',
  sponsor: 'InterExchange',
  agency: '',
  startDate: 'May 25, 2027',
  endDate: 'September 15, 2027',
  experience: 'I am hardworking, friendly and quick to learn, and I have experience working with customers.',
  resumeLink: '',
  gmailAccount: '',
};

export const DEFAULT_TEMPLATES = {
  cold: {
    label: 'Холодное письмо (вакансий может не быть)',
    subject: 'Summer 2027 Seasonal Job Inquiry – J-1 Work and Travel Student from {{country}}',
    body: `Dear {{business}} Hiring Team,

My name is {{name}}, and I am a {{studyYear}} student at {{university}} in {{country}}{{majorClause}}. I am participating in the J-1 Summer Work and Travel program in 2027 through {{sponsor}}, a U.S. Department of State designated sponsor, and I am looking for a seasonal job in {{city}} from {{startDate}} to {{endDate}}.

I would be happy to join your team at {{business}} in any entry-level role, for example {{positions}}. Even if you do not have open positions posted right now, I would be very grateful to be considered for the 2027 season.

A little about me:
- English level: {{english}}
- Available full-time (32–40+ hours per week) for the whole season, including weekends and holidays
- {{experience}}

Hiring a J-1 student is easy for employers: my sponsor arranges the visa, health insurance and SEVIS registration, there is no sponsorship fee for you, and J-1 students are generally exempt from FICA taxes (Social Security and Medicare). I would only need a job offer to submit to my sponsor.

My resume: {{resumeLink}}
I am available for a video interview (Zoom, Skype, WhatsApp) at any time convenient for you.

Thank you for your time and consideration. I look forward to hearing from you!

Best regards,
{{name}}
{{phone}}
{{email}}`,
  },
  vacancy: {
    label: 'Отклик на вакансию',
    subject: 'Application for {{positionTitle}} – Summer 2027 (J-1 Work and Travel)',
    body: `Dear Hiring Manager,

I am writing to apply for the {{positionTitle}} position at {{business}} for the 2027 summer season. My name is {{name}}, and I am a {{studyYear}} student at {{university}} in {{country}}.

I will be in the United States on the J-1 Summer Work and Travel program through {{sponsor}} and I am available to work from {{startDate}} to {{endDate}}, full-time, including weekends and holidays.

- English level: {{english}}
- {{experience}}

My sponsor handles the visa, insurance and SEVIS paperwork, and there is no sponsorship fee for employers.

My resume: {{resumeLink}}
I would be glad to have a video interview at your convenience.

Thank you for considering my application.

Best regards,
{{name}}
{{phone}}
{{email}}`,
  },
  followup: {
    label: 'Повторное письмо (через 7–10 дней)',
    subject: 'Following up: Summer 2027 seasonal job – {{name}}',
    body: `Dear {{business}} Hiring Team,

I hope you are doing well. I am following up on my email about a seasonal position at {{business}} for summer 2027 ({{startDate}} – {{endDate}}).

I am still very interested in working with your team in any entry-level role, and I am available for a video interview at any time. My resume: {{resumeLink}}

Thank you again for your time!

Best regards,
{{name}}
{{phone}}
{{email}}`,
  },
};

export const STATUSES = [
  { id: 'new', label: 'Новый', color: 'gray' },
  { id: 'emailed', label: 'Письмо отправлено', color: 'blue' },
  { id: 'followup', label: 'Повторно написал', color: 'indigo' },
  { id: 'replied', label: 'Ответили', color: 'amber' },
  { id: 'interview', label: 'Интервью', color: 'violet' },
  { id: 'offer', label: 'Job offer! 🎉', color: 'green' },
  { id: 'rejected', label: 'Отказ', color: 'red' },
  { id: 'skip', label: 'Пропустить', color: 'gray' },
];
export const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? '').toString());
}

export function buildVars(profile, lead = {}, extra = {}) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  const cat = CATEGORY_BY_ID[lead.category];
  const city = [lead.city, lead.state].filter(Boolean).join(', ') || 'your area';
  return {
    ...p,
    name: p.name || '[Your Name]',
    university: p.university || '[University]',
    studyYear: p.studyYear || '[2nd-year]',
    email: p.email || '',
    resumeLink: p.resumeLink || '[link to resume]',
    majorClause: p.major ? `, majoring in ${p.major}` : '',
    business: lead.name || 'your company',
    city,
    positions: cat?.positions || 'housekeeping, food service or guest services',
    positionTitle: extra.positionTitle || cat?.positions?.split(',')[0]?.trim() || 'seasonal',
    ...extra,
  };
}

export function composeEmail(templates, templateId, profile, lead, extra) {
  const tpl = templates[templateId] || DEFAULT_TEMPLATES[templateId] || DEFAULT_TEMPLATES.cold;
  const vars = buildVars(profile, lead, extra);
  return {
    subject: renderTemplate(tpl.subject, vars).replace(/\s+/g, ' ').trim(),
    body: renderTemplate(tpl.body, vars).replace(/\n{3,}/g, '\n\n'),
  };
}

export function gmailComposeUrl({ to, subject, body, authuser }) {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject || '', body: body || '' });
  if (authuser) params.set('authuser', authuser);
  return `https://mail.google.com/mail/?${params}`;
}

export function mailtoUrl({ to, subject, body }) {
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
}

function placeQuery(lead) {
  const where = lead.address || [lead.city, lead.state].filter(Boolean).join(', ');
  return [lead.name, where].filter(Boolean).join(', ');
}

export function googleMapsUrl(lead) {
  if (lead.gmapsUrl) return lead.gmapsUrl;
  const params = new URLSearchParams({ api: '1', query: placeQuery(lead) });
  if (lead.placeId) params.set('query_place_id', lead.placeId);
  return `https://www.google.com/maps/search/?${params}`;
}

// Keyless Google Maps embed (works in an iframe without an API key).
export function googleMapsEmbedUrl(lead) {
  const params = new URLSearchParams({ q: placeQuery(lead), output: 'embed', z: '16' });
  if (Number.isFinite(lead.lat)) params.set('ll', `${lead.lat},${lead.lon}`);
  return `https://maps.google.com/maps?${params}`;
}

export function googleMapsSearchUrl(what, city, stateCode) {
  const where = [city, stateCode].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/${encodeURIComponent(`${what} in ${where}`)}`;
}

export function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

export function emailSearchUrl(lead) {
  const site = lead.website ? (() => { try { return new URL(lead.website).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
  const q = site
    ? `site:${site} email OR contact OR careers OR employment`
    : `"${lead.name}" ${[lead.city, lead.state].filter(Boolean).join(' ')} email contact jobs`;
  return googleSearchUrl(q);
}

export function jobBoardLinks(city, stateCode) {
  const stateName = STATE_BY_CODE[stateCode]?.name || stateCode || '';
  const loc = [city, stateCode].filter(Boolean).join(', ') || stateName;
  const enc = encodeURIComponent;
  return [
    { label: 'Indeed: seasonal', url: `https://www.indeed.com/jobs?q=${enc('seasonal summer')}&l=${enc(loc)}` },
    { label: 'Indeed: J-1 / Work and Travel', url: `https://www.indeed.com/jobs?q=${enc('"J-1" OR "work and travel" OR "international students"')}&l=${enc(loc)}` },
    { label: 'Google Jobs', url: `https://www.google.com/search?q=${enc(`seasonal summer jobs ${loc}`)}&ibp=htl;jobs` },
    { label: 'CoolWorks (сезонные)', url: googleSearchUrl(`site:coolworks.com ${stateName} ${city || ''} summer`) },
    { label: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${enc('seasonal')}&location=${enc(loc)}` },
    { label: 'Craigslist', url: googleSearchUrl(`site:craigslist.org ${loc} summer seasonal jobs`) },
    { label: '“J-1 housing provided”', url: googleSearchUrl(`"J-1" "housing" seasonal jobs ${loc} 2027`) },
    { label: 'Facebook-группы W&T', url: googleSearchUrl(`facebook group work and travel ${stateName} jobs`) },
  ];
}

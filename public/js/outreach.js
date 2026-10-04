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
  // Searching as a pair (two friends, one joint resume)
  searchMode: 'pair',
  partnerName: '',
  partnerEmail: '',
  partnerPhone: '',
  partnerUniversity: '',
  partnerEnglish: 'Upper-Intermediate (B2)',
  ccPartner: 'yes',
  housingNeed: 'yes', // ask employers about staff housing in emails
};

export const SOLO_EXPERIENCE = DEFAULT_PROFILE.experience;
export const PAIR_EXPERIENCE = 'We are hardworking, friendly and quick to learn, and we both have experience working with customers.';

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

{{housingLine}}

Hiring a J-1 student is easy for employers: my sponsor arranges the visa, health insurance and SEVIS registration, there is no sponsorship fee for you, and J-1 students are generally exempt from FICA taxes (Social Security and Medicare). I would only need a job offer to submit to my sponsor.

{{resumeLine}}
I am available for a video interview (Zoom, Google Meet or WhatsApp) at any time convenient for you.

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

{{housingLine}}

My sponsor handles the visa, insurance and SEVIS paperwork, and there is no sponsorship fee for employers.

{{resumeLine}}
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

I am still very interested in working with your team in any entry-level role, and I am available for a video interview at any time. {{resumeLine}}

Thank you again for your time!

Best regards,
{{name}}
{{phone}}
{{email}}`,
  },
};

export const DEFAULT_TEMPLATES_PAIR = {
  cold: {
    label: 'Холодное письмо (вакансий может не быть)',
    subject: 'Summer 2027 Seasonal Jobs for Two J-1 Work and Travel Students from {{country}}',
    body: `Dear {{business}} Hiring Team,

My name is {{name}}, and together with my friend {{partnerName}} we are {{studentsClause}} in {{country}}. We are both participating in the J-1 Summer Work and Travel program in 2027 through {{sponsor}}, a U.S. Department of State designated sponsor, and we are looking for seasonal jobs in {{city}} from {{startDate}} to {{endDate}}.

We would love to join your team at {{business}} together, in any entry-level roles, for example {{positions}}. Even if you do not have open positions posted right now, we would be very grateful to be considered for the 2027 season. Working at the same place makes housing and transportation easier for us, and we are happy to work different positions or shifts.

A little about us:
- English level: {{englishLine}}
- Both available full-time (32–40+ hours per week) for the whole season, including weekends and holidays
- {{experience}}

{{housingLine}}

Hiring J-1 students is easy for employers: our sponsor arranges the visas, health insurance and SEVIS registration, there is no sponsorship fee for you, and J-1 students are generally exempt from FICA taxes (Social Security and Medicare). We would only need a job offer for each of us to submit to our sponsor.

{{resumeLine}}
We are available for a video interview (Zoom, Google Meet or WhatsApp) at any time convenient for you, together or separately.

Thank you for your time and consideration. We look forward to hearing from you!

Best regards,
{{names}}
{{contacts}}`,
  },
  vacancy: {
    label: 'Отклик на вакансию',
    subject: 'Application for {{positionTitle}} (2 positions) – Summer 2027, J-1 Work and Travel',
    body: `Dear Hiring Manager,

We are writing to apply for the {{positionTitle}} position at {{business}} for the 2027 summer season. My name is {{name}}, and together with my friend {{partnerName}} we are {{studentsClause}} in {{country}}. We would like to apply together for two positions, but we are also open to different roles or shifts.

We will be in the United States on the J-1 Summer Work and Travel program through {{sponsor}} and we are available to work from {{startDate}} to {{endDate}}, full-time, including weekends and holidays.

- English level: {{englishLine}}
- {{experience}}

{{housingLine}}

Our sponsor handles the visa, insurance and SEVIS paperwork, and there is no sponsorship fee for employers. We would need a job offer for each of us.

{{resumeLine}}
We would be glad to have a video interview at your convenience.

Thank you for considering our application.

Best regards,
{{names}}
{{contacts}}`,
  },
  followup: {
    label: 'Повторное письмо (через 7–10 дней)',
    subject: 'Following up: Summer 2027 seasonal jobs – {{names}}',
    body: `Dear {{business}} Hiring Team,

We hope you are doing well. We are following up on our email about seasonal positions at {{business}} for summer 2027 ({{startDate}} – {{endDate}}) for the two of us.

We are still very interested in working with your team in any entry-level roles, and we are available for a video interview at any time. {{resumeLine}}

Thank you again for your time!

Best regards,
{{names}}
{{contacts}}`,
  },
};

export function defaultTemplatesFor(mode) {
  return mode === 'pair' ? DEFAULT_TEMPLATES_PAIR : DEFAULT_TEMPLATES;
}

export const STATUSES = [
  { id: 'new', label: 'Новый', color: 'gray' },
  { id: 'emailed', label: 'Письмо отправлено', color: 'blue' },
  { id: 'followup', label: 'Повторно написал', color: 'indigo' },
  { id: 'replied', label: 'Ответили', color: 'amber' },
  { id: 'interview', label: 'Интервью', color: 'violet' },
  { id: 'offer', label: 'Job offer! 🎉', color: 'green' },
  { id: 'rejected', label: 'Отказ', color: 'red' },
  { id: 'bounced', label: 'Email не дошёл', color: 'red' },
  { id: 'skip', label: 'Пропустить', color: 'gray' },
];
export const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? '').toString());
}

/** "Our resumes are attached…" / "My resume: <link>" depending on attachments and link. */
export function resumeLine(p, attachmentCount, pair) {
  const link = (p.resumeLink || '').trim();
  const many = attachmentCount > 1 || pair;
  if (attachmentCount > 0) {
    const att = pair ? `Our resume${many ? 's are' : ' is'} attached to this email` : `My resume${attachmentCount > 1 ? 's are' : ' is'} attached to this email`;
    return link ? `${att} (also available here: ${link}).` : `${att}.`;
  }
  return `${pair ? 'Our resume' : 'My resume'}: ${link || '[link to resume]'}`;
}

function contactLine(name, phone, email) {
  const bits = [phone, email].filter(Boolean).join(', ');
  return bits ? `${name}: ${bits}` : '';
}

export function buildVars(profile, lead = {}, extra = {}) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  const cat = CATEGORY_BY_ID[lead.category];
  const city = [lead.city, lead.state].filter(Boolean).join(', ') || 'your area';
  const name = p.name || '[Your Name]';
  const university = p.university || '[University]';
  const vars = {
    ...p,
    name,
    university,
    studyYear: p.studyYear || '[2nd-year]',
    email: p.email || '',
    resumeLink: p.resumeLink || '[link to resume]',
    majorClause: p.major ? `, majoring in ${p.major}` : '',
    business: lead.name || 'your company',
    city,
    positions: cat?.positions || 'housekeeping, food service or guest services',
    positionTitle: extra.positionTitle || cat?.positions?.split(',')[0]?.trim() || 'seasonal',
    resumeLine: resumeLine(p, extra.attachments || 0, false),
    housingLine: p.housingNeed === 'yes'
      ? 'Housing is very important for me: do you provide employee housing, or could you help me find affordable housing close to work?'
      : '',
  };
  if (p.searchMode === 'pair') {
    const partnerName = p.partnerName || "[Friend's Name]";
    const partnerUni = p.partnerUniversity.trim();
    const sameUni = !partnerUni || partnerUni.toLowerCase() === university.toLowerCase();
    Object.assign(vars, {
      partnerName,
      names: `${name} and ${partnerName}`,
      studentsClause: sameUni ? `both students at ${university}` : `students at ${university} and ${partnerUni}`,
      englishLine: !p.partnerEnglish || p.partnerEnglish === p.english
        ? `${p.english} (both)`
        : `${name} – ${p.english}, ${partnerName} – ${p.partnerEnglish}`,
      experience: p.experience === SOLO_EXPERIENCE ? PAIR_EXPERIENCE : p.experience,
      contacts: [contactLine(name, p.phone, p.email), contactLine(partnerName, p.partnerPhone, p.partnerEmail)].filter(Boolean).join('\n'),
      resumeLine: resumeLine(p, extra.attachments || 0, true),
      housingLine: p.housingNeed === 'yes'
        ? 'Housing is very important for us: do you provide employee housing for two people, or could you help us find affordable housing close to work?'
        : '',
    });
  }
  return { ...vars, ...extra };
}

/** CC address for the partner when searching as a pair. */
export function partnerCc(profile) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  return p.searchMode === 'pair' && p.ccPartner === 'yes' ? (p.partnerEmail || '').trim() : '';
}

export function composeEmail(templates, templateId, profile, lead, extra) {
  const tpl = templates[templateId] || DEFAULT_TEMPLATES[templateId] || DEFAULT_TEMPLATES.cold;
  const vars = buildVars(profile, lead, extra);
  return {
    subject: renderTemplate(tpl.subject, vars).replace(/\s+/g, ' ').trim(),
    body: renderTemplate(tpl.body, vars).replace(/\n{3,}/g, '\n\n'),
  };
}

export function gmailComposeUrl({ to, cc, subject, body, authuser }) {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject || '', body: body || '' });
  if (cc) params.set('cc', cc);
  if (authuser) params.set('authuser', authuser);
  return `https://mail.google.com/mail/?${params}`;
}

export function mailtoUrl({ to, cc, subject, body }) {
  return `mailto:${encodeURIComponent(to || '')}?${cc ? `cc=${encodeURIComponent(cc)}&` : ''}subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
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

/** Links for finding housing near a workplace (rooms, shared apartments, weekly motels, J-1 groups). */
export function housingLinks(lead) {
  const near = lead.address || [lead.city, lead.state].filter(Boolean).join(', ');
  const town = [lead.city, lead.state].filter(Boolean).join(', ') || near;
  const gm = (what) => `https://www.google.com/maps/search/${encodeURIComponent(`${what} near ${near}`)}`;
  return [
    { label: '🏢 Квартиры рядом (Google Maps)', url: gm('apartments for rent') },
    { label: '🛏️ Мотели с недельной оплатой', url: gm('motel weekly rates') },
    { label: 'Сдают комнату / жильё для сезонных работников', url: googleSearchUrl(`"seasonal" OR "summer" employee housing ${town} room for rent`) },
    { label: 'Craigslist: жильё', url: googleSearchUrl(`site:craigslist.org ${town} room for rent summer`) },
    { label: 'Facebook: J-1 housing', url: googleSearchUrl(`facebook J1 student housing ${town}`) },
    { label: 'Zillow: аренда', url: googleSearchUrl(`site:zillow.com ${town} rentals`) },
  ];
}

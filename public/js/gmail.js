// Gmail API from the browser: Google sign-in (token model), sending, and reply tracking.
// Needs an OAuth "Web application" client ID; the access token lives only in memory.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ---------- pure helpers (unit-tested in Node) ----------
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const toBase64Url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function encodeHeader(value) {
  // RFC 2047 for non-ASCII subjects/names.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

const cleanHeader = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();

const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

/**
 * Builds the base64url "raw" RFC 822 message for users.messages.send.
 * attachments: [{ filename, mimeType, data }] where data is plain base64.
 */
export function buildRawMessage({ to, cc, subject, body, inReplyTo, attachments = [] }) {
  const headers = [
    `To: ${cleanHeader(to)}`,
    cc ? `Cc: ${cleanHeader(cc)}` : null,
    `Subject: ${encodeHeader(cleanHeader(subject))}`,
    inReplyTo ? `In-Reply-To: ${cleanHeader(inReplyTo)}` : null,
    inReplyTo ? `References: ${cleanHeader(inReplyTo)}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8ToBase64(String(body || '').replace(/\r?\n/g, '\r\n'))),
  ].join('\r\n');

  let message;
  if (!attachments.length) {
    message = `${headers.join('\r\n')}\r\n${textPart}`;
  } else {
    const boundary = `wt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const parts = [textPart, ...attachments.map((a) => {
      const name = encodeHeader(cleanHeader(a.filename).replace(/"/g, ''));
      return [
        `Content-Type: ${cleanHeader(a.mimeType || 'application/octet-stream')}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(String(a.data).replace(/\s+/g, '')),
      ].join('\r\n');
    })];
    message = `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`
      + parts.map((p) => `--${boundary}\r\n${p}`).join('\r\n') + `\r\n--${boundary}--`;
  }
  return toBase64Url(utf8ToBase64(message));
}

export const headerOf = (msg, name) =>
  (msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

export const emailOf = (fromHeader) => ((String(fromHeader).match(/<([^>]+)>/) || [])[1] || String(fromHeader)).trim().toLowerCase();

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliverable|delivery (has )?failed|returned mail|address not found/i;

/**
 * Looks at a Gmail thread and tells whether the employer replied or the email bounced.
 * ownAddresses: our own emails (me + partner) so our messages/CC replies don't count.
 */
export function analyzeThread(thread, ownAddresses = []) {
  const own = new Set(ownAddresses.filter(Boolean).map((e) => e.toLowerCase()));
  let reply = null;
  let bounced = false;
  for (const m of thread?.messages || []) {
    const from = headerOf(m, 'From');
    const addr = emailOf(from);
    if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(headerOf(m, 'Subject'))) { bounced = true; continue; }
    if (!addr || own.has(addr) || (m.labelIds || []).includes('SENT')) continue;
    reply = {
      from,
      snippet: (m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 280),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      messageId: m.id,
    };
  }
  return { replied: Boolean(reply), bounced: bounced && !reply, reply };
}

export const gmailThreadUrl = (threadId, account) =>
  `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}#all/${threadId}`;

/** Turns raw Google errors into actionable Russian messages. */
export function friendlyGoogleError(raw, status) {
  const m = String(raw || '');
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(m)) {
    return 'Gmail API не включён в проекте Google Cloud. Включи: APIs & Services → Library → Gmail API → Enable (подожди 1–2 минуты).';
  }
  if (/insufficient|scope|PERMISSION_DENIED/i.test(m) && status === 403) {
    return 'Нет разрешения на отправку или чтение писем. Нажми «Подключить Gmail» ещё раз и отметь все галочки в окне Google.';
  }
  if (/access_denied/i.test(m)) {
    return 'Google не пустил аккаунт. Проверь, что твой Gmail добавлен в Google Auth Platform → Audience → Test users.';
  }
  if (/popup_closed/i.test(m)) return 'Окно входа Google закрыто. Попробуй ещё раз.';
  if (/popup_failed_to_open|popup.*block/i.test(m)) return 'Браузер заблокировал окно входа Google. Разреши всплывающие окна для этого сайта.';
  if (/invalid_client|idpiframe_initialization_failed|origin/i.test(m)) {
    return 'Client ID не подходит к этому адресу сайта. В Google Auth Platform → Clients → твой клиент → Authorized JavaScript origins должен быть точный адрес сайта (https://…vercel.app без / в конце).';
  }
  return m || `Ошибка Google${status ? ` (HTTP ${status})` : ''}`;
}

// ---------- browser client ----------
export class GmailClient {
  constructor({ clientId, onChange } = {}) {
    this.clientId = clientId;
    this.onChange = onChange || (() => {});
    this.token = null;
    this.expiresAt = 0;
    this.email = '';
    this.tokenClient = null;
  }

  get connected() { return Boolean(this.token) && Date.now() < this.expiresAt - 60_000; }

  async loadGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Не удалось загрузить вход Google'));
      document.head.appendChild(s);
    });
  }

  /** Must be called from a click (opens Google's popup). */
  async connect({ hint } = {}) {
    if (!this.clientId) throw new Error('Не задан Google OAuth Client ID');
    await this.loadGis();
    const token = await new Promise((resolve, reject) => {
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: GMAIL_SCOPES,
        hint,
        callback: (resp) => (resp.error ? reject(new Error(friendlyGoogleError(`${resp.error} ${resp.error_description || ''}`))) : resolve(resp)),
        error_callback: (err) => reject(new Error(friendlyGoogleError(err?.type || err?.message || 'popup_closed'))),
      });
      this.tokenClient.requestAccessToken({ prompt: this.email ? '' : 'consent' });
    });
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(token, ...GMAIL_SCOPES.split(' '))) {
      throw new Error('Нужно разрешить и отправку, и чтение писем (галочки в окне Google)');
    }
    this.token = token.access_token;
    this.expiresAt = Date.now() + (Number(token.expires_in) || 3600) * 1000;
    const profile = await this.api('/profile');
    this.email = (profile.emailAddress || '').toLowerCase();
    this.onChange();
    return this.email;
  }

  disconnect() {
    if (this.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(this.token, () => {});
    this.token = null;
    this.expiresAt = 0;
    this.onChange();
  }

  async api(path, opts = {}) {
    if (!this.connected) throw Object.assign(new Error('Сессия Gmail истекла — нажми «Подключить Gmail»'), { code: 'auth' });
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      this.token = null;
      this.onChange();
      throw Object.assign(new Error('Сессия Gmail истекла — нажми «Подключить Gmail»'), { code: 'auth' });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const rawMsg = `${json.error?.message || ''} ${json.error?.status || ''} ${(json.error?.details || []).map((d) => d.reason || '').join(' ')}`.trim();
      const msg = friendlyGoogleError(rawMsg || `Gmail HTTP ${res.status}`, res.status);
      throw Object.assign(new Error(msg), { code: res.status === 429 || /limit|quota/i.test(msg) ? 'limit' : 'api', status: res.status });
    }
    return json;
  }

  async send({ to, cc, subject, body, threadId, inReplyTo, attachments }) {
    const raw = buildRawMessage({ to, cc, subject, body, inReplyTo, attachments });
    const res = await this.api('/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
    return { id: res.id, threadId: res.threadId };
  }

  async messageIdHeader(messageId) {
    const m = await this.api(`/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`);
    return headerOf(m, 'Message-ID');
  }

  thread(threadId) {
    return this.api(`/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage, encodeHeader, analyzeThread, emailOf, gmailThreadUrl } from '../../public/js/gmail.js';

const fromB64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('buildRawMessage produces a valid UTF-8 MIME message', () => {
  const raw = buildRawMessage({
    to: 'jobs@hotel.com', cc: 'friend@example.org', subject: 'Summer 2027 – J-1 students',
    body: 'Dear Hotel,\nWe are students from Kazakhstan — Алматы.\n', inReplyTo: '<abc@mail.gmail.com>',
  });
  assert.doesNotMatch(raw, /[+/=]/);
  const msg = fromB64Url(raw);
  const [head, bodyB64] = msg.split('\r\n\r\n');
  assert.match(head, /^To: jobs@hotel\.com\r\nCc: friend@example\.org\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(head, /In-Reply-To: <abc@mail\.gmail\.com>\r\nReferences: <abc@mail\.gmail\.com>/);
  assert.match(head, /Content-Type: text\/plain; charset="UTF-8"/);
  const subjB64 = head.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(subjB64, 'base64').toString('utf8'), 'Summer 2027 – J-1 students');
  const body = Buffer.from(bodyB64.replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'Dear Hotel,\r\nWe are students from Kazakhstan — Алматы.\r\n');
  assert.ok(bodyB64.split('\r\n').every((line) => line.length <= 76));
});

test('headers cannot be injected and ASCII subjects stay plain', () => {
  const msg = fromB64Url(buildRawMessage({ to: 'a@b.com\r\nBcc: evil@x.com', subject: 'Hi', body: 'x' }));
  assert.doesNotMatch(msg, /\r\nBcc:/);
  assert.equal(encodeHeader('Plain subject'), 'Plain subject');
});

const msg = (from, { labels = [], snippet = '', subject = 'Re: Summer jobs', id = 'm' } = {}) => ({
  id, labelIds: labels, snippet, internalDate: '1791100000000',
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] },
});

test('analyzeThread detects employer replies, ignores own and partner messages', () => {
  const own = ['me@gmail.com', 'friend@example.org'];
  assert.deepEqual(analyzeThread({ messages: [msg('Me <me@gmail.com>', { labels: ['SENT'] })] }, own), { replied: false, bounced: false, reply: null });
  assert.equal(analyzeThread({ messages: [msg('Me <me@gmail.com>', { labels: ['SENT'] }), msg('Friend <friend@example.org>')] }, own).replied, false);
  const r = analyzeThread({ messages: [msg('me@gmail.com', { labels: ['SENT'] }), msg('Kate HR <kate@hotel.com>', { snippet: 'Hi! We&#39;d love to talk', id: 'r1' })] }, own);
  assert.equal(r.replied, true);
  assert.equal(r.reply.snippet, "Hi! We'd love to talk");
  assert.equal(r.reply.messageId, 'r1');
  assert.equal(emailOf('Kate HR <Kate@Hotel.com>'), 'kate@hotel.com');
});

test('analyzeThread detects bounces', () => {
  const b = analyzeThread({ messages: [msg('me@gmail.com', { labels: ['SENT'] }), msg('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', { subject: 'Delivery Status Notification (Failure)' })] }, ['me@gmail.com']);
  assert.deepEqual([b.replied, b.bounced], [false, true]);
  assert.match(gmailThreadUrl('18c2f', 'me@gmail.com'), /authuser=me%40gmail\.com#all\/18c2f$/);
});

test('buildRawMessage attaches files as multipart/mixed', () => {
  const pdf = Buffer.from('%PDF-1.4 test resume').toString('base64');
  const msg = fromB64Url(buildRawMessage({
    to: 'jobs@hotel.com', subject: 'Hi', body: 'See attached',
    attachments: [{ filename: 'Resume_A.pdf', mimeType: 'application/pdf', data: pdf }, { filename: 'Resume_B.pdf', mimeType: 'application/pdf', data: pdf }],
  }));
  const boundary = msg.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/)[1];
  const parts = msg.split(`--${boundary}`);
  assert.equal(parts.length, 5); // preamble, text, 2 files, closing
  assert.match(parts[1], /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(parts[2], /Content-Disposition: attachment; filename="Resume_A\.pdf"/);
  assert.equal(Buffer.from(parts[3].split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString(), '%PDF-1.4 test resume');
  assert.match(parts[4], /^--\s*$/);
});

test('friendly Google error messages', async () => {
  const { friendlyGoogleError } = await import('../../public/js/gmail.js');
  assert.match(friendlyGoogleError('Gmail API has not been used in project 123 before or it is disabled.', 403), /Gmail API не включён/);
  assert.match(friendlyGoogleError('access_denied'), /Test users/);
  assert.match(friendlyGoogleError('popup_failed_to_open'), /всплывающие окна/);
  assert.match(friendlyGoogleError('Request had insufficient authentication scopes. PERMISSION_DENIED', 403), /галочки/);
  assert.equal(friendlyGoogleError('Something else', 500), 'Something else');
});

test('From header uses the profile name; bounce reports are parsed', async () => {
  const { formatAddress, bounceRecipients, isBounceMessage } = await import('../../public/js/gmail.js');
  const msg = fromB64Url(buildRawMessage({ from: { name: 'Nurassyl Example', email: 'me@gmail.com' }, to: 'a@b.com', subject: 'Hi', body: 'x' }));
  assert.match(msg, /^From: "Nurassyl Example" <me@gmail\.com>\r\nTo: a@b\.com/);
  assert.match(formatAddress('Алия', 'x@y.com'), /^=\?UTF-8\?B\?.+\?= <x@y\.com>$/);

  const o365 = { id: 'n1', snippet: "Your message to cx_test@hotel-inn.com couldn&#39;t be delivered. cx_test wasn&#39;t found at hotel-inn.com. me Office 365 cx_test Action Required Recipient",
    payload: { headers: [{ name: 'From', value: 'postmaster@hotelgroup.com' }, { name: 'Subject', value: 'Undeliverable: Summer 2027 Seasonal Jobs' }] } };
  assert.equal(isBounceMessage(o365), true);
  assert.deepEqual(bounceRecipients(o365, ['me@gmail.com']), ['cx_test@hotel-inn.com']);
  const gmailNdr = { id: 'n2', snippet: "Address not found Your message wasn't delivered to jobs@old-motel.com because the address couldn't be found",
    payload: { headers: [{ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, { name: 'X-Failed-Recipients', value: 'jobs@old-motel.com' }] } };
  assert.deepEqual(bounceRecipients(gmailNdr, ['me@gmail.com']), ['jobs@old-motel.com']);
  assert.equal(isBounceMessage({ payload: { headers: [{ name: 'From', value: 'Kate <kate@hotel.com>' }, { name: 'Subject', value: 'Re: jobs' }] } }), false);
});

test('applyBounce: next address goes back to the queue, last address marks bounced', async () => {
  const { applyBounce } = await import('../../public/js/store.js');
  const lead = { emails: ['cx_old@inn.com', 'info@inn.com'], status: 'emailed', gmail: { threadId: 't1' } };
  assert.equal(applyBounce(lead, 'CX_old@inn.com'), true);
  assert.deepEqual([lead.emails, lead.badEmails, lead.status, lead.gmail], [['info@inn.com'], ['cx_old@inn.com'], 'new', null]);
  assert.equal(applyBounce(lead, 'cx_old@inn.com'), false);
  lead.status = 'emailed';
  applyBounce(lead, 'info@inn.com');
  assert.equal(lead.status, 'bounced');
  const replied = { emails: ['a@x.com'], status: 'replied', reply: { from: 'x' } };
  applyBounce(replied, 'a@x.com');
  assert.equal(replied.status, 'replied');
});

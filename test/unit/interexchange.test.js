import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../tools/interexchange-collector.js');
const IX = globalThis.__IX;

const POSITIONS = ['Attractions Attendant', 'Barista', 'Bartender', 'Housekeeper', 'Lifeguard', 'Server', 'Server Assistant'];

test('labelled card: wage, hours, housing, dates, location, tipped, openings', () => {
  const r = IX.parseListing([
    'Ocean Breeze Hotel', 'Housekeeper', 'Ocean City, MD',
    'Wage per hour', '$15.50', 'Average Hours per week', '32-40',
    'Housing Provided', 'Housing cost: $150 / week',
    'Preferred Work Dates', 'May 20, 2027 - September 10, 2027',
    'Tipped?', 'No', 'Employer Positions Available: 6', 'Interviews: Skype / Zoom',
  ].join('\n'), { positions: POSITIONS });
  assert.equal(r.position, 'Housekeeper');
  assert.deepEqual([r.city, r.state], ['Ocean City', 'MD']);
  assert.deepEqual([r.wage, r.hours, r.hoursMax, r.weekly], [15.5, 32, 40, 496]);
  assert.equal(r.housing, 'provided');
  assert.match(r.housingCost, /\$150/);
  assert.deepEqual([r.start, r.end], ['2027-05-20', '2027-09-10']);
  assert.equal(r.tipped, false);
  assert.equal(r.openings, 6);
  assert.equal(r.interviews, 'Skype / Zoom');
});

test('wage is not taken from housing cost or deposit', () => {
  assert.equal(IX.parseWage(IX.toLines('Housing: $125/week\nDeposit $50\nPay: $16.00/hr, 40 hrs per week')).wage, 16);
  assert.equal(IX.parseWage(IX.toLines('Rent $95 per week')).wage, null);
  assert.deepEqual(IX.parseWage(IX.toLines('Wage: 15.00 - 17.00 USD')), { wage: 15, wageMax: 17 });
});

test('hours ignore "$15 per hour"', () => {
  assert.equal(IX.parseHours(IX.toLines('$15 per hour\n35 hours/week')).hours, 35);
  assert.equal(IX.parseHours(IX.toLines('40+ hrs')).hours, 40);
  assert.equal(IX.parseHours(IX.toLines('$15 per hour')).hours, null);
});

test('housing flags', () => {
  const h = (t) => IX.parseHousing(IX.toLines(t)).housing;
  assert.equal(h('Housing Assistance'), 'assistance');
  assert.equal(h('Housing: Provided'), 'provided');
  assert.equal(h('Housing Provided: No\nHousing Assistance: Yes'), 'assistance');
  assert.equal(h('Housing Provided: No\nHousing Assistance: No'), 'none');
  assert.equal(h('Barista, great team'), '');
});

test('dates in several formats; posted dates ignored', () => {
  assert.deepEqual(IX.findDates('06/01/2027 to 9/5/27'), ['2027-06-01', '2027-09-05']);
  assert.deepEqual(IX.findDates('1st June 2027'), ['2027-06-01']);
  assert.deepEqual(IX.parseDates(IX.toLines('Posted Oct 1, 2026\nStart: 2027-06-15\nEnd: 2027-09-01')), { start: '2027-06-15', end: '2027-09-01' });
});

test('location by state name, longest position wins', () => {
  assert.deepEqual(IX.parseLocation(IX.toLines('Wisconsin Dells, Wisconsin')), { city: 'Wisconsin Dells', state: 'WI' });
  assert.deepEqual(IX.parseLocation(IX.toLines('City: Seward, AK')), { city: 'Seward', state: 'AK' });
  assert.equal(IX.parseListing('Server Assistant\nBar Harbor, ME', { positions: POSITIONS }).position, 'Server Assistant');
});

test('InterExchange card: wage, tips, hours, rent, overtime, badges, location, dates, 21+', () => {
  const r = IX.normalizeIx({
    id: '37ed9e45', position: ' Housekeeping ', profileUrl: 'https://app.example/wt/employers/9/enrollment_profiles/1',
    fields: {
      'Host Employer': 'Hillside Inn', 'Type of Business': 'Motel', Location: 'HAMPTON, NH\nNew England',
      'Last Visited': 'Nov 22 2026', 'Preferred Finish Dates': 'Sep 15 2027 - Sep 30 2027',
    },
    badges: ['Tipped', 'Maybe Overtime', 'Housing Provided'],
    leftLines: ['4 Positions', 'TippedMaybe OvertimeHousing Provided'],
    rightLines: ['$15.00 + tips /hour', '35 hours /week', '$140.00 rent /week', 'Overtime Wage', '$22.50 /hour', 'Preferred Finish Dates', 'Sep 15 2027 - Sep 30 2027'],
    bodyLines: ['4 Positions', 'Position Description', 'Must be 21 years old by your arrival date to apply.'],
    section: 'Job Listings',
  });
  assert.deepEqual([r.key, r.position, r.employer, r.business], ['37ed9e45', 'Housekeeping', 'Hillside Inn', 'Motel']);
  assert.deepEqual([r.city, r.state, r.region], ['Hampton', 'NH', 'New England']);
  assert.deepEqual([r.wage, r.tipped, r.hours, r.weekly, r.rent, r.net, r.overtimeWage], [15, true, 35, 525, 140, 385, 22.5]);
  assert.deepEqual([r.housing, r.overtime, r.openings, r.age21, r.interviews], ['provided', 'maybe', 4, true, false]);
  assert.deepEqual([r.finishFrom, r.finishTo, r.lastVisited], ['2027-09-15', '2027-09-30', '2026-11-22']);
});

test('InterExchange card: no housing badge = none; interview section; tips sometimes', () => {
  const r = IX.normalizeIx({
    id: 'x', position: 'Lifeguard', fields: { Location: 'Eureka, MO\nMidwest' }, badges: [],
    leftLines: ['1 Position'], rightLines: ['$17.35 /hour', 'tips are sometimes received', '31 hours /week'],
    section: 'Interviews Available', interviewOn: 'Dec 02',
  });
  assert.deepEqual([r.housing, r.tipped, r.tipsSometimes, r.openings, r.interviews, r.interviewOn, r.rent, r.net], ['none', false, true, 1, true, 'Dec 02', null, null]);
  assert.equal(r.weekly, 538);
});

test('host profile: start/finish windows, rent, roommates, transport; merge keeps card rent', () => {
  const p = IX.normalizeProfile({
    fields: {
      Start: 'May 15 2027 - Jun 30 2027', Finish: 'Aug 31 2027 - Sep 30 2027', 'Housing Type': 'Provided', Rent: '$165.00/week',
      'Housing Deposit': '$165.00', 'Number of people sharing a bedroom': '4', 'Estimated Transportation Cost': '$30.00/week',
      'Drug Testing Requirements': 'No',
    },
    address: ' 1 Main St, Cape May, NJ ',
  });
  assert.deepEqual([p.startFrom, p.startTo, p.finishFrom, p.finishTo], ['2027-05-15', '2027-06-30', '2027-08-31', '2027-09-30']);
  assert.deepEqual([p.rent, p.deposit, p.shareBedroom, p.transportCost, p.drugTest, p.address], [165, 165, 4, 30, 'No', '1 Main St, Cape May, NJ']);
  assert.equal(IX.normalizeProfile({ fields: { Rent: '$600/month' } }).rent, 139);

  const card = { weekly: 500, rent: null, finishFrom: '2027-09-01', finishTo: '2027-09-20' };
  IX.mergeProfile(card, p);
  assert.deepEqual([card.rent, card.net, card.startFrom, card.finishFrom, card.profile], [165, 335, '2027-05-15', '2027-09-01', true]);
  const withRent = IX.mergeProfile({ weekly: 500, rent: 140 }, p);
  assert.deepEqual([withRent.rent, withRent.net], [140, 360]);
});

test('CSV uses ; and a BOM for Excel, escapes quotes', () => {
  const csv = IX.toCsv([{ employer: 'Joe "Crab" Shack; Inc', position: 'Server', housing: 'provided', tipped: true, wage: 15, overtime: 'maybe' }]);
  assert.ok(csv.startsWith('﻿Работодатель;Должность;'));
  const row = csv.split('\r\n')[1].split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  assert.equal(row[0], '"Joe ""Crab"" Shack; Inc"');
  assert.deepEqual([row[1], row[6], row[7], row[12], row[20]], ['Server', '15', 'да', 'предоставляется', 'возможно']);
});

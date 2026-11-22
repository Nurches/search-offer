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

test('CSV uses ; and a BOM for Excel, escapes quotes', () => {
  const csv = IX.toCsv([{ employer: 'Joe "Crab" Shack; Inc', position: 'Server', housing: 'provided', tipped: true, wage: 15 }]);
  assert.ok(csv.startsWith('﻿Работодатель;'));
  assert.match(csv, /"Joe ""Crab"" Shack; Inc";Server;;;15;;;предоставляется;;да/);
});

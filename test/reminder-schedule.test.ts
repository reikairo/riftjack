import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReminder, validSchedule, type CalendarSchedule } from '../src/reminder-schedule.js';

const daily: CalendarSchedule = { frequency: 'daily', time: '09:00', timezone: 'Europe/London' };
const next = (schedule: CalendarSchedule, after: string) => new Date(nextReminder(schedule, Date.parse(after))).toISOString();

test('calendar schedules preserve local time across midnight and DST changes', () => {
  assert.equal(next(daily, '2026-03-28T10:00:00Z'), '2026-03-29T08:00:00.000Z');
  assert.equal(next(daily, '2026-10-24T10:00:00Z'), '2026-10-25T09:00:00.000Z');
  assert.equal(next({ ...daily, timezone: 'Asia/Kathmandu' }, '2026-01-01T03:15:00Z'), '2026-01-02T03:15:00.000Z');
  assert.equal(next({ ...daily, frequency: 'weekly', weekday: 1 }, '2026-01-05T09:00:00Z'), '2026-01-12T09:00:00.000Z');
});

test('nonexistent DST times are skipped and ambiguous times run only once', () => {
  const schedule = { ...daily, time: '01:30' };
  assert.equal(next(schedule, '2026-03-28T02:00:00Z'), '2026-03-30T00:30:00.000Z');
  assert.equal(next(schedule, '2026-10-25T00:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(next(schedule, '2026-10-25T00:45:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(next({ ...schedule, frequency: 'weekly', weekday: 7 }, '2026-03-22T02:00:00Z'), '2026-04-05T00:30:00.000Z');
});

test('schedule validation rejects malformed times, timezones and weekday combinations', () => {
  assert.ok(validSchedule(daily));
  for (const schedule of [null, [], { ...daily, frequency: 'monthly' }, { ...daily, time: '24:00' },
    { ...daily, time: '9:00' }, { ...daily, timezone: 'Not/AZone' }, { ...daily, weekday: 1 },
    { ...daily, frequency: 'weekly' }, { ...daily, frequency: 'weekly', weekday: 0 }, { ...daily, extra: true }]) {
    assert.equal(validSchedule(schedule), false);
  }
});

test('interval series are anchored, finite counts include the first, and elapsed slots are skipped', () => {
  const s = { frequency: 'interval' as const, interval_minutes: 10, count: 3, start_at: '2026-10-27T10:00:00Z' };
  assert.equal(nextReminder(s, Date.parse('2026-10-27T09:59:00Z')), Date.parse(s.start_at));
  assert.equal(nextReminder(s, Date.parse('2026-10-27T10:09:00Z')), Date.parse('2026-10-27T10:10:00Z'));
  assert.equal(nextReminder(s, Date.parse('2026-10-27T10:19:59Z')), Date.parse('2026-10-27T10:20:00Z'));
  assert.equal(nextReminder(s, Date.parse('2026-10-27T10:20:00Z')), null);
  assert.equal(nextReminder({ ...s, count: undefined }, Date.parse('2026-10-27T11:22:00Z')), Date.parse('2026-10-27T11:30:00Z'));
});

test('calendar series respect weekdays, exclusive ends and daily count reset', () => {
  const s: CalendarSchedule = { frequency: 'daily', time: '10:00', timezone: 'UTC', weekdays: [1,2,3,4,5], interval_minutes: 15, end_time: '12:00' };
  assert.equal(next(s, '2026-10-30T11:44:00Z'), '2026-10-30T11:45:00.000Z');
  assert.equal(next(s, '2026-10-30T11:45:00Z'), '2026-11-02T10:00:00.000Z');
  assert.equal(next({ ...s, end_time: undefined, count: 2 }, '2026-10-27T10:15:00Z'), '2026-10-28T10:00:00.000Z');
});

test('calendar interval slots skip DST gaps without extending count and do not repeat the folded hour', () => {
  const s: CalendarSchedule = { frequency: 'daily', time: '01:00', timezone: 'Europe/London', interval_minutes: 30, count: 3 };
  assert.equal(next(s, '2026-03-29T00:00:00Z'), '2026-03-29T01:00:00.000Z'); // only 02:00 exists
  assert.equal(next(s, '2026-03-29T01:00:00Z'), '2026-03-30T00:00:00.000Z');
  assert.equal(next(s, '2026-10-25T00:30:00Z'), '2026-10-25T02:00:00.000Z');
});

test('series validation rejects ambiguous rules and unbounded daily windows', () => {
  const interval = { frequency: 'interval', interval_minutes: 10 };
  const calendar = { frequency: 'daily', time: '10:00', timezone: 'UTC', interval_minutes: 10, count: 6 };
  for (const s of [interval, { ...interval, count: 6 }, calendar, { ...calendar, weekdays: [1, 3] }]) assert.ok(validSchedule(s));
  for (const s of [{ ...interval, interval_minutes: 0 }, { ...interval, count: 0 }, { ...interval, count: 1.5 },
    { ...interval, timezone: 'UTC' }, { ...interval, start_at: '2026-10-27T10:00' },
    { ...calendar, count: undefined }, { ...calendar, end_time: '12:00' },
    { ...calendar, count: undefined, end_time: '09:00' }, { ...calendar, time: '23:30' },
    { ...calendar, weekdays: [] }, { ...calendar, weekdays: [1,1] }, { ...calendar, weekdays: [0] },
    { ...calendar, interval_minutes: undefined }, { ...calendar, frequency: 'weekly', weekday: 1, weekdays: [1] }]) {
    assert.equal(validSchedule(s), false, JSON.stringify(s));
  }
});

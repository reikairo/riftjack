export type CalendarSchedule = { frequency: 'daily' | 'weekly'; time: string; timezone: string; weekday?: number;
  weekdays?: number[]; interval_minutes?: number; count?: number; end_time?: string };
export type IntervalSchedule = { frequency: 'interval'; interval_minutes: number; start_at?: string; count?: number };
export type ReminderSchedule = CalendarSchedule | IntervalSchedule;
const time = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const integer = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
export const validStart = (v: unknown): v is string => typeof v === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));

export function validSchedule(value: unknown): value is ReminderSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as ReminderSchedule;
  if (s.frequency === 'interval') return !Object.keys(s).some(k => !['frequency', 'interval_minutes', 'start_at', 'count'].includes(k)) &&
    integer(s.interval_minutes, 86400) && (s.count === undefined || integer(s.count, 10000)) && (s.start_at === undefined || validStart(s.start_at));
  if (Object.keys(s).some(k => !['frequency', 'time', 'timezone', 'weekday', 'weekdays', 'interval_minutes', 'count', 'end_time'].includes(k)) ||
    !['daily', 'weekly'].includes(s.frequency) || !time(s.time) || typeof s.timezone !== 'string' || s.timezone.length > 100 ||
    (s.frequency === 'daily' ? s.weekday !== undefined : !integer(s.weekday, 7) || s.weekdays !== undefined) ||
    (s.weekdays !== undefined && (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.length > 7 ||
      new Set(s.weekdays).size !== s.weekdays.length || !s.weekdays.every(d => integer(d, 7))))) return false;
  if (s.interval_minutes === undefined) {
    if (s.count !== undefined || s.end_time !== undefined) return false;
  } else if (!integer(s.interval_minutes, 1440) || (s.count === undefined) === (s.end_time === undefined) ||
    (s.count !== undefined && (!integer(s.count, 1440) || minutes(s.time) + (s.count - 1) * s.interval_minutes >= 1440)) ||
    (s.end_time !== undefined && (!time(s.end_time) || minutes(s.end_time) <= minutes(s.time)))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); return true; } catch { return false; }
}
function wallClock(timezone: string) {
  const format = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return (stamp: number) => {
    const parts = Object.fromEntries(format.formatToParts(stamp).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  };
}
const dayStart = (stamp: number) => Math.floor(stamp / 86_400_000) * 86_400_000;
const endMinute = (s: CalendarSchedule) => s.end_time ? minutes(s.end_time) : Math.min(1440, minutes(s.time) + s.count! * s.interval_minutes!);

// Interval series use a persisted UTC anchor. Calendar series use wall time:
// gaps are skipped, ambiguous times use only their first occurrence.
export function nextReminder(schedule: CalendarSchedule, after: number): number;
export function nextReminder(schedule: ReminderSchedule, after: number): number | null;
export function nextReminder(schedule: ReminderSchedule, after: number): number | null {
  if (schedule.frequency === 'interval') {
    if (!validStart(schedule.start_at)) throw new Error('Interval schedule needs a persisted start_at.');
    const start = Date.parse(schedule.start_at), step = schedule.interval_minutes * 60_000;
    const index = Math.max(0, Math.floor((after - start) / step) + 1);
    return schedule.count !== undefined && index >= schedule.count ? null : start + index * step;
  }
  const wall = wallClock(schedule.timezone), midnight = dayStart(wall(after));
  const start = minutes(schedule.time), step = schedule.interval_minutes ?? 1440;
  const end = schedule.interval_minutes ? endMinute(schedule) : start + 1;
  for (let day = 0; day < 15; day++) {
    const date = midnight + day * 86_400_000, weekday = new Date(date).getUTCDay() || 7;
    if (schedule.frequency === 'weekly' ? weekday !== schedule.weekday : schedule.weekdays && !schedule.weekdays.includes(weekday)) continue;
    const probeTime = date + start * 60_000;
    const offsets = new Set([-1, 0, 1].map(d => { const probe = probeTime + d * 86_400_000; return wall(probe) - probe; }));
    for (let minute = start; minute < end; minute += step) {
      const wanted = date + minute * 60_000;
      const candidates = [...offsets].map(offset => wanted - offset).filter(stamp => wall(stamp) === wanted).sort((a, b) => a - b);
      if (candidates.length && candidates[0] > after) return candidates[0];
    }
  }
  throw new Error('Could not find the next reminder occurrence.');
}

export function occurrenceInWindow(schedule: ReminderSchedule, due: number, now: number): boolean {
  if (schedule.frequency === 'interval') return schedule.count === undefined ||
    now < Date.parse(schedule.start_at!) + schedule.count * schedule.interval_minutes * 60_000;
  if (!schedule.interval_minutes) return true; // Preserve legacy late daily/weekly reminders.
  const wall = wallClock(schedule.timezone), current = wall(now), date = dayStart(wall(due));
  return dayStart(current) === date && current < date + endMinute(schedule) * 60_000;
}
export function remainingOccurrences(schedule: ReminderSchedule, due: number, exhausted = false): number | undefined {
  if (schedule.frequency === 'interval') return schedule.count === undefined ? undefined : exhausted ? 0 :
    Math.max(0, schedule.count - Math.round((due - Date.parse(schedule.start_at!)) / (schedule.interval_minutes * 60_000)));
  if (!schedule.interval_minutes) return undefined;
  const current = wallClock(schedule.timezone)(due);
  return Math.max(0, Math.ceil((endMinute(schedule) - (current - dayStart(current)) / 60_000) / schedule.interval_minutes));
}
export function scheduleDescription(s: ReminderSchedule): string {
  if (s.frequency === 'interval') return `every ${s.interval_minutes} minutes, from ${s.start_at}${s.count ? `, ${s.count} scheduled occurrences` : ''}`;
  return `${s.frequency}, ${s.time} (${s.timezone})` + (s.frequency === 'weekly' ? `, ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][s.weekday! - 1]}` : s.weekdays ? `, weekdays ${s.weekdays.join(',')}` : '') +
    (s.interval_minutes ? `, every ${s.interval_minutes} minutes` + (s.count ? `, ${s.count} per series` : `, until ${s.end_time} (exclusive)`) : '');
}

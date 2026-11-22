// A queue describes one review pass. Its independent units are fixed before
// the first turn, so a stopped unit cannot generate follow-up work.
export type ReviewUnit = { file: string; start_line?: number; end_line?: number };
export type AstraReview = { units: ReviewUnit[]; cursor: number; skipped: number[] };

type Fields = Record<string, unknown>;
const fields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const line = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

export function validUnits(value: unknown): value is ReviewUnit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return false;
  const seen = new Map<string, ReviewUnit[]>();
  for (const unit of value) {
    if (!fields(unit) || Object.keys(unit).some(k => !['file', 'start_line', 'end_line'].includes(k)) ||
        typeof unit.file !== 'string' || !unit.file.trim() || unit.file.length > 512 || /[\\\x00-\x1f]/.test(unit.file) ||
        unit.file.split('/').some(part => !part || part === '.' || part === '..')) return false;
    const { file, start_line, end_line } = unit;
    if (start_line !== undefined || end_line !== undefined) {
      if (!line(start_line) || !line(end_line) || start_line > end_line) return false;
    }
    const prior = seen.get(file) ?? [];
    const item = unit as ReviewUnit;
    if (prior.some(p => (p.start_line ?? 1) <= (item.end_line ?? Infinity) &&
      (item.start_line ?? 1) <= (p.end_line ?? Infinity))) return false;
    prior.push(item);
    seen.set(file, prior);
  }
  return true;
}

export function validReview(value: unknown): value is AstraReview {
  if (!fields(value) || !validUnits(value.units) || typeof value.cursor !== 'number' ||
      !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor > value.units.length ||
      !Array.isArray(value.skipped)) return false;
  const cursor = value.cursor;
  return value.skipped.every((n, i, list) => Number.isInteger(n) && n >= 0 && n < cursor && (!i || n > list[i - 1]));
}

export function reviewStatus(review: AstraReview, pass: string) {
  return { pass, processed: review.cursor, total: review.units.length, next: review.units[review.cursor] ?? null,
    notes: review.skipped.map(i => ({ ...review.units[i], reason: 'cyberPolicy', status: 'skipped' })) };
}

export function reviewMessage(review: AstraReview) {
  const previousSkipped = review.skipped.at(-1) === review.cursor - 1;
  return (previousSkipped ? 'The previous unit was skipped by policy. Riftjack saved its location: ' + JSON.stringify(review.units[review.cursor - 1]) +
    '. Заведи про это заметку и продолжи без глубокого анализа этой проблемы. Leave the skipped problem closed.\n' : '') +
    'Review only this independent unit in the current pass: ' + JSON.stringify(review.units[review.cursor]);
}

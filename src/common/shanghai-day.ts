/** Asia/Shanghai fixed offset (no DST). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ShanghaiDayBounds = {
  /** Calendar day as UTC midnight (date-only key for DailyStatistics.date). */
  dateKey: Date;
  /** Inclusive start of the Shanghai natural day (absolute instant). */
  start: Date;
  /** Exclusive end of the Shanghai natural day (absolute instant). */
  end: Date;
};

/**
 * Resolve Asia/Shanghai calendar day bounds for a given instant.
 * dateKey is stored as UTC midnight of Y-M-D; query window is [start, end).
 */
export function getShanghaiDayBounds(date: Date = new Date()): ShanghaiDayBounds {
  const shanghaiNow = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const y = shanghaiNow.getUTCFullYear();
  const m = shanghaiNow.getUTCMonth();
  const d = shanghaiNow.getUTCDate();

  const dateKey = new Date(Date.UTC(y, m, d));
  const start = new Date(dateKey.getTime() - SHANGHAI_OFFSET_MS);
  const end = new Date(start.getTime() + DAY_MS);

  return { dateKey, start, end };
}

/** Shift a date-only key by N Shanghai calendar days. */
export function addShanghaiCalendarDays(dateKey: Date, days: number): Date {
  return new Date(dateKey.getTime() + days * DAY_MS);
}

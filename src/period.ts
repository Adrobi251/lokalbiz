import { Temporal } from '@js-temporal/polyfill';
import { ApiError } from './errors.js';

export interface PeriodBounds {
  startDate?: string;
  endDate?: string;
  startAt?: string;
  endAt?: string;
}

export function periodBounds(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
  requireBoth = false,
): PeriodBounds {
  if (requireBoth && (!from || !to)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from dan to wajib diisi dengan format YYYY-MM-DD.');
  }

  const startAt = from ? localMidnight(from, timeZone) : undefined;
  const endAt = to ? localMidnight(to, timeZone) : undefined;
  if (from && to && startAt! >= endAt!) {
    throw new ApiError(422, 'INVALID_DATE_RANGE', 'to harus lebih besar dari from.');
  }

  return { startDate: from, endDate: to, startAt, endAt };
}

function localMidnight(dateText: string, timeZone: string): string {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error('Invalid date format');
    const instant = Temporal.PlainDate.from(dateText).toZonedDateTime(timeZone).toInstant();
    return new Date(instant.epochMilliseconds).toISOString();
  } catch {
    throw new ApiError(422, 'INVALID_DATE', 'Tanggal harus valid dengan format YYYY-MM-DD.');
  }
}

export function subtractDays(instant: string, days: number): string {
  const result = Temporal.Instant.from(instant).subtract({ hours: days * 24 });
  return new Date(result.epochMilliseconds).toISOString();
}

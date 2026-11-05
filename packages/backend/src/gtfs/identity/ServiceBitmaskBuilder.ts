import type { ServiceBitmask } from "@pt/shared";
import type { GtfsService, GtfsCalendarDate } from "../parser.js";

export interface BuildServiceBitmasksInput {
  services: GtfsService[];
  exceptions: GtfsCalendarDate[];
  /** Day 0 of the output bitmap, ISO YYYY-MM-DD. */
  startDateIso: string;
  /** Number of days in the bitmap (spec default 90). */
  horizonDays: number;
}

const GTFS_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseGtfsDate(yyyymmdd: string): Date {
  const m = GTFS_DATE_RE.exec(yyyymmdd);
  if (!m) throw new Error(`ServiceBitmaskBuilder: malformed GTFS date ${JSON.stringify(yyyymmdd)}`);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

function parseIsoDate(iso: string): Date {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new Error(`ServiceBitmaskBuilder: malformed ISO date ${JSON.stringify(iso)}`);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayOffset(anchor: Date, target: Date): number {
  return Math.round((target.getTime() - anchor.getTime()) / DAY_MS);
}

/** 0 = Monday, 6 = Sunday (UTC). */
function dowMonFirst(d: Date): number {
  const js = d.getUTCDay();
  return (js + 6) % 7;
}

function setBit(bits: Uint8Array, d: number): void {
  bits[d >> 3]! |= (1 << (d & 7));
}

function clearBit(bits: Uint8Array, d: number): void {
  bits[d >> 3]! &= ~(1 << (d & 7));
}

export function buildServiceBitmasks(input: BuildServiceBitmasksInput): Map<string, ServiceBitmask> {
  const { services, exceptions, startDateIso, horizonDays } = input;
  if (horizonDays <= 0) {
    throw new Error(`buildServiceBitmasks: horizonDays must be positive, got ${horizonDays}`);
  }
  const anchor = parseIsoDate(startDateIso);
  const byteLen = Math.ceil(horizonDays / 8);
  const out = new Map<string, ServiceBitmask>();

  function bitmapFor(serviceId: string): Uint8Array {
    let m = out.get(serviceId);
    if (!m) {
      m = {
        startDateIso,
        horizonDays,
        bits: new Uint8Array(byteLen),
      };
      out.set(serviceId, m);
    }
    return m.bits;
  }

  for (const svcRow of services) {
    const bits = bitmapFor(svcRow.serviceId);
    const start = parseGtfsDate(svcRow.startDate);
    const end = parseGtfsDate(svcRow.endDate);
    const dowFlags = [
      svcRow.monday, svcRow.tuesday, svcRow.wednesday, svcRow.thursday,
      svcRow.friday, svcRow.saturday, svcRow.sunday,
    ];
    const firstDayOffset = Math.max(0, dayOffset(anchor, start));
    const lastDayOffsetInclusive = Math.min(horizonDays - 1, dayOffset(anchor, end));
    for (let d = firstDayOffset; d <= lastDayOffsetInclusive; d++) {
      const date = new Date(anchor.getTime() + d * DAY_MS);
      const dow = dowMonFirst(date);
      if (dowFlags[dow]) setBit(bits, d);
    }
  }

  for (const ex of exceptions) {
    const bits = bitmapFor(ex.serviceId);
    const target = parseGtfsDate(ex.date);
    const d = dayOffset(anchor, target);
    if (d < 0 || d >= horizonDays) continue;
    if (ex.exceptionType === 1) setBit(bits, d);
    else if (ex.exceptionType === 2) clearBit(bits, d);
  }

  return out;
}

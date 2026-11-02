/**
 * Utilidades de fechas. Las fechas "solo día" se manejan como strings
 * 'YYYY-MM-DD' para no sufrir corrimientos por zona horaria.
 * process.env.TZ = America/Bogota (ver config/env.ts).
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return toDateStr(new Date());
}

export function parseDateStr(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isDateStr(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(parseDateStr(s).getTime());
}

export function addDays(s: string, days: number): string {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** Igual que DateTime.AddMonths de .NET: si el día no existe se ajusta al último día del mes. */
export function addMonths(s: string, months: number): string {
  const d = parseDateStr(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toDateStr(d);
}

export function addYears(s: string, years: number): string {
  return addMonths(s, years * 12);
}

/** Diferencia en días calendario (b - a). */
export function diffDays(a: string, b: string): number {
  const ms = parseDateStr(b).getTime() - parseDateStr(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function startOfDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function startOfMonth(year: number, month: number): Date {
  return new Date(year, month - 1, 1);
}

export function addDaysDate(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function addMonthsDate(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

/** 'YYYY-MM-DDTHH:mm:ss' en hora local (mismo formato que devolvía la API .NET). */
export function toLocalIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${toDateStr(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
export const nombreMes = (mes: number) => MESES[mes - 1] ?? 'Desconocido';

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const nombreDia = (s: string) => DIAS[parseDateStr(s).getDay()];

export function formatDMY(s: string): string {
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

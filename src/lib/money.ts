/** Redondeo a 2 decimales para evitar arrastrar errores de coma flotante. */
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const sum = <T>(items: T[], pick: (x: T) => number) => r2(items.reduce((acc, x) => acc + (pick(x) || 0), 0));

export const cop = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

interface Mov {
  tipo: string;
  monto: number;
  metodoPago: string | null;
  categoria?: string | null;
}

const ING_CATEGORIAS_BASE = ['membresia', 'renovacion', 'producto', 'abono_deuda'];

/** Totales que se repetían en todos los controladores de caja del sistema original. */
export function totalesMovimientos<T extends Mov>(movs: T[]) {
  const ing = movs.filter((m) => m.tipo === 'ingreso');
  const egr = movs.filter((m) => m.tipo === 'egreso');
  const ingEf = sum(ing.filter((m) => m.metodoPago === 'efectivo'), (m) => m.monto);
  const egrEf = sum(egr.filter((m) => m.metodoPago === 'efectivo'), (m) => m.monto);
  const ingTr = sum(ing.filter((m) => m.metodoPago === 'transferencia'), (m) => m.monto);
  const egrTr = sum(egr.filter((m) => m.metodoPago === 'transferencia'), (m) => m.monto);
  const totalIngresos = sum(ing, (m) => m.monto);
  const totalEgresos = sum(egr, (m) => m.monto);
  return {
    totalIngresos,
    totalEgresos,
    balance: r2(totalIngresos - totalEgresos),
    efectivo: { ingresos: ingEf, egresos: egrEf, balance: r2(ingEf - egrEf) },
    transferencia: { ingresos: ingTr, egresos: egrTr, balance: r2(ingTr - egrTr) },
    categorias: {
      membresias: sum(ing.filter((m) => m.categoria === 'membresia' || m.categoria === 'renovacion'), (m) => m.monto),
      productos: sum(ing.filter((m) => m.categoria === 'producto'), (m) => m.monto),
      abonos: sum(ing.filter((m) => m.categoria === 'abono_deuda'), (m) => m.monto),
      otros: sum(ing.filter((m) => !ING_CATEGORIAS_BASE.includes(m.categoria ?? '')), (m) => m.monto),
    },
  };
}

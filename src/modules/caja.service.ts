import { db, type Db } from '../db/index.js';
import { addDays, formatDMY, parseDateStr, startOfDay, toDateStr, today } from '../lib/dates.js';
import { badRequest } from '../lib/http.js';
import { cop, r2, totalesMovimientos } from '../lib/money.js';

// ───────────────────────────── CAJA FUERTE ─────────────────────────────

export async function obtenerCajaFuerte(trx: Db = db) {
  let cf = await trx.selectFrom('cajaFuerte').selectAll().orderBy('createdAt').executeTakeFirst();
  if (!cf) cf = await trx.insertInto('cajaFuerte').defaultValues().returningAll().executeTakeFirstOrThrow();
  return cf;
}

/** Aplica un delta a los balances de la caja fuerte (positivo = entra dinero). */
export async function ajustarBalance(trx: Db, metodo: string, delta: number) {
  const cf = await obtenerCajaFuerte(trx);
  const ef = r2(cf.balanceEfectivo + (metodo === 'efectivo' ? delta : 0));
  const tr = r2(cf.balanceTransferencias + (metodo === 'efectivo' ? 0 : delta));
  return trx
    .updateTable('cajaFuerte')
    .set({ balanceEfectivo: ef, balanceTransferencias: tr, balanceTotal: r2(ef + tr), ultimaActualizacion: new Date() })
    .where('id', '=', cf.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export const balancePublico = (cf: { balanceEfectivo: number; balanceTransferencias: number; balanceTotal: number }) => ({
  efectivo: cf.balanceEfectivo,
  transferencias: cf.balanceTransferencias,
  total: cf.balanceTotal,
});

/** Equivalente a CajaFuerteController.RecibirDesdeCajaInternoAsync. */
export async function recibirCierreEnCajaFuerte(
  trx: Db,
  p: { montoEfectivo: number; montoTransferencia: number; fechaCierre: Date; cierreCajaId: string; usuarioId: string },
) {
  const ya = await trx
    .selectFrom('movimientosCajaFuerte')
    .select('id')
    .where('cierreCajaId', '=', p.cierreCajaId)
    .where('origen', '=', 'cierre_caja')
    .executeTakeFirst();
  if (ya || (p.montoEfectivo <= 0 && p.montoTransferencia <= 0)) return false;

  const fecha = formatDMY(toDateStr(p.fechaCierre));
  for (const [metodo, monto] of [
    ['efectivo', p.montoEfectivo],
    ['transferencia', p.montoTransferencia],
  ] as const) {
    if (monto <= 0) continue;
    await trx
      .insertInto('movimientosCajaFuerte')
      .values({
        tipo: 'ingreso',
        origen: 'cierre_caja',
        metodoPago: metodo,
        monto,
        descripcion: `Cierre de caja del ${fecha} - ${metodo === 'efectivo' ? 'Efectivo' : 'Transferencias'}`,
        categoria: null,
        cierreCajaId: p.cierreCajaId,
        movimientoCajaId: null,
        usuarioId: p.usuarioId,
        fecha: toDateStr(p.fechaCierre) === today() ? new Date() : p.fechaCierre,
      })
      .execute();
    await ajustarBalance(trx, metodo, monto);
  }
  return true;
}

// ───────────────────────────── CAJA DIARIA ─────────────────────────────

/** Inicio del conteo de hoy: después del último cierre del día (permite varios cierres/turnos). */
export async function inicioPeriodoActual(fecha = today()) {
  const ini = parseDateStr(fecha);
  const fin = parseDateStr(addDays(fecha, 1));
  const ultimo = await db
    .selectFrom('cierresCaja')
    .select('createdAt')
    .where('fechaCierre', '>=', ini)
    .where('fechaCierre', '<', fin)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  return ultimo ? new Date(ultimo.createdAt) : ini;
}

export async function movimientosPeriodoActual(fecha = today()) {
  const desde = await inicioPeriodoActual(fecha);
  return db
    .selectFrom('movimientosCaja')
    .selectAll()
    .where('fecha', '>=', desde)
    .where('fecha', '<', parseDateStr(addDays(fecha, 1)))
    .orderBy('fecha')
    .execute();
}

export interface CerrarCajaInput {
  fecha?: string;
  efectivoADejar?: number;
  observaciones?: string | null;
  tipoCierre?: 'manual' | 'automatico';
}

/** Equivalente a CajaController.CerrarCaja (.NET). */
export async function cerrarCaja(input: CerrarCajaInput, usuarioId: string) {
  const fecha = input.fecha ?? today();
  return db.transaction().execute(async (trx) => {
    const pendientes = await trx
      .selectFrom('movimientosCaja')
      .selectAll()
      .where('cerrado', '=', false)
      .where('fecha', '>=', parseDateStr(fecha))
      .where('fecha', '<', parseDateStr(addDays(fecha, 1)))
      .orderBy('fecha')
      .forUpdate()
      .execute();
    if (!pendientes.length) throw badRequest(`No hay movimientos pendientes para cerrar el día ${formatDMY(fecha)}`);

    const t = totalesMovimientos(pendientes);
    const efectivoADejar = input.efectivoADejar ?? 0;
    if (efectivoADejar < 0) throw badRequest('El efectivo a dejar no puede ser negativo');
    if (efectivoADejar > t.efectivo.balance) {
      throw badRequest(`El efectivo a dejar (${cop(efectivoADejar)}) no puede ser mayor al balance de efectivo (${cop(t.efectivo.balance)})`);
    }
    const efectivoACF = r2(t.efectivo.balance - efectivoADejar);
    const transferenciaACF = t.transferencia.balance;

    const cierre = await trx
      .insertInto('cierresCaja')
      .values({
        fechaCierre: parseDateStr(fecha),
        tipoCierre: input.tipoCierre ?? 'manual',
        efectivoInicial: 0,
        ingresosEfectivo: t.efectivo.ingresos,
        egresosEfectivo: t.efectivo.egresos,
        efectivoFinal: efectivoACF,
        ingresosTransferencia: t.transferencia.ingresos,
        egresosTransferencia: t.transferencia.egresos,
        totalIngresos: t.totalIngresos,
        totalEgresos: t.totalEgresos,
        balanceGeneral: t.balance,
        cantidadMovimientos: pendientes.length,
        observaciones: [
          input.observaciones?.trim(),
          `Cierre del día ${formatDMY(fecha)}. Efectivo dejado en caja: ${cop(efectivoADejar)}, a Caja Fuerte: ${cop(efectivoACF)}`,
        ]
          .filter(Boolean)
          .join(' - '),
        usuarioId,
        createdAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('movimientosCaja')
      .set({ cerrado: true, cierreCajaId: cierre.id })
      .where(
        'id',
        'in',
        pendientes.map((m) => m.id),
      )
      .execute();

    const enviado = await recibirCierreEnCajaFuerte(trx, {
      montoEfectivo: efectivoACF,
      montoTransferencia: transferenciaACF,
      fechaCierre: parseDateStr(fecha),
      cierreCajaId: cierre.id,
      usuarioId,
    });

    return {
      cierre,
      resumen: { ...t, efectivoADejar, efectivoACajaFuerte: efectivoACF, transferenciaACajaFuerte: transferenciaACF },
      enviadoACajaFuerte: enviado,
    };
  });
}

/** Para el cierre automático: cierra todos los días anteriores que quedaron abiertos y el de hoy. */
export async function cerrarDiasPendientes(usuarioId: string) {
  const rows = await db
    .selectFrom('movimientosCaja')
    .select('fecha')
    .where('cerrado', '=', false)
    .where('fecha', '<', startOfDay(new Date(Date.now() + 86_400_000)))
    .execute();
  const dias = [...new Set(rows.map((r) => toDateStr(new Date(r.fecha))))].sort();
  const resultados = [];
  for (const dia of dias) {
    try {
      resultados.push(await cerrarCaja({ fecha: dia, tipoCierre: 'automatico', observaciones: 'Cierre automático' }, usuarioId));
    } catch (err) {
      console.warn(`  ⚠ No se pudo cerrar ${dia}: ${(err as Error).message}`);
    }
  }
  return resultados;
}

import { db, type Db } from '../db/index.js';
import type { MovimientosCajaTable, OrigenMontoInicial } from '../db/types.js';
import type { Insertable } from 'kysely';
import { badRequest, HttpError } from '../lib/http.js';
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

/** Envía a Caja Fuerte el efectivo y las transferencias de un cierre (una sola vez por cierre). */
export async function recibirCierreEnCajaFuerte(
  trx: Db,
  p: { montoEfectivo: number; montoTransferencia: number; cierreCajaId: string; usuarioId: string; etiqueta: string },
) {
  const ya = await trx
    .selectFrom('movimientosCajaFuerte')
    .select('id')
    .where('cierreCajaId', '=', p.cierreCajaId)
    .where('origen', '=', 'cierre_caja')
    .executeTakeFirst();
  if (ya || (p.montoEfectivo <= 0 && p.montoTransferencia <= 0)) return false;

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
        descripcion: `${p.etiqueta} - ${metodo === 'efectivo' ? 'Efectivo' : 'Transferencias'}`,
        categoria: null,
        cierreCajaId: p.cierreCajaId,
        movimientoCajaId: null,
        usuarioId: p.usuarioId,
        fecha: new Date(),
      })
      .execute();
    await ajustarBalance(trx, metodo, monto);
  }
  return true;
}

// ─────────────────────────── SESIONES DE CAJA DIARIA ───────────────────────────
//
// La caja trabaja por sesiones (turnos): se abre con un monto inicial, todos los
// cobros/pagos quedan ligados a la sesión abierta y se cierra con arqueo.
// No hay cierres por horario: la sesión dura lo que dure el turno.

export const cajaCerrada = () =>
  new HttpError(409, 'La caja está cerrada. Ábrela desde "Caja diaria" para registrar cobros o pagos.');

export function obtenerSesionAbierta(trx: Db = db) {
  return trx.selectFrom('sesionesCaja').selectAll().where('estado', '=', 'abierta').executeTakeFirst();
}

type NuevoMovimiento = Omit<Insertable<MovimientosCajaTable>, 'sesionCajaId' | 'cerrado' | 'cierreCajaId' | 'fecha'> & {
  cierreCajaId?: null;
};

/**
 * Único punto de entrada para registrar dinero en caja diaria
 * (mensualidades, ventas, abonos, salarios, movimientos manuales, transferencias de CF).
 * Exige una sesión abierta y deja el movimiento ligado a ella.
 */
export async function registrarMovimientoCaja(trx: Db, mov: NuevoMovimiento) {
  const sesion = await obtenerSesionAbierta(trx);
  if (!sesion) throw cajaCerrada();
  return trx
    .insertInto('movimientosCaja')
    .values({
      ...mov,
      cierreCajaId: null,
      cerrado: false,
      fecha: new Date(),
      sesionCajaId: sesion.id,
      movimientoCajaFuerteId: mov.movimientoCajaFuerteId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function movimientosDeSesion(sesionId: string, trx: Db = db) {
  return trx.selectFrom('movimientosCaja').selectAll().where('sesionCajaId', '=', sesionId).orderBy('fecha').execute();
}

/** Totales de una sesión + efectivo que debería haber físicamente en la caja. */
export function resumenSesion(montoInicial: number, movs: Awaited<ReturnType<typeof movimientosDeSesion>>) {
  const t = totalesMovimientos(movs);
  return { ...t, montoInicial, efectivoEsperado: r2(montoInicial + t.efectivo.balance), cantidad: movs.length };
}

/** Base sugerida para abrir: lo que se dejó en caja en el último cierre. */
export async function baseSugerida() {
  const ultima = await db
    .selectFrom('sesionesCaja')
    .select(['efectivoDejado', 'fechaCierre'])
    .where('estado', '=', 'cerrada')
    .orderBy('fechaCierre', 'desc')
    .executeTakeFirst();
  return { monto: ultima?.efectivoDejado ?? 0, fechaCierre: ultima?.fechaCierre ?? null };
}

export interface AbrirCajaInput {
  montoInicial: number;
  origen: OrigenMontoInicial;
  observaciones?: string | null;
}

export async function abrirCaja(input: AbrirCajaInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    if (await obtenerSesionAbierta(trx)) throw badRequest('Ya hay una caja abierta. Ciérrala antes de abrir una nueva.');

    const sesion = await trx
      .insertInto('sesionesCaja')
      .values({
        estado: 'abierta',
        montoInicial: input.montoInicial,
        origenMontoInicial: input.origen,
        fechaApertura: new Date(),
        usuarioApertura: usuarioId,
        observacionesApertura: input.observaciones || null,
        fechaCierre: null,
        usuarioCierre: null,
        cierreCajaId: null,
        efectivoEsperado: null,
        efectivoContado: null,
        diferencia: null,
        efectivoDejado: null,
        observacionesCierre: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // La base sale de la Caja Fuerte: se descuenta de su efectivo
    if (input.origen === 'caja_fuerte' && input.montoInicial > 0) {
      const cf = await obtenerCajaFuerte(trx);
      if (cf.balanceEfectivo < input.montoInicial) {
        throw badRequest(`La Caja Fuerte solo tiene ${cop(cf.balanceEfectivo)} en efectivo`);
      }
      await trx
        .insertInto('movimientosCajaFuerte')
        .values({
          tipo: 'egreso',
          origen: 'transferencia_a_caja',
          metodoPago: 'efectivo',
          monto: input.montoInicial,
          descripcion: 'Base para apertura de caja diaria',
          categoria: 'base_caja',
          cierreCajaId: null,
          movimientoCajaId: null,
          usuarioId,
          fecha: new Date(),
        })
        .execute();
      await ajustarBalance(trx, 'efectivo', -input.montoInicial);
    }

    // Movimientos que quedaron sin cerrar del sistema anterior (o sin sesión) pasan a esta sesión
    const huerfanos = await trx
      .updateTable('movimientosCaja')
      .set({ sesionCajaId: sesion.id })
      .where('cerrado', '=', false)
      .where('sesionCajaId', 'is', null)
      .executeTakeFirst();

    return { sesion, movimientosAdoptados: Number(huerfanos.numUpdatedRows ?? 0) };
  });
}

export interface CerrarSesionInput {
  efectivoContado: number;
  efectivoADejar: number;
  observaciones?: string | null;
}

/** Cierre con arqueo: compara lo contado vs lo esperado y envía el dinero a Caja Fuerte. */
export async function cerrarSesion(input: CerrarSesionInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    const sesion = await trx.selectFrom('sesionesCaja').selectAll().where('estado', '=', 'abierta').forUpdate().executeTakeFirst();
    if (!sesion) throw badRequest('No hay una caja abierta para cerrar');
    if (input.efectivoContado < 0 || input.efectivoADejar < 0) throw badRequest('Los montos no pueden ser negativos');
    if (input.efectivoADejar > input.efectivoContado) {
      throw badRequest(`No puedes dejar ${cop(input.efectivoADejar)} si contaste ${cop(input.efectivoContado)}`);
    }

    const movs = await movimientosDeSesion(sesion.id, trx);
    const r = resumenSesion(sesion.montoInicial, movs);
    const diferencia = r2(input.efectivoContado - r.efectivoEsperado);
    const efectivoACF = r2(input.efectivoContado - input.efectivoADejar);
    const transferenciaACF = Math.max(r.transferencia.balance, 0);
    const ahora = new Date();
    const estadoArqueo = diferencia === 0 ? 'cuadró' : diferencia > 0 ? `sobrante de ${cop(diferencia)}` : `faltante de ${cop(-diferencia)}`;

    const cierre = await trx
      .insertInto('cierresCaja')
      .values({
        fechaCierre: ahora,
        tipoCierre: 'sesion',
        efectivoInicial: sesion.montoInicial,
        ingresosEfectivo: r.efectivo.ingresos,
        egresosEfectivo: r.efectivo.egresos,
        efectivoFinal: efectivoACF,
        ingresosTransferencia: r.transferencia.ingresos,
        egresosTransferencia: r.transferencia.egresos,
        totalIngresos: r.totalIngresos,
        totalEgresos: r.totalEgresos,
        balanceGeneral: r.balance,
        cantidadMovimientos: movs.length,
        observaciones: [
          input.observaciones?.trim(),
          `Arqueo: esperado ${cop(r.efectivoEsperado)}, contado ${cop(input.efectivoContado)} (${estadoArqueo}). Base dejada: ${cop(input.efectivoADejar)}`,
        ]
          .filter(Boolean)
          .join(' - '),
        usuarioId,
        createdAt: ahora,
        sesionCajaId: sesion.id,
        efectivoContado: input.efectivoContado,
        diferencia,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (movs.length) {
      await trx
        .updateTable('movimientosCaja')
        .set({ cerrado: true, cierreCajaId: cierre.id })
        .where('sesionCajaId', '=', sesion.id)
        .execute();
    }

    const enviado = await recibirCierreEnCajaFuerte(trx, {
      montoEfectivo: efectivoACF,
      montoTransferencia: transferenciaACF,
      cierreCajaId: cierre.id,
      usuarioId,
      etiqueta: `Cierre de caja (${ahora.toLocaleDateString('es-CO')} ${ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })})`,
    });

    const cerrada = await trx
      .updateTable('sesionesCaja')
      .set({
        estado: 'cerrada',
        fechaCierre: ahora,
        usuarioCierre: usuarioId,
        cierreCajaId: cierre.id,
        efectivoEsperado: r.efectivoEsperado,
        efectivoContado: input.efectivoContado,
        diferencia,
        efectivoDejado: input.efectivoADejar,
        observacionesCierre: input.observaciones || null,
      })
      .where('id', '=', sesion.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      sesion: cerrada,
      cierre,
      resumen: { ...r, efectivoContado: input.efectivoContado, diferencia, efectivoADejar: input.efectivoADejar, efectivoACajaFuerte: efectivoACF, transferenciaACajaFuerte: transferenciaACF },
      enviadoACajaFuerte: enviado,
    };
  });
}

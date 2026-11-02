import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { addDays, isDateStr, nombreDia, parseDateStr, toDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { sum, totalesMovimientos } from '../lib/money.js';
import { requireRole, userId } from '../middleware/auth.js';
import { ajustarBalance, cerrarCaja, inicioPeriodoActual, movimientosPeriodoActual } from './caja.service.js';

/** Caja diaria (CajaController del sistema .NET). */
export const cajaRouter = Router();

export const CATEGORIAS_CAJA = {
  ingreso: ['membresia', 'renovacion', 'producto', 'abono_deuda', 'transferencia_cajafuerte', 'otro_ingreso'],
  egreso: ['sueldo', 'salario', 'servicio', 'mantenimiento', 'compra', 'proveedor', 'otro_egreso'],
};

cajaRouter.get('/categorias', (_req, res) => res.json(CATEGORIAS_CAJA));

/** Panel: totales del periodo actual (desde el último cierre de hoy), control de cierre y alertas. */
cajaRouter.get(
  '/dashboard',
  ah(async (_req, res) => {
    const hoy = today();
    const movs = await movimientosPeriodoActual(hoy);
    const ultimoCierre = await db
      .selectFrom('cierresCaja')
      .select(['id', 'fechaCierre', 'createdAt', 'tipoCierre', 'balanceGeneral', 'efectivoFinal', 'cantidadMovimientos'])
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const anteriores = await db
      .selectFrom('movimientosCaja')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('cerrado', '=', false)
      .where('fecha', '<', parseDateStr(hoy))
      .executeTakeFirstOrThrow();
    const yaSeCerroHoy = !!ultimoCierre && toDateStr(new Date(ultimoCierre.fechaCierre)) === hoy;
    res.json({
      fecha: hoy,
      inicioPeriodo: await inicioPeriodoActual(hoy),
      cajaHoy: { ...totalesMovimientos(movs), cantidad: movs.length },
      movimientos: movs.slice().reverse(),
      ultimoCierre,
      controlCierre: { yaSeCerroHoy, horaUltimoCierre: yaSeCerroHoy ? ultimoCierre!.createdAt : null },
      alertas: { movimientosPendientesAnteriores: anteriores.n, tieneMovimientosPendientesAnteriores: anteriores.n > 0 },
    });
  }),
);

cajaRouter.get(
  '/semanal',
  ah(async (_req, res) => {
    const hoy = today();
    const desde = addDays(hoy, -6);
    const movs = await db
      .selectFrom('movimientosCaja')
      .selectAll()
      .where('fecha', '>=', parseDateStr(desde))
      .where('fecha', '<', parseDateStr(addDays(hoy, 1)))
      .execute();
    const dias = Array.from({ length: 7 }, (_, i) => {
      const fecha = addDays(desde, i);
      const t = totalesMovimientos(movs.filter((m) => toDateStr(new Date(m.fecha)) === fecha));
      return {
        fecha,
        dia: nombreDia(fecha),
        ingresos: t.totalIngresos,
        egresos: t.totalEgresos,
        balance: t.balance,
        ingresosEfectivo: t.efectivo.ingresos,
        ingresosTransferencia: t.transferencia.ingresos,
        productos: t.categorias.productos,
        membresias: t.categorias.membresias,
      };
    });
    res.json({ periodo: { desde, hasta: hoy }, dias, totales: totalesMovimientos(movs) });
  }),
);

/** Días anteriores que quedaron sin cerrar. */
cajaRouter.get(
  '/pendientes',
  ah(async (_req, res) => {
    const movs = await db.selectFrom('movimientosCaja').selectAll().where('cerrado', '=', false).orderBy('fecha').execute();
    const porFecha = new Map<string, typeof movs>();
    for (const m of movs) {
      const k = toDateStr(new Date(m.fecha));
      porFecha.set(k, [...(porFecha.get(k) ?? []), m]);
    }
    res.json({
      cantidadTotal: movs.length,
      dias: [...porFecha.entries()].map(([fecha, ms]) => {
        const t = totalesMovimientos(ms);
        return { fecha, cantidad: ms.length, totalIngresos: t.totalIngresos, totalEgresos: t.totalEgresos, balance: t.balance };
      }),
    });
  }),
);

cajaRouter.get(
  '/movimientos',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        desde: z.string().refine(isDateStr).optional(),
        hasta: z.string().refine(isDateStr).optional(),
        soloPendientes: z.coerce.boolean().default(false),
        tipo: z.enum(['ingreso', 'egreso']).optional(),
        categoria: z.string().optional(),
      }),
      req.query,
    );
    const rows = await db
      .selectFrom('movimientosCaja')
      .selectAll()
      .$if(q.soloPendientes, (qb) => qb.where('cerrado', '=', false))
      .$if(!!q.desde, (qb) => qb.where('fecha', '>=', parseDateStr(q.desde!)))
      .$if(!!q.hasta, (qb) => qb.where('fecha', '<', parseDateStr(addDays(q.hasta!, 1))))
      .$if(!!q.tipo, (qb) => qb.where('tipo', '=', q.tipo!))
      .$if(!!q.categoria, (qb) => qb.where('categoria', '=', q.categoria!))
      .orderBy('fecha', 'desc')
      .limit(5000)
      .execute();
    res.json({ cantidad: rows.length, totales: totalesMovimientos(rows), data: rows });
  }),
);

cajaRouter.post(
  '/movimientos',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        tipo: z.enum(['ingreso', 'egreso']),
        categoria: z.string().trim().min(1).max(50),
        monto: z.coerce.number().positive('El monto debe ser mayor a 0'),
        descripcion: z.string().trim().min(1, 'Describe el movimiento').max(500),
        metodoPago: z.enum(['efectivo', 'transferencia']),
      }),
      req.body,
    );
    const mov = await db
      .insertInto('movimientosCaja')
      .values({
        ...b,
        referenciaId: null,
        usuarioId: userId(req),
        fecha: new Date(),
        cerrado: false,
        cierreCajaId: null,
        movimientoCajaFuerteId: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, movimiento: mov, message: `${b.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} registrado` });
  }),
);

/**
 * Elimina un movimiento dejando auditoría. Si vino de Caja Fuerte, revierte también
 * el movimiento espejo y el balance de la caja fuerte (igual que el sistema original).
 */
cajaRouter.delete(
  '/movimientos/:id',
  ah(async (req, res) => {
    const motivo = parse(z.object({ motivo: z.string().trim().max(300).nullish() }), req.body ?? {}).motivo || 'Sin motivo especificado';
    const uid = userId(req);
    await db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('movimientosCaja').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!m) throw notFound('Movimiento no encontrado');
      if (m.cerrado && !m.movimientoCajaFuerteId) {
        throw badRequest('No se puede eliminar un movimiento que ya fue incluido en un cierre de caja');
      }
      await trx
        .insertInto('movimientosEliminados')
        .values({
          movimientoOriginalId: m.id,
          moduloOrigen: 'caja_diaria',
          tipo: m.tipo,
          origen: m.categoria || 'manual',
          metodoPago: m.metodoPago || 'efectivo',
          monto: m.monto,
          descripcion: m.descripcion || '',
          categoria: m.categoria || '',
          fechaOriginal: m.fecha,
          fechaEliminacion: new Date(),
          usuarioEliminacion: uid,
          motivoEliminacion: motivo,
        })
        .execute();

      if (m.movimientoCajaFuerteId) {
        const cf = await trx.selectFrom('movimientosCajaFuerte').selectAll().where('id', '=', m.movimientoCajaFuerteId).executeTakeFirst();
        if (cf) {
          await ajustarBalance(trx, cf.metodoPago, cf.tipo === 'egreso' ? cf.monto : -cf.monto);
          await trx
            .insertInto('movimientosEliminados')
            .values({
              movimientoOriginalId: cf.id,
              moduloOrigen: 'caja_fuerte',
              tipo: cf.tipo,
              origen: cf.origen,
              metodoPago: cf.metodoPago,
              monto: cf.monto,
              descripcion: cf.descripcion || '',
              categoria: cf.categoria || '',
              fechaOriginal: cf.fecha,
              fechaEliminacion: new Date(),
              usuarioEliminacion: uid,
              motivoEliminacion: `Eliminado en cascada desde Caja Diaria. Motivo: ${motivo}`,
            })
            .execute();
          await trx.deleteFrom('movimientosCajaFuerte').where('id', '=', cf.id).execute();
        }
      }
      await trx.deleteFrom('movimientosCaja').where('id', '=', m.id).execute();
    });
    res.json({ success: true, message: 'Movimiento eliminado y registrado en auditoría' });
  }),
);

cajaRouter.post(
  '/cerrar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        fecha: z.string().refine(isDateStr).optional(),
        efectivoADejar: z.coerce.number().min(0).optional(),
        observaciones: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    const r = await cerrarCaja({ ...b, fecha: b.fecha?.slice(0, 10), tipoCierre: 'manual' }, userId(req));
    res.json({ success: true, ...r, message: 'Caja cerrada correctamente' });
  }),
);

cajaRouter.get(
  '/cierres',
  ah(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 30, 365);
    const rows = await db
      .selectFrom('cierresCaja as c')
      .leftJoin('usuarios as u', 'u.id', 'c.usuarioId')
      .selectAll('c')
      .select('u.nombre as usuarioNombre')
      .orderBy('c.createdAt', 'desc')
      .limit(limite)
      .execute();
    res.json(rows);
  }),
);

cajaRouter.get(
  '/cierres/:id',
  ah(async (req, res) => {
    const cierre = await db.selectFrom('cierresCaja').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!cierre) throw notFound('Cierre no encontrado');
    const movimientos = await db.selectFrom('movimientosCaja').selectAll().where('cierreCajaId', '=', cierre.id).orderBy('fecha').execute();
    res.json({ cierre, movimientos });
  }),
);

cajaRouter.get(
  '/eliminados',
  requireRole('admin'),
  ah(async (req, res) => {
    const modulo = req.query.modulo === 'caja_fuerte' ? 'caja_fuerte' : 'caja_diaria';
    const rows = await db
      .selectFrom('movimientosEliminados as e')
      .leftJoin('usuarios as u', 'u.id', 'e.usuarioEliminacion')
      .selectAll('e')
      .select('u.nombre as usuarioNombre')
      .where('e.moduloOrigen', '=', modulo)
      .orderBy('e.fechaEliminacion', 'desc')
      .limit(500)
      .execute();
    res.json({ totalMonto: sum(rows, (r) => r.monto), data: rows });
  }),
);

import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../db/index.js';
import { addDays, isDateStr, nombreDia, parseDateStr, toDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { cop, sum, totalesMovimientos } from '../lib/money.js';
import { requireRole, userId } from '../middleware/auth.js';
import {
  abrirCaja,
  ajustarBalance,
  baseSugerida,
  cerrarSesion,
  movimientosDeSesion,
  registrarMovimientoCaja,
  resumenSesion,
} from './caja.service.js';

/** Caja diaria (CajaController del sistema .NET). */
export const cajaRouter = Router();

export const CATEGORIAS_CAJA = {
  ingreso: ['membresia', 'renovacion', 'producto', 'abono_deuda', 'transferencia_cajafuerte', 'otro_ingreso'],
  egreso: ['sueldo', 'salario', 'servicio', 'mantenimiento', 'compra', 'proveedor', 'otro_egreso'],
};

cajaRouter.get('/categorias', (_req, res) => res.json(CATEGORIAS_CAJA));

const SESION_COLS = [
  's.id',
  's.estado',
  's.montoInicial',
  's.origenMontoInicial',
  's.fechaApertura',
  's.observacionesApertura',
  's.fechaCierre',
  's.cierreCajaId',
  's.efectivoEsperado',
  's.efectivoContado',
  's.diferencia',
  's.efectivoDejado',
  's.observacionesCierre',
  'ua.nombre as usuarioAperturaNombre',
  'uc.nombre as usuarioCierreNombre',
] as const;

const sesionQuery = () =>
  db
    .selectFrom('sesionesCaja as s')
    .innerJoin('usuarios as ua', 'ua.id', 's.usuarioApertura')
    .leftJoin('usuarios as uc', 'uc.id', 's.usuarioCierre')
    .select([...SESION_COLS]);

/** Estado de la caja: sesión abierta (con totales y movimientos) o datos para abrirla. */
cajaRouter.get(
  '/sesion',
  ah(async (_req, res) => {
    const sesion = await sesionQuery().where('s.estado', '=', 'abierta').executeTakeFirst();
    if (!sesion) {
      const [sugerida, ultima, pendientes] = await Promise.all([
        baseSugerida(),
        sesionQuery().where('s.estado', '=', 'cerrada').orderBy('s.fechaCierre', 'desc').executeTakeFirst(),
        db
          .selectFrom('movimientosCaja')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('cerrado', '=', false)
          .where('sesionCajaId', 'is', null)
          .executeTakeFirstOrThrow(),
      ]);
      return res.json({ abierta: false, baseSugerida: sugerida, ultimaSesion: ultima ?? null, movimientosSinSesion: pendientes.n });
    }
    const movs = await movimientosDeSesion(sesion.id);
    res.json({
      abierta: true,
      sesion,
      resumen: resumenSesion(sesion.montoInicial, movs),
      movimientos: movs.slice().reverse(),
    });
  }),
);

cajaRouter.post(
  '/abrir',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        montoInicial: z.coerce.number().min(0, 'El monto inicial no puede ser negativo'),
        origen: z.enum(['anterior', 'caja_fuerte', 'externo']).default('anterior'),
        observaciones: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    const r = await abrirCaja(b, userId(req));
    res.status(201).json({
      success: true,
      ...r,
      message:
        `Caja abierta con ${cop(b.montoInicial)} de base` +
        (r.movimientosAdoptados ? `. Se incluyeron ${r.movimientosAdoptados} movimientos pendientes sin cerrar.` : ''),
    });
  }),
);

/** Cierre de la sesión con arqueo de efectivo. */
cajaRouter.post(
  '/cerrar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        efectivoContado: z.coerce.number().min(0, 'Ingresa el efectivo contado'),
        efectivoADejar: z.coerce.number().min(0).default(0),
        observaciones: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    const r = await cerrarSesion(b, userId(req));
    const d = r.resumen.diferencia;
    res.json({
      success: true,
      ...r,
      message: d === 0 ? 'Caja cerrada. ¡El arqueo cuadró!' : d > 0 ? `Caja cerrada con sobrante de ${cop(d)}` : `Caja cerrada con faltante de ${cop(-d)}`,
    });
  }),
);

/** Historial de sesiones (turnos). */
cajaRouter.get(
  '/sesiones',
  ah(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 50, 500);
    const rows = await sesionQuery()
      .select((eb) => [
        eb
          .selectFrom('movimientosCaja as m')
          .whereRef('m.sesionCajaId', '=', 's.id')
          .select(sql<number>`count(*)::int`.as('n'))
          .as('cantidadMovimientos'),
        eb
          .selectFrom('movimientosCaja as m')
          .whereRef('m.sesionCajaId', '=', 's.id')
          .where('m.tipo', '=', 'ingreso')
          .select(sql<number>`coalesce(sum(m.monto),0)::float`.as('t'))
          .as('totalIngresos'),
        eb
          .selectFrom('movimientosCaja as m')
          .whereRef('m.sesionCajaId', '=', 's.id')
          .where('m.tipo', '=', 'egreso')
          .select(sql<number>`coalesce(sum(m.monto),0)::float`.as('t'))
          .as('totalEgresos'),
        eb.selectFrom('cierresCaja as c').whereRef('c.id', '=', 's.cierreCajaId').select('c.efectivoFinal').as('efectivoEnviado'),
      ])
      .orderBy('s.fechaApertura', 'desc')
      .limit(limite)
      .execute();
    res.json(rows);
  }),
);

cajaRouter.get(
  '/sesiones/:id',
  ah(async (req, res) => {
    const sesion = await sesionQuery().where('s.id', '=', req.params.id).executeTakeFirst();
    if (!sesion) throw notFound('Sesión no encontrada');
    const movs = await movimientosDeSesion(sesion.id);
    const cierre = sesion.cierreCajaId
      ? await db.selectFrom('cierresCaja').selectAll().where('id', '=', sesion.cierreCajaId).executeTakeFirst()
      : null;
    res.json({ sesion, resumen: resumenSesion(sesion.montoInicial, movs), movimientos: movs, cierre });
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
    const mov = await registrarMovimientoCaja(db, { ...b, referenciaId: null, usuarioId: userId(req) });
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

import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { addDays, diffDays, isDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { sum } from '../lib/money.js';
import { requireRole, userId } from '../middleware/auth.js';
import {
  actualizarEstadosVencidas,
  calcularVencimiento,
  crearMembresia,
  describirDuracion,
  reanudarMembresia,
  renovarMembresia,
  suspenderMembresia,
} from './membresias.service.js';

export const membresiasRouter = Router();

const metodoPago = z.enum(['efectivo', 'transferencia']);
const fecha = z.string().refine(isDateStr, 'Fecha inválida (YYYY-MM-DD)').transform((s) => s.slice(0, 10));

/** Última membresía de cada cliente (la que define su situación actual). */
const vigentes = () =>
  db
    .selectFrom('membresias')
    .selectAll()
    .distinctOn('clienteId')
    .orderBy('clienteId')
    .orderBy(sql`case when estado in ('activa', 'suspendida') then 0 else 1 end`)
    .orderBy('fechaVencimiento', 'desc')
    .orderBy('createdAt', 'desc');

const baseSelect = (vista: 'vigentes' | 'historial') =>
  db
    .selectFrom(vista === 'vigentes' ? vigentes().as('m') : db.selectFrom('membresias').selectAll().as('m'))
    .innerJoin('clientes as c', 'c.id', 'm.clienteId')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .selectAll('m')
    .select([
      'c.nombre as clienteNombre',
      'c.apellido as clienteApellido',
      'c.cedula as clienteCedula',
      'c.telefono as clienteTelefono',
      'p.nombre as planNombre',
      'p.color as planColor',
      'p.precio as planPrecio',
      'p.personas as planPersonas',
      'p.promocional as planPromocional',
    ])
    .select((eb) =>
      eb
        .selectFrom('deudasClientes as d')
        .whereRef('d.clienteId', '=', 'm.clienteId')
        .where('d.estado', '=', 'pendiente')
        .select(sql<number>`coalesce(sum(d.saldo),0)::float`.as('s'))
        .as('saldoDeuda'),
    )
    .select((eb) =>
      eb
        .selectFrom('membresias as g')
        .innerJoin('clientes as gc', 'gc.id', 'g.clienteId')
        .whereRef('g.grupoId', '=', 'm.grupoId')
        .whereRef('g.clienteId', '!=', 'm.clienteId')
        .select(sql<{ id: string; nombre: string; apellido: string; cedula: string }[] | null>`json_agg(distinct jsonb_build_object('id', gc.id, 'nombre', gc.nombre, 'apellido', gc.apellido, 'cedula', gc.cedula))`.as('x'))
        .as('companeros'),
    );

/**
 * Listado de mensualidades con pestañas:
 *  activas | por_vencer | vencidas | suspendidas | todas (vigentes por cliente) | historial (todas las filas)
 */
membresiasRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        tab: z.enum(['activas', 'por_vencer', 'vencidas', 'suspendidas', 'todas', 'historial']).default('todas'),
        buscar: z.string().optional(),
        planId: z.string().uuid().optional(),
        dias: z.coerce.number().int().min(1).max(60).default(env.DIAS_ALERTA_VENCIMIENTO),
      }),
      req.query,
    );
    await actualizarEstadosVencidas();
    const hoy = today();
    const limite = addDays(hoy, q.dias);

    let query = baseSelect(q.tab === 'historial' ? 'historial' : 'vigentes');
    if (q.tab === 'activas') query = query.where('m.estado', '=', 'activa').where('m.fechaVencimiento', '>', limite);
    if (q.tab === 'por_vencer')
      query = query.where('m.estado', '=', 'activa').where('m.fechaVencimiento', '>=', hoy).where('m.fechaVencimiento', '<=', limite);
    if (q.tab === 'vencidas') query = query.where('m.estado', 'in', ['vencida', 'cancelada']).where('c.activo', '=', true);
    if (q.tab === 'suspendidas') query = query.where('m.estado', '=', 'suspendida');
    if (q.planId) query = query.where('m.planId', '=', q.planId);
    if (q.buscar?.trim()) {
      const t = `%${q.buscar.trim().toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([eb(eb.fn('lower', [sql`c.nombre || ' ' || c.apellido`]), 'like', t), eb('c.cedula', 'like', t)]),
      );
    }

    const order = q.tab === 'vencidas' ? 'desc' : q.tab === 'por_vencer' || q.tab === 'activas' ? 'asc' : 'desc';
    const rows = await query.orderBy('m.fechaVencimiento', order).limit(1000).execute();

    res.json(
      rows.map((m) => {
        const total = diffDays(m.fechaInicio, m.fechaVencimiento) + 1;
        const restantes = diffDays(hoy, m.fechaVencimiento);
        const transcurridos = Math.min(Math.max(diffDays(m.fechaInicio, hoy) + 1, 0), total);
        return {
          ...m,
          diasRestantes: restantes,
          diasTotales: total,
          progreso: total > 0 ? Math.round((transcurridos / total) * 100) : 100,
          diasCongelada: m.estado === 'suspendida' && m.fechaSuspension ? diffDays(m.fechaSuspension, hoy) : 0,
        };
      }),
    );
  }),
);

/** KPIs del módulo de mensualidades. */
membresiasRouter.get(
  '/resumen',
  ah(async (_req, res) => {
    await actualizarEstadosVencidas();
    const hoy = today();
    const limite = addDays(hoy, env.DIAS_ALERTA_VENCIMIENTO);
    const ahora = new Date();
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    const vig = await db
      .selectFrom(vigentes().as('m'))
      .innerJoin('clientes as c', 'c.id', 'm.clienteId')
      .where('c.activo', '=', true)
      .select(['m.estado', 'm.fechaVencimiento', 'm.fechaInicio', 'm.clienteId'])
      .execute();

    const [pagosMes, renovacionesMes, nuevasMes] = await Promise.all([
      db.selectFrom('pagos').select(['monto']).where('fechaPago', '>=', inicioMes).execute(),
      db
        .selectFrom('movimientosCaja')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('categoria', '=', 'renovacion')
        .where('fecha', '>=', inicioMes)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('movimientosCaja')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('categoria', '=', 'membresia')
        .where('fecha', '>=', inicioMes)
        .executeTakeFirstOrThrow(),
    ]);

    // Tasa de renovación: de las membresías que vencieron en los últimos 30 días,
    // cuántas tienen una membresía posterior para el mismo cliente.
    const hace30 = addDays(hoy, -30);
    const vencieron = await db
      .selectFrom('membresias as m')
      .select(['m.id', 'm.clienteId', 'm.fechaVencimiento'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('membresias as n')
              .select('n.id')
              .whereRef('n.clienteId', '=', 'm.clienteId')
              .whereRef('n.fechaVencimiento', '>', 'm.fechaVencimiento'),
          )
          .as('renovo'),
      )
      .where('m.fechaVencimiento', '>=', hace30)
      .where('m.fechaVencimiento', '<', hoy)
      .execute();

    const activas = vig.filter((m) => m.estado === 'activa');
    res.json({
      activas: activas.length,
      porVencer: activas.filter((m) => m.fechaVencimiento >= hoy && m.fechaVencimiento <= limite).length,
      vencenHoy: activas.filter((m) => m.fechaVencimiento === hoy).length,
      vencidas: vig.filter((m) => m.estado === 'vencida' || m.estado === 'cancelada').length,
      suspendidas: vig.filter((m) => m.estado === 'suspendida').length,
      ingresosMes: sum(pagosMes, (p) => p.monto),
      renovacionesMes: renovacionesMes.n,
      nuevasMes: nuevasMes.n,
      tasaRenovacion: vencieron.length ? Math.round((vencieron.filter((v) => v.renovo).length / vencieron.length) * 100) : null,
      diasAlerta: env.DIAS_ALERTA_VENCIMIENTO,
    });
  }),
);

/** Calcula la fecha de vencimiento antes de guardar (vista previa en el formulario). */
membresiasRouter.get(
  '/preview',
  ah(async (req, res) => {
    const q = parse(z.object({ planId: z.string().uuid(), fechaInicio: fecha.optional() }), req.query);
    const plan = await db.selectFrom('planes').selectAll().where('id', '=', q.planId).executeTakeFirst();
    if (!plan) throw notFound('Plan no encontrado');
    const inicio = q.fechaInicio ?? today();
    const venc = calcularVencimiento(inicio, plan);
    res.json({
      fechaInicio: inicio,
      fechaVencimiento: venc,
      diasTotales: diffDays(inicio, venc) + 1,
      duracionTexto: describirDuracion(plan),
      precio: plan.precio,
    });
  }),
);

membresiasRouter.get(
  '/:id',
  ah(async (req, res) => {
    const m = await baseSelect('historial').where('m.id', '=', req.params.id).executeTakeFirst();
    if (!m) throw notFound('Membresía no encontrada');
    const pagos = await db
      .selectFrom('pagos')
      .select(['id', 'monto', 'metodoPago', 'fechaPago', 'notas'])
      .where('membresiaId', '=', m.id)
      .orderBy('fechaPago', 'desc')
      .execute();
    res.json({ ...m, pagos, diasRestantes: diffDays(today(), m.fechaVencimiento) });
  }),
);

membresiasRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        clienteId: z.string().uuid('Selecciona un cliente'),
        acompanantes: z.array(z.string().uuid('Selecciona los acompañantes')).max(9).optional(),
        planId: z.string().uuid('Selecciona un plan'),
        fechaInicio: fecha.optional(),
        montoPagado: z.coerce.number().min(0, 'Monto inválido'),
        metodoPago,
        notas: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    const r = await crearMembresia(body, userId(req));
    res.status(201).json({ success: true, ...r });
  }),
);

membresiasRouter.post(
  '/:id/renovar',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        planId: z.string().uuid().optional(),
        acompanantes: z.array(z.string().uuid()).max(9).optional(),
        montoPagado: z.coerce.number().min(0),
        metodoPago,
        desde: z.enum(['hoy', 'vencimiento']).default('vencimiento'),
        notas: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    const r = await renovarMembresia(req.params.id, body, userId(req));
    res.json({ success: true, ...r });
  }),
);

membresiasRouter.post(
  '/:id/congelar',
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().max(200).nullish() }), req.body ?? {});
    res.json({ success: true, ...(await suspenderMembresia(req.params.id, motivo)) });
  }),
);

membresiasRouter.post(
  '/:id/reanudar',
  ah(async (req, res) => {
    res.json({ success: true, ...(await reanudarMembresia(req.params.id)) });
  }),
);

membresiasRouter.post(
  '/:id/cancelar',
  requireRole('admin'),
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().max(200).nullish() }), req.body ?? {});
    const m = await db.selectFrom('membresias').select(['id', 'notas']).where('id', '=', req.params.id).executeTakeFirst();
    if (!m) throw notFound('Membresía no encontrada');
    await db
      .updateTable('membresias')
      .set({
        estado: 'cancelada',
        fechaSuspension: null,
        notas: [m.notas, `Cancelada${motivo ? `: ${motivo}` : ''}`].filter(Boolean).join(' · '),
        updatedAt: today(),
      })
      .where('id', '=', m.id)
      .execute();
    res.json({ success: true, message: 'Membresía cancelada' });
  }),
);

/** Edición manual (corrección de datos) — solo administrador. */
membresiasRouter.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        planId: z.string().uuid(),
        fechaInicio: fecha,
        fechaVencimiento: fecha,
        estado: z.enum(['activa', 'vencida', 'suspendida', 'cancelada']),
        montoPagado: z.coerce.number().min(0),
        metodoPago,
        notas: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    if (body.fechaVencimiento < body.fechaInicio) throw badRequest('La fecha de vencimiento no puede ser anterior al inicio');
    const r = await db
      .updateTable('membresias')
      .set({
        ...body,
        notas: body.notas || null,
        fechaSuspension: body.estado === 'suspendida' ? today() : null,
        updatedAt: today(),
      })
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Membresía no encontrada');
    res.json({ success: true, message: 'Membresía actualizada' });
  }),
);

membresiasRouter.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const r = await db.deleteFrom('membresias').where('id', '=', req.params.id).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound('Membresía no encontrada');
    res.json({ success: true, message: 'Membresía eliminada' });
  }),
);


import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { addDays, diffDays, isDateStr, parseDateStr, toDateStr, today } from '../lib/dates.js';
import { ah, parse } from '../lib/http.js';
import { sum, totalesMovimientos } from '../lib/money.js';
import { actualizarEstadosVencidas } from './membresias.service.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  ah(async (_req, res) => {
    await actualizarEstadosVencidas();
    const hoy = today();
    const ahora = new Date();
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const inicioMesAnt = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
    const limite = addDays(hoy, env.DIAS_ALERTA_VENCIMIENTO);
    const hace29 = parseDateStr(addDays(hoy, -29));

    const vigentes = db
      .selectFrom('membresias')
      .selectAll()
      .distinctOn('clienteId')
      .orderBy('clienteId')
      .orderBy('fechaVencimiento', 'desc')
      .as('m');

    const [clientes, vig, checkinsHoy, asistencia, movsMes, movsMesAnt, topClientes, stockBajo, cumpleanos, deudas] = await Promise.all([
      db
        .selectFrom('clientes')
        .select([
          sql<number>`count(*) filter (where activo)::int`.as('activos'),
          sql<number>`count(*) filter (where created_at >= ${toDateStr(inicioMes)}::date)::int`.as('nuevosMes'),
        ])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom(vigentes)
        .innerJoin('clientes as c', 'c.id', 'm.clienteId')
        .innerJoin('planes as p', 'p.id', 'm.planId')
        .where('c.activo', '=', true)
        .select(['m.id', 'm.planId', 'm.estado', 'm.fechaVencimiento', 'c.id as clienteId', 'c.nombre', 'c.apellido', 'c.telefono', 'p.nombre as plan', 'p.color'])
        .execute(),
      db
        .selectFrom('checkins')
        .select([sql<number>`count(*) filter (where exitoso)::int`.as('ok'), sql<number>`count(*) filter (where not exitoso)::int`.as('denegados')])
        .where('fechaHora', '>=', parseDateStr(hoy))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkins')
        .select([sql<string>`to_char(fecha_hora, 'YYYY-MM-DD')`.as('fecha'), sql<number>`count(*)::int`.as('total')])
        .where('exitoso', '=', true)
        .where('fechaHora', '>=', hace29)
        .groupBy(sql`to_char(fecha_hora, 'YYYY-MM-DD')`)
        .execute(),
      db.selectFrom('movimientosCaja').selectAll().where('fecha', '>=', inicioMes).execute(),
      db.selectFrom('movimientosCaja').select(['tipo', 'monto', 'metodoPago', 'categoria']).where('fecha', '>=', inicioMesAnt).where('fecha', '<', inicioMes).execute(),
      db
        .selectFrom('checkins as ch')
        .innerJoin('clientes as c', 'c.id', 'ch.clienteId')
        .select(['c.id', 'c.nombre', 'c.apellido', sql<number>`count(*)::int`.as('total')])
        .where('ch.exitoso', '=', true)
        .where('ch.fechaHora', '>=', inicioMes)
        .groupBy(['c.id', 'c.nombre', 'c.apellido'])
        .orderBy('total', 'desc')
        .limit(5)
        .execute(),
      db
        .selectFrom('productos')
        .select(['id', 'nombre', 'stock'])
        .where('activo', '=', true)
        .where('stock', '<=', env.STOCK_MINIMO)
        .orderBy('stock')
        .limit(8)
        .execute(),
      db
        .selectFrom('clientes')
        .select(['id', 'nombre', 'apellido', 'telefono'])
        .where('activo', '=', true)
        .where(sql`to_char(fecha_nacimiento, 'MM-DD')`, '=', hoy.slice(5))
        .execute(),
      db
        .selectFrom('deudasClientes')
        .select([sql<number>`coalesce(sum(saldo),0)::float`.as('total'), sql<number>`count(distinct cliente_id)::int`.as('clientes')])
        .where('estado', '=', 'pendiente')
        .executeTakeFirstOrThrow(),
    ]);

    const activas = vig.filter((m) => m.estado === 'activa');
    const porVencer = activas
      .filter((m) => m.fechaVencimiento >= hoy && m.fechaVencimiento <= limite)
      .map((m) => ({ ...m, diasRestantes: diffDays(hoy, m.fechaVencimiento) }))
      .sort((a, b) => a.diasRestantes - b.diasRestantes);
    const vencidas = vig
      .filter((m) => m.estado === 'vencida' && diffDays(m.fechaVencimiento, hoy) <= 30)
      .map((m) => ({ ...m, diasVencido: diffDays(m.fechaVencimiento, hoy) }))
      .sort((a, b) => a.diasVencido - b.diasVencido)
      .slice(0, 15);

    const asisMap = new Map(asistencia.map((a) => [a.fecha, a.total]));
    const serie = Array.from({ length: 30 }, (_, i) => {
      const f = addDays(hoy, -29 + i);
      return { fecha: f, total: asisMap.get(f) ?? 0 };
    });

    const tMes = totalesMovimientos(movsMes);
    const tAnt = totalesMovimientos(movsMesAnt);
    const ingresosPorDia = Array.from({ length: ahora.getDate() }, (_, i) => {
      const f = toDateStr(new Date(ahora.getFullYear(), ahora.getMonth(), i + 1));
      const t = totalesMovimientos(movsMes.filter((m) => toDateStr(new Date(m.fecha)) === f));
      return { fecha: f, ingresos: t.totalIngresos, egresos: t.totalEgresos };
    });

    res.json({
      kpis: {
        clientesActivos: clientes.activos,
        clientesNuevosMes: clientes.nuevosMes,
        membresiasActivas: activas.length,
        porVencer: porVencer.length,
        vencidas: vig.filter((m) => m.estado === 'vencida').length,
        checkinsHoy: checkinsHoy.ok,
        accesosDenegadosHoy: checkinsHoy.denegados,
        ingresosMes: tMes.totalIngresos,
        egresosMes: tMes.totalEgresos,
        balanceMes: tMes.balance,
        ingresosMesAnterior: tAnt.totalIngresos,
        deudaPendiente: deudas.total,
        clientesConDeuda: deudas.clientes,
      },
      ingresosMes: tMes,
      ingresosPorDia,
      asistencia30dias: serie,
      porVencer,
      vencidas,
      topClientes,
      stockBajo,
      cumpleanos,
    });
  }),
);

// ═════════════════════════════ REPORTES ═════════════════════════════
export const reportesRouter = Router();

const rango = z.object({
  desde: z.string().refine(isDateStr).optional(),
  hasta: z.string().refine(isDateStr).optional(),
});
const resolverRango = (q: z.infer<typeof rango>, diasAtras = 30) => {
  const hasta = q.hasta?.slice(0, 10) ?? today();
  const desde = q.desde?.slice(0, 10) ?? addDays(hasta, -diasAtras);
  return { desde, hasta, d: parseDateStr(desde), h: parseDateStr(addDays(hasta, 1)) };
};

reportesRouter.get(
  '/asistencia',
  ah(async (req, res) => {
    const r = resolverRango(parse(rango, req.query));
    const rows = await db
      .selectFrom('checkins')
      .select([
        sql<string>`to_char(fecha_hora, 'YYYY-MM-DD')`.as('fecha'),
        sql<number>`count(*) filter (where exitoso)::int`.as('total'),
        sql<number>`count(*) filter (where not exitoso)::int`.as('denegados'),
      ])
      .where('fechaHora', '>=', r.d)
      .where('fechaHora', '<', r.h)
      .groupBy(sql`to_char(fecha_hora, 'YYYY-MM-DD')`)
      .orderBy('fecha')
      .execute();
    const porHora = await db
      .selectFrom('checkins')
      .select([sql<number>`extract(hour from fecha_hora)::int`.as('hora'), sql<number>`count(*)::int`.as('total')])
      .where('exitoso', '=', true)
      .where('fechaHora', '>=', r.d)
      .where('fechaHora', '<', r.h)
      .groupBy(sql`extract(hour from fecha_hora)`)
      .orderBy('hora')
      .execute();
    res.json({ desde: r.desde, hasta: r.hasta, dias: rows, porHora, total: sum(rows, (x) => x.total) });
  }),
);

reportesRouter.get(
  '/ingresos-membresias',
  ah(async (req, res) => {
    const r = resolverRango(parse(rango, req.query));
    const rows = await db
      .selectFrom('pagos as pg')
      .innerJoin('membresias as m', 'm.id', 'pg.membresiaId')
      .innerJoin('planes as p', 'p.id', 'm.planId')
      .select(['p.id', 'p.nombre', 'p.color', sql<number>`count(*)::int`.as('cantidad'), sql<number>`sum(pg.monto)::float`.as('total')])
      .where('pg.fechaPago', '>=', r.d)
      .where('pg.fechaPago', '<', r.h)
      .groupBy(['p.id', 'p.nombre', 'p.color'])
      .orderBy('total', 'desc')
      .execute();
    res.json({ desde: r.desde, hasta: r.hasta, planes: rows, total: sum(rows, (x) => x.total) });
  }),
);

reportesRouter.get(
  '/productos-mas-vendidos',
  ah(async (req, res) => {
    const r = resolverRango(parse(rango, req.query));
    const rows = await db
      .selectFrom('ventasProductos as v')
      .innerJoin('productos as p', 'p.id', 'v.productoId')
      .select(['p.id', 'p.nombre', sql<number>`sum(v.cantidad)::int`.as('cantidad'), sql<number>`sum(v.total)::float`.as('total')])
      .where('v.fechaVenta', '>=', r.d)
      .where('v.fechaVenta', '<', r.h)
      .groupBy(['p.id', 'p.nombre'])
      .orderBy('cantidad', 'desc')
      .limit(15)
      .execute();
    res.json({ desde: r.desde, hasta: r.hasta, productos: rows, total: sum(rows, (x) => x.total) });
  }),
);

reportesRouter.get(
  '/clientes-inactivos',
  ah(async (req, res) => {
    const dias = Math.max(Number(req.query.dias) || 30, 1);
    const limite = parseDateStr(addDays(today(), -dias));
    const rows = await db
      .selectFrom('clientes as c')
      .select(['c.id', 'c.nombre', 'c.apellido', 'c.cedula', 'c.telefono'])
      .select((eb) =>
        eb.selectFrom('checkins as ch').whereRef('ch.clienteId', '=', 'c.id').where('ch.exitoso', '=', true).select((e2) => e2.fn.max('ch.fechaHora').as('f')).as('ultimaVisita'),
      )
      .where('c.activo', '=', true)
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('checkins as ch').select('ch.id').whereRef('ch.clienteId', '=', 'c.id').where('ch.fechaHora', '>=', limite))),
      )
      .orderBy('c.nombre')
      .execute();
    res.json({ dias, clientes: rows });
  }),
);

reportesRouter.get(
  '/ingresos',
  ah(async (req, res) => {
    const r = resolverRango(parse(rango, req.query));
    const movs = await db.selectFrom('movimientosCaja').selectAll().where('fecha', '>=', r.d).where('fecha', '<', r.h).execute();
    const porCategoria = new Map<string, { tipo: string; categoria: string; total: number; cantidad: number }>();
    for (const m of movs) {
      const k = `${m.tipo}|${m.categoria}`;
      const x = porCategoria.get(k) ?? { tipo: m.tipo, categoria: m.categoria, total: 0, cantidad: 0 };
      x.total += m.monto;
      x.cantidad++;
      porCategoria.set(k, x);
    }
    res.json({ desde: r.desde, hasta: r.hasta, ...totalesMovimientos(movs), porCategoria: [...porCategoria.values()].sort((a, b) => b.total - a.total) });
  }),
);

// ═════════════════════════════ NOTIFICACIONES ═════════════════════════════
export const notificacionesRouter = Router();

notificacionesRouter.get(
  '/',
  ah(async (_req, res) => {
    const [items, noLeidas] = await Promise.all([
      db.selectFrom('notificaciones').selectAll().orderBy('fechaCreacion', 'desc').limit(30).execute(),
      db.selectFrom('notificaciones').select((eb) => eb.fn.countAll<number>().as('n')).where('leida', '=', false).executeTakeFirstOrThrow(),
    ]);
    res.json({ items, noLeidas: noLeidas.n });
  }),
);

notificacionesRouter.post(
  '/leer-todas',
  ah(async (_req, res) => {
    await db.updateTable('notificaciones').set({ leida: true, fechaLeida: new Date() }).where('leida', '=', false).execute();
    res.json({ success: true });
  }),
);

notificacionesRouter.post(
  '/:id/leer',
  ah(async (req, res) => {
    await db.updateTable('notificaciones').set({ leida: true, fechaLeida: new Date() }).where('id', '=', req.params.id).execute();
    res.json({ success: true });
  }),
);

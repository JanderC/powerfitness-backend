import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../db/index.js';
import { diffDays, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { sum } from '../lib/money.js';
import { actualizarEstadosVencidas } from './membresias.service.js';

export const clientesRouter = Router();

const optStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const clienteSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es requerido').max(100),
  apellido: z.string().trim().min(1, 'El apellido es requerido').max(100),
  cedula: z.string().trim().min(3, 'Cédula inválida').max(20),
  telefono: optStr(20),
  email: z
    .string()
    .trim()
    .max(150)
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => !v || /^\S+@\S+\.\S+$/.test(v), 'Email inválido'),
  direccion: optStr(500),
  fechaNacimiento: z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, 10) : null)),
  peso: z.coerce.number().positive().max(500).nullish(),
  fotoBase64: z.string().nullish(),
  activo: z.boolean().optional(),
});

// Columnas livianas para listados (sin plantillas de huella)
const LIST_COLS = [
  'c.id',
  'c.nombre',
  'c.apellido',
  'c.cedula',
  'c.telefono',
  'c.email',
  'c.fechaNacimiento',
  'c.direccion',
  'c.peso',
  'c.activo',
  'c.createdAt',
] as const;

/**
 * Listado con estado de mensualidad calculado (activa / por vencer / vencida / sin plan)
 * y saldo de deuda. Soporta búsqueda y paginación.
 */
clientesRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        buscar: z.string().optional(),
        estado: z.enum(['todos', 'activos', 'inactivos']).default('todos'),
        conFoto: z.coerce.boolean().default(false),
        pagina: z.coerce.number().int().min(1).default(1),
        porPagina: z.coerce.number().int().min(1).max(1000).default(50),
      }),
      req.query,
    );
    await actualizarEstadosVencidas();

    let query = db.selectFrom('clientes as c');
    if (q.buscar?.trim()) {
      const term = `%${q.buscar.trim().toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(eb.fn('lower', [sql`c.nombre || ' ' || c.apellido`]), 'like', term),
          eb('c.cedula', 'like', term),
          eb(eb.fn('coalesce', ['c.telefono', sql.lit('')]), 'like', term),
        ]),
      );
    }
    if (q.estado === 'activos') query = query.where('c.activo', '=', true);
    if (q.estado === 'inactivos') query = query.where('c.activo', '=', false);

    const { total } = await query.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();

    const rows = await query
      .select([...LIST_COLS])
      .$if(q.conFoto, (qb) => qb.select('c.fotoBase64'))
      .select((eb) => [
        eb
          .selectFrom('membresias as m')
          .innerJoin('planes as p', 'p.id', 'm.planId')
          .whereRef('m.clienteId', '=', 'c.id')
          .orderBy('m.fechaVencimiento', 'desc')
          .limit(1)
          .select(sql<string>`json_build_object('id', m.id, 'estado', m.estado, 'fechaVencimiento', m.fecha_vencimiento, 'plan', p.nombre, 'color', p.color)`.as('x'))
          .as('ultimaMembresia'),
        eb
          .selectFrom('deudasClientes as d')
          .whereRef('d.clienteId', '=', 'c.id')
          .where('d.estado', '=', 'pendiente')
          .select(sql<number>`coalesce(sum(d.saldo), 0)::float`.as('s'))
          .as('saldoDeuda'),
      ])
      .orderBy('c.createdAt', 'desc')
      .orderBy('c.nombre')
      .limit(q.porPagina)
      .offset((q.pagina - 1) * q.porPagina)
      .execute();

    const hoy = today();
    const items = rows.map((c) => {
      const um = c.ultimaMembresia as unknown as { id: string; estado: string; fechaVencimiento: string; plan: string; color: string } | null;
      const dias = um ? diffDays(hoy, um.fechaVencimiento) : null;
      return {
        ...c,
        ultimaMembresia: um ? { ...um, diasRestantes: dias } : null,
        estadoMembresia: !um ? 'sin_plan' : um.estado !== 'activa' ? um.estado : dias! <= 7 ? 'por_vencer' : 'activa',
      };
    });
    res.json({ items, total, pagina: q.pagina, porPagina: q.porPagina, totalPaginas: Math.ceil(total / q.porPagina) });
  }),
);

/** Búsqueda rápida para autocompletar (POS, membresías, deudas). */
clientesRouter.get(
  '/buscar',
  ah(async (req, res) => {
    const term = String(req.query.q ?? '').trim().toLowerCase();
    if (term.length < 1) return res.json([]);
    const rows = await db
      .selectFrom('clientes as c')
      .select(['c.id', 'c.nombre', 'c.apellido', 'c.cedula', 'c.telefono', 'c.activo'])
      .where('c.activo', '=', true)
      .where((eb) =>
        eb.or([
          eb(eb.fn('lower', [sql`c.nombre || ' ' || c.apellido`]), 'like', `%${term}%`),
          eb('c.cedula', 'like', `%${term}%`),
        ]),
      )
      .orderBy('c.nombre')
      .limit(15)
      .execute();
    res.json(rows);
  }),
);

/** Ficha completa: datos, mensualidades, pagos, asistencias y deudas. */
clientesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const cliente = await db
      .selectFrom('clientes as c')
      .select([...LIST_COLS, 'c.fotoBase64'])
      .select((eb) =>
        eb
          .case()
          .when(eb.or([eb('c.huellaTemplate', 'is not', null), eb('c.huellaTemplate1', 'is not', null)]))
          .then(true)
          .else(false)
          .end()
          .as('tieneHuella'),
      )
      .where('c.id', '=', req.params.id)
      .executeTakeFirst();
    if (!cliente) throw notFound('Cliente no encontrado');

    const hoy = today();
    const [membresias, checkins, deudas, pagos, totalCheckins] = await Promise.all([
      db
        .selectFrom('membresias as m')
        .innerJoin('planes as p', 'p.id', 'm.planId')
        .selectAll('m')
        .select(['p.nombre as planNombre', 'p.color as planColor', 'p.precio as planPrecio'])
        .where('m.clienteId', '=', cliente.id)
        .orderBy('m.fechaInicio', 'desc')
        .execute(),
      db
        .selectFrom('checkins')
        .select(['id', 'fechaHora', 'metodo', 'exitoso', 'nota'])
        .where('clienteId', '=', cliente.id)
        .orderBy('fechaHora', 'desc')
        .limit(30)
        .execute(),
      db
        .selectFrom('deudasClientes')
        .selectAll()
        .where('clienteId', '=', cliente.id)
        .orderBy('fechaCreacion', 'desc')
        .execute(),
      db
        .selectFrom('pagos')
        .select(['id', 'membresiaId', 'monto', 'metodoPago', 'fechaPago', 'notas'])
        .where('clienteId', '=', cliente.id)
        .orderBy('fechaPago', 'desc')
        .limit(50)
        .execute(),
      db
        .selectFrom('checkins')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('clienteId', '=', cliente.id)
        .where('exitoso', '=', true)
        .executeTakeFirstOrThrow(),
    ]);

    res.json({
      ...cliente,
      membresias: membresias.map((m) => ({
        ...m,
        diasRestantes: m.estado === 'activa' ? diffDays(hoy, m.fechaVencimiento) : 0,
        duracionTotal: diffDays(m.fechaInicio, m.fechaVencimiento) + 1,
      })),
      checkins,
      totalCheckins: totalCheckins.n,
      deudas,
      saldoDeuda: sum(
        deudas.filter((d) => d.estado === 'pendiente'),
        (d) => d.saldo,
      ),
      pagos,
    });
  }),
);

clientesRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(clienteSchema, req.body);
    const existe = await db.selectFrom('clientes').select('id').where('cedula', '=', body.cedula).executeTakeFirst();
    if (existe) throw badRequest('Ya existe un cliente con esa cédula');
    const cliente = await db
      .insertInto('clientes')
      .values({
        nombre: body.nombre,
        apellido: body.apellido,
        cedula: body.cedula,
        telefono: body.telefono,
        email: body.email,
        direccion: body.direccion,
        fechaNacimiento: body.fechaNacimiento,
        peso: body.peso ?? null,
        fotoBase64: body.fotoBase64 || null,
        activo: true,
        huellaTemplate: null,
        huellaDigital: null,
        huellaTemplate1: null,
        huellaTemplate2: null,
        huellaTemplate3: null,
        huellaTemplate4: null,
        huellaTemplate5: null,
        qualityScore: null,
        featureSet: null,
      })
      .returning(['id', 'nombre', 'apellido', 'cedula'])
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, data: cliente, message: 'Cliente creado exitosamente' });
  }),
);

clientesRouter.put(
  '/:id',
  ah(async (req, res) => {
    const body = parse(clienteSchema, req.body);
    const actual = await db.selectFrom('clientes').select('id').where('id', '=', req.params.id).executeTakeFirst();
    if (!actual) throw notFound('Cliente no encontrado');
    const dup = await db
      .selectFrom('clientes')
      .select('id')
      .where('cedula', '=', body.cedula)
      .where('id', '!=', req.params.id)
      .executeTakeFirst();
    if (dup) throw badRequest('Ya existe otro cliente con esa cédula');
    await db
      .updateTable('clientes')
      .set({
        nombre: body.nombre,
        apellido: body.apellido,
        cedula: body.cedula,
        telefono: body.telefono,
        email: body.email,
        direccion: body.direccion,
        fechaNacimiento: body.fechaNacimiento,
        peso: body.peso ?? null,
        ...(body.fotoBase64 !== undefined && { fotoBase64: body.fotoBase64 || null }),
        ...(body.activo !== undefined && { activo: body.activo }),
        updatedAt: today(),
      })
      .where('id', '=', req.params.id)
      .execute();
    res.json({ success: true, message: 'Cliente actualizado' });
  }),
);

clientesRouter.patch(
  '/:id/toggle-activo',
  ah(async (req, res) => {
    const c = await db
      .updateTable('clientes')
      .set((eb) => ({ activo: eb.not('activo'), updatedAt: today() }))
      .where('id', '=', req.params.id)
      .returning('activo')
      .executeTakeFirst();
    if (!c) throw notFound('Cliente no encontrado');
    res.json({ success: true, activo: c.activo, message: `Cliente ${c.activo ? 'activado' : 'desactivado'}` });
  }),
);

clientesRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const r = await db.deleteFrom('clientes').where('id', '=', req.params.id).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound('Cliente no encontrado');
    res.json({ success: true, message: 'Cliente eliminado' });
  }),
);

/** Guarda plantillas de huella enviadas por el puente del lector biométrico. */
clientesRouter.post(
  '/:id/huella',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        huellaTemplate: z.string().min(1),
        huellaDigital: z.string().nullish(),
        templates: z.array(z.string()).max(5).optional(),
      }),
      req.body,
    );
    const t = body.templates ?? [];
    const r = await db
      .updateTable('clientes')
      .set({
        huellaTemplate: body.huellaTemplate,
        huellaDigital: body.huellaDigital ?? null,
        huellaTemplate1: t[0] ?? null,
        huellaTemplate2: t[1] ?? null,
        huellaTemplate3: t[2] ?? null,
        huellaTemplate4: t[3] ?? null,
        huellaTemplate5: t[4] ?? null,
        updatedAt: today(),
      })
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Cliente no encontrado');
    res.json({ success: true, message: 'Huella guardada exitosamente' });
  }),
);

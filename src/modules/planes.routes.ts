import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../db/index.js';
import type { TipoCalculo } from '../db/types.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { describirDuracion } from './membresias.service.js';

export const planesRouter = Router();

export const TIPOS_PLAN = ['semanal', 'mensual', 'personalizado', 'diario', 'trimestral', 'semestral', 'anual', 'otro'] as const;
const TIPOS_CALCULO = ['dias', 'semanas', 'meses', 'anios'] as const;

const planSchema = z
  .object({
    nombre: z.string().trim().min(1, 'El nombre del plan es requerido').max(100),
    descripcion: z.string().trim().nullish(),
    tipo: z.string().toLowerCase().pipe(z.enum(TIPOS_PLAN)),
    tipoCalculoVencimiento: z.string().toLowerCase().pipe(z.enum(TIPOS_CALCULO)).default('dias'),
    cantidadUnidades: z.coerce.number().int().positive('La cantidad de unidades debe ser mayor a 0').default(1),
    duracionDias: z.coerce.number().int().min(0).default(0),
    precio: z.coerce.number().positive('El precio debe ser mayor a 0'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido')
      .nullish(),
    activo: z.boolean().default(true),
    // Plan grupal: el precio cubre a varias personas (ej. Promo Dúo = 2)
    personas: z.coerce.number().int().min(1, 'Mínimo 1 persona').max(10, 'Máximo 10 personas').default(1),
    promocional: z.boolean().default(false),
  })
  .transform((p) => {
    // Igual que el sistema original: duracion_dias aproximada para planes por meses/semanas/años
    if (p.tipoCalculoVencimiento === 'dias') {
      if (p.duracionDias <= 0) p.duracionDias = p.cantidadUnidades;
      p.cantidadUnidades = p.duracionDias;
    } else {
      const factor = { semanas: 7, meses: 30, anios: 365 }[p.tipoCalculoVencimiento];
      p.duracionDias = p.cantidadUnidades * factor;
    }
    return p;
  });

const withDuracion = <T extends { tipoCalculoVencimiento: TipoCalculo; cantidadUnidades: number; duracionDias: number; precio: number; personas: number }>(p: T) => ({
  ...p,
  duracionTexto: describirDuracion(p),
  precioPorPersona: Math.round((p.precio / Math.max(p.personas, 1)) * 100) / 100,
});

planesRouter.get(
  '/',
  ah(async (req, res) => {
    const soloActivos = req.query.activos === 'true';
    const planes = await db
      .selectFrom('planes as p')
      .selectAll('p')
      .select((eb) => [
        eb
          .selectFrom('membresias as m')
          .whereRef('m.planId', '=', 'p.id')
          .where('m.estado', '=', 'activa')
          .select(sql<number>`count(*)::int`.as('n'))
          .as('membresiasActivas'),
        eb
          .selectFrom('membresias as m')
          .whereRef('m.planId', '=', 'p.id')
          .select(sql<number>`count(*)::int`.as('n'))
          .as('totalVendidas'),
      ])
      .$if(soloActivos, (qb) => qb.where('p.activo', '=', true))
      .orderBy('p.activo', 'desc')
      .orderBy('p.precio')
      .execute();
    res.json(planes.map(withDuracion));
  }),
);

planesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const plan = await db.selectFrom('planes').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!plan) throw notFound('Plan no encontrado');
    res.json(withDuracion(plan));
  }),
);

async function nombreDuplicado(nombre: string, exceptId?: string) {
  const r = await db
    .selectFrom('planes')
    .select('id')
    .where((eb) => eb(eb.fn('lower', ['nombre']), '=', nombre.toLowerCase()))
    .$if(!!exceptId, (qb) => qb.where('id', '!=', exceptId!))
    .executeTakeFirst();
  return !!r;
}

planesRouter.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = parse(planSchema, req.body);
    if (await nombreDuplicado(p.nombre)) throw badRequest('Ya existe un plan con ese nombre');
    const plan = await db
      .insertInto('planes')
      .values({ ...p, descripcion: p.descripcion ?? null, color: p.color ?? '#1E6FE3' })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, data: withDuracion(plan), message: 'Plan creado exitosamente' });
  }),
);

planesRouter.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = parse(planSchema, req.body);
    const actual = await db.selectFrom('planes').select('id').where('id', '=', req.params.id).executeTakeFirst();
    if (!actual) throw notFound('Plan no encontrado');
    if (await nombreDuplicado(p.nombre, req.params.id)) throw badRequest('Ya existe otro plan con ese nombre');
    await db
      .updateTable('planes')
      .set({ ...p, descripcion: p.descripcion ?? null, color: p.color ?? '#1E6FE3', updatedAt: new Date() })
      .where('id', '=', req.params.id)
      .execute();
    res.json({ success: true, message: 'Plan actualizado' });
  }),
);

planesRouter.patch(
  '/:id/toggle-activo',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = await db
      .updateTable('planes')
      .set((eb) => ({ activo: eb.not('activo'), updatedAt: new Date() }))
      .where('id', '=', req.params.id)
      .returning('activo')
      .executeTakeFirst();
    if (!p) throw notFound('Plan no encontrado');
    res.json({ success: true, activo: p.activo, message: `Plan ${p.activo ? 'activado' : 'desactivado'} exitosamente` });
  }),
);

planesRouter.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const usado = await db.selectFrom('membresias').select('id').where('planId', '=', req.params.id).executeTakeFirst();
    if (usado) throw badRequest('No se puede eliminar el plan porque tiene membresías asociadas. Puede desactivarlo en su lugar.');
    const r = await db.deleteFrom('planes').where('id', '=', req.params.id).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound('Plan no encontrado');
    res.json({ success: true, message: 'Plan eliminado exitosamente' });
  }),
);

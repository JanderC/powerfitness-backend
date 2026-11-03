import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { isDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { cop, sum } from '../lib/money.js';
import { userId } from '../middleware/auth.js';
import { registrarMovimientoCaja } from './caja.service.js';

export const empleadosRouter = Router();

const optStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const empleadoSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  apellido: z.string().trim().min(1).max(100),
  cedula: z.string().trim().min(3).max(20),
  telefono: optStr(20),
  email: optStr(150),
  cargo: optStr(50),
  salario: z.coerce.number().min(0).nullish(),
  fechaContratacion: z.string().refine(isDateStr).nullish(),
  activo: z.boolean().default(true),
});

empleadosRouter.get(
  '/',
  ah(async (_req, res) => {
    const rows = await db
      .selectFrom('empleados as e')
      .selectAll('e')
      .select((eb) =>
        eb.selectFrom('pagosEmpleados as p').whereRef('p.empleadoId', '=', 'e.id').select((e2) => e2.fn.max('p.fechaPago').as('f')).as('ultimoPago'),
      )
      .orderBy('e.activo', 'desc')
      .orderBy('e.nombre')
      .execute();
    res.json(rows);
  }),
);

empleadosRouter.post(
  '/',
  ah(async (req, res) => {
    const b = parse(empleadoSchema, req.body);
    const dup = await db.selectFrom('empleados').select('id').where('cedula', '=', b.cedula).executeTakeFirst();
    if (dup) throw badRequest('Ya existe un empleado con esta cédula');
    const e = await db
      .insertInto('empleados')
      .values({ ...b, salario: b.salario ?? null, fechaContratacion: b.fechaContratacion?.slice(0, 10) ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, data: e, message: 'Empleado creado' });
  }),
);

empleadosRouter.put(
  '/:id',
  ah(async (req, res) => {
    const b = parse(empleadoSchema, req.body);
    const dup = await db.selectFrom('empleados').select('id').where('cedula', '=', b.cedula).where('id', '!=', req.params.id).executeTakeFirst();
    if (dup) throw badRequest('Ya existe otro empleado con esta cédula');
    const r = await db
      .updateTable('empleados')
      .set({ ...b, salario: b.salario ?? null, fechaContratacion: b.fechaContratacion?.slice(0, 10) ?? null, updatedAt: today() })
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Empleado no encontrado');
    res.json({ success: true, message: 'Empleado actualizado' });
  }),
);

/** Desactiva (no borra: conserva el historial de pagos). */
empleadosRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const r = await db.updateTable('empleados').set({ activo: false, updatedAt: today() }).where('id', '=', req.params.id).executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Empleado no encontrado');
    res.json({ success: true, message: 'Empleado desactivado' });
  }),
);

/** Pago de salario: registra el pago y el egreso en caja diaria. */
empleadosRouter.post(
  '/:id/pagar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        monto: z.coerce.number().positive('El monto debe ser mayor a 0'),
        periodo: z.string().trim().min(1, 'Indica el periodo').max(50),
        metodoPago: z.enum(['efectivo', 'transferencia']).default('efectivo'),
        notas: z.string().trim().max(300).nullish(),
      }),
      req.body,
    );
    const uid = userId(req);
    await db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom('empleados').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!e || !e.activo) throw badRequest('Empleado no encontrado o inactivo');
      const pago = await trx
        .insertInto('pagosEmpleados')
        .values({ empleadoId: e.id, monto: b.monto, periodo: b.periodo, metodoPago: b.metodoPago, notas: b.notas || null, fechaPago: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await registrarMovimientoCaja(trx, {
        tipo: 'egreso',
        categoria: 'salario',
        monto: b.monto,
        descripcion: `Pago salario ${b.periodo} - ${e.nombre} ${e.apellido}`,
        referenciaId: pago.id,
        usuarioId: uid,
        metodoPago: b.metodoPago,
      });
    });
    res.json({ success: true, message: `Pago de ${cop(b.monto)} registrado` });
  }),
);

empleadosRouter.get(
  '/:id/pagos',
  ah(async (req, res) => {
    const pagos = await db.selectFrom('pagosEmpleados').selectAll().where('empleadoId', '=', req.params.id).orderBy('fechaPago', 'desc').execute();
    res.json({ pagos, totalPagado: sum(pagos, (p) => p.monto) });
  }),
);

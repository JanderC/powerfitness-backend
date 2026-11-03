import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../db/index.js';
import { diffDays, isDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { cop, r2, sum } from '../lib/money.js';
import { userId } from '../middleware/auth.js';
import { registrarMovimientoCaja } from './caja.service.js';

/** Unifica DeudasController + HistorialDeudaController del sistema .NET. */
export const deudasRouter = Router();

const conDias = <T extends { fechaVencimiento: string | null; saldo: number; estado: string }>(d: T) => {
  const dias = d.fechaVencimiento ? diffDays(today(), d.fechaVencimiento) : null;
  return {
    ...d,
    diasParaVencer: dias,
    venceProximamente: dias !== null && dias >= 0 && dias <= 7 && d.saldo > 0 && d.estado === 'pendiente',
    vencida: dias !== null && dias < 0 && d.estado === 'pendiente',
  };
};

deudasRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        estado: z.enum(['pendiente', 'pagada', 'cancelada', 'todas']).default('pendiente'),
        buscar: z.string().optional(),
      }),
      req.query,
    );
    let query = db
      .selectFrom('deudasClientes as d')
      .innerJoin('clientes as c', 'c.id', 'd.clienteId')
      .selectAll('d')
      .select(['c.nombre as clienteNombre', 'c.apellido as clienteApellido', 'c.cedula as clienteCedula', 'c.telefono as clienteTelefono']);
    if (q.estado !== 'todas') query = query.where('d.estado', '=', q.estado);
    if (q.buscar?.trim()) {
      const t = `%${q.buscar.trim().toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(eb.fn('lower', [sql`c.nombre || ' ' || c.apellido`]), 'like', t),
          eb('c.cedula', 'like', t),
          eb(eb.fn('lower', ['d.concepto']), 'like', t),
        ]),
      );
    }
    const rows = (await query.orderBy('d.fechaCreacion', 'desc').limit(2000).execute()).map(conDias);
    const pendientes = rows.filter((d) => d.estado === 'pendiente');
    res.json({
      items: rows,
      resumen: {
        totalDeudas: rows.length,
        totalPendiente: sum(pendientes, (d) => d.saldo),
        countPendientes: pendientes.length,
        countVencidas: rows.filter((d) => d.vencida).length,
        countVenceProximamente: rows.filter((d) => d.venceProximamente).length,
        clientesConDeuda: new Set(pendientes.map((d) => d.clienteId)).size,
      },
    });
  }),
);

deudasRouter.get(
  '/:id',
  ah(async (req, res) => {
    const d = await db
      .selectFrom('deudasClientes as d')
      .innerJoin('clientes as c', 'c.id', 'd.clienteId')
      .selectAll('d')
      .select(['c.nombre as clienteNombre', 'c.apellido as clienteApellido', 'c.cedula as clienteCedula'])
      .where('d.id', '=', req.params.id)
      .executeTakeFirst();
    if (!d) throw notFound('Deuda no encontrada');
    const abonos = await db.selectFrom('abonosDeuda').selectAll().where('deudaId', '=', d.id).orderBy('fechaAbono').execute();
    let saldo = d.montoTotal;
    res.json({
      ...conDias(d),
      abonos: abonos.map((a) => {
        saldo = r2(saldo - a.monto);
        return { ...a, saldoTrasAbono: Math.max(saldo, 0) };
      }),
      totalAbonado: sum(abonos, (a) => a.monto),
    });
  }),
);

deudasRouter.post(
  '/',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        clienteId: z.string().uuid('Selecciona un cliente'),
        concepto: z.string().trim().min(1, 'Concepto requerido').max(200),
        monto: z.coerce.number().positive('El monto debe ser mayor a 0'),
        fechaVencimiento: z.string().refine(isDateStr).nullish(),
        notas: z.string().trim().nullish(),
      }),
      req.body,
    );
    const c = await db.selectFrom('clientes').select('id').where('id', '=', b.clienteId).executeTakeFirst();
    if (!c) throw notFound('Cliente no encontrado');
    const deuda = await db
      .insertInto('deudasClientes')
      .values({
        clienteId: b.clienteId,
        concepto: b.concepto,
        montoTotal: b.monto,
        montoPagado: 0,
        saldo: b.monto,
        estado: 'pendiente',
        fechaVencimiento: b.fechaVencimiento?.slice(0, 10) ?? null,
        notas: b.notas || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, data: deuda, message: 'Deuda registrada' });
  }),
);

/** Abono: registra el abono, el ingreso en caja diaria y actualiza saldo/estado. */
deudasRouter.post(
  '/:id/abonar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        monto: z.coerce.number().positive('El monto debe ser mayor a 0'),
        metodoPago: z.enum(['efectivo', 'transferencia']).default('efectivo'),
        notas: z.string().trim().max(300).nullish(),
      }),
      req.body,
    );
    const uid = userId(req);
    const r = await db.transaction().execute(async (trx) => {
      const d = await trx
        .selectFrom('deudasClientes as d')
        .innerJoin('clientes as c', 'c.id', 'd.clienteId')
        .selectAll('d')
        .select(['c.nombre', 'c.apellido'])
        .where('d.id', '=', req.params.id)
        .forUpdate('d')
        .executeTakeFirst();
      if (!d) throw notFound('Deuda no encontrada');
      if (d.estado === 'pagada') throw badRequest('Esta deuda ya está completamente pagada');
      if (d.estado === 'cancelada') throw badRequest('Esta deuda fue cancelada y no admite abonos');
      if (b.monto > d.saldo) throw badRequest(`El abono (${cop(b.monto)}) supera el saldo pendiente (${cop(d.saldo)})`);

      await trx
        .insertInto('abonosDeuda')
        .values({ deudaId: d.id, monto: b.monto, metodoPago: b.metodoPago, notas: b.notas || `Abono — ${d.concepto}` })
        .execute();
      await registrarMovimientoCaja(trx, {
        tipo: 'ingreso',
        categoria: 'abono_deuda',
        metodoPago: b.metodoPago,
        monto: b.monto,
        descripcion: `Abono deuda — ${d.nombre} ${d.apellido} — ${d.concepto}`,
        referenciaId: d.id,
        usuarioId: uid,
      });
      const montoPagado = r2(d.montoPagado + b.monto);
      const saldo = Math.max(r2(d.montoTotal - montoPagado), 0);
      const estado = saldo <= 0 ? 'pagada' : 'pendiente';
      await trx.updateTable('deudasClientes').set({ montoPagado, saldo, estado }).where('id', '=', d.id).execute();
      return { estado, saldo, montoPagado };
    });
    res.json({
      success: true,
      estadoDeuda: r.estado,
      saldoRestante: r.saldo,
      montoPagado: r.montoPagado,
      message: r.estado === 'pagada' ? 'Deuda pagada completamente' : `Abono registrado. Saldo: ${cop(r.saldo)}`,
    });
  }),
);

deudasRouter.patch(
  '/:id/estado',
  ah(async (req, res) => {
    const b = parse(
      z.object({ nuevoEstado: z.enum(['pendiente', 'pagada', 'cancelada']), motivo: z.string().trim().max(200).nullish() }),
      req.body,
    );
    const d = await db.selectFrom('deudasClientes').select(['id', 'estado', 'notas']).where('id', '=', req.params.id).executeTakeFirst();
    if (!d) throw notFound('Deuda no encontrada');
    if (d.estado === 'pagada' && b.nuevoEstado !== 'cancelada') {
      throw badRequest('No se puede cambiar el estado de una deuda ya pagada');
    }
    await db
      .updateTable('deudasClientes')
      .set({
        estado: b.nuevoEstado,
        notas: b.motivo ? [d.notas, `${b.nuevoEstado}: ${b.motivo}`].filter(Boolean).join(' · ') : d.notas,
      })
      .where('id', '=', d.id)
      .execute();
    res.json({ success: true, estadoAnterior: d.estado, estadoNuevo: b.nuevoEstado, message: 'Estado actualizado' });
  }),
);

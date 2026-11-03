import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { addDays, isDateStr, parseDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { cop, r2 } from '../lib/money.js';
import { requireRole, userId } from '../middleware/auth.js';
import { registrarMovimientoCaja } from './caja.service.js';

// ═════════════════════════════ PRODUCTOS ═════════════════════════════
export const productosRouter = Router();

const productoSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre del producto es requerido').max(150),
  descripcion: z.string().trim().nullish(),
  precio: z.coerce.number().positive('El precio debe ser mayor a 0'),
  stock: z.coerce.number().int().min(0, 'El stock no puede ser negativo'),
  imagenBase64: z.string().nullish(),
  categoria: z.string().trim().max(50).nullish(),
  activo: z.boolean().default(true),
});

productosRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        buscar: z.string().optional(),
        categoria: z.string().optional(),
        soloDisponibles: z.coerce.boolean().default(false),
      }),
      req.query,
    );
    let query = db.selectFrom('productos').selectAll();
    if (q.buscar?.trim()) {
      const t = `%${q.buscar.trim().toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(eb.fn('lower', ['nombre']), 'like', t),
          eb(eb.fn('lower', [eb.fn.coalesce('descripcion', sql.lit(''))]), 'like', t),
          eb(eb.fn('lower', [eb.fn.coalesce('categoria', sql.lit(''))]), 'like', t),
        ]),
      );
    }
    if (q.categoria) query = query.where('categoria', '=', q.categoria);
    if (q.soloDisponibles) query = query.where('activo', '=', true).where('stock', '>', 0);
    const rows = await query.orderBy('activo', 'desc').orderBy('nombre').execute();
    res.json(rows.map((p) => ({ ...p, stockBajo: p.activo && p.stock <= env.STOCK_MINIMO })));
  }),
);

productosRouter.get(
  '/categorias',
  ah(async (_req, res) => {
    const rows = await db
      .selectFrom('productos')
      .select('categoria')
      .distinct()
      .where('categoria', 'is not', null)
      .where('categoria', '!=', '')
      .orderBy('categoria')
      .execute();
    res.json(rows.map((r) => r.categoria));
  }),
);

productosRouter.get(
  '/:id',
  ah(async (req, res) => {
    const p = await db.selectFrom('productos').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!p) throw notFound('Producto no encontrado');
    res.json(p);
  }),
);

productosRouter.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = parse(productoSchema, req.body);
    const data = await db
      .insertInto('productos')
      .values({ ...p, descripcion: p.descripcion ?? null, imagenBase64: p.imagenBase64 ?? null, categoria: p.categoria ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, data, message: 'Producto creado' });
  }),
);

productosRouter.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = parse(productoSchema, req.body);
    const r = await db
      .updateTable('productos')
      .set({
        ...p,
        descripcion: p.descripcion ?? null,
        imagenBase64: p.imagenBase64 ?? null,
        categoria: p.categoria ?? null,
        updatedAt: new Date(),
      })
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Producto no encontrado');
    res.json({ success: true, message: 'Producto actualizado' });
  }),
);

productosRouter.patch(
  '/:id/toggle-activo',
  requireRole('admin'),
  ah(async (req, res) => {
    const p = await db
      .updateTable('productos')
      .set((eb) => ({ activo: eb.not('activo'), updatedAt: new Date() }))
      .where('id', '=', req.params.id)
      .returning('activo')
      .executeTakeFirst();
    if (!p) throw notFound('Producto no encontrado');
    res.json({ success: true, activo: p.activo, message: `Producto ${p.activo ? 'activado' : 'desactivado'}` });
  }),
);

/** Ajuste de inventario: { nuevoStock } o { ajuste: +n / -n } */
productosRouter.patch(
  '/:id/stock',
  requireRole('admin'),
  ah(async (req, res) => {
    const b = parse(
      z.object({ nuevoStock: z.coerce.number().int().min(0).optional(), ajuste: z.coerce.number().int().optional() }),
      req.body,
    );
    const p = await db.selectFrom('productos').select(['id', 'stock']).where('id', '=', req.params.id).executeTakeFirst();
    if (!p) throw notFound('Producto no encontrado');
    const nuevo = b.nuevoStock ?? p.stock + (b.ajuste ?? 0);
    if (nuevo < 0) throw badRequest('El stock no puede ser negativo');
    await db.updateTable('productos').set({ stock: nuevo, updatedAt: new Date() }).where('id', '=', p.id).execute();
    res.json({ success: true, stock: nuevo, message: 'Stock actualizado' });
  }),
);

productosRouter.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const venta = await db.selectFrom('ventasProductos').select('id').where('productoId', '=', req.params.id).executeTakeFirst();
    if (venta) throw badRequest('No se puede eliminar el producto porque tiene ventas registradas. Puede desactivarlo en su lugar.');
    const r = await db.deleteFrom('productos').where('id', '=', req.params.id).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound('Producto no encontrado');
    res.json({ success: true, message: 'Producto eliminado' });
  }),
);

// ═════════════════════════════ VENTAS ═════════════════════════════
export const ventasRouter = Router();

ventasRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        desde: z.string().refine(isDateStr).optional(),
        hasta: z.string().refine(isDateStr).optional(),
        estado: z.enum(['pendiente', 'parcial', 'pagado', 'fiado']).optional(),
        clienteId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const desde = parseDateStr(q.desde ?? addDays(today(), -30));
    const hasta = parseDateStr(addDays(q.hasta ?? today(), 1));
    const rows = await db
      .selectFrom('ventasProductos as v')
      .innerJoin('productos as p', 'p.id', 'v.productoId')
      .leftJoin('clientes as c', 'c.id', 'v.clienteId')
      .selectAll('v')
      .select(['p.nombre as productoNombre', 'c.nombre as clienteNombre', 'c.apellido as clienteApellido'])
      .where('v.fechaVenta', '>=', desde)
      .where('v.fechaVenta', '<', hasta)
      .$if(!!q.estado, (qb) => qb.where('v.estadoPago', '=', q.estado!))
      .$if(!!q.clienteId, (qb) => qb.where('v.clienteId', '=', q.clienteId!))
      .orderBy('v.fechaVenta', 'desc')
      .limit(2000)
      .execute();
    res.json(rows);
  }),
);

/**
 * Venta (carrito). Igual que el sistema original: descuenta stock, registra el
 * ingreso en caja por lo pagado y crea una deuda por el saldo pendiente.
 * Nuevo: varios productos en una sola venta y el saldo fiado exige un cliente.
 */
ventasRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        clienteId: z.string().uuid().nullish(),
        items: z
          .array(
            z.object({
              productoId: z.string().uuid(),
              cantidad: z.coerce.number().int().positive('Cantidad inválida'),
              precioUnitario: z.coerce.number().positive().optional(),
            }),
          )
          .min(1, 'Agrega al menos un producto'),
        montoPagado: z.coerce.number().min(0).optional(),
        metodoPago: z.enum(['efectivo', 'transferencia']).default('efectivo'),
        notas: z.string().trim().max(300).nullish(),
      }),
      req.body,
    );
    const uid = userId(req);

    const result = await db.transaction().execute(async (trx) => {
      const cliente = body.clienteId
        ? await trx.selectFrom('clientes').select(['id', 'nombre', 'apellido']).where('id', '=', body.clienteId).executeTakeFirst()
        : null;
      if (body.clienteId && !cliente) throw badRequest('El cliente especificado no existe');

      const lineas: { productoId: string; nombre: string; cantidad: number; precio: number; total: number }[] = [];
      for (const it of body.items) {
        // Bloquea la fila para evitar sobreventa con ventas simultáneas
        const p = await trx.selectFrom('productos').selectAll().where('id', '=', it.productoId).forUpdate().executeTakeFirst();
        if (!p || !p.activo) throw badRequest('Uno de los productos no existe o está inactivo');
        if (p.stock < it.cantidad) throw badRequest(`Stock insuficiente de ${p.nombre}. Disponible: ${p.stock}`);
        const precio = it.precioUnitario ?? p.precio;
        lineas.push({ productoId: p.id, nombre: p.nombre, cantidad: it.cantidad, precio, total: r2(precio * it.cantidad) });
        await trx
          .updateTable('productos')
          .set({ stock: p.stock - it.cantidad, updatedAt: new Date() })
          .where('id', '=', p.id)
          .execute();
      }

      const total = r2(lineas.reduce((a, l) => a + l.total, 0));
      const pagado = body.montoPagado ?? total;
      if (pagado > total) throw badRequest('El monto pagado no puede ser mayor al total de la venta');
      const saldo = r2(total - pagado);
      if (saldo > 0 && !cliente) throw badRequest('Para dejar saldo pendiente (fiado) debes seleccionar un cliente');
      const estadoPago = pagado === 0 ? 'pendiente' : saldo > 0 ? 'parcial' : 'pagado';
      const resumen = lineas.map((l) => `${l.nombre} (x${l.cantidad})`).join(', ');

      const ventas = [];
      for (const l of lineas) {
        ventas.push(
          await trx
            .insertInto('ventasProductos')
            .values({
              clienteId: cliente?.id ?? null,
              productoId: l.productoId,
              cantidad: l.cantidad,
              precioUnitario: l.precio,
              total: l.total,
              estadoPago,
              fechaVenta: new Date(),
              fechaPago: estadoPago === 'pagado' ? new Date() : null,
              notas: body.notas || null,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }

      let deudaId: string | null = null;
      if (saldo > 0 && cliente) {
        const d = await trx
          .insertInto('deudasClientes')
          .values({
            clienteId: cliente.id,
            concepto: `Venta de ${resumen}`.slice(0, 200),
            montoTotal: saldo,
            montoPagado: 0,
            saldo,
            estado: 'pendiente',
            fechaVencimiento: null,
            notas: pagado > 0 ? `Abono inicial: ${cop(pagado)} de ${cop(total)}` : 'Venta fiada - Sin pago inicial',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        deudaId = d.id;
      }

      if (pagado > 0) {
        await registrarMovimientoCaja(trx, {
          tipo: 'ingreso',
          categoria: 'producto',
          monto: pagado,
          descripcion:
            `Venta de ${resumen} - ${cliente ? `${cliente.nombre} ${cliente.apellido}` : 'Venta rápida'}` +
            (saldo > 0 ? ` (Pago parcial, saldo: ${cop(saldo)})` : ''),
          referenciaId: ventas[0].id,
          usuarioId: uid,
          metodoPago: body.metodoPago,
        });
      }
      return { ventas, total, pagado, saldo, deudaId };
    });

    res.status(201).json({
      success: true,
      ...result,
      message: result.saldo > 0 ? `Venta registrada. Saldo pendiente: ${cop(result.saldo)}` : 'Venta registrada exitosamente',
    });
  }),
);

/** Anula una venta: devuelve el stock. (No toca la caja: si hubo pago, registrar egreso.) */
ventasRouter.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    await db.transaction().execute(async (trx) => {
      const v = await trx.selectFrom('ventasProductos').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!v) throw notFound('Venta no encontrada');
      await trx
        .updateTable('productos')
        .set((eb) => ({ stock: eb('stock', '+', v.cantidad), updatedAt: new Date() }))
        .where('id', '=', v.productoId)
        .execute();
      await trx.deleteFrom('ventasProductos').where('id', '=', v.id).execute();
    });
    res.json({ success: true, message: 'Venta anulada y stock devuelto' });
  }),
);

ventasRouter.post(
  '/:id/marcar-pagado',
  ah(async (req, res) => {
    const r = await db
      .updateTable('ventasProductos')
      .set({ estadoPago: 'pagado', fechaPago: new Date(), updatedAt: new Date() })
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Venta no encontrada');
    res.json({ success: true, message: 'Venta marcada como pagada' });
  }),
);

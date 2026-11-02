import { db, type Db } from '../db/index.js';
import type { Plan } from '../db/types.js';
import { addDays, addMonths, addYears, diffDays, formatDMY, today } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/http.js';
import { cop, r2 } from '../lib/money.js';

type PlanCalc = Pick<Plan, 'tipoCalculoVencimiento' | 'cantidadUnidades' | 'duracionDias'>;

/**
 * Misma regla que MembresiasController.CalcularFechaVencimiento (.NET):
 *  - meses/semanas/años: se suman al inicio (el día de vencimiento = inicio del siguiente ciclo)
 *  - días: inicio + duración - 1 (el día de inicio cuenta)
 */
export function calcularVencimiento(fechaInicio: string, plan: PlanCalc): string {
  switch (plan.tipoCalculoVencimiento) {
    case 'meses':
      return addMonths(fechaInicio, plan.cantidadUnidades);
    case 'semanas':
      return addDays(fechaInicio, plan.cantidadUnidades * 7);
    case 'anios':
      return addYears(fechaInicio, plan.cantidadUnidades);
    default:
      return addDays(fechaInicio, Math.max(plan.duracionDias, 1) - 1);
  }
}

export function describirDuracion(plan: PlanCalc): string {
  const n = plan.cantidadUnidades;
  switch (plan.tipoCalculoVencimiento) {
    case 'meses':
      return `${n} ${n === 1 ? 'mes' : 'meses'}`;
    case 'semanas':
      return `${n} ${n === 1 ? 'semana' : 'semanas'}`;
    case 'anios':
      return `${n} ${n === 1 ? 'año' : 'años'}`;
    default:
      return `${plan.duracionDias} ${plan.duracionDias === 1 ? 'día' : 'días'}`;
  }
}

let ultimaRevision = 0;

/** Marca como vencidas las membresías activas cuya fecha ya pasó (máx. 1 vez por minuto). */
export async function actualizarEstadosVencidas(force = false): Promise<number> {
  if (!force && Date.now() - ultimaRevision < 60_000) return 0;
  ultimaRevision = Date.now();
  const r = await db
    .updateTable('membresias')
    .set({ estado: 'vencida', updatedAt: today() })
    .where('estado', '=', 'activa')
    .where('fechaVencimiento', '<', today())
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0);
}

async function getPlanActivo(trx: Db, planId: string) {
  const plan = await trx.selectFrom('planes').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!plan || !plan.activo) throw badRequest('Plan no válido o inactivo');
  return plan;
}

async function getClienteActivo(trx: Db, clienteId: string) {
  const c = await trx.selectFrom('clientes').select(['id', 'nombre', 'apellido', 'activo']).where('id', '=', clienteId).executeTakeFirst();
  if (!c || !c.activo) throw badRequest('Cliente no válido o inactivo');
  return c;
}

interface CobroInput {
  trx: Db;
  clienteId: string;
  membresiaId: string;
  plan: Plan;
  montoPagado: number;
  metodoPago: string;
  usuarioId: string;
  categoria: 'membresia' | 'renovacion';
  descripcion: string;
  fechaVencimiento: string;
  notaPago: string | null;
}

/** Registra pago, deuda por saldo pendiente y el ingreso en caja diaria. */
async function registrarCobro(i: CobroInput) {
  const saldo = r2(i.plan.precio - i.montoPagado);

  if (i.montoPagado > 0) {
    await i.trx
      .insertInto('pagos')
      .values({
        membresiaId: i.membresiaId,
        clienteId: i.clienteId,
        monto: i.montoPagado,
        metodoPago: i.metodoPago,
        reciboNumero: null,
        notas: saldo > 0 ? 'Pago parcial de membresía' : i.notaPago,
      })
      .execute();
    await i.trx
      .insertInto('movimientosCaja')
      .values({
        tipo: 'ingreso',
        categoria: i.categoria,
        monto: i.montoPagado,
        descripcion: i.descripcion + (saldo > 0 ? ` (Pago parcial, saldo: ${cop(saldo)})` : ''),
        referenciaId: i.membresiaId,
        usuarioId: i.usuarioId,
        metodoPago: i.metodoPago,
        fecha: new Date(),
        cierreCajaId: null,
        movimientoCajaFuerteId: null,
      })
      .execute();
  }

  let deudaId: string | null = null;
  if (saldo > 0) {
    const deuda = await i.trx
      .insertInto('deudasClientes')
      .values({
        clienteId: i.clienteId,
        concepto: `Saldo ${i.categoria === 'renovacion' ? 'renovación' : 'membresía'} ${i.plan.nombre}`.slice(0, 200),
        montoTotal: i.plan.precio,
        montoPagado: i.montoPagado,
        saldo,
        estado: 'pendiente',
        fechaVencimiento: i.fechaVencimiento,
        notas: `Membresía ID: ${i.membresiaId}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    deudaId = deuda.id;
  }
  return { saldo, deudaId };
}

export interface CrearMembresiaInput {
  clienteId: string;
  planId: string;
  fechaInicio?: string;
  montoPagado: number;
  metodoPago: string;
  notas?: string | null;
}

export async function crearMembresia(input: CrearMembresiaInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    const cliente = await getClienteActivo(trx, input.clienteId);
    const plan = await getPlanActivo(trx, input.planId);
    if (input.montoPagado > plan.precio) throw badRequest('El monto pagado no puede ser mayor al precio del plan');

    const fechaInicio = input.fechaInicio ?? today();
    const fechaVencimiento = calcularVencimiento(fechaInicio, plan);
    const membresia = await trx
      .insertInto('membresias')
      .values({
        clienteId: cliente.id,
        planId: plan.id,
        fechaInicio,
        fechaVencimiento,
        estado: fechaVencimiento < today() ? 'vencida' : 'activa',
        montoPagado: input.montoPagado,
        metodoPago: input.metodoPago,
        notas: input.notas || null,
        fechaSuspension: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const { saldo, deudaId } = await registrarCobro({
      trx,
      clienteId: cliente.id,
      membresiaId: membresia.id,
      plan,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      usuarioId,
      categoria: 'membresia',
      descripcion: `Venta membresía ${plan.nombre} - ${cliente.nombre} ${cliente.apellido}`,
      fechaVencimiento,
      notaPago: null,
    });

    return {
      data: membresia,
      deudaId,
      saldoPendiente: saldo,
      message:
        saldo > 0
          ? `Membresía creada. Vence el ${formatDMY(fechaVencimiento)}. Saldo pendiente: ${cop(saldo)}`
          : `Membresía creada. Vence el ${formatDMY(fechaVencimiento)}`,
    };
  });
}

export interface RenovarInput {
  planId?: string;
  montoPagado: number;
  metodoPago: string;
  desde: 'hoy' | 'vencimiento';
  notas?: string | null;
}

/**
 * Renovación. A diferencia del sistema anterior (que sobrescribía la misma fila
 * y perdía el historial), aquí se crea una NUEVA membresía encadenada:
 *  - desde 'vencimiento': empieza el día que vence la actual (no se pierden días)
 *  - desde 'hoy': empieza hoy y la anterior se cierra
 * Permite pago parcial: el saldo queda como deuda del cliente.
 */
export async function renovarMembresia(membresiaId: string, input: RenovarInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    const actual = await trx.selectFrom('membresias').selectAll().where('id', '=', membresiaId).executeTakeFirst();
    if (!actual) throw notFound('Membresía no encontrada');
    const cliente = await getClienteActivo(trx, actual.clienteId);
    const plan = await getPlanActivo(trx, input.planId ?? actual.planId);
    if (input.montoPagado < 0 || input.montoPagado > plan.precio) {
      throw badRequest(`El monto debe estar entre $0 y ${cop(plan.precio)}`);
    }

    const hoy = today();
    // Si ya venció, "desde vencimiento" no tiene sentido: arranca hoy
    const desdeVenc = input.desde === 'vencimiento' && actual.fechaVencimiento >= hoy;
    const fechaInicio = desdeVenc ? actual.fechaVencimiento : hoy;
    const fechaVencimiento = calcularVencimiento(fechaInicio, plan);
    const cambioPlan = plan.id !== actual.planId;
    const etiqueta = desdeVenc ? 'Renovación desde fecha de vencimiento' : 'Renovación desde hoy';

    if (!desdeVenc && (actual.estado === 'activa' || actual.estado === 'suspendida')) {
      await trx
        .updateTable('membresias')
        .set({
          estado: 'vencida',
          fechaSuspension: null,
          notas: [actual.notas, `Reemplazada por renovación el ${formatDMY(hoy)}`].filter(Boolean).join(' · '),
          updatedAt: hoy,
        })
        .where('id', '=', actual.id)
        .execute();
    }

    const nueva = await trx
      .insertInto('membresias')
      .values({
        clienteId: cliente.id,
        planId: plan.id,
        fechaInicio,
        fechaVencimiento,
        estado: 'activa',
        montoPagado: input.montoPagado,
        metodoPago: input.metodoPago,
        notas: input.notas || (cambioPlan ? `Renovación con cambio a ${plan.nombre}` : etiqueta),
        fechaSuspension: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const { saldo, deudaId } = await registrarCobro({
      trx,
      clienteId: cliente.id,
      membresiaId: nueva.id,
      plan,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      usuarioId,
      categoria: 'renovacion',
      descripcion: `Renovación ${plan.nombre} - ${cliente.nombre} ${cliente.apellido} (${etiqueta})`,
      fechaVencimiento,
      notaPago: etiqueta,
    });

    return {
      data: nueva,
      deudaId,
      saldoPendiente: saldo,
      message: `Membresía renovada ${desdeVenc ? 'desde su vencimiento' : 'desde HOY'} por ${describirDuracion(plan)}. Vence el ${formatDMY(fechaVencimiento)}${saldo > 0 ? `. Saldo pendiente: ${cop(saldo)}` : ''}`,
    };
  });
}

/** Congela la mensualidad: los días que dure congelada se devuelven al reanudar. */
export async function suspenderMembresia(id: string, motivo?: string | null) {
  const m = await db.selectFrom('membresias').selectAll().where('id', '=', id).executeTakeFirst();
  if (!m) throw notFound('Membresía no encontrada');
  if (m.estado !== 'activa') throw badRequest('Solo se pueden congelar membresías activas');
  const hoy = today();
  await db
    .updateTable('membresias')
    .set({
      estado: 'suspendida',
      fechaSuspension: hoy,
      notas: [m.notas, `Congelada el ${formatDMY(hoy)}${motivo ? `: ${motivo}` : ''}`].filter(Boolean).join(' · '),
      updatedAt: hoy,
    })
    .where('id', '=', id)
    .execute();
  return { message: 'Membresía congelada. Los días restantes se conservarán al reanudarla.' };
}

export async function reanudarMembresia(id: string) {
  const m = await db.selectFrom('membresias').selectAll().where('id', '=', id).executeTakeFirst();
  if (!m) throw notFound('Membresía no encontrada');
  if (m.estado !== 'suspendida') throw badRequest('La membresía no está congelada');
  const hoy = today();
  const diasCongelada = m.fechaSuspension ? Math.max(diffDays(m.fechaSuspension, hoy), 0) : 0;
  const nuevoVenc = addDays(m.fechaVencimiento, diasCongelada);
  await db
    .updateTable('membresias')
    .set({
      estado: nuevoVenc < hoy ? 'vencida' : 'activa',
      fechaVencimiento: nuevoVenc,
      fechaSuspension: null,
      notas: [m.notas, `Reanudada el ${formatDMY(hoy)} (+${diasCongelada} días)`].filter(Boolean).join(' · '),
      updatedAt: hoy,
    })
    .where('id', '=', id)
    .execute();
  return {
    diasCongelada,
    fechaVencimiento: nuevoVenc,
    message: `Membresía reanudada. Se sumaron ${diasCongelada} días: ahora vence el ${formatDMY(nuevoVenc)}`,
  };
}

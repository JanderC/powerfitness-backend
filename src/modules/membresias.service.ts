import crypto from 'node:crypto';
import { db, type Db } from '../db/index.js';
import type { Plan } from '../db/types.js';
import { addDays, addMonths, addYears, diffDays, formatDMY, today } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/http.js';
import { cop, r2 } from '../lib/money.js';
import { registrarMovimientoCaja } from './caja.service.js';

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

type ClienteMin = { id: string; nombre: string; apellido: string };

const nombreGrupo = (cs: ClienteMin[]) => cs.map((c) => `${c.nombre} ${c.apellido}`).join(' y ');

/** Reparte el monto entre las personas del grupo (el residuo de redondeo queda en el titular). */
function repartir(total: number, n: number): number[] {
  const parte = Math.floor((total / n) * 100) / 100;
  const partes = Array.from({ length: n }, () => parte);
  partes[0] = r2(total - parte * (n - 1));
  return partes;
}

/**
 * Valida las personas de un plan: titular + acompañantes deben ser exactamente
 * `plan.personas` clientes activos y distintos.
 */
async function resolverIntegrantes(trx: Db, plan: Plan, titularId: string, acompanantes: string[] = []) {
  const ids = [titularId, ...acompanantes.filter((x) => x && x !== titularId)];
  if (new Set(ids).size !== ids.length) throw badRequest('No puedes repetir la misma persona en el plan');
  if (ids.length !== plan.personas) {
    throw badRequest(
      plan.personas > 1
        ? `El plan "${plan.nombre}" es para ${plan.personas} personas: selecciona ${plan.personas - 1} acompañante${plan.personas > 2 ? 's' : ''}`
        : `El plan "${plan.nombre}" es individual`,
    );
  }
  const clientes: ClienteMin[] = [];
  for (const id of ids) clientes.push(await getClienteActivo(trx, id));
  return clientes;
}

interface CobroInput {
  trx: Db;
  clientes: ClienteMin[];
  membresiaIds: string[];
  plan: Plan;
  montoPagado: number;
  metodoPago: string;
  usuarioId: string;
  categoria: 'membresia' | 'renovacion';
  descripcion: string;
  fechaVencimiento: string;
  notaPago: string | null;
}

/**
 * Registra el cobro de una o varias mensualidades vendidas juntas:
 * un pago por persona (monto repartido), UN solo ingreso en caja y,
 * si queda saldo, UNA deuda a nombre del titular.
 */
async function registrarCobro(i: CobroInput) {
  const saldo = r2(i.plan.precio - i.montoPagado);
  const grupal = i.clientes.length > 1;

  if (i.montoPagado > 0) {
    const partes = repartir(i.montoPagado, i.clientes.length);
    for (let k = 0; k < i.clientes.length; k++) {
      const notas = [saldo > 0 ? 'Pago parcial de membresía' : i.notaPago, grupal ? `Plan ${i.plan.nombre} (${nombreGrupo(i.clientes)})` : null]
        .filter(Boolean)
        .join(' · ');
      await i.trx
        .insertInto('pagos')
        .values({
          membresiaId: i.membresiaIds[k],
          clienteId: i.clientes[k].id,
          monto: partes[k],
          metodoPago: i.metodoPago,
          reciboNumero: null,
          notas: notas || null,
        })
        .execute();
    }
    await registrarMovimientoCaja(i.trx, {
      tipo: 'ingreso',
      categoria: i.categoria,
      monto: i.montoPagado,
      descripcion: i.descripcion + (saldo > 0 ? ` (Pago parcial, saldo: ${cop(saldo)})` : ''),
      referenciaId: i.membresiaIds[0],
      usuarioId: i.usuarioId,
      metodoPago: i.metodoPago,
    });
  }

  let deudaId: string | null = null;
  if (saldo > 0) {
    const deuda = await i.trx
      .insertInto('deudasClientes')
      .values({
        clienteId: i.clientes[0].id,
        concepto: `Saldo ${i.categoria === 'renovacion' ? 'renovación' : 'membresía'} ${i.plan.nombre}${grupal ? ` (${nombreGrupo(i.clientes)})` : ''}`.slice(0, 200),
        montoTotal: i.plan.precio,
        montoPagado: i.montoPagado,
        saldo,
        estado: 'pendiente',
        fechaVencimiento: i.fechaVencimiento,
        notas: `Membresía ID: ${i.membresiaIds.join(', ')}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    deudaId = deuda.id;
  }
  return { saldo, deudaId };
}

/** Crea una mensualidad por persona con las mismas fechas (y un grupo si son varias). */
async function insertarMembresias(
  trx: Db,
  clientes: ClienteMin[],
  plan: Plan,
  datos: { fechaInicio: string; fechaVencimiento: string; montoPagado: number; metodoPago: string; notas: string | null },
) {
  const grupoId = clientes.length > 1 ? crypto.randomUUID() : null;
  const partes = repartir(datos.montoPagado, clientes.length);
  const creadas = [];
  for (let k = 0; k < clientes.length; k++) {
    creadas.push(
      await trx
        .insertInto('membresias')
        .values({
          clienteId: clientes[k].id,
          planId: plan.id,
          fechaInicio: datos.fechaInicio,
          fechaVencimiento: datos.fechaVencimiento,
          estado: datos.fechaVencimiento < today() ? 'vencida' : 'activa',
          montoPagado: partes[k],
          metodoPago: datos.metodoPago,
          notas: datos.notas,
          fechaSuspension: null,
          grupoId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  return creadas;
}

export interface CrearMembresiaInput {
  clienteId: string;
  /** Para planes de varias personas (ej. Promo Dúo) */
  acompanantes?: string[];
  planId: string;
  fechaInicio?: string;
  montoPagado: number;
  metodoPago: string;
  notas?: string | null;
}

export async function crearMembresia(input: CrearMembresiaInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    const plan = await getPlanActivo(trx, input.planId);
    const clientes = await resolverIntegrantes(trx, plan, input.clienteId, input.acompanantes);
    if (input.montoPagado > plan.precio) throw badRequest('El monto pagado no puede ser mayor al precio del plan');

    const fechaInicio = input.fechaInicio ?? today();
    const fechaVencimiento = calcularVencimiento(fechaInicio, plan);
    const creadas = await insertarMembresias(trx, clientes, plan, {
      fechaInicio,
      fechaVencimiento,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      notas: input.notas || null,
    });

    const { saldo, deudaId } = await registrarCobro({
      trx,
      clientes,
      membresiaIds: creadas.map((m) => m.id),
      plan,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      usuarioId,
      categoria: 'membresia',
      descripcion: `Venta membresía ${plan.nombre} - ${nombreGrupo(clientes)}`,
      fechaVencimiento,
      notaPago: null,
    });

    const quien = clientes.length > 1 ? ` para ${nombreGrupo(clientes)}` : '';
    return {
      data: creadas[0],
      membresias: creadas,
      deudaId,
      saldoPendiente: saldo,
      message: `Membresía creada${quien}. Vence el ${formatDMY(fechaVencimiento)}` + (saldo > 0 ? `. Saldo pendiente: ${cop(saldo)}` : ''),
    };
  });
}

export interface RenovarInput {
  planId?: string;
  /** Acompañantes para planes de varias personas; si no se envían se reutiliza el grupo actual */
  acompanantes?: string[];
  montoPagado: number;
  metodoPago: string;
  desde: 'hoy' | 'vencimiento';
  notas?: string | null;
}

/**
 * Renovación. Se crea una NUEVA membresía encadenada por persona (no se pierde historial):
 *  - desde 'vencimiento': empieza el día que vence la actual (no se pierden días)
 *  - desde 'hoy': empieza hoy y las anteriores se cierran
 * En planes grupales se renuevan todas las personas juntas con un solo cobro.
 * Permite pago parcial: el saldo queda como deuda del titular.
 */
export async function renovarMembresia(membresiaId: string, input: RenovarInput, usuarioId: string) {
  return db.transaction().execute(async (trx) => {
    const actual = await trx.selectFrom('membresias').selectAll().where('id', '=', membresiaId).executeTakeFirst();
    if (!actual) throw notFound('Membresía no encontrada');
    const plan = await getPlanActivo(trx, input.planId ?? actual.planId);
    if (input.montoPagado < 0 || input.montoPagado > plan.precio) {
      throw badRequest(`El monto debe estar entre $0 y ${cop(plan.precio)}`);
    }

    // Integrantes: los enviados, o el grupo actual si el plan es grupal
    let acompanantes = input.acompanantes;
    if (!acompanantes && plan.personas > 1 && actual.grupoId) {
      const grupo = await trx.selectFrom('membresias').select('clienteId').where('grupoId', '=', actual.grupoId).execute();
      acompanantes = [...new Set(grupo.map((g) => g.clienteId))].filter((id) => id !== actual.clienteId);
    }
    const clientes = await resolverIntegrantes(trx, plan, actual.clienteId, plan.personas > 1 ? acompanantes : []);

    const hoy = today();
    const desdeVenc = input.desde === 'vencimiento' && actual.fechaVencimiento >= hoy;
    const fechaInicio = desdeVenc ? actual.fechaVencimiento : hoy;
    const fechaVencimiento = calcularVencimiento(fechaInicio, plan);
    const etiqueta = desdeVenc ? 'Renovación desde fecha de vencimiento' : 'Renovación desde hoy';

    // Desde hoy: se cierran las mensualidades vigentes de cada integrante
    if (!desdeVenc) {
      for (const c of clientes) {
        const vigentes = await trx
          .selectFrom('membresias')
          .select(['id', 'notas'])
          .where('clienteId', '=', c.id)
          .where('estado', 'in', ['activa', 'suspendida'])
          .where('fechaInicio', '<=', hoy)
          .execute();
        for (const v of vigentes) {
          await trx
            .updateTable('membresias')
            .set({
              estado: 'vencida',
              fechaSuspension: null,
              notas: [v.notas, `Reemplazada por renovación el ${formatDMY(hoy)}`].filter(Boolean).join(' · '),
              updatedAt: hoy,
            })
            .where('id', '=', v.id)
            .execute();
        }
      }
    }

    const cambioPlan = plan.id !== actual.planId;
    const creadas = await insertarMembresias(trx, clientes, plan, {
      fechaInicio,
      fechaVencimiento,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      notas: input.notas || (cambioPlan ? `Renovación con cambio a ${plan.nombre}` : etiqueta),
    });

    const { saldo, deudaId } = await registrarCobro({
      trx,
      clientes,
      membresiaIds: creadas.map((m) => m.id),
      plan,
      montoPagado: input.montoPagado,
      metodoPago: input.metodoPago,
      usuarioId,
      categoria: 'renovacion',
      descripcion: `Renovación ${plan.nombre} - ${nombreGrupo(clientes)} (${etiqueta})`,
      fechaVencimiento,
      notaPago: etiqueta,
    });

    const para = clientes.length > 1 ? ` para ${nombreGrupo(clientes)}` : '';
    return {
      data: creadas[0],
      membresias: creadas,
      deudaId,
      saldoPendiente: saldo,
      message:
        `Membresía renovada ${desdeVenc ? 'desde su vencimiento' : 'desde HOY'} por ${describirDuracion(plan)}${para}. ` +
        `Vence el ${formatDMY(fechaVencimiento)}${saldo > 0 ? `. Saldo pendiente: ${cop(saldo)}` : ''}`,
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

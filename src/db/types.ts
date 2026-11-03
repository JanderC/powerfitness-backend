import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Tipos de las 20 tablas. Las columnas están en camelCase porque Kysely usa
 * CamelCasePlugin (en la BD siguen siendo snake_case, igual que el sistema original).
 *
 * - numeric  → number   (parser global en db/index.ts)
 * - date     → string 'YYYY-MM-DD' (parser global, evita corrimientos de zona horaria)
 * - timestamp→ Date     (hora local America/Bogota)
 */
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsReq = ColumnType<Date, Date | string, Date | string>;
type DateOnly = ColumnType<string, string | undefined, string>;
type DateOnlyReq = ColumnType<string, string, string>;
type Def<T> = ColumnType<T, T | undefined, T>;

export interface UsuariosTable {
  id: Generated<string>;
  nombre: string;
  email: string;
  passwordHash: string;
  rol: Def<'admin' | 'staff'>;
  telefono: string | null;
  activo: Def<boolean>;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface ClientesTable {
  id: Generated<string>;
  nombre: string;
  apellido: string;
  cedula: string;
  telefono: string | null;
  email: string | null;
  fechaNacimiento: string | null;
  direccion: string | null;
  huellaTemplate: string | null;
  fotoBase64: string | null;
  activo: Def<boolean>;
  createdAt: DateOnly;
  updatedAt: DateOnly;
  huellaDigital: string | null;
  huellaTemplate1: string | null;
  huellaTemplate2: string | null;
  huellaTemplate3: string | null;
  peso: number | null;
  huellaTemplate4: string | null;
  huellaTemplate5: string | null;
  qualityScore: string | null;
  fingerPosition: Def<string | null>;
  rawWidth: Def<number | null>;
  rawHeight: Def<number | null>;
  rawDpi: Def<number | null>;
  featureSet: string | null;
}

export type TipoCalculo = 'dias' | 'semanas' | 'meses' | 'anios';

export interface PlanesTable {
  id: Generated<string>;
  nombre: string;
  descripcion: string | null;
  tipo: string;
  duracionDias: number;
  precio: number;
  activo: Def<boolean>;
  color: Def<string | null>;
  createdAt: Ts;
  updatedAt: Ts;
  tipoCalculoVencimiento: Def<TipoCalculo>;
  cantidadUnidades: Def<number>;
  personas: Def<number>;
  promocional: Def<boolean>;
}

export type EstadoMembresia = 'activa' | 'vencida' | 'suspendida' | 'cancelada';

export interface MembresiasTable {
  id: Generated<string>;
  clienteId: string;
  planId: string;
  fechaInicio: DateOnlyReq;
  fechaVencimiento: DateOnlyReq;
  estado: Def<EstadoMembresia>;
  montoPagado: number;
  metodoPago: string | null;
  notas: string | null;
  createdAt: DateOnly;
  updatedAt: DateOnly;
  fechaSuspension: string | null;
  grupoId: Def<string | null>;
}

export interface PagosTable {
  id: Generated<string>;
  membresiaId: string;
  clienteId: string;
  monto: number;
  metodoPago: string;
  fechaPago: Ts;
  reciboNumero: string | null;
  notas: string | null;
  createdAt: Ts;
  updateAt: Ts;
  updatedAt: Ts;
}

export interface ProductosTable {
  id: Generated<string>;
  nombre: string;
  descripcion: string | null;
  precio: number;
  stock: Def<number>;
  imagenBase64: string | null;
  categoria: string | null;
  activo: Def<boolean>;
  createdAt: Ts;
  updatedAt: Ts;
}

export type EstadoPagoVenta = 'pendiente' | 'parcial' | 'pagado' | 'fiado';

export interface VentasProductosTable {
  id: Generated<string>;
  clienteId: string | null;
  productoId: string;
  cantidad: Def<number>;
  precioUnitario: number;
  total: number;
  estadoPago: Def<EstadoPagoVenta>;
  fechaVenta: Ts;
  fechaPago: Date | null;
  notas: string | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface CheckinsTable {
  id: Generated<string>;
  clienteId: string;
  fechaHora: Ts;
  metodo: Def<'huella' | 'manual' | 'cedula'>;
  exitoso: Def<boolean>;
  nota: string | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface NotificacionesTable {
  id: Generated<string>;
  tipo: 'vencimiento_proximo' | 'membresia_vencida' | 'pago_pendiente' | 'stock_bajo' | 'sistema';
  titulo: string;
  mensaje: string;
  clienteId: string | null;
  leida: Def<boolean>;
  prioridad: Def<'baja' | 'normal' | 'alta' | 'urgente'>;
  fechaCreacion: Ts;
  fechaLeida: Date | null;
}

export type MetodoPago = 'efectivo' | 'transferencia';

export interface MovimientosCajaTable {
  id: Generated<string>;
  tipo: 'ingreso' | 'egreso';
  categoria: string;
  monto: number;
  descripcion: string | null;
  referenciaId: string | null;
  usuarioId: string;
  fecha: Ts;
  metodoPago: string | null;
  createdAt: DateOnly;
  cerrado: Def<boolean>;
  cierreCajaId: string | null;
  movimientoCajaFuerteId: string | null;
  sesionCajaId: Def<string | null>;
}

export interface CierresCajaTable {
  id: Generated<string>;
  fechaCierre: TsReq;
  tipoCierre: string;
  efectivoInicial: Def<number>;
  ingresosEfectivo: Def<number>;
  egresosEfectivo: Def<number>;
  efectivoFinal: Def<number>;
  ingresosTransferencia: Def<number>;
  egresosTransferencia: Def<number>;
  totalIngresos: Def<number>;
  totalEgresos: Def<number>;
  balanceGeneral: Def<number>;
  cantidadMovimientos: Def<number>;
  observaciones: string | null;
  usuarioId: string;
  createdAt: Ts;
  sesionCajaId: Def<string | null>;
  efectivoContado: Def<number | null>;
  diferencia: Def<number | null>;
}

export type OrigenMontoInicial = 'anterior' | 'caja_fuerte' | 'externo';

export interface SesionesCajaTable {
  id: Generated<string>;
  estado: Def<'abierta' | 'cerrada'>;
  montoInicial: Def<number>;
  origenMontoInicial: Def<OrigenMontoInicial>;
  fechaApertura: Ts;
  usuarioApertura: string;
  observacionesApertura: string | null;
  fechaCierre: Date | null;
  usuarioCierre: string | null;
  cierreCajaId: string | null;
  efectivoEsperado: number | null;
  efectivoContado: number | null;
  diferencia: number | null;
  efectivoDejado: number | null;
  observacionesCierre: string | null;
  createdAt: Ts;
}

export interface EmpleadosTable {
  id: Generated<string>;
  nombre: string;
  apellido: string;
  cedula: string;
  telefono: string | null;
  email: string | null;
  cargo: string | null;
  salario: number | null;
  fechaContratacion: string | null;
  activo: Def<boolean>;
  createdAt: DateOnly;
  updatedAt: DateOnly;
}

export interface PagosEmpleadosTable {
  id: Generated<string>;
  empleadoId: string;
  monto: number;
  periodo: string | null;
  fechaPago: Ts;
  metodoPago: string | null;
  notas: string | null;
  createdAt: Ts;
}

export type EstadoDeuda = 'pendiente' | 'pagada' | 'vencida' | 'cancelada';

export interface DeudasClientesTable {
  id: Generated<string>;
  clienteId: string;
  concepto: string;
  montoTotal: number;
  montoPagado: Def<number>;
  saldo: number;
  estado: Def<EstadoDeuda>;
  fechaCreacion: Ts;
  fechaVencimiento: string | null;
  notas: string | null;
  createdAt: Ts;
}

export interface AbonosDeudaTable {
  id: Generated<string>;
  deudaId: string;
  monto: number;
  metodoPago: string | null;
  fechaAbono: Ts;
  notas: string | null;
}

export interface CajaFuerteTable {
  id: Generated<string>;
  balanceEfectivo: Def<number>;
  balanceTransferencias: Def<number>;
  balanceTotal: Def<number>;
  ultimaActualizacion: Ts;
  createdAt: Ts;
  updatedAt: Ts;
}

export type OrigenCF =
  | 'cierre_caja'
  | 'retiro_manual'
  | 'ingreso_manual'
  | 'transferencia_a_caja'
  | 'transferencia_desde_caja'
  | 'otros';

export interface MovimientosCajaFuerteTable {
  id: Generated<string>;
  tipo: 'ingreso' | 'egreso';
  origen: OrigenCF;
  metodoPago: MetodoPago;
  monto: number;
  descripcion: string | null;
  categoria: string | null;
  cierreCajaId: string | null;
  usuarioId: string;
  fecha: Ts;
  createdAt: Ts;
  movimientoCajaId: string | null;
}

export interface ConsolidadosMensualesTable {
  id: Generated<string>;
  mes: number;
  anio: number;
  totalIngresosEfectivo: Def<number>;
  totalIngresosTransferencia: Def<number>;
  totalEgresosEfectivo: Def<number>;
  totalEgresosTransferencia: Def<number>;
  balanceFinalEfectivo: Def<number>;
  balanceFinalTransferencia: Def<number>;
  fechaConsolidacion: TsReq;
  createdAt: Ts;
}

export interface ConfiguracionCajaFuerteTable {
  id: Generated<string>;
  passwordHash: string;
  requiereCambioPassword: Def<boolean>;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface MovimientosEliminadosTable {
  id: Generated<string>;
  movimientoOriginalId: string;
  tipo: string;
  origen: string;
  metodoPago: string;
  monto: number;
  descripcion: string;
  categoria: string | null;
  fechaOriginal: TsReq;
  fechaEliminacion: TsReq;
  usuarioEliminacion: string;
  motivoEliminacion: string;
  createdAt: Ts;
  moduloOrigen: Def<'caja_fuerte' | 'caja_diaria'>;
}

export interface DB {
  usuarios: UsuariosTable;
  clientes: ClientesTable;
  planes: PlanesTable;
  membresias: MembresiasTable;
  pagos: PagosTable;
  productos: ProductosTable;
  ventasProductos: VentasProductosTable;
  checkins: CheckinsTable;
  notificaciones: NotificacionesTable;
  movimientosCaja: MovimientosCajaTable;
  cierresCaja: CierresCajaTable;
  empleados: EmpleadosTable;
  pagosEmpleados: PagosEmpleadosTable;
  deudasClientes: DeudasClientesTable;
  abonosDeuda: AbonosDeudaTable;
  cajaFuerte: CajaFuerteTable;
  movimientosCajaFuerte: MovimientosCajaFuerteTable;
  consolidadosMensuales: ConsolidadosMensualesTable;
  configuracionCajaFuerte: ConfiguracionCajaFuerteTable;
  movimientosEliminados: MovimientosEliminadosTable;
  sesionesCaja: SesionesCajaTable;
}

export type Usuario = Selectable<UsuariosTable>;
export type Cliente = Selectable<ClientesTable>;
export type Plan = Selectable<PlanesTable>;
export type Membresia = Selectable<MembresiasTable>;
export type NuevaMembresia = Insertable<MembresiasTable>;
export type MembresiaUpdate = Updateable<MembresiasTable>;
export type MovimientoCaja = Selectable<MovimientosCajaTable>;
export type MovimientoCajaFuerte = Selectable<MovimientosCajaFuerteTable>;
export type CajaFuerte = Selectable<CajaFuerteTable>;
export type SesionCaja = Selectable<SesionesCajaTable>;

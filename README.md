# POWER FITNESS · Backend (API)

Migración del sistema .NET (VidaFit, rama `ramaNuevaPower`) a **Node.js + TypeScript** (API) y **React + TypeScript** (aplicación web), con la identidad visual de Power Fitness (oso, azul eléctrico `#1E6FE3` / `#3D8EFF` y morado `#6B3FA0`).

API REST · Express + Kysely (PostgreSQL) + Zod + JWT. Frontend: [powerfitness](https://github.com/JanderC/powerfitness).

```
src/
├── config/     variables de entorno validadas
├── db/         conexión, tipos, migraciones, seed e importador del sistema anterior
├── modules/    rutas y servicios por dominio (clientes, membresías, caja…)
├── jobs/       tareas automáticas
└── index.ts
database/       001_schema.sql (las 20 tablas) + referencia del esquema original
```

## Requisitos

- Node.js 20 o superior
- PostgreSQL 14 o superior (en este equipo: 16, usuario `postgres`)

## Inicio rápido

```bash
npm install
cp .env.example .env        # configura DATABASE_URL (Railway) o DB_* (local) y JWT_SECRET
npm run dev                 # http://localhost:5000/api
```

### Base de datos en Railway

La BD de producción está en Railway (proyecto `powerfitness`, servicio `Postgres`). Pon en `.env` la URL pública del proxy TCP:

```
DATABASE_URL=postgresql://postgres:<password>@<host-proxy>.proxy.rlwy.net:<puerto>/railway
```

Se obtiene con `railway variables --service Postgres` (`PGPASSWORD`, `RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT`). Si el backend se despliega dentro de Railway, usa la variable interna `${{Postgres.DATABASE_URL}}`.

**Acceso inicial** (cámbialo en el primer ingreso):

| Qué | Valor |
|---|---|
| Panel | `admin@powerfitness.com` / `Admin123*` |
| Caja Fuerte | `123456` (el sistema pide cambiarla) |

## Base de datos

- BD nueva: **`power_fitness`** — las mismas 20 tablas y columnas de la BD `nosirve` del sistema anterior, **sin datos**.
- Mejoras del esquema: llaves primarias y foráneas que faltaban, índices, `UNIQUE` en cédulas/email, y los `CHECK` alineados con la lógica real (`cancelada` en deudas, `ingreso_manual` en caja fuerte).
- Columna nueva: `membresias.fecha_suspension` (para congelar mensualidades).

### Traer la información del sistema anterior

```bat
:: Simulación (no escribe nada, muestra cuántos registros pasarían)
npm run db:import-legacy -- --from nosirve

:: Importación real
npm run db:import-legacy -- --from nosirve --apply
```

Se puede ejecutar varias veces (omite lo que ya existe). Corrige datos huérfanos del sistema viejo (usuario "sistema" `0000…`, deudas sin cliente). Las contraseñas en texto plano del sistema anterior se convierten a BCrypt automáticamente en el primer inicio de sesión.

## Qué se migró

Toda la lógica de los controladores `Controllers/API/*.cs` y los reportes de `Controllers/WEB/ReportesController.cs`:

| Sistema .NET | Nuevo módulo (`backend/src/modules`) |
|---|---|
| AuthController + AuthService | `auth.routes.ts` (login, perfil, usuarios, roles admin/recepción) |
| ClientesController | `clientes.routes.ts` |
| PlanesController | `planes.routes.ts` |
| MembresiasController | `membresias.service.ts` + `membresias.routes.ts` |
| CheckInController + Kiosko | `checkin.routes.ts` (kiosko público + panel) |
| ProductosController + VentasProductosController | `productos.routes.ts` |
| DeudasController + HistorialDeudaController | `deudas.routes.ts` |
| CajaController | `caja.service.ts` + `caja.routes.ts` (incluye varios cierres por día) |
| CajaFuerteController | `caja-fuerte.routes.ts` (saldo acumulado por movimiento, consolidados, CSV) |
| EmpleadosController | `empleados.routes.ts` |
| DashboardController + ReportesController + NotificationService | `dashboard.routes.ts` |

## Caja por sesiones

La caja diaria ya no se cierra por día ni por horario: trabaja por **sesiones (turnos)**.

1. **Apertura** con un monto inicial (base). Origen: lo que se dejó en el cierre anterior (se sugiere solo), retirado de Caja Fuerte (se descuenta de su efectivo) u otro origen.
2. Mientras la sesión está abierta, **todo** cobro o pago (mensualidades, ventas, abonos, salarios, ingresos/egresos manuales, envíos desde Caja Fuerte) queda ligado a ella. Con la caja cerrada la API responde `409` y la interfaz lo avisa.
3. **Cierre con arqueo**: se cuenta el efectivo (por billetes/monedas o total), se compara con el esperado (`base + ingresos − egresos en efectivo`) y se registra sobrante/faltante (con observación obligatoria). Se elige cuánto dejar como base del siguiente turno; el resto del efectivo y las transferencias netas pasan a Caja Fuerte. Se imprime un comprobante.

Solo puede haber una sesión abierta a la vez. Tabla `sesiones_caja` (migración `002_sesiones_caja.sql`); `movimientos_caja.sesion_caja_id` y `cierres_caja.sesion_caja_id/efectivo_contado/diferencia`.

Endpoints: `GET /api/caja/sesion`, `POST /api/caja/abrir`, `POST /api/caja/cerrar`, `GET /api/caja/sesiones`, `GET /api/caja/sesiones/:id`.

Las reglas de negocio se conservan: cálculo de vencimiento (`meses` suma meses calendario, `días` cuenta el día de inicio), un check-in cada 12 h, deuda automática por pagos parciales, ingreso en caja por cada cobro, cierre de caja que envía efectivo/transferencias a Caja Fuerte, eliminación con auditoría y reverso en cascada entre cajas.

## Mejoras en mensualidades

- **Panel de mensualidades** con pestañas *Por vencer · Al día · Vencidas · Congeladas · Todas · Historial*, búsqueda y filtro por plan.
- **Indicadores**: activas, por vencer (vencen hoy), vencidas sin renovar, congeladas, cobrado del mes y **tasa de renovación**.
- **Vista previa del vencimiento** en vivo al crear o renovar (antes de cobrar).
- **Renovación sin perder historial**: cada renovación es una membresía nueva encadenada (antes se sobrescribía la misma fila). Opción *desde el vencimiento* (no pierde días) o *desde hoy*, con cambio de plan.
- **Pago parcial también al renovar**: el saldo queda como deuda (antes la renovación exigía el pago completo).
- **Congelar / reanudar**: los días congelados se suman al vencimiento al reanudar. El kiosko informa "membresía congelada".
- **Recordatorio por WhatsApp** con mensaje listo (por vencer, vencida, deuda, cumpleaños, inactivos).
- Barra de progreso de días usados, deuda visible por cliente y línea de tiempo de mensualidades en la ficha del cliente.

## Autonomía

- Arranque en un clic (`iniciar.bat`): instala, compila, migra la BD, crea el admin y abre panel + kiosko.
- **Tareas automáticas** (`backend/src/jobs/scheduler.ts`, configurables en `.env`):
  - Revisión diaria: vence mensualidades, genera avisos de "por vencer"/"vencida" y de stock bajo, limpia notificaciones viejas. También corre al iniciar, por si el equipo estuvo apagado.
  - Consolidación mensual automática de Caja Fuerte (día 1).
  - Aviso si una sesión de caja lleva más de `CAJA_ALERTA_HORAS` (14 h) abierta.
- Notificaciones en el panel (campana), alertas de días sin cerrar en Caja Diaria y diagnóstico/sincronización del balance de Caja Fuerte.

## Seguridad

- JWT en toda la API (antes casi todos los endpoints eran públicos); roles `admin` y `staff` (recepción).
- Caja Fuerte: la contraseña ahora se valida en el servidor y emite un token temporal de 4 h (antes solo se validaba en el navegador).
- Contraseñas con BCrypt, validación de datos con Zod, transacciones en todas las operaciones de dinero y bloqueo de filas para evitar sobreventa de stock.

## Lector de huellas

El lector DigitalPersona dependía de DLLs nativas de .NET, que no se ejecutan en Node. Las columnas de huella se conservan y la API expone dos endpoints para un **puente local** (servicio pequeño que habla con el lector):

- `GET /api/kiosko/plantillas-huella` — descarga plantillas para identificar localmente.
- `POST /api/kiosko/checkin-huella` `{ clienteId }` — registra el acceso.

Ambos exigen la cabecera `x-bridge-key` = `FINGERPRINT_BRIDGE_KEY` del `.env`. Mientras tanto, el kiosko funciona por cédula (teclado en pantalla, teclado físico o lector de código de barras).

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | API con recarga automática |
| `npm run build` / `npm start` | Compilar y ejecutar en producción |
| `npm run db:setup` | Crea BD (local), aplica esquema y crea admin |
| `npm run db:import-legacy -- --from <bd>` | Importa datos del sistema anterior (BD local → `DATABASE_URL`) |
| `npm run typecheck` | Verifica tipos |

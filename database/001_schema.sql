-- =====================================================================
--  POWER FITNESS · Esquema de base de datos (PostgreSQL 14+)
--  Migrado desde la BD "nosirve" del sistema .NET (rama ramaNuevaPower).
--
--  * Mismas 20 tablas y mismas columnas que el sistema original, para que
--    la información se pueda importar 1:1 más adelante
--    (ver backend/src/db/import-legacy.ts).
--  * Mejoras: llaves primarias, llaves foráneas, únicos e índices que
--    faltaban, CHECKs alineados con la lógica real del backend y la nueva
--    columna membresias.fecha_suspension (congelar mensualidades).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

-- ───────────────────────── USUARIOS ─────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre        varchar(100) NOT NULL,
    email         varchar(150) NOT NULL,
    password_hash varchar(255) NOT NULL,
    rol           varchar(20)  DEFAULT 'admin',
    telefono      varchar(20),
    activo        boolean      DEFAULT true,
    created_at    timestamp    DEFAULT CURRENT_TIMESTAMP,
    updated_at    timestamp    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin', 'staff')),
    CONSTRAINT usuarios_email_unique UNIQUE (email)
);

-- ───────────────────────── CLIENTES ─────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre            varchar(100) NOT NULL,
    apellido          varchar(100) NOT NULL,
    cedula            varchar(20)  NOT NULL,
    telefono          varchar(20),
    email             varchar(150),
    fecha_nacimiento  date,
    direccion         text,
    huella_template   varchar,
    foto_base64       text,
    activo            boolean DEFAULT true,
    created_at        date DEFAULT CURRENT_TIMESTAMP,
    updated_at        date DEFAULT CURRENT_TIMESTAMP,
    huella_digital    varchar,
    huella_template_1 text,
    huella_template_2 text,
    huella_template_3 text,
    peso              numeric(5,2),
    huella_template_4 text,
    huella_template_5 text,
    quality_score     text,
    finger_position   text    DEFAULT 'unknown',
    raw_width         integer DEFAULT 252,
    raw_height        integer DEFAULT 324,
    raw_dpi           integer DEFAULT 500,
    feature_set       text,
    CONSTRAINT clientes_cedula_unique UNIQUE (cedula)
);
COMMENT ON COLUMN clientes.peso IS 'Peso del cliente en kilogramos';
CREATE INDEX IF NOT EXISTS idx_clientes_activo ON clientes (activo);
CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes (lower(nombre), lower(apellido));

-- ───────────────────────── PLANES ─────────────────────────
CREATE TABLE IF NOT EXISTS planes (
    id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre                   varchar(100) NOT NULL,
    descripcion              text,
    tipo                     varchar(20)  NOT NULL,
    duracion_dias            integer      NOT NULL,
    precio                   numeric(10,2) NOT NULL,
    activo                   boolean      DEFAULT true,
    color                    varchar(7)   DEFAULT '#1E6FE3',
    created_at               timestamp    DEFAULT CURRENT_TIMESTAMP,
    updated_at               timestamp    DEFAULT CURRENT_TIMESTAMP,
    tipo_calculo_vencimiento varchar(20)  DEFAULT 'dias' NOT NULL,
    cantidad_unidades        integer      DEFAULT 1 NOT NULL,
    CONSTRAINT planes_tipo_check CHECK (tipo IN ('semanal','mensual','personalizado','diario','trimestral','semestral','anual','otro')),
    CONSTRAINT planes_tipo_calculo_check CHECK (tipo_calculo_vencimiento IN ('dias','semanas','meses','anios'))
);

-- ───────────────────────── MEMBRESÍAS ─────────────────────────
CREATE TABLE IF NOT EXISTS membresias (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    cliente_id        uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    plan_id           uuid NOT NULL REFERENCES planes(id)   ON DELETE RESTRICT,
    fecha_inicio      date NOT NULL,
    fecha_vencimiento date NOT NULL,
    estado            varchar(20) DEFAULT 'activa',
    monto_pagado      numeric(10,2) NOT NULL,
    metodo_pago       varchar(50),
    notas             text,
    created_at        date DEFAULT CURRENT_TIMESTAMP,
    updated_at        date DEFAULT CURRENT_TIMESTAMP,
    -- NUEVO: fecha en que se congeló la mensualidad (estado = 'suspendida')
    fecha_suspension  date,
    CONSTRAINT membresias_estado_check CHECK (estado IN ('activa','vencida','suspendida','cancelada'))
);
CREATE INDEX IF NOT EXISTS idx_membresias_cliente ON membresias (cliente_id);
CREATE INDEX IF NOT EXISTS idx_membresias_plan ON membresias (plan_id);
CREATE INDEX IF NOT EXISTS idx_membresias_estado ON membresias (estado);
CREATE INDEX IF NOT EXISTS idx_membresias_fecha_vencimiento ON membresias (fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_membresias_estado_vencimiento ON membresias (estado, fecha_vencimiento);

-- ───────────────────────── PAGOS (de membresías) ─────────────────────────
CREATE TABLE IF NOT EXISTS pagos (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    membresia_id  uuid NOT NULL REFERENCES membresias(id) ON DELETE CASCADE,
    cliente_id    uuid NOT NULL REFERENCES clientes(id)   ON DELETE CASCADE,
    monto         numeric(10,2) NOT NULL,
    metodo_pago   varchar(50) NOT NULL,
    fecha_pago    timestamptz DEFAULT CURRENT_TIMESTAMP,
    recibo_numero varchar(50),
    notas         text,
    created_at    timestamptz DEFAULT CURRENT_TIMESTAMP,
    update_at     timestamptz DEFAULT CURRENT_TIMESTAMP, -- columna heredada del sistema original
    updated_at    timestamptz DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pagos_membresia ON pagos (membresia_id);
CREATE INDEX IF NOT EXISTS idx_pagos_cliente ON pagos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos (fecha_pago);

-- ───────────────────────── PRODUCTOS ─────────────────────────
CREATE TABLE IF NOT EXISTS productos (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre        varchar(150) NOT NULL,
    descripcion   text,
    precio        numeric(10,2) NOT NULL,
    stock         integer DEFAULT 0,
    imagen_base64 text,
    categoria     varchar(50),
    activo        boolean DEFAULT true,
    created_at    timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at    timestamp DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────── VENTAS DE PRODUCTOS ─────────────────────────
CREATE TABLE IF NOT EXISTS ventas_productos (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    cliente_id      uuid REFERENCES clientes(id) ON DELETE SET NULL,
    producto_id     uuid NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
    cantidad        integer DEFAULT 1 NOT NULL,
    precio_unitario numeric(10,2) NOT NULL,
    total           numeric(10,2) NOT NULL,
    estado_pago     varchar(20) DEFAULT 'pendiente',
    fecha_venta     timestamp DEFAULT CURRENT_TIMESTAMP,
    fecha_pago      timestamp,
    notas           text,
    created_at      timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at      timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ventas_productos_estado_pago_check CHECK (estado_pago IN ('pendiente','parcial','pagado','fiado'))
);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas_productos (fecha_venta);
CREATE INDEX IF NOT EXISTS idx_ventas_producto ON ventas_productos (producto_id);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas_productos (cliente_id);

-- ───────────────────────── CHECK-INS ─────────────────────────
CREATE TABLE IF NOT EXISTS checkins (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    fecha_hora timestamp DEFAULT CURRENT_TIMESTAMP,
    metodo     varchar(20) DEFAULT 'huella',
    exitoso    boolean DEFAULT true,
    nota       text,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT checkins_metodo_check CHECK (metodo IN ('huella','manual','cedula'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_fecha ON checkins (fecha_hora);
CREATE INDEX IF NOT EXISTS idx_checkins_cliente ON checkins (cliente_id);

-- ───────────────────────── NOTIFICACIONES ─────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    tipo           varchar(50)  NOT NULL,
    titulo         varchar(200) NOT NULL,
    mensaje        text NOT NULL,
    cliente_id     uuid REFERENCES clientes(id) ON DELETE CASCADE,
    leida          boolean DEFAULT false,
    prioridad      varchar(20) DEFAULT 'normal',
    fecha_creacion timestamp DEFAULT CURRENT_TIMESTAMP,
    fecha_leida    timestamp,
    CONSTRAINT notificaciones_prioridad_check CHECK (prioridad IN ('baja','normal','alta','urgente')),
    CONSTRAINT notificaciones_tipo_check CHECK (tipo IN ('vencimiento_proximo','membresia_vencida','pago_pendiente','stock_bajo','sistema'))
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_leida ON notificaciones (leida);
CREATE INDEX IF NOT EXISTS idx_notificaciones_fecha ON notificaciones (fecha_creacion);

-- ───────────────────────── CIERRES DE CAJA ─────────────────────────
CREATE TABLE IF NOT EXISTS cierres_caja (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    fecha_cierre           timestamp NOT NULL,
    tipo_cierre            varchar(20) NOT NULL,
    efectivo_inicial       numeric(10,2) DEFAULT 0 NOT NULL,
    ingresos_efectivo      numeric(10,2) DEFAULT 0 NOT NULL,
    egresos_efectivo       numeric(10,2) DEFAULT 0 NOT NULL,
    efectivo_final         numeric(10,2) DEFAULT 0 NOT NULL,
    ingresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    egresos_transferencia  numeric(10,2) DEFAULT 0 NOT NULL,
    total_ingresos         numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos          numeric(10,2) DEFAULT 0 NOT NULL,
    balance_general        numeric(10,2) DEFAULT 0 NOT NULL,
    cantidad_movimientos   integer DEFAULT 0 NOT NULL,
    observaciones          text,
    usuario_id             uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    created_at             timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cierres_caja_fecha_cierre ON cierres_caja (fecha_cierre);
CREATE INDEX IF NOT EXISTS idx_cierres_caja_usuario_id ON cierres_caja (usuario_id);

-- ───────────────────────── MOVIMIENTOS DE CAJA DIARIA ─────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_caja (
    id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    tipo                      varchar(20) NOT NULL,
    categoria                 varchar(50) NOT NULL,
    monto                     numeric(10,2) NOT NULL,
    descripcion               text,
    referencia_id             uuid,
    -- Sin FK: el sistema original guardaba un usuario "sistema" (0000…)
    usuario_id                uuid NOT NULL,
    fecha                     timestamp DEFAULT CURRENT_TIMESTAMP,
    metodo_pago               varchar(50),
    created_at                date DEFAULT CURRENT_TIMESTAMP,
    cerrado                   boolean DEFAULT false NOT NULL,
    cierre_caja_id            uuid REFERENCES cierres_caja(id) ON DELETE SET NULL,
    movimiento_caja_fuerte_id uuid,
    CONSTRAINT movimientos_caja_tipo_check CHECK (tipo IN ('ingreso','egreso'))
);
COMMENT ON COLUMN movimientos_caja.cerrado IS 'Indica si el movimiento ya fue incluido en un cierre de caja';
COMMENT ON COLUMN movimientos_caja.cierre_caja_id IS 'ID del cierre de caja que incluyó este movimiento';
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_cerrado ON movimientos_caja (cerrado);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_cierre_caja_id ON movimientos_caja (cierre_caja_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_fecha ON movimientos_caja (fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_tipo ON movimientos_caja (tipo);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_usuario_id ON movimientos_caja (usuario_id);
CREATE INDEX IF NOT EXISTS ix_movimientos_caja_movimiento_cf_id ON movimientos_caja (movimiento_caja_fuerte_id);

-- ───────────────────────── EMPLEADOS ─────────────────────────
CREATE TABLE IF NOT EXISTS empleados (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre             varchar(100) NOT NULL,
    apellido           varchar(100) NOT NULL,
    cedula             varchar(20)  NOT NULL,
    telefono           varchar(20),
    email              varchar(150),
    cargo              varchar(50),
    salario            numeric(10,2),
    fecha_contratacion date,
    activo             boolean DEFAULT true,
    created_at         date DEFAULT CURRENT_TIMESTAMP,
    updated_at         date DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT empleados_cedula_unique UNIQUE (cedula)
);

CREATE TABLE IF NOT EXISTS pagos_empleados (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    empleado_id uuid NOT NULL REFERENCES empleados(id) ON DELETE RESTRICT,
    monto       numeric(10,2) NOT NULL,
    periodo     varchar(50),
    fecha_pago  timestamp DEFAULT CURRENT_TIMESTAMP,
    metodo_pago varchar(50),
    notas       text,
    created_at  timestamp DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pagos_empleados_empleado ON pagos_empleados (empleado_id);

-- ───────────────────────── DEUDAS ─────────────────────────
CREATE TABLE IF NOT EXISTS deudas_clientes (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    cliente_id        uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    concepto          varchar(200) NOT NULL,
    monto_total       numeric(10,2) NOT NULL,
    monto_pagado      numeric(10,2) DEFAULT 0,
    saldo             numeric(10,2) NOT NULL,
    estado            varchar(20) DEFAULT 'pendiente',
    fecha_creacion    timestamp DEFAULT CURRENT_TIMESTAMP,
    fecha_vencimiento date,
    notas             text,
    created_at        timestamp DEFAULT CURRENT_TIMESTAMP,
    -- 'cancelada' la usaba el backend original pero no estaba en el CHECK
    CONSTRAINT deudas_estado_check CHECK (estado IN ('pendiente','pagada','vencida','cancelada'))
);
CREATE INDEX IF NOT EXISTS idx_deudas_cliente ON deudas_clientes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_deudas_estado ON deudas_clientes (estado);

CREATE TABLE IF NOT EXISTS abonos_deuda (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    deuda_id    uuid NOT NULL REFERENCES deudas_clientes(id) ON DELETE CASCADE,
    monto       numeric(10,2) NOT NULL,
    metodo_pago varchar(50),
    fecha_abono timestamp DEFAULT CURRENT_TIMESTAMP,
    notas       text
);
CREATE INDEX IF NOT EXISTS idx_abonos_deuda ON abonos_deuda (deuda_id);

-- ───────────────────────── CAJA FUERTE ─────────────────────────
CREATE TABLE IF NOT EXISTS caja_fuerte (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    balance_efectivo       numeric(10,2) DEFAULT 0 NOT NULL,
    balance_transferencias numeric(10,2) DEFAULT 0 NOT NULL,
    balance_total          numeric(10,2) DEFAULT 0 NOT NULL,
    ultima_actualizacion   timestamp(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at             timestamp(6) DEFAULT CURRENT_TIMESTAMP,
    updated_at             timestamp(6) DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE caja_fuerte IS 'Balance principal del negocio - solo debe existir un registro';

CREATE TABLE IF NOT EXISTS configuracion_caja_fuerte (
    id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    password_hash            varchar(255) NOT NULL,
    requiere_cambio_password boolean DEFAULT false NOT NULL,
    created_at               timestamp(6) DEFAULT CURRENT_TIMESTAMP,
    updated_at               timestamp(6) DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON COLUMN configuracion_caja_fuerte.password_hash IS 'Hash SHA256 (base64) de la contraseña de acceso — compatible con el sistema original';

CREATE TABLE IF NOT EXISTS movimientos_caja_fuerte (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    tipo               varchar(20) NOT NULL,
    origen             varchar(50) NOT NULL,
    metodo_pago        varchar(50) NOT NULL,
    monto              numeric(10,2) NOT NULL,
    descripcion        text,
    categoria          varchar(50),
    cierre_caja_id     uuid REFERENCES cierres_caja(id) ON DELETE SET NULL,
    usuario_id         uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha              timestamp(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at         timestamp(6) DEFAULT CURRENT_TIMESTAMP,
    movimiento_caja_id uuid REFERENCES movimientos_caja(id) ON DELETE SET NULL,
    CONSTRAINT movimientos_caja_fuerte_metodo_pago_check CHECK (metodo_pago IN ('efectivo','transferencia')),
    -- 'ingreso_manual' lo usaba el backend original pero no estaba en el CHECK
    CONSTRAINT movimientos_caja_fuerte_origen_check CHECK (origen IN ('cierre_caja','retiro_manual','ingreso_manual','transferencia_a_caja','transferencia_desde_caja','otros')),
    CONSTRAINT movimientos_caja_fuerte_tipo_check CHECK (tipo IN ('ingreso','egreso'))
);
CREATE INDEX IF NOT EXISTS idx_movimientos_cf_fecha ON movimientos_caja_fuerte (fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_cf_tipo ON movimientos_caja_fuerte (tipo);
CREATE INDEX IF NOT EXISTS idx_movimientos_cf_usuario_id ON movimientos_caja_fuerte (usuario_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_cf_cierre ON movimientos_caja_fuerte (cierre_caja_id);
CREATE INDEX IF NOT EXISTS ix_movimientos_caja_fuerte_movimiento_caja_id ON movimientos_caja_fuerte (movimiento_caja_id);

CREATE TABLE IF NOT EXISTS consolidados_mensuales (
    id                           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    mes                          integer NOT NULL,
    anio                         integer NOT NULL,
    total_ingresos_efectivo      numeric(10,2) DEFAULT 0 NOT NULL,
    total_ingresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos_efectivo       numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos_transferencia  numeric(10,2) DEFAULT 0 NOT NULL,
    balance_final_efectivo       numeric(10,2) DEFAULT 0 NOT NULL,
    balance_final_transferencia  numeric(10,2) DEFAULT 0 NOT NULL,
    fecha_consolidacion          timestamp(6) NOT NULL,
    created_at                   timestamp(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT consolidados_mensuales_mes_check CHECK (mes BETWEEN 1 AND 12),
    CONSTRAINT consolidados_mensuales_unique UNIQUE (mes, anio)
);

CREATE TABLE IF NOT EXISTS movimientos_eliminados (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    movimiento_original_id uuid NOT NULL,
    tipo                   varchar(20)  NOT NULL,
    origen                 varchar(100) NOT NULL,
    metodo_pago            varchar(50)  NOT NULL,
    monto                  numeric(10,2) NOT NULL,
    descripcion            text NOT NULL,
    categoria              varchar(100),
    fecha_original         timestamp NOT NULL,
    fecha_eliminacion      timestamp NOT NULL,
    usuario_eliminacion    uuid NOT NULL,
    motivo_eliminacion     text NOT NULL,
    created_at             timestamp DEFAULT now() NOT NULL,
    modulo_origen          varchar(20) DEFAULT 'caja_fuerte' NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_movimientos_eliminados_fecha_eliminacion ON movimientos_eliminados (fecha_eliminacion);
CREATE INDEX IF NOT EXISTS ix_movimientos_eliminados_fecha_original ON movimientos_eliminados (fecha_original);
CREATE INDEX IF NOT EXISTS ix_movimientos_eliminados_modulo ON movimientos_eliminados (modulo_origen);

-- ───────────────────────── TRIGGERS updated_at ─────────────────────────
DROP TRIGGER IF EXISTS update_caja_fuerte_updated_at ON caja_fuerte;
CREATE TRIGGER update_caja_fuerte_updated_at BEFORE UPDATE ON caja_fuerte
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_configuracion_cf_updated_at ON configuracion_caja_fuerte;
CREATE TRIGGER update_configuracion_cf_updated_at BEFORE UPDATE ON configuracion_caja_fuerte
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

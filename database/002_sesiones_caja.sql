-- =====================================================================
--  Sesiones de caja: apertura con monto inicial y cierre por sesión
--  (reemplaza el cierre por día/horario).
--
--  * Solo puede haber UNA sesión abierta a la vez (índice único parcial).
--  * Todo movimiento de caja diaria queda ligado a la sesión abierta.
--  * El cierre guarda el arqueo: efectivo esperado, contado y diferencia.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sesiones_caja (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    estado                 varchar(20)   NOT NULL DEFAULT 'abierta',
    -- Apertura
    monto_inicial          numeric(10,2) NOT NULL DEFAULT 0,
    origen_monto_inicial   varchar(20)   NOT NULL DEFAULT 'anterior',
    fecha_apertura         timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    usuario_apertura       uuid          NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    observaciones_apertura text,
    -- Cierre (arqueo)
    fecha_cierre           timestamp,
    usuario_cierre         uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
    cierre_caja_id         uuid REFERENCES cierres_caja(id) ON DELETE SET NULL,
    efectivo_esperado      numeric(10,2),
    efectivo_contado       numeric(10,2),
    diferencia             numeric(10,2),
    efectivo_dejado        numeric(10,2),
    observaciones_cierre   text,
    created_at             timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sesiones_caja_estado_check CHECK (estado IN ('abierta', 'cerrada')),
    CONSTRAINT sesiones_caja_origen_check CHECK (origen_monto_inicial IN ('anterior', 'caja_fuerte', 'externo'))
);
COMMENT ON TABLE sesiones_caja IS 'Turnos de caja diaria: se abren con un monto inicial y se cierran con arqueo';
COMMENT ON COLUMN sesiones_caja.origen_monto_inicial IS 'anterior = base dejada en el cierre previo · caja_fuerte = retirado de caja fuerte · externo = otro origen';

CREATE UNIQUE INDEX IF NOT EXISTS ux_sesiones_caja_una_abierta ON sesiones_caja (estado) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS idx_sesiones_caja_apertura ON sesiones_caja (fecha_apertura DESC);

ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS sesion_caja_id uuid REFERENCES sesiones_caja(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_sesion ON movimientos_caja (sesion_caja_id);

ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS sesion_caja_id   uuid REFERENCES sesiones_caja(id) ON DELETE SET NULL;
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS efectivo_contado numeric(10,2);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS diferencia       numeric(10,2);

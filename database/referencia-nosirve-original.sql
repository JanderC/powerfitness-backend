--
-- PostgreSQL database dump
--

-- Dumped from database version 15.12
-- Dumped by pg_dump version 16.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abonos_deuda; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abonos_deuda (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deuda_id uuid NOT NULL,
    monto numeric(10,2) NOT NULL,
    metodo_pago character varying(50),
    fecha_abono timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    notas text
);


--
-- Name: caja_fuerte; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caja_fuerte (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    balance_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    balance_transferencias numeric(10,2) DEFAULT 0 NOT NULL,
    balance_total numeric(10,2) DEFAULT 0 NOT NULL,
    ultima_actualizacion timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE caja_fuerte; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.caja_fuerte IS 'Balance principal del negocio - solo debe existir un registro';


--
-- Name: COLUMN caja_fuerte.balance_efectivo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caja_fuerte.balance_efectivo IS 'Dinero físico real en caja fuerte';


--
-- Name: COLUMN caja_fuerte.balance_transferencias; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caja_fuerte.balance_transferencias IS 'Registro contable de transferencias';


--
-- Name: COLUMN caja_fuerte.balance_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caja_fuerte.balance_total IS 'Suma de efectivo + transferencias';


--
-- Name: checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkins (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cliente_id uuid NOT NULL,
    fecha_hora timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metodo character varying(20) DEFAULT 'huella'::character varying,
    exitoso boolean DEFAULT true,
    nota text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT checkins_metodo_check CHECK (((metodo)::text = ANY (ARRAY[('huella'::character varying)::text, ('manual'::character varying)::text, ('cedula'::character varying)::text])))
);


--
-- Name: cierres_caja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cierres_caja (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    fecha_cierre timestamp without time zone NOT NULL,
    tipo_cierre character varying(20) NOT NULL,
    efectivo_inicial numeric(10,2) DEFAULT 0 NOT NULL,
    ingresos_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    egresos_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    efectivo_final numeric(10,2) DEFAULT 0 NOT NULL,
    ingresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    egresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    total_ingresos numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos numeric(10,2) DEFAULT 0 NOT NULL,
    balance_general numeric(10,2) DEFAULT 0 NOT NULL,
    cantidad_movimientos integer DEFAULT 0 NOT NULL,
    observaciones text,
    usuario_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: clientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clientes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying(100) NOT NULL,
    apellido character varying(100) NOT NULL,
    cedula character varying(20) NOT NULL,
    telefono character varying(20),
    email character varying(150),
    fecha_nacimiento date,
    direccion text,
    huella_template character varying,
    foto_base64 text,
    activo boolean DEFAULT true,
    created_at date DEFAULT CURRENT_TIMESTAMP,
    updated_at date DEFAULT CURRENT_TIMESTAMP,
    huella_digital character varying,
    huella_template_1 text,
    huella_template_2 text,
    huella_template_3 text,
    peso numeric(5,2),
    huella_template_4 text,
    huella_template_5 text,
    quality_score text,
    finger_position text DEFAULT 'unknown'::text,
    raw_width integer DEFAULT 252,
    raw_height integer DEFAULT 324,
    raw_dpi integer DEFAULT 500,
    feature_set text
);


--
-- Name: COLUMN clientes.peso; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clientes.peso IS 'Peso del cliente en kilogramos';


--
-- Name: configuracion_caja_fuerte; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuracion_caja_fuerte (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    password_hash character varying(255) NOT NULL,
    requiere_cambio_password boolean DEFAULT false NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE configuracion_caja_fuerte; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.configuracion_caja_fuerte IS 'Configuración de seguridad de caja fuerte - solo debe existir un registro';


--
-- Name: COLUMN configuracion_caja_fuerte.password_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.configuracion_caja_fuerte.password_hash IS 'Hash SHA256 de la contraseña de acceso';


--
-- Name: COLUMN configuracion_caja_fuerte.requiere_cambio_password; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.configuracion_caja_fuerte.requiere_cambio_password IS 'Indica si se debe forzar cambio de contraseña (opcional)';


--
-- Name: consolidados_mensuales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consolidados_mensuales (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    mes integer NOT NULL,
    anio integer NOT NULL,
    total_ingresos_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    total_ingresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    total_egresos_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    balance_final_efectivo numeric(10,2) DEFAULT 0 NOT NULL,
    balance_final_transferencia numeric(10,2) DEFAULT 0 NOT NULL,
    fecha_consolidacion timestamp(6) without time zone NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT consolidados_mensuales_mes_check CHECK (((mes >= 1) AND (mes <= 12)))
);


--
-- Name: TABLE consolidados_mensuales; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.consolidados_mensuales IS 'Resúmenes históricos mensuales - Los movimientos detallados se eliminan después de consolidar';


--
-- Name: COLUMN consolidados_mensuales.mes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.consolidados_mensuales.mes IS 'Mes consolidado (1-12)';


--
-- Name: COLUMN consolidados_mensuales.anio; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.consolidados_mensuales.anio IS 'Año del consolidado';


--
-- Name: deudas_clientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deudas_clientes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cliente_id uuid NOT NULL,
    concepto character varying(200) NOT NULL,
    monto_total numeric(10,2) NOT NULL,
    monto_pagado numeric(10,2) DEFAULT 0,
    saldo numeric(10,2) NOT NULL,
    estado character varying(20) DEFAULT 'pendiente'::character varying,
    fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    fecha_vencimiento date,
    notas text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT deudas_estado_check CHECK (((estado)::text = ANY (ARRAY[('pendiente'::character varying)::text, ('pagada'::character varying)::text, ('vencida'::character varying)::text])))
);


--
-- Name: empleados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empleados (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying(100) NOT NULL,
    apellido character varying(100) NOT NULL,
    cedula character varying(20) NOT NULL,
    telefono character varying(20),
    email character varying(150),
    cargo character varying(50),
    salario numeric(10,2),
    fecha_contratacion date,
    activo boolean DEFAULT true,
    created_at date DEFAULT CURRENT_TIMESTAMP,
    updated_at date DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: membresias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membresias (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cliente_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    fecha_inicio date NOT NULL,
    fecha_vencimiento date NOT NULL,
    estado character varying(20) DEFAULT 'activa'::character varying,
    monto_pagado numeric(10,2) NOT NULL,
    metodo_pago character varying(50),
    notas text,
    created_at date DEFAULT CURRENT_TIMESTAMP,
    updated_at date DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT membresias_estado_check CHECK (((estado)::text = ANY (ARRAY[('activa'::character varying)::text, ('vencida'::character varying)::text, ('suspendida'::character varying)::text, ('cancelada'::character varying)::text])))
);


--
-- Name: movimientos_caja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos_caja (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tipo character varying(20) NOT NULL,
    categoria character varying(50) NOT NULL,
    monto numeric(10,2) NOT NULL,
    descripcion text,
    referencia_id uuid,
    usuario_id uuid DEFAULT '1e9f2a3f-86b1-4f53-8ef4-f706d001a2e4'::uuid NOT NULL,
    fecha timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metodo_pago character varying(50),
    created_at date DEFAULT CURRENT_TIMESTAMP,
    cerrado boolean DEFAULT false NOT NULL,
    cierre_caja_id uuid,
    movimiento_caja_fuerte_id uuid,
    CONSTRAINT movimientos_caja_tipo_check CHECK (((tipo)::text = ANY (ARRAY[('ingreso'::character varying)::text, ('egreso'::character varying)::text])))
);


--
-- Name: COLUMN movimientos_caja.cerrado; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movimientos_caja.cerrado IS 'Indica si el movimiento ya fue incluido en un cierre de caja';


--
-- Name: COLUMN movimientos_caja.cierre_caja_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movimientos_caja.cierre_caja_id IS 'ID del cierre de caja que incluyó este movimiento';


--
-- Name: movimientos_caja_fuerte; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos_caja_fuerte (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tipo character varying(20) NOT NULL,
    origen character varying(50) NOT NULL,
    metodo_pago character varying(50) NOT NULL,
    monto numeric(10,2) NOT NULL,
    descripcion text,
    categoria character varying(50),
    cierre_caja_id uuid,
    usuario_id uuid NOT NULL,
    fecha timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP,
    movimiento_caja_id uuid,
    CONSTRAINT movimientos_caja_fuerte_metodo_pago_check CHECK (((metodo_pago)::text = ANY (ARRAY[('efectivo'::character varying)::text, ('transferencia'::character varying)::text]))),
    CONSTRAINT movimientos_caja_fuerte_origen_check CHECK (((origen)::text = ANY (ARRAY[('cierre_caja'::character varying)::text, ('retiro_manual'::character varying)::text, ('transferencia_a_caja'::character varying)::text, ('transferencia_desde_caja'::character varying)::text, ('otros'::character varying)::text]))),
    CONSTRAINT movimientos_caja_fuerte_tipo_check CHECK (((tipo)::text = ANY (ARRAY[('ingreso'::character varying)::text, ('egreso'::character varying)::text])))
);


--
-- Name: TABLE movimientos_caja_fuerte; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.movimientos_caja_fuerte IS 'Registro de todos los movimientos en caja fuerte';


--
-- Name: COLUMN movimientos_caja_fuerte.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movimientos_caja_fuerte.tipo IS 'Tipo de movimiento: ingreso o egreso';


--
-- Name: COLUMN movimientos_caja_fuerte.origen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movimientos_caja_fuerte.origen IS 'Origen del movimiento: cierre_caja, retiro_manual, transferencia_a_caja, transferencia_desde_caja, otros';


--
-- Name: COLUMN movimientos_caja_fuerte.categoria; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movimientos_caja_fuerte.categoria IS 'Para egresos: pago_proveedores, servicios_publicos, mantenimiento, nomina, otros';


--
-- Name: movimientos_eliminados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos_eliminados (
    id uuid NOT NULL,
    movimiento_original_id uuid NOT NULL,
    tipo character varying(20) NOT NULL,
    origen character varying(100) NOT NULL,
    metodo_pago character varying(50) NOT NULL,
    monto numeric(10,2) NOT NULL,
    descripcion text NOT NULL,
    categoria character varying(100),
    fecha_original timestamp without time zone NOT NULL,
    fecha_eliminacion timestamp without time zone NOT NULL,
    usuario_eliminacion uuid NOT NULL,
    motivo_eliminacion text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    modulo_origen character varying(20) DEFAULT 'caja_fuerte'::character varying NOT NULL
);


--
-- Name: notificaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notificaciones (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tipo character varying(50) NOT NULL,
    titulo character varying(200) NOT NULL,
    mensaje text NOT NULL,
    cliente_id uuid,
    leida boolean DEFAULT false,
    prioridad character varying(20) DEFAULT 'normal'::character varying,
    fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    fecha_leida timestamp without time zone,
    CONSTRAINT notificaciones_prioridad_check CHECK (((prioridad)::text = ANY (ARRAY[('baja'::character varying)::text, ('normal'::character varying)::text, ('alta'::character varying)::text, ('urgente'::character varying)::text]))),
    CONSTRAINT notificaciones_tipo_check CHECK (((tipo)::text = ANY (ARRAY[('vencimiento_proximo'::character varying)::text, ('membresia_vencida'::character varying)::text, ('pago_pendiente'::character varying)::text, ('stock_bajo'::character varying)::text, ('sistema'::character varying)::text])))
);


--
-- Name: pagos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pagos (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    membresia_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    monto numeric(10,2) NOT NULL,
    metodo_pago character varying(50) NOT NULL,
    fecha_pago timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    recibo_numero character varying(50),
    notas text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    update_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: pagos_empleados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pagos_empleados (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    empleado_id uuid NOT NULL,
    monto numeric(10,2) NOT NULL,
    periodo character varying(50),
    fecha_pago timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metodo_pago character varying(50),
    notas text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: planes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying(100) NOT NULL,
    descripcion text,
    tipo character varying(20) NOT NULL,
    duracion_dias integer NOT NULL,
    precio numeric(10,2) NOT NULL,
    activo boolean DEFAULT true,
    color character varying(7) DEFAULT '#00FF00'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    tipo_calculo_vencimiento character varying(20) DEFAULT 'dias'::character varying NOT NULL,
    cantidad_unidades integer DEFAULT 1 NOT NULL,
    CONSTRAINT planes_tipo_check CHECK (((tipo)::text = ANY (ARRAY[('semanal'::character varying)::text, ('mensual'::character varying)::text, ('personalizado'::character varying)::text, ('diario'::character varying)::text, ('trimestral'::character varying)::text, ('semestral'::character varying)::text, ('anual'::character varying)::text, ('otro'::character varying)::text])))
);


--
-- Name: productos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.productos (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying(150) NOT NULL,
    descripcion text,
    precio numeric(10,2) NOT NULL,
    stock integer DEFAULT 0,
    imagen_base64 text,
    categoria character varying(50),
    activo boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    nombre character varying(100) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash character varying(255) NOT NULL,
    rol character varying(20) DEFAULT 'admin'::character varying,
    telefono character varying(20),
    activo boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT usuarios_rol_check CHECK (((rol)::text = ANY (ARRAY[('admin'::character varying)::text, ('staff'::character varying)::text])))
);


--
-- Name: ventas_productos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ventas_productos (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cliente_id uuid,
    producto_id uuid NOT NULL,
    cantidad integer DEFAULT 1 NOT NULL,
    precio_unitario numeric(10,2) NOT NULL,
    total numeric(10,2) NOT NULL,
    estado_pago character varying(20) DEFAULT 'pendiente'::character varying,
    fecha_venta timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    fecha_pago timestamp without time zone,
    notas text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ventas_productos_estado_pago_check CHECK (((estado_pago)::text = ANY (ARRAY[('pendiente'::character varying)::text, ('parcial'::character varying)::text, ('pagado'::character varying)::text, ('fiado'::character varying)::text])))
);


--
-- Name: caja_fuerte caja_fuerte_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_fuerte
    ADD CONSTRAINT caja_fuerte_pkey PRIMARY KEY (id);


--
-- Name: cierres_caja cierres_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja
    ADD CONSTRAINT cierres_caja_pkey PRIMARY KEY (id);


--
-- Name: configuracion_caja_fuerte configuracion_caja_fuerte_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion_caja_fuerte
    ADD CONSTRAINT configuracion_caja_fuerte_pkey PRIMARY KEY (id);


--
-- Name: consolidados_mensuales consolidados_mensuales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidados_mensuales
    ADD CONSTRAINT consolidados_mensuales_pkey PRIMARY KEY (id);


--
-- Name: consolidados_mensuales consolidados_mensuales_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidados_mensuales
    ADD CONSTRAINT consolidados_mensuales_unique UNIQUE (mes, anio);


--
-- Name: movimientos_caja_fuerte movimientos_caja_fuerte_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja_fuerte
    ADD CONSTRAINT movimientos_caja_fuerte_pkey PRIMARY KEY (id);


--
-- Name: movimientos_eliminados movimientos_eliminados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_eliminados
    ADD CONSTRAINT movimientos_eliminados_pkey PRIMARY KEY (id);


--
-- Name: movimientos_caja pk_movimientos_caja; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT pk_movimientos_caja PRIMARY KEY (id);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: idx_cierres_caja_fecha_cierre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cierres_caja_fecha_cierre ON public.cierres_caja USING btree (fecha_cierre);


--
-- Name: idx_cierres_caja_usuario_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cierres_caja_usuario_id ON public.cierres_caja USING btree (usuario_id);


--
-- Name: idx_consolidados_mes_anio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consolidados_mes_anio ON public.consolidados_mensuales USING btree (anio DESC NULLS LAST, mes DESC NULLS LAST);


--
-- Name: idx_membresias_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membresias_estado ON public.membresias USING btree (estado);


--
-- Name: idx_membresias_estado_vencimiento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membresias_estado_vencimiento ON public.membresias USING btree (estado, fecha_vencimiento);


--
-- Name: idx_membresias_fecha_vencimiento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membresias_fecha_vencimiento ON public.membresias USING btree (fecha_vencimiento);


--
-- Name: idx_movimientos_caja_cerrado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_caja_cerrado ON public.movimientos_caja USING btree (cerrado);


--
-- Name: idx_movimientos_caja_cierre_caja_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_caja_cierre_caja_id ON public.movimientos_caja USING btree (cierre_caja_id);


--
-- Name: idx_movimientos_caja_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_caja_fecha ON public.movimientos_caja USING btree (fecha);


--
-- Name: idx_movimientos_caja_usuario_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_caja_usuario_id ON public.movimientos_caja USING btree (usuario_id);


--
-- Name: idx_movimientos_cf_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_cf_fecha ON public.movimientos_caja_fuerte USING btree (fecha);


--
-- Name: idx_movimientos_cf_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_cf_tipo ON public.movimientos_caja_fuerte USING btree (tipo);


--
-- Name: idx_movimientos_cf_usuario_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_cf_usuario_id ON public.movimientos_caja_fuerte USING btree (usuario_id);


--
-- Name: ix_movimientos_caja_fuerte_movimiento_caja_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_caja_fuerte_movimiento_caja_id ON public.movimientos_caja_fuerte USING btree (movimiento_caja_id);


--
-- Name: ix_movimientos_caja_movimiento_cf_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_caja_movimiento_cf_id ON public.movimientos_caja USING btree (movimiento_caja_fuerte_id);


--
-- Name: ix_movimientos_eliminados_fecha_eliminacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_eliminados_fecha_eliminacion ON public.movimientos_eliminados USING btree (fecha_eliminacion);


--
-- Name: ix_movimientos_eliminados_fecha_original; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_eliminados_fecha_original ON public.movimientos_eliminados USING btree (fecha_original);


--
-- Name: ix_movimientos_eliminados_movimiento_original_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_eliminados_movimiento_original_id ON public.movimientos_eliminados USING btree (movimiento_original_id);


--
-- Name: ix_movimientos_eliminados_usuario_eliminacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_movimientos_eliminados_usuario_eliminacion ON public.movimientos_eliminados USING btree (usuario_eliminacion);


--
-- Name: caja_fuerte update_caja_fuerte_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_caja_fuerte_updated_at BEFORE UPDATE ON public.caja_fuerte FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: configuracion_caja_fuerte update_configuracion_cf_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_configuracion_cf_updated_at BEFORE UPDATE ON public.configuracion_caja_fuerte FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: movimientos_caja_fuerte fk_movimientos_caja_fuerte_movimiento_caja; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja_fuerte
    ADD CONSTRAINT fk_movimientos_caja_fuerte_movimiento_caja FOREIGN KEY (movimiento_caja_id) REFERENCES public.movimientos_caja(id) ON DELETE SET NULL;


--
-- Name: movimientos_caja_fuerte fk_movimientos_cf_cierre_caja; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja_fuerte
    ADD CONSTRAINT fk_movimientos_cf_cierre_caja FOREIGN KEY (cierre_caja_id) REFERENCES public.cierres_caja(id) ON DELETE SET NULL;


--
-- Name: movimientos_caja_fuerte fk_movimientos_cf_usuario; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja_fuerte
    ADD CONSTRAINT fk_movimientos_cf_usuario FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


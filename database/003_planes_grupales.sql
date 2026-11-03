-- =====================================================================
--  Planes grupales / promocionales (ej. "Promo Dúo": 2 personas por $35.000)
--
--  * planes.personas: cuántas personas cubre el precio del plan (1 = individual).
--  * planes.promocional: marca visual de promoción.
--  * membresias.grupo_id: une las mensualidades vendidas juntas en un mismo plan
--    grupal (se renuevan juntas). Cada persona tiene su propia mensualidad.
-- =====================================================================

ALTER TABLE planes ADD COLUMN IF NOT EXISTS personas integer NOT NULL DEFAULT 1;
ALTER TABLE planes ADD COLUMN IF NOT EXISTS promocional boolean NOT NULL DEFAULT false;
ALTER TABLE planes DROP CONSTRAINT IF EXISTS planes_personas_check;
ALTER TABLE planes ADD CONSTRAINT planes_personas_check CHECK (personas BETWEEN 1 AND 10);
COMMENT ON COLUMN planes.personas IS 'Personas que cubre el precio (1 = individual, 2 = dúo, …)';

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS grupo_id uuid;
CREATE INDEX IF NOT EXISTS idx_membresias_grupo ON membresias (grupo_id) WHERE grupo_id IS NOT NULL;
COMMENT ON COLUMN membresias.grupo_id IS 'Mensualidades vendidas juntas en un plan grupal';

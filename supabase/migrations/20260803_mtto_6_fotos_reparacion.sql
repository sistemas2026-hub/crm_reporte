-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: fotos en las líneas de cotización.
--
-- Motivo: las fotos existentes (mtto_orden_foto) cuelgan de un
-- HALLAZGO del checklist, y son OBLIGATORIAS en los ítems en M.
-- Esta migración agrega fotos que cuelgan de una LÍNEA DE
-- REPARACIÓN, para que el mecánico pueda mostrarle al aprobador
-- el repuesto dañado que está cotizando. Son OPCIONALES: no
-- cambian ninguna regla de validación de mtto_enviar_a_revision.
--
-- Se usa una tabla nueva en lugar de ampliar mtto_orden_foto para
-- no tocar su constraint NOT NULL, su trigger ni sus políticas, que
-- ya están en producción.
--
-- Requiere 20260803_mtto_1_schema.sql. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mtto_reparacion_foto (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reparacion_id uuid NOT NULL REFERENCES public.mtto_orden_reparacion(id) ON DELETE CASCADE,
    path          text NOT NULL,
    mime          text,
    bytes         int,
    subido_por    uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtto_rep_foto_reparacion ON public.mtto_reparacion_foto(reparacion_id);

-- ------------------------------------------------------------
-- Inmutabilidad fuera de borrador (mismo criterio que las fotos
-- de hallazgo: se bloquea con trigger, no solo con RLS)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_bloquear_edicion_foto_reparacion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_reparacion_id uuid := COALESCE(NEW.reparacion_id, OLD.reparacion_id);
BEGIN
    SELECT o.estado INTO v_estado
    FROM public.mtto_orden_reparacion r
    JOIN public.mtto_orden o ON o.id = r.orden_id
    WHERE r.id = v_reparacion_id;

    IF v_estado IS DISTINCT FROM 'borrador' THEN
        RAISE EXCEPTION 'No se puede modificar fotos de cotización de una orden fuera de borrador (estado actual: %)', v_estado;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_bloquear_edicion_foto_reparacion ON public.mtto_reparacion_foto;
CREATE TRIGGER trg_mtto_bloquear_edicion_foto_reparacion
    BEFORE UPDATE OR DELETE ON public.mtto_reparacion_foto
    FOR EACH ROW EXECUTE FUNCTION public.mtto_bloquear_edicion_foto_reparacion();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.mtto_reparacion_foto ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mtto_rep_foto_select ON public.mtto_reparacion_foto;
CREATE POLICY mtto_rep_foto_select ON public.mtto_reparacion_foto
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden_reparacion r
        JOIN public.mtto_orden o ON o.id = r.orden_id
        WHERE r.id = reparacion_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

DROP POLICY IF EXISTS mtto_rep_foto_insert ON public.mtto_reparacion_foto;
CREATE POLICY mtto_rep_foto_insert ON public.mtto_reparacion_foto
    FOR INSERT WITH CHECK (
        public.mtto_tiene_rol('mecanico')
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden_reparacion r
            JOIN public.mtto_orden o ON o.id = r.orden_id
            WHERE r.id = reparacion_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
        )
    );

DROP POLICY IF EXISTS mtto_rep_foto_delete ON public.mtto_reparacion_foto;
CREATE POLICY mtto_rep_foto_delete ON public.mtto_reparacion_foto
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden_reparacion r
        JOIN public.mtto_orden o ON o.id = r.orden_id
        WHERE r.id = reparacion_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

-- ------------------------------------------------------------
-- STORAGE: se reutiliza el bucket privado mtto-fotos.
-- Ruta: mtto-fotos/{orden_id}/{reparacion_id}/{uuid}.jpg
--
-- La política de SELECT existente ya sirve: solo valida que la
-- primera carpeta sea una orden de la organización, sin importar
-- qué haya en la segunda. Hay que ampliar INSERT y DELETE, que sí
-- exigían que la segunda carpeta fuera un hallazgo.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS mtto_fotos_insert ON storage.objects;
CREATE POLICY mtto_fotos_insert ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'mtto-fotos'
        AND public.mtto_tiene_rol('mecanico')
        AND (
            -- foto de un hallazgo del checklist
            EXISTS (
                SELECT 1 FROM public.mtto_orden_hallazgo h
                JOIN public.mtto_orden o ON o.id = h.orden_id
                WHERE h.id::text = (storage.foldername(name))[2]
                  AND o.id::text = (storage.foldername(name))[1]
                  AND o.creado_por = auth.uid()
                  AND o.estado = 'borrador'
            )
            -- o foto de una línea de cotización
            OR EXISTS (
                SELECT 1 FROM public.mtto_orden_reparacion r
                JOIN public.mtto_orden o ON o.id = r.orden_id
                WHERE r.id::text = (storage.foldername(name))[2]
                  AND o.id::text = (storage.foldername(name))[1]
                  AND o.creado_por = auth.uid()
                  AND o.estado = 'borrador'
            )
        )
    );

DROP POLICY IF EXISTS mtto_fotos_delete ON storage.objects;
CREATE POLICY mtto_fotos_delete ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'mtto-fotos'
        AND (
            EXISTS (
                SELECT 1 FROM public.mtto_orden_hallazgo h
                JOIN public.mtto_orden o ON o.id = h.orden_id
                WHERE h.id::text = (storage.foldername(name))[2]
                  AND o.id::text = (storage.foldername(name))[1]
                  AND o.creado_por = auth.uid()
                  AND o.estado = 'borrador'
            )
            OR EXISTS (
                SELECT 1 FROM public.mtto_orden_reparacion r
                JOIN public.mtto_orden o ON o.id = r.orden_id
                WHERE r.id::text = (storage.foldername(name))[2]
                  AND o.id::text = (storage.foldername(name))[1]
                  AND o.creado_por = auth.uid()
                  AND o.estado = 'borrador'
            )
        )
    );

NOTIFY pgrst, 'reload schema';

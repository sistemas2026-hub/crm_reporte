-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Guardián: al cambiar el vehículo de una orden en borrador, el
-- vehículo nuevo debe ser de la misma organización.
--
-- Contexto: la pestaña Vehículo ahora permite cambiar de vehículo
-- mientras la orden esté en borrador (antes solo se elegía al
-- crearla). El trigger mtto_bloquear_edicion_orden ya impide ese
-- cambio fuera de borrador, y la política RLS de UPDATE valida el
-- org_id de la ORDEN — pero no el del vehículo nuevo.
--
-- Sin esta validación, una llamada manipulada a la API podría
-- apuntar la orden al vehículo de otra organización. No filtraría
-- datos (el SELECT de ese vehículo sigue protegido por RLS, así que
-- devolvería vacío), pero dejaría la orden en un estado roto y
-- confuso. Es barato cerrarlo.
--
-- Requiere mtto_1_schema. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mtto_validar_vehiculo_orden()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_org_vehiculo uuid;
BEGIN
    IF NEW.vehiculo_id IS DISTINCT FROM OLD.vehiculo_id THEN
        SELECT org_id INTO v_org_vehiculo
        FROM public.mtto_vehiculo WHERE id = NEW.vehiculo_id;

        IF v_org_vehiculo IS NULL THEN
            RAISE EXCEPTION 'El vehículo indicado no existe';
        END IF;
        IF v_org_vehiculo <> OLD.org_id THEN
            RAISE EXCEPTION 'No se puede asignar la orden a un vehículo de otra organización';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_validar_vehiculo_orden ON public.mtto_orden;
CREATE TRIGGER trg_mtto_validar_vehiculo_orden
    BEFORE UPDATE ON public.mtto_orden
    FOR EACH ROW EXECUTE FUNCTION public.mtto_validar_vehiculo_orden();

NOTIFY pgrst, 'reload schema';

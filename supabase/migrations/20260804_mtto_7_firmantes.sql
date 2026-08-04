-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: firmantes SIN cuenta de plataforma.
--
-- Hasta ahora, revisar y aprobar exigía que la persona tuviera
-- usuario en la plataforma (auth.users + profiles), porque la firma
-- era su usuario_id. Esta migración agrega un segundo tipo de
-- firmante: una persona registrada solo dentro del módulo, con
-- nombre, documento y PIN propio, que NO puede iniciar sesión.
--
-- La firma sigue siendo verificable e inmodificable: queda el id del
-- firmante + la hora del servidor, escrito por funciones SECURITY
-- DEFINER en la tabla append-only de trazabilidad. La diferencia es
-- que la identidad se ancla a un registro del módulo en vez de a una
-- cuenta.
--
-- ADVERTENCIA DE DISEÑO: el PIN inicial lo crea el administrador, así
-- que hasta que la persona lo cambie, quien lo creó podría firmar en
-- su nombre. Por eso se incluye mtto_cambiar_pin_firmante(), que
-- exige el PIN actual y permite a la persona hacerlo exclusivo suyo
-- desde la misma pantalla de firma.
--
-- Requiere 20260803_mtto_1_schema.sql y _3_rpc.sql. Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABLA DE FIRMANTES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mtto_firmante (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                uuid NOT NULL DEFAULT public.get_my_org_id() REFERENCES public.organizations(id),
    nombre                text NOT NULL,
    documento             text,
    cargo                 text,
    rol                   public.mtto_rol NOT NULL,
    pin_hash              text,
    pin_intentos_fallidos int NOT NULL DEFAULT 0,
    pin_bloqueado_hasta   timestamptz,
    pin_definido_por_admin boolean NOT NULL DEFAULT true, -- false cuando la persona ya lo cambió
    -- Derivada: permite saber si ya hay PIN sin exponer el hash, cuyo
    -- SELECT está revocado más abajo.
    tiene_pin             boolean GENERATED ALWAYS AS (pin_hash IS NOT NULL) STORED,
    activo                boolean NOT NULL DEFAULT true,
    creado_por            uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mtto_firmante_nombre_no_vacio CHECK (btrim(nombre) <> '')
);

CREATE INDEX IF NOT EXISTS idx_mtto_firmante_org ON public.mtto_firmante(org_id);

-- ------------------------------------------------------------
-- 2. COLUMNAS DE FIRMA EN LA ORDEN
-- revisado_por / aprobado_por siguen apuntando a profiles cuando
-- firma un usuario con cuenta. Estas nuevas apuntan al firmante sin
-- cuenta. En cada paso se llena una u otra, nunca ambas.
-- ------------------------------------------------------------
ALTER TABLE public.mtto_orden
    ADD COLUMN IF NOT EXISTS revisado_por_firmante uuid REFERENCES public.mtto_firmante(id),
    ADD COLUMN IF NOT EXISTS aprobado_por_firmante uuid REFERENCES public.mtto_firmante(id);

DO $$ BEGIN
    ALTER TABLE public.mtto_orden ADD CONSTRAINT mtto_orden_un_revisor
        CHECK (revisado_por IS NULL OR revisado_por_firmante IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.mtto_orden ADD CONSTRAINT mtto_orden_un_aprobador
        CHECK (aprobado_por IS NULL OR aprobado_por_firmante IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- El trigger de inmutabilidad no lista estas columnas, así que no hay
-- que tocarlo: solo las escriben las funciones RPC de abajo.

-- ------------------------------------------------------------
-- 3. TRAZABILIDAD
-- mtto_orden_evento.usuario_id es NOT NULL y apunta a profiles. Para
-- registrar eventos firmados por alguien sin cuenta se agrega una
-- columna paralela y se relaja el NOT NULL, exigiendo que haya
-- exactamente uno de los dos.
-- ------------------------------------------------------------
ALTER TABLE public.mtto_orden_evento
    ADD COLUMN IF NOT EXISTS firmante_id uuid REFERENCES public.mtto_firmante(id);

ALTER TABLE public.mtto_orden_evento ALTER COLUMN usuario_id DROP NOT NULL;

DO $$ BEGIN
    ALTER TABLE public.mtto_orden_evento ADD CONSTRAINT mtto_evento_un_autor
        CHECK (num_nonnulls(usuario_id, firmante_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 4. RLS — lectura para el módulo, escritura solo admin.
-- pin_hash nunca se expone: el cliente lee la tabla, así que se
-- revoca el SELECT sobre esa columna en particular.
-- ------------------------------------------------------------
ALTER TABLE public.mtto_firmante ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mtto_firmante_select ON public.mtto_firmante;
CREATE POLICY mtto_firmante_select ON public.mtto_firmante
    FOR SELECT USING (public.mtto_tiene_rol_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_firmante_insert ON public.mtto_firmante;
CREATE POLICY mtto_firmante_insert ON public.mtto_firmante
    FOR INSERT WITH CHECK (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_firmante_update ON public.mtto_firmante;
CREATE POLICY mtto_firmante_update ON public.mtto_firmante
    FOR UPDATE USING (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

-- El hash del PIN no debe viajar nunca al navegador. OJO: con esto,
-- un `select *` sobre la tabla falla; el cliente debe pedir columnas
-- explícitas (ver MTTO_FIRMANTE_COLS en mttoService.ts). Para saber si
-- ya hay PIN se usa la columna derivada tiene_pin.
REVOKE SELECT (pin_hash) ON public.mtto_firmante FROM authenticated, anon;

-- ------------------------------------------------------------
-- 5. GESTIÓN DEL PIN
-- ------------------------------------------------------------

-- El admin asigna el PIN inicial (queda marcado como definido por admin)
CREATE OR REPLACE FUNCTION public.mtto_asignar_pin_firmante(p_firmante_id uuid, p_pin text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
    IF NOT public.mtto_es_admin_modulo() THEN
        RAISE EXCEPTION 'Solo un administrador del módulo puede asignar el PIN inicial';
    END IF;
    IF p_pin !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'El PIN debe tener entre 4 y 6 dígitos numéricos';
    END IF;

    UPDATE public.mtto_firmante
    SET pin_hash = crypt(p_pin, gen_salt('bf')),
        pin_intentos_fallidos = 0,
        pin_bloqueado_hasta = NULL,
        pin_definido_por_admin = true
    WHERE id = p_firmante_id AND org_id = public.get_my_org_id();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Firmante no encontrado';
    END IF;
END;
$$;

-- La persona cambia SU PIN presentando el actual. A partir de aquí
-- solo ella lo conoce (pin_definido_por_admin queda en false).
CREATE OR REPLACE FUNCTION public.mtto_cambiar_pin_firmante(p_firmante_id uuid, p_pin_actual text, p_pin_nuevo text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF p_pin_nuevo !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'El PIN nuevo debe tener entre 4 y 6 dígitos numéricos';
    END IF;

    PERFORM public.mtto_validar_pin_firmante(p_firmante_id, p_pin_actual);

    UPDATE public.mtto_firmante
    SET pin_hash = crypt(p_pin_nuevo, gen_salt('bf')),
        pin_intentos_fallidos = 0,
        pin_bloqueado_hasta = NULL,
        pin_definido_por_admin = false
    WHERE id = p_firmante_id;
END;
$$;

-- Validación con bloqueo tras 5 intentos fallidos (15 minutos).
-- No se expone al cliente: solo la usan las funciones de firma.
CREATE OR REPLACE FUNCTION public.mtto_validar_pin_firmante(p_firmante_id uuid, p_pin text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_hash text;
    v_bloqueado timestamptz;
    v_activo boolean;
BEGIN
    SELECT pin_hash, pin_bloqueado_hasta, activo
    INTO v_hash, v_bloqueado, v_activo
    FROM public.mtto_firmante WHERE id = p_firmante_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Firmante no encontrado';
    END IF;
    IF NOT v_activo THEN
        RAISE EXCEPTION 'Ese firmante está inactivo';
    END IF;
    IF v_hash IS NULL THEN
        RAISE EXCEPTION 'Ese firmante todavía no tiene PIN asignado';
    END IF;
    IF v_bloqueado IS NOT NULL AND v_bloqueado > now() THEN
        RAISE EXCEPTION 'PIN bloqueado por intentos fallidos. Intente después de %', to_char(v_bloqueado, 'HH24:MI');
    END IF;

    IF v_hash <> crypt(p_pin, v_hash) THEN
        UPDATE public.mtto_firmante
        SET pin_intentos_fallidos = pin_intentos_fallidos + 1,
            pin_bloqueado_hasta = CASE WHEN pin_intentos_fallidos + 1 >= 5 THEN now() + interval '15 minutes' ELSE pin_bloqueado_hasta END
        WHERE id = p_firmante_id;
        RAISE EXCEPTION 'PIN incorrecto';
    END IF;

    UPDATE public.mtto_firmante SET pin_intentos_fallidos = 0, pin_bloqueado_hasta = NULL WHERE id = p_firmante_id;
END;
$$;

-- ------------------------------------------------------------
-- 6. FIRMA DE ÓRDENES POR FIRMANTE SIN CUENTA
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mtto_revisar_orden_firmante(p_orden_id uuid, p_firmante_id uuid, p_pin text, p_obs text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_rol public.mtto_rol;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    SELECT rol INTO v_rol FROM public.mtto_firmante WHERE id = p_firmante_id AND org_id = public.get_my_org_id();
    IF v_rol IS NULL THEN
        RAISE EXCEPTION 'Firmante no encontrado';
    END IF;
    IF v_rol NOT IN ('encargado', 'admin') THEN
        RAISE EXCEPTION 'Esa persona no tiene rol de encargado de flota';
    END IF;

    PERFORM public.mtto_validar_pin_firmante(p_firmante_id, p_pin);

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado <> 'en_revision' THEN
        RAISE EXCEPTION 'Solo se puede revisar una orden en en_revision (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_orden
    SET estado = 'en_aprobacion',
        revisado_por = NULL,
        revisado_por_firmante = p_firmante_id,
        revisado_at = now(),
        obs_encargado = p_obs
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
    VALUES (p_orden_id, NULL, p_firmante_id, 'revisado',
            jsonb_build_object('obs', p_obs, 'via', 'pin_firmante', 'operado_por', auth.uid()));
END;
$$;

CREATE OR REPLACE FUNCTION public.mtto_aprobar_orden_firmante(
    p_orden_id uuid,
    p_firmante_id uuid,
    p_pin text,
    p_decision public.mtto_decision,
    p_obs text,
    p_valor_aprobado numeric,
    p_lineas_autorizadas uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_nuevo_estado public.mtto_estado_orden;
    v_rol public.mtto_rol;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    SELECT rol INTO v_rol FROM public.mtto_firmante WHERE id = p_firmante_id AND org_id = public.get_my_org_id();
    IF v_rol IS NULL THEN
        RAISE EXCEPTION 'Firmante no encontrado';
    END IF;
    IF v_rol NOT IN ('aprobador', 'admin') THEN
        RAISE EXCEPTION 'Esa persona no tiene rol de aprobador';
    END IF;

    PERFORM public.mtto_validar_pin_firmante(p_firmante_id, p_pin);

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado <> 'en_aprobacion' THEN
        RAISE EXCEPTION 'Solo se puede aprobar una orden en en_aprobacion (estado actual: %)', v_estado;
    END IF;

    IF p_decision = 'aprobado_parcial' THEN
        IF btrim(coalesce(p_obs, '')) = '' THEN
            RAISE EXCEPTION 'La aprobación parcial exige observaciones';
        END IF;
        IF p_lineas_autorizadas IS NULL OR array_length(p_lineas_autorizadas, 1) IS NULL THEN
            RAISE EXCEPTION 'La aprobación parcial exige indicar las líneas autorizadas';
        END IF;
    END IF;

    PERFORM set_config('mtto.autorizando', 'on', true);

    IF p_decision = 'aprobado' THEN
        UPDATE public.mtto_orden_reparacion SET autorizado = true WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'aprobada';
    ELSIF p_decision = 'aprobado_parcial' THEN
        UPDATE public.mtto_orden_reparacion
        SET autorizado = (id = ANY (p_lineas_autorizadas))
        WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'aprobada';
    ELSE
        UPDATE public.mtto_orden_reparacion SET autorizado = false WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'rechazada';
    END IF;

    UPDATE public.mtto_orden
    SET estado = v_nuevo_estado,
        aprobado_por = NULL,
        aprobado_por_firmante = p_firmante_id,
        aprobado_at = now(),
        decision = p_decision,
        obs_aprobador = p_obs,
        valor_aprobado = p_valor_aprobado
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
    VALUES (p_orden_id, NULL, p_firmante_id, 'decision_aprobacion', jsonb_build_object(
        'decision', p_decision, 'obs', p_obs, 'valor_aprobado', p_valor_aprobado,
        'lineas_autorizadas', to_jsonb(p_lineas_autorizadas),
        'via', 'pin_firmante', 'operado_por', auth.uid()
    ));
END;
$$;

-- ------------------------------------------------------------
-- 7. PERMISOS
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mtto_validar_pin_firmante(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_asignar_pin_firmante(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_cambiar_pin_firmante(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_revisar_orden_firmante(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_aprobar_orden_firmante(uuid, uuid, text, public.mtto_decision, text, numeric, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mtto_asignar_pin_firmante(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_cambiar_pin_firmante(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_revisar_orden_firmante(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_aprobar_orden_firmante(uuid, uuid, text, public.mtto_decision, text, numeric, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: firma rápida por PIN para encargado/aprobador.
--
-- Motivo: crear la cuenta ya es fácil (create_new_user existente),
-- pero pedirle al encargado de flota o al aprobador que hagan login
-- de correo+clave cada vez que revisan/aprueban desde el celular del
-- mecánico es fricción real. La firma sigue siendo de una persona
-- real y verificable — NO se reemplaza auth.uid() por una foto o un
-- dibujo (eso sí sería falsificable por cualquiera con el teléfono
-- en la mano). En vez de eso: cada encargado/aprobador configura un
-- PIN propio (una sola vez, logueado normalmente); para revisar o
-- aprobar en el teléfono de otra persona, el sistema exige el
-- usuario_id de quien firma + su PIN, verificado con bcrypt del lado
-- del servidor, con bloqueo tras varios intentos fallidos.
--
-- El login normal (mtto_revisar_orden / mtto_aprobar_orden) sigue
-- existiendo intacto para quien prefiera loguearse en su propio
-- dispositivo.
--
-- Requiere haber corrido 20260803_mtto_1_schema.sql y
-- 20260803_mtto_3_rpc.sql antes.
-- ============================================================

ALTER TABLE public.mtto_usuario_rol
    ADD COLUMN IF NOT EXISTS pin_hash text,
    ADD COLUMN IF NOT EXISTS pin_intentos_fallidos int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pin_bloqueado_hasta timestamptz;

-- ------------------------------------------------------------
-- Helper: ¿el usuario p_usuario_id (no auth.uid()) tiene el rol
-- p_rol activo en el módulo? Análogo a mtto_tiene_rol() pero
-- parametrizado, para validar al FIRMANTE por PIN, no a quien
-- tiene la sesión abierta en el dispositivo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_usuario_tiene_rol(p_usuario_id uuid, p_rol public.mtto_rol)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = p_usuario_id AND role = 'admin'
    ) OR EXISTS (
        SELECT 1 FROM public.mtto_usuario_rol
        WHERE usuario_id = p_usuario_id AND activo AND rol IN (p_rol, 'admin')
    );
$$;

GRANT EXECUTE ON FUNCTION public.mtto_usuario_tiene_rol(uuid, public.mtto_rol) TO authenticated;

-- ------------------------------------------------------------
-- mtto_configurar_pin — cada persona configura SU PROPIO PIN,
-- logueada normalmente (no requiere PIN previo, obvio).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_configurar_pin(p_pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF p_pin !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'El PIN debe tener entre 4 y 6 dígitos numéricos';
    END IF;

    UPDATE public.mtto_usuario_rol
    SET pin_hash = crypt(p_pin, gen_salt('bf')), pin_intentos_fallidos = 0, pin_bloqueado_hasta = NULL
    WHERE usuario_id = auth.uid();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Su usuario todavía no tiene un rol asignado en el módulo de mantenimiento';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_configurar_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_configurar_pin(text) TO authenticated;

-- ------------------------------------------------------------
-- Helper interno: valida el PIN de p_usuario_id contra bcrypt,
-- con bloqueo tras 5 intentos fallidos (15 minutos). No se
-- expone directamente al cliente — solo lo usan las funciones de
-- firma de abajo, para no dar un "oráculo" de validación de PIN
-- suelto por RPC.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_validar_pin(p_usuario_id uuid, p_pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_hash text;
    v_bloqueado_hasta timestamptz;
    v_intentos int;
BEGIN
    SELECT pin_hash, pin_bloqueado_hasta, pin_intentos_fallidos
    INTO v_hash, v_bloqueado_hasta, v_intentos
    FROM public.mtto_usuario_rol
    WHERE usuario_id = p_usuario_id
    FOR UPDATE;

    IF NOT FOUND OR v_hash IS NULL THEN
        RAISE EXCEPTION 'Esa persona todavía no ha configurado su PIN';
    END IF;

    IF v_bloqueado_hasta IS NOT NULL AND v_bloqueado_hasta > now() THEN
        RAISE EXCEPTION 'PIN bloqueado por intentos fallidos. Intente de nuevo después de %', to_char(v_bloqueado_hasta, 'HH24:MI');
    END IF;

    IF v_hash <> crypt(p_pin, v_hash) THEN
        UPDATE public.mtto_usuario_rol
        SET pin_intentos_fallidos = pin_intentos_fallidos + 1,
            pin_bloqueado_hasta = CASE WHEN pin_intentos_fallidos + 1 >= 5 THEN now() + interval '15 minutes' ELSE pin_bloqueado_hasta END
        WHERE usuario_id = p_usuario_id;
        RAISE EXCEPTION 'PIN incorrecto';
    END IF;

    UPDATE public.mtto_usuario_rol SET pin_intentos_fallidos = 0, pin_bloqueado_hasta = NULL WHERE usuario_id = p_usuario_id;
END;
$$;

-- ------------------------------------------------------------
-- mtto_revisar_orden_pin — firma del encargado de flota vía PIN,
-- operado desde la sesión de cualquier usuario del módulo (ej.
-- el mecánico, en su propio teléfono).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_revisar_orden_pin(p_orden_id uuid, p_usuario_id uuid, p_pin text, p_obs text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF NOT public.mtto_usuario_tiene_rol(p_usuario_id, 'encargado') THEN
        RAISE EXCEPTION 'Esa persona no tiene rol de encargado de flota';
    END IF;

    PERFORM public.mtto_validar_pin(p_usuario_id, p_pin);

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado <> 'en_revision' THEN
        RAISE EXCEPTION 'Solo se puede revisar una orden en en_revision (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_orden
    SET estado = 'en_aprobacion', revisado_por = p_usuario_id, revisado_at = now(), obs_encargado = p_obs
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, p_usuario_id, 'revisado', jsonb_build_object('obs', p_obs, 'via', 'pin', 'operado_por', auth.uid()));
END;
$$;

-- ------------------------------------------------------------
-- mtto_aprobar_orden_pin — firma del responsable de mantenimiento
-- vía PIN.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_aprobar_orden_pin(
    p_orden_id uuid,
    p_usuario_id uuid,
    p_pin text,
    p_decision public.mtto_decision,
    p_obs text,
    p_valor_aprobado numeric,
    p_lineas_autorizadas uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_estado       public.mtto_estado_orden;
    v_nuevo_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF NOT public.mtto_usuario_tiene_rol(p_usuario_id, 'aprobador') THEN
        RAISE EXCEPTION 'Esa persona no tiene rol de aprobador';
    END IF;

    PERFORM public.mtto_validar_pin(p_usuario_id, p_pin);

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
        aprobado_por = p_usuario_id,
        aprobado_at = now(),
        decision = p_decision,
        obs_aprobador = p_obs,
        valor_aprobado = p_valor_aprobado
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, p_usuario_id, 'decision_aprobacion', jsonb_build_object(
        'decision', p_decision,
        'obs', p_obs,
        'valor_aprobado', p_valor_aprobado,
        'lineas_autorizadas', to_jsonb(p_lineas_autorizadas),
        'via', 'pin',
        'operado_por', auth.uid()
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_revisar_orden_pin(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_aprobar_orden_pin(uuid, uuid, text, public.mtto_decision, text, numeric, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_revisar_orden_pin(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_aprobar_orden_pin(uuid, uuid, text, public.mtto_decision, text, numeric, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

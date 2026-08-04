-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: firma por enlace (sin sesión) + PIN.
--
-- Permite mandarle al encargado o al aprobador un enlace por
-- WhatsApp para que revise y firme la orden desde SU propio
-- celular, sin cuenta, sin instalar nada y sin pasarse el
-- teléfono del mecánico.
--
-- DOS FACTORES:
--   1. El enlace  → algo que TIENE (llegó a su WhatsApp)
--   2. El PIN     → algo que SABE
-- Si el enlace se reenvía por error, sin el PIN no sirve.
--
-- FORMA DEL TOKEN: "{uuid}.{secreto}". En la base solo se guarda
-- el hash bcrypt del secreto, así que ni con acceso a la tabla se
-- pueden reconstruir enlaces válidos. El uuid sirve de índice para
-- no tener que escanear toda la tabla al verificar.
--
-- Requiere mtto_1_schema, mtto_3_rpc y mtto_7_firmantes.
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mtto_firma_token (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden_id      uuid NOT NULL REFERENCES public.mtto_orden(id) ON DELETE CASCADE,
    accion        text NOT NULL CHECK (accion IN ('revisar', 'aprobar')),
    -- Quién debe firmar: una persona sin cuenta o un usuario con cuenta
    firmante_id   uuid REFERENCES public.mtto_firmante(id),
    usuario_id    uuid REFERENCES public.profiles(id),
    secreto_hash  text NOT NULL,
    -- URLs firmadas de las fotos, generadas al crear el enlace (cuando
    -- quien lo genera sí tiene sesión). Permite ver las fotos sin abrir
    -- el bucket, que sigue siendo privado.
    fotos         jsonb NOT NULL DEFAULT '{}'::jsonb,
    expira_at     timestamptz NOT NULL,
    usado_at      timestamptz,
    anulado       boolean NOT NULL DEFAULT false,
    creado_por    uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mtto_token_un_destinatario CHECK (num_nonnulls(firmante_id, usuario_id) = 1)
);

CREATE INDEX IF NOT EXISTS idx_mtto_firma_token_orden ON public.mtto_firma_token(orden_id);

ALTER TABLE public.mtto_firma_token ENABLE ROW LEVEL SECURITY;

-- Solo lectura para el módulo (para ver enlaces emitidos); el secreto
-- ya está hasheado. La escritura ocurre solo por las RPC de abajo.
DROP POLICY IF EXISTS mtto_firma_token_select ON public.mtto_firma_token;
CREATE POLICY mtto_firma_token_select ON public.mtto_firma_token
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

REVOKE SELECT (secreto_hash) ON public.mtto_firma_token FROM authenticated, anon;

-- ------------------------------------------------------------
-- 1. GENERAR EL ENLACE (requiere sesión)
-- Devuelve el token completo UNA SOLA VEZ. No se puede recuperar
-- después: si se pierde, se genera otro.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_generar_token_firma(
    p_orden_id uuid,
    p_accion text,
    p_firmante_id uuid DEFAULT NULL,
    p_usuario_id uuid DEFAULT NULL,
    p_fotos jsonb DEFAULT '{}'::jsonb,
    p_horas int DEFAULT 48
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_secreto text;
    v_id uuid;
    v_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF NOT public.mtto_tiene_rol_modulo() THEN
        RAISE EXCEPTION 'No tiene rol en el módulo de mantenimiento';
    END IF;
    IF p_accion NOT IN ('revisar', 'aprobar') THEN
        RAISE EXCEPTION 'Acción inválida';
    END IF;
    IF num_nonnulls(p_firmante_id, p_usuario_id) <> 1 THEN
        RAISE EXCEPTION 'Indique exactamente un destinatario';
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden
    WHERE id = p_orden_id AND org_id = public.get_my_org_id();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden no encontrada';
    END IF;
    IF (p_accion = 'revisar' AND v_estado <> 'en_revision')
       OR (p_accion = 'aprobar' AND v_estado <> 'en_aprobacion') THEN
        RAISE EXCEPTION 'La orden no está en el estado que corresponde a esa acción (estado actual: %)', v_estado;
    END IF;

    -- Anula enlaces anteriores de la misma acción: solo uno vigente a la vez
    UPDATE public.mtto_firma_token SET anulado = true
    WHERE orden_id = p_orden_id AND accion = p_accion AND usado_at IS NULL AND NOT anulado;

    v_secreto := encode(gen_random_bytes(24), 'hex');

    INSERT INTO public.mtto_firma_token (orden_id, accion, firmante_id, usuario_id, secreto_hash, fotos, expira_at)
    VALUES (p_orden_id, p_accion, p_firmante_id, p_usuario_id,
            crypt(v_secreto, gen_salt('bf')), COALESCE(p_fotos, '{}'::jsonb),
            now() + make_interval(hours => GREATEST(1, LEAST(p_horas, 168))))
    RETURNING id INTO v_id;

    RETURN v_id::text || '.' || v_secreto;
END;
$$;

-- ------------------------------------------------------------
-- Helper interno: resuelve y valida un token. No se expone.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_resolver_token(p_token text)
RETURNS public.mtto_firma_token
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_partes text[];
    v_row public.mtto_firma_token;
BEGIN
    v_partes := string_to_array(p_token, '.');
    IF array_length(v_partes, 1) <> 2 THEN
        RAISE EXCEPTION 'Enlace inválido';
    END IF;

    BEGIN
        SELECT * INTO v_row FROM public.mtto_firma_token WHERE id = v_partes[1]::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Enlace inválido';
    END;

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'Enlace inválido';
    END IF;
    IF v_row.secreto_hash <> crypt(v_partes[2], v_row.secreto_hash) THEN
        RAISE EXCEPTION 'Enlace inválido';
    END IF;
    IF v_row.anulado THEN
        RAISE EXCEPTION 'Este enlace fue reemplazado por uno más reciente';
    END IF;
    IF v_row.usado_at IS NOT NULL THEN
        RAISE EXCEPTION 'Este enlace ya se usó';
    END IF;
    IF v_row.expira_at < now() THEN
        RAISE EXCEPTION 'Este enlace ya venció. Pida uno nuevo.';
    END IF;

    RETURN v_row;
END;
$$;

-- ------------------------------------------------------------
-- 2. VER LA ORDEN CON EL ENLACE (sin sesión)
-- Devuelve solo lo necesario para decidir. El token acota el
-- alcance: nunca expone otras órdenes ni otras organizaciones.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_ver_orden_por_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_tok public.mtto_firma_token;
    v_resultado jsonb;
BEGIN
    v_tok := public.mtto_resolver_token(p_token);

    SELECT jsonb_build_object(
        'accion', v_tok.accion,
        'expira_at', v_tok.expira_at,
        'fotos', v_tok.fotos,
        'firmante', (
            SELECT jsonb_build_object('nombre', f.nombre, 'documento', f.documento, 'rol', f.rol)
            FROM public.mtto_firmante f WHERE f.id = v_tok.firmante_id
        ),
        'usuario', (
            SELECT jsonb_build_object('nombre', p.full_name)
            FROM public.profiles p WHERE p.id = v_tok.usuario_id
        ),
        'orden', jsonb_build_object(
            'id', o.id, 'numero', o.numero, 'fecha', o.fecha, 'estado', o.estado,
            'tipo_servicio', o.tipo_servicio, 'taller', o.taller, 'motivo', o.motivo,
            'kilometraje', o.kilometraje, 'iva_tasa', o.iva_tasa,
            'obs_encargado', o.obs_encargado
        ),
        'vehiculo', jsonb_build_object(
            'codigo', v.codigo, 'placa', v.placa, 'tipo', v.tipo,
            'marca', v.marca, 'linea', v.linea
        ),
        'hallazgos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', h.id, 'estado', h.estado, 'observacion', h.observacion,
                'item', ci.nombre, 'critico', ci.critico, 'seccion', cs.nombre,
                'fotos', COALESCE((SELECT jsonb_agg(fo.path) FROM public.mtto_orden_foto fo WHERE fo.hallazgo_id = h.id), '[]'::jsonb)
            ) ORDER BY cs.orden, ci.orden)
            FROM public.mtto_orden_hallazgo h
            JOIN public.mtto_checklist_item ci ON ci.id = h.item_id
            JOIN public.mtto_checklist_seccion cs ON cs.id = ci.seccion_id
            WHERE h.orden_id = o.id
        ), '[]'::jsonb),
        'reparaciones', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', r.id, 'descripcion', r.descripcion, 'repuesto', r.repuesto,
                'cantidad', r.cantidad, 'valor_unitario', r.valor_unitario,
                'mano_obra', r.mano_obra, 'total', r.total, 'prioridad', r.prioridad,
                'fotos', COALESCE((SELECT jsonb_agg(rf.path) FROM public.mtto_reparacion_foto rf WHERE rf.reparacion_id = r.id), '[]'::jsonb)
            ) ORDER BY r.created_at)
            FROM public.mtto_orden_reparacion r WHERE r.orden_id = o.id
        ), '[]'::jsonb)
    ) INTO v_resultado
    FROM public.mtto_orden o
    JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
    WHERE o.id = v_tok.orden_id;

    RETURN v_resultado;
END;
$$;

-- ------------------------------------------------------------
-- 3. FIRMAR CON EL ENLACE + PIN (sin sesión)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_firmar_por_token(
    p_token text,
    p_pin text,
    p_obs text DEFAULT NULL,
    p_decision public.mtto_decision DEFAULT NULL,
    p_valor_aprobado numeric DEFAULT NULL,
    p_lineas_autorizadas uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_tok public.mtto_firma_token;
    v_estado public.mtto_estado_orden;
    v_nuevo_estado public.mtto_estado_orden;
BEGIN
    v_tok := public.mtto_resolver_token(p_token);

    -- El PIN es el segundo factor: el enlace prueba posesión, el PIN
    -- prueba conocimiento. Ambas validaciones bloquean tras 5 fallos.
    IF v_tok.firmante_id IS NOT NULL THEN
        PERFORM public.mtto_validar_pin_firmante(v_tok.firmante_id, p_pin);
    ELSE
        PERFORM public.mtto_validar_pin(v_tok.usuario_id, p_pin);
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = v_tok.orden_id FOR UPDATE;

    IF v_tok.accion = 'revisar' THEN
        IF v_estado <> 'en_revision' THEN
            RAISE EXCEPTION 'La orden ya no está en revisión (estado actual: %)', v_estado;
        END IF;

        UPDATE public.mtto_orden
        SET estado = 'en_aprobacion',
            revisado_por = v_tok.usuario_id,
            revisado_por_firmante = v_tok.firmante_id,
            revisado_at = now(),
            obs_encargado = p_obs
        WHERE id = v_tok.orden_id;

        INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
        VALUES (v_tok.orden_id, v_tok.usuario_id, v_tok.firmante_id, 'revisado',
                jsonb_build_object('obs', p_obs, 'via', 'enlace_pin'));

    ELSE -- aprobar
        IF v_estado <> 'en_aprobacion' THEN
            RAISE EXCEPTION 'La orden ya no está en aprobación (estado actual: %)', v_estado;
        END IF;
        IF p_decision IS NULL THEN
            RAISE EXCEPTION 'Indique la decisión';
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
            UPDATE public.mtto_orden_reparacion SET autorizado = true WHERE orden_id = v_tok.orden_id;
            v_nuevo_estado := 'aprobada';
        ELSIF p_decision = 'aprobado_parcial' THEN
            UPDATE public.mtto_orden_reparacion SET autorizado = (id = ANY (p_lineas_autorizadas)) WHERE orden_id = v_tok.orden_id;
            v_nuevo_estado := 'aprobada';
        ELSE
            UPDATE public.mtto_orden_reparacion SET autorizado = false WHERE orden_id = v_tok.orden_id;
            v_nuevo_estado := 'rechazada';
        END IF;

        UPDATE public.mtto_orden
        SET estado = v_nuevo_estado,
            aprobado_por = v_tok.usuario_id,
            aprobado_por_firmante = v_tok.firmante_id,
            aprobado_at = now(),
            decision = p_decision,
            obs_aprobador = p_obs,
            valor_aprobado = p_valor_aprobado
        WHERE id = v_tok.orden_id;

        INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
        VALUES (v_tok.orden_id, v_tok.usuario_id, v_tok.firmante_id, 'decision_aprobacion',
                jsonb_build_object('decision', p_decision, 'obs', p_obs,
                                   'valor_aprobado', p_valor_aprobado,
                                   'lineas_autorizadas', to_jsonb(p_lineas_autorizadas),
                                   'via', 'enlace_pin'));
    END IF;

    -- Un solo uso
    UPDATE public.mtto_firma_token SET usado_at = now() WHERE id = v_tok.id;
END;
$$;

-- ------------------------------------------------------------
-- 4. PERMISOS
-- Las dos funciones del enlace se otorgan a anon a propósito: son
-- la puerta pública. Están acotadas por el token, que es aleatorio,
-- hasheado, de un solo uso y con caducidad.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mtto_resolver_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_generar_token_firma(uuid, text, uuid, uuid, jsonb, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_ver_orden_por_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_firmar_por_token(text, text, text, public.mtto_decision, numeric, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mtto_generar_token_firma(uuid, text, uuid, uuid, jsonb, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_ver_orden_por_token(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_firmar_por_token(text, text, text, public.mtto_decision, numeric, uuid[]) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

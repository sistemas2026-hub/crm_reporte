-- ============================================================
-- CORRECCIÓN: function gen_salt(unknown) does not exist
--
-- Las funciones de PIN y de tokens usan crypt(), gen_salt() y
-- gen_random_bytes(), que vienen de la extensión pgcrypto. En
-- Supabase pgcrypto NO vive en public, sino en el esquema
-- 'extensions'. Como esas funciones se declararon con
--     SET search_path = public
-- el motor no las encuentra y falla al asignar o validar un PIN.
--
-- La convención correcta ya estaba en el proyecto: create_new_user
-- usa SET search_path TO 'public', 'auth', 'extensions'.
--
-- No hace falta reescribir los cuerpos: basta con ampliar el
-- search_path de cada función afectada.
--
-- Idempotente y seguro de re-ejecutar.
-- ============================================================

DO $$
DECLARE
    v_fn text;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        -- PIN de usuarios con cuenta (20260803_mtto_5_pin.sql)
        'public.mtto_configurar_pin(text)',
        'public.mtto_validar_pin(uuid, text)',
        -- PIN de firmantes sin cuenta (20260804_mtto_7_firmantes.sql)
        'public.mtto_asignar_pin_firmante(uuid, text)',
        'public.mtto_cambiar_pin_firmante(uuid, text, text)',
        'public.mtto_validar_pin_firmante(uuid, text)',
        -- Tokens de enlace (20260804_mtto_8_firma_por_enlace.sql)
        'public.mtto_generar_token_firma(uuid, text, uuid, uuid, jsonb, int)',
        'public.mtto_resolver_token(text)'
    ]
    LOOP
        BEGIN
            EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions', v_fn);
            RAISE NOTICE 'search_path corregido: %', v_fn;
        EXCEPTION WHEN undefined_function THEN
            -- Si alguna migración previa no se corrió, se avisa y se sigue
            RAISE WARNING 'No existe (¿falta correr su migración?): %', v_fn;
        END;
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- VERIFICACIÓN: debe devolver 'public, extensions' en las 7.
-- ------------------------------------------------------------
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       array_to_string(p.proconfig, ', ')        AS config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'mtto_configurar_pin', 'mtto_validar_pin',
      'mtto_asignar_pin_firmante', 'mtto_cambiar_pin_firmante', 'mtto_validar_pin_firmante',
      'mtto_generar_token_firma', 'mtto_resolver_token'
  )
ORDER BY p.proname;

NOTIFY pgrst, 'reload schema';

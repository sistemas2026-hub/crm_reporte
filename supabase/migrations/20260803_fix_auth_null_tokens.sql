-- ============================================================
-- REPARACIÓN: errores 500 en /auth/v1/token?grant_type=refresh_token
--
-- Síntoma: la sesión funciona un rato y luego la app expulsa al
-- usuario, con cientos de 500 seguidos en el endpoint de refresh.
--
-- Causa: GoTrue (el servicio de Auth de Supabase, escrito en Go) lee
-- varias columnas de auth.users como string NO nullable. Cuando un
-- usuario se inserta manualmente por SQL/RPC (como hace la función
-- create_new_user de este proyecto) esas columnas quedan en NULL en
-- vez de cadena vacía, y GoTrue falla con:
--     sql: Scan error ... converting NULL to string is unsupported
-- devolviendo HTTP 500 en login y en refresh de token.
--
-- Este script es seguro e idempotente: solo cambia NULL por ''.
-- No toca contraseñas, ni sesiones, ni ningún dato real.
-- ============================================================

-- ------------------------------------------------------------
-- PASO 1 — DIAGNÓSTICO: ¿cuántos usuarios están afectados?
-- Corra esto primero. Si todos los contadores dan 0, el problema
-- es otro (vea las notas al final del archivo).
-- ------------------------------------------------------------
SELECT
    count(*) FILTER (WHERE confirmation_token        IS NULL) AS confirmation_token_null,
    count(*) FILTER (WHERE email_change              IS NULL) AS email_change_null,
    count(*) FILTER (WHERE email_change_token_new    IS NULL) AS email_change_token_new_null,
    count(*) FILTER (WHERE email_change_token_current IS NULL) AS email_change_token_current_null,
    count(*) FILTER (WHERE phone_change              IS NULL) AS phone_change_null,
    count(*) FILTER (WHERE phone_change_token        IS NULL) AS phone_change_token_null,
    count(*) FILTER (WHERE recovery_token            IS NULL) AS recovery_token_null,
    count(*) FILTER (WHERE reauthentication_token    IS NULL) AS reauthentication_token_null,
    count(*)                                                  AS total_usuarios
FROM auth.users;

-- ------------------------------------------------------------
-- PASO 2 — REPARACIÓN: reemplaza NULL por cadena vacía.
-- ------------------------------------------------------------
UPDATE auth.users
SET confirmation_token         = COALESCE(confirmation_token, ''),
    email_change               = COALESCE(email_change, ''),
    email_change_token_new     = COALESCE(email_change_token_new, ''),
    email_change_token_current = COALESCE(email_change_token_current, ''),
    phone_change               = COALESCE(phone_change, ''),
    phone_change_token         = COALESCE(phone_change_token, ''),
    recovery_token             = COALESCE(recovery_token, ''),
    reauthentication_token     = COALESCE(reauthentication_token, '')
WHERE confirmation_token         IS NULL
   OR email_change               IS NULL
   OR email_change_token_new     IS NULL
   OR email_change_token_current IS NULL
   OR phone_change               IS NULL
   OR phone_change_token         IS NULL
   OR recovery_token             IS NULL
   OR reauthentication_token     IS NULL;

-- ------------------------------------------------------------
-- PASO 3 — VERIFICACIÓN: debe devolver 0 filas.
-- ------------------------------------------------------------
SELECT id, email
FROM auth.users
WHERE confirmation_token         IS NULL
   OR email_change               IS NULL
   OR email_change_token_new     IS NULL
   OR email_change_token_current IS NULL
   OR phone_change               IS NULL
   OR phone_change_token         IS NULL
   OR recovery_token             IS NULL
   OR reauthentication_token     IS NULL;

-- ------------------------------------------------------------
-- PASO 4 (recomendado) — arreglar el ORIGEN, no solo el síntoma.
--
-- Mientras create_new_user siga insertando NULL en esas columnas,
-- cada usuario nuevo volverá a romper el refresh de token. Para ver
-- el código actual de esa función y confirmar si es el caso:
--
--   SELECT pg_get_functiondef(oid)
--   FROM pg_proc
--   WHERE proname = 'create_new_user';
--
-- En su INSERT INTO auth.users deben ir '' (cadena vacía) en lugar
-- de NULL —o simplemente omitirse si la columna tiene DEFAULT ''—
-- para: confirmation_token, email_change, email_change_token_new,
-- email_change_token_current, phone_change, phone_change_token,
-- recovery_token y reauthentication_token.
--
-- Pásame el resultado de ese SELECT y le corrijo la función.
-- ------------------------------------------------------------

-- ============================================================
-- SI EL PASO 1 DIO TODO EN 0, el 500 viene de otra parte. Revise
-- entonces, en el dashboard de Supabase: Logs → Auth Logs, filtrando
-- por status 500, para ver el mensaje real del error. Las otras
-- causas frecuentes son: usuarios "zombie" (fila en public.profiles
-- sin su fila en auth.users, ver directivas/GESTION_USUARIOS_SUPABASE.md)
-- y saturación de conexiones a la base de datos.
-- ============================================================

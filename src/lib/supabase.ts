
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase URL and Anon Key are required in .env');
}

/**
 * Limpia manualmente los restos de sesión del navegador.
 * Se usa desde App.tsx cuando se detecta una sesión inservible.
 */
export function clearCorruptedSession() {
  const host = new URL(supabaseUrl).hostname.split('.')[0];
  const KEYS = [
    `sb-${host}-auth-token`,
    `sb-${host}-auth-token-code-verifier`,
    'sb-rapilink-auth-token', // clave legacy, por si quedó de versiones anteriores
  ];
  console.warn('[Supabase:Storage] 🗑️ Limpiando sesión del navegador...');
  KEYS.forEach(k => window.localStorage.removeItem(k));
}

/**
 * ⚠️ NO volver a introducir un "storage" que bloquee removeItem.
 *
 * Hubo aquí un parche (STORAGE ANTI-500) que ignoraba los primeros
 * intentos de supabase-js de borrar el token, con la idea de proteger
 * la sesión ante fallos transitorios de refresh. En la práctica causaba
 * una RECURSIÓN INFINITA cuando el endpoint de refresh devolvía 500:
 *
 *   _callRefreshToken → _removeSession → _notifyAllSubscribers
 *     → (realtime) setAuth → getSession → __loadSession
 *     → _callRefreshToken → ...
 *
 * Al no dejar que se borrara el token muerto, cada notificación de
 * SIGNED_OUT hacía que el cliente volviera a encontrarlo en localStorage
 * y reintentara refrescarlo, colgando la pestaña con cientos de
 * peticiones. Dejando que supabase-js limpie la sesión, el ciclo se
 * corta solo: el usuario cae al login una vez y ya.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Sin 'storage' personalizado: se usa localStorage tal cual.
    // Sin 'storageKey': se usa la clave automática (sb-{host}-auth-token).
    // El override 'sb-rapilink-auth-token' causaba conflicto con la sesión
    // real → error 400 y advertencia de Multiple GoTrueClient.
  }
});

/**
 * Helper resiliente para obtener el usuario evitando AbortError críticos
 * que ocurren durante el doble montaje de React StrictMode o recargas rápidas.
 */
export async function safeGetUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      if (error.message?.includes('aborted') || (error as any).name === 'AbortError') {
        console.warn('[Supabase:Auth] ⚠️ getUser() abortado por el navegador (ignore si es recarga)');
        return { data: { user: null }, error: null };
      }
      throw error;
    }
    return { data, error: null };
  } catch (e: any) {
    if (e.message?.includes('aborted') || e.name === 'AbortError') {
      return { data: { user: null }, error: null };
    }
    console.error('[Supabase:Auth] ❌ Error crítico en safeGetUser:', e);
    return { data: { user: null }, error: e };
  }
}

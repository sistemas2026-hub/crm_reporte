
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase URL and Anon Key are required in .env');
}

// 🛡️ STORAGE ANTI-500 V2: Detecta sesiones corruptas y las limpia automáticamente
let refreshFailCount = 0;
const MAX_REFRESH_FAILS = 3;

export function clearCorruptedSession() {
  const KEYS = [
    `sb-${supabaseUrl.split('.')[0].split('//')[1]}-auth-token`,
    `sb-${supabaseUrl.split('.')[0].split('//')[1]}-auth-token-code-verifier`,
  ];
  console.warn('[Supabase:Storage] 🗑️ Limpiando sesión corrupta del navegador...');
  KEYS.forEach(k => window.localStorage.removeItem(k));
  // También limpiar clave legacy por si existe
  window.localStorage.removeItem('sb-rapilink-auth-token');
  refreshFailCount = 0;
}

const safeStorage = {
  getItem: (key: string) => {
    return window.localStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    window.localStorage.setItem(key, value);
  },
  removeItem: (key: string) => {
    // Si Supabase intenta borrar el token por error de refresh, contar los intentos
    if (key.includes('-auth-token') && key.startsWith('sb-') && !(window as any).__isIntentionalLogout) {
      refreshFailCount++;

      // Después de N fallos consecutivos, la sesión está corrupta - permitir limpieza
      if (refreshFailCount >= MAX_REFRESH_FAILS) {
        console.warn(`[Supabase:Storage] 🗑️ ${MAX_REFRESH_FAILS} fallos de refresh consecutivos. Sesión corrupta confirmada, limpiando...`);
        window.localStorage.removeItem(key);
        refreshFailCount = 0;
        return;
      }

      console.warn(`[Supabase:Storage] 🛡️ Ignorando intento de borrar '${key}' (fallo ${refreshFailCount}/${MAX_REFRESH_FAILS}). Esperando confirmación...`);
      return;
    }

    // Logout intencional o limpieza automática después de fallos - permitir
    refreshFailCount = 0;
    window.localStorage.removeItem(key);
  }
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true, // ✅ Restaurado - fallos manejados por contador de reintentos
    detectSessionInUrl: true,
    storage: safeStorage,
    // ⚠️ storageKey eliminado: usar la clave automática de Supabase (sb-{projectId}-auth-token)
    // El override 'sb-rapilink-auth-token' causaba conflicto con la sesión real → error 400 y Multiple GoTrueClient
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

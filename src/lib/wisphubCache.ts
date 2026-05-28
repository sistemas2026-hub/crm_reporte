/**
 * wisphubCache — Caché en memoria compartida para tickets de WispHub.
 *
 * Todas las páginas leen de esta caché sin hacer sync propio.
 * Supabase sigue siendo la fuente para el estado workflow (iniciado/validado/rechazado).
 *
 * Flujo:
 *   WispHub API → wisphubCache (TTL 15 min, módulo singleton) → páginas
 *
 * Stale-while-revalidate: si el caché existe pero venció, se devuelven los datos
 * viejos de inmediato y se inicia un refresh en background sin bloquear al caller.
 */
import { WisphubService } from './wisphub';

const TTL_MS = 15 * 60 * 1000; // 15 minutos
const CLOSED_DAYS = 7;         // ventana para estados cerrado/resuelto

function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
}

function mergeById(arrays: any[][]): any[] {
    const map = new Map<string, any>();
    for (const arr of arrays) {
        for (const t of arr) {
            if (t?.id != null && !map.has(String(t.id))) {
                map.set(String(t.id), t);
            }
        }
    }
    return Array.from(map.values());
}

interface CacheEntry {
    tickets: any[];
    fetchedAt: number;
}

let _cache: CacheEntry | null = null;
let _inflightPromise: Promise<any[]> | null = null;

async function fetchFromWisphub(): Promise<any[]> {
    const startClosed = daysAgo(CLOSED_DAYS);
    // Estados abiertos sin límite de fecha; cerrado/resuelto con ventana reciente
    const [open, inProgress, resolved, closed] = await Promise.all([
        WisphubService.getAllTickets({ status: '1', pageSize: 200 }).catch(() => [] as any[]),
        WisphubService.getAllTickets({ status: '2', pageSize: 200 }).catch(() => [] as any[]),
        WisphubService.getAllTickets({ status: '3', startDate: startClosed, maxResults: 600, pageSize: 200 }).catch(() => [] as any[]),
        WisphubService.getAllTickets({ status: '4', startDate: startClosed, maxResults: 600, pageSize: 200 }).catch(() => [] as any[]),
    ]);
    return mergeById([open, inProgress, resolved, closed]);
}

export interface TicketFilters {
    status?: string[];           // '1' | '2' | '3' | '4'
    tecnicoId?: string | number;
    tecnicoNombre?: string;      // fallback si no hay ID numérico
    startDate?: string;          // YYYY-MM-DD
    endDate?: string;
    search?: string;             // busca en asunto, nombre_cliente, id
}

export const WisphubCache = {
    isStale(): boolean {
        return !_cache || Date.now() - _cache.fetchedAt > TTL_MS;
    },

    getLastFetchedAt(): Date | null {
        return _cache ? new Date(_cache.fetchedAt) : null;
    },

    getCached(): any[] {
        return _cache?.tickets ?? [];
    },

    /** Retorna todos los tickets. Stale-while-revalidate: si hay datos viejos los devuelve
     *  de inmediato y dispara un refresh en background sin bloquear al caller. */
    async getAll(forceRefresh = false): Promise<any[]> {
        // Cache fresco → devolver de inmediato
        if (!forceRefresh && _cache && !this.isStale()) {
            return _cache.tickets;
        }

        // Cache vencido pero existe → devolver datos viejos + refrescar en background
        if (!forceRefresh && _cache && this.isStale()) {
            if (!_inflightPromise) {
                _inflightPromise = fetchFromWisphub()
                    .then(tickets => {
                        _cache = { tickets, fetchedAt: Date.now() };
                        console.log(`[WisphubCache] ✅ background refresh: ${tickets.length} tickets`);
                        return tickets;
                    })
                    .finally(() => { _inflightPromise = null; });
            }
            // No esperamos: devolvemos los datos actuales ya
            return _cache.tickets;
        }

        // Cache vacío o forceRefresh → esperar el fetch antes de devolver
        if (!_inflightPromise) {
            _inflightPromise = fetchFromWisphub()
                .then(tickets => {
                    _cache = { tickets, fetchedAt: Date.now() };
                    console.log(`[WisphubCache] ✅ ${tickets.length} tickets cargados`);
                    return tickets;
                })
                .finally(() => { _inflightPromise = null; });
        }
        return _inflightPromise;
    },

    /** Filtra el caché en memoria (sin red). Llama getAll() antes si necesitas datos frescos. */
    filter(tickets: any[], f: TicketFilters): any[] {
        return tickets.filter(t => {
            if (f.status?.length && !f.status.includes(String(t.id_estado))) return false;
            if (f.tecnicoId != null) {
                const tid = String(f.tecnicoId);
                const match =
                    String(t.tecnico_id ?? '') === tid ||
                    String(t.tecnico ?? '') === tid;
                if (!match) return false;
            }
            if (f.tecnicoNombre) {
                const q = f.tecnicoNombre.toLowerCase();
                const techName = (t.nombre_tecnico || t.tecnico_usuario || '').toLowerCase();
                if (!techName.includes(q)) return false;
            }
            if (f.startDate && t.fecha_creacion && t.fecha_creacion < f.startDate) return false;
            if (f.endDate && t.fecha_creacion && t.fecha_creacion > f.endDate) return false;
            if (f.search) {
                const q = f.search.toLowerCase();
                const hay = [
                    t.asunto, t.nombre_cliente, String(t.id ?? ''),
                    t.nombre_tecnico, t.direccion, t.barrio,
                ].map(v => (v || '').toLowerCase()).join(' ');
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    },

    /** Invalida el caché para forzar un nuevo fetch en el próximo getAll(). */
    invalidate() {
        _cache = null;
        _inflightPromise = null;
    },

    /** Invalida y fuerza re-fetch inmediato (espera el resultado, útil tras crear un ticket). */
    async refresh(): Promise<any[]> {
        _cache = null; // invalida sin cancelar inflight existente
        _inflightPromise = null;
        return this.getAll(true);
    },
};

import { useState, useEffect, useCallback, useRef } from 'react';
import { WisphubCache, type TicketFilters } from '../lib/wisphubCache';

interface UseWisphubTicketsResult {
    tickets: any[];
    loading: boolean;
    lastUpdated: Date | null;
    refresh: () => Promise<void>;
    totalByStatus: Record<string, number>;
}

/**
 * Hook compartido para leer tickets directamente de WispHub (caché en memoria).
 * No hace sync a Supabase. Cualquier página puede llamarlo con sus filtros propios.
 *
 * @example
 *   // Todos los tickets activos
 *   const { tickets, loading, refresh } = useWisphubTickets({ status: ['1', '2'] });
 *
 *   // Solo del técnico 1428053
 *   const { tickets } = useWisphubTickets({ tecnicoId: 1428053, status: ['1', '2'] });
 */
export function useWisphubTickets(
    filters?: TicketFilters,
    options?: { autoRefresh?: boolean; refreshIntervalMs?: number }
): UseWisphubTicketsResult {
    const [tickets, setTickets] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const filtersKey = JSON.stringify(filters ?? {});
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const apply = useCallback((all: any[]) => {
        const filtered = filters ? WisphubCache.filter(all, filters) : all;
        setTickets(filtered);
        setLastUpdated(WisphubCache.getLastFetchedAt());
    }, [filtersKey]);

    const load = useCallback(async (forceRefresh = false) => {
        setLoading(true);
        try {
            const all = await WisphubCache.getAll(forceRefresh);
            apply(all);
        } finally {
            setLoading(false);
        }
    }, [apply]);

    const refresh = useCallback(async () => {
        await load(true);
    }, [load]);

    useEffect(() => {
        load();
    }, [load]);

    // Auto-refresh opcional
    useEffect(() => {
        if (!options?.autoRefresh) return;
        const ms = options?.refreshIntervalMs ?? 5 * 60 * 1000;
        intervalRef.current = setInterval(() => load(true), ms);
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [options?.autoRefresh, options?.refreshIntervalMs, load]);

    const totalByStatus = useCallback(() => {
        const all = WisphubCache.getCached();
        const counts: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0 };
        for (const t of all) {
            const s = String(t.id_estado ?? '');
            if (s in counts) counts[s]++;
        }
        return counts;
    }, [lastUpdated])();

    return { tickets, loading, lastUpdated, refresh, totalByStatus };
}

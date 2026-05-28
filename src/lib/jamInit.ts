import { jam } from '@jam.dev/sdk';
import { WisphubCache } from './wisphubCache';

/**
 * Inicializa Jam con contexto dinámico de la app.
 * Se llama UNA VEZ en main.tsx antes del render.
 * La función callback se evalúa en el momento de capturar cada bug.
 */
export function initJam() {
    jam.metadata(() => {
        // Usuario desde supabase token en localStorage
        let userId = '';
        let userEmail = '';
        let userRole = '';
        try {
            const raw = localStorage.getItem('sb-rapilink-auth-token');
            if (raw) {
                const parsed = JSON.parse(raw);
                userId = parsed?.user?.id ?? '';
                userEmail = parsed?.user?.email ?? '';
            }
            userRole = localStorage.getItem('user_role') ?? '';
        } catch { /* no bloquear si falla */ }

        // Cache de WispHub
        const cachedTickets = WisphubCache.getCached();
        const lastSync = WisphubCache.getLastFetchedAt();

        return {
            // Identidad
            userId,
            userEmail,
            userRole,

            // Navegación
            currentPage: window.location.pathname,
            currentHash: window.location.hash,

            // Estado WispHub
            wisphubCacheSize: cachedTickets.length,
            wisphubLastSync: lastSync?.toISOString() ?? 'nunca',
            wisphubCacheStale: WisphubCache.isStale(),

            // Contexto del ticket activo (si el técnico tiene uno abierto)
            activeTicketId: sessionStorage.getItem('active_ticket_id') ?? '',

            // Entorno
            env: import.meta.env.MODE,
            appVersion: import.meta.env.VITE_APP_VERSION ?? '1.0.0',
        };
    });
}

/**
 * Marca el ticket activo para que aparezca en los bug reports capturados
 * mientras el técnico trabaja sobre ese ticket.
 */
export function setActiveTicket(ticketId: string | number | null) {
    if (ticketId) {
        sessionStorage.setItem('active_ticket_id', String(ticketId));
    } else {
        sessionStorage.removeItem('active_ticket_id');
    }
}

/**
 * Construye la URL de Recording Link con contexto de la página actual.
 * Requiere VITE_JAM_RECORDING_LINK_ID en el .env
 */
export function getRecordingLinkUrl(context?: { ticketId?: string | number; page?: string }): string {
    const linkId = import.meta.env.VITE_JAM_RECORDING_LINK_ID;
    if (!linkId) return 'https://jam.dev';

    const page = context?.page ?? window.location.pathname.replace('/operaciones/', '').replace('/', '') || 'inicio';
    const title = `Bug en ${page}${context?.ticketId ? ` — Ticket #${context.ticketId}` : ''}`;
    const params = new URLSearchParams({
        'jam-title': title,
        'jam-reference': window.location.pathname,
    });
    if (context?.ticketId) params.set('jam-reference', `ticket-${context.ticketId}`);

    return `https://jam.dev/r/${linkId}?${params.toString()}`;
}

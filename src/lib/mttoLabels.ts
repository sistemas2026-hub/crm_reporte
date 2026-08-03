import type { MttoOrden } from './mttoService';

export const ESTADO_LABEL: Record<MttoOrden['estado'], string> = {
    borrador: 'Borrador',
    en_revision: 'En revisión',
    en_aprobacion: 'En aprobación',
    aprobada: 'Aprobada',
    rechazada: 'Rechazada',
    en_ejecucion: 'En ejecución',
    cerrada: 'Cerrada',
    anulada: 'Anulada',
};

export const ESTADO_COLOR: Record<MttoOrden['estado'], string> = {
    borrador: 'bg-muted text-muted-foreground border-border',
    en_revision: 'bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400',
    en_aprobacion: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
    aprobada: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
    rechazada: 'bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400',
    en_ejecucion: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30 dark:text-indigo-400',
    cerrada: 'bg-slate-500/10 text-slate-600 border-slate-500/30 dark:text-slate-400',
    anulada: 'bg-neutral-500/10 text-neutral-500 border-neutral-500/30 line-through',
};

export const TIPO_SERVICIO_LABEL: Record<string, string> = {
    preventivo: 'Preventivo',
    correctivo: 'Correctivo',
    emergencia: 'Emergencia',
    diagnostico: 'Diagnóstico',
    alistamiento: 'Alistamiento',
};

export const EVENTO_LABEL: Record<string, string> = {
    enviado_a_revision: 'Enviado a revisión',
    revisado: 'Revisado por encargado de flota',
    decision_aprobacion: 'Decisión de aprobación',
    devuelto: 'Devuelto a borrador',
    inicio_ejecucion: 'Inicio de ejecución',
    cerrado: 'Orden cerrada',
};

export const money = (n: number | null | undefined) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

export const toast = (message: string, type: 'success' | 'error' | 'info' = 'info', description?: string) => {
    window.dispatchEvent(new CustomEvent('app:toast', { detail: { message, type, description, duration: 4000 } }));
};

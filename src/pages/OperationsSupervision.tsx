import { useState, useEffect, useCallback } from 'react';
import {
    Search, Calendar, RefreshCcw,
    ChevronLeft, ChevronRight, Users, Filter,
    CheckSquare, Square, AlertCircle, Loader2, X
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { WorkflowService } from '../lib/workflowService';
import { OperationsHeader } from '../components/operations/OperationsHeader';
import { orgService } from '../lib/orgService';
import clsx from 'clsx';

// ─── SLA helpers ──────────────────────────────────────────────────────────────

interface SlaConfig { max_hours: number; threshold_pct: number; }
type SlaStatus = 'ok' | 'warning' | 'critical';

function getSlaInfo(
    createdAt: string,
    ticketType: string,
    slaMap: Record<string, SlaConfig>
): { hoursOpen: number; pct: number; status: SlaStatus; maxHours: number } {
    // Aislar asunto puro (ver memoria técnica §12)
    const isolated = ticketType.includes(' - ') ? ticketType.split(' - ')[0] : ticketType;
    const key = isolated.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    const cfg = slaMap[key] || slaMap['ADMINISTRATIVO'] || { max_hours: 24, threshold_pct: 80 };
    const hoursOpen = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
    const pct = Math.min(Math.round((hoursOpen / cfg.max_hours) * 100), 999);
    const status: SlaStatus = pct >= 100 ? 'critical' : pct >= cfg.threshold_pct ? 'warning' : 'ok';
    return { hoursOpen: Math.round(hoursOpen * 10) / 10, pct, status, maxHours: cfg.max_hours };
}

const PAGE_SIZE = 50;

export function OperationsSupervision() {
    const [processes, setProcesses] = useState<any[]>([]);
    const [platformUsers, setPlatformUsers] = useState<any[]>([]);
    const [slaMap, setSlaMap] = useState<Record<string, SlaConfig>>({});
    const [loading, setLoading] = useState(false);
    const [totalCount, setTotalCount] = useState(0);
    const [page, setPage] = useState(0);

    // Filtros
    const [searchTerm, setSearchTerm] = useState('');
    const [filterTech, setFilterTech] = useState('');
    const [filterBarrio, setFilterBarrio] = useState('');
    const [filterEscalated, setFilterEscalated] = useState<'all' | 'yes' | 'no'>('all');
    const [dateRange, setDateRange] = useState({
        start: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        end: new Date().toISOString().split('T')[0],
    });

    // Bulk reassign
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkTech, setBulkTech] = useState('');
    const [bulkReassigning, setBulkReassigning] = useState(false);
    const [bulkResult, setBulkResult] = useState<string | null>(null);

    // Cleanup legacy cache al montar (ver memoria técnica §11)
    useEffect(() => {
        try {
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('supervision_cache_')) localStorage.removeItem(k);
            });
        } catch (_) { /* ignorar */ }
    }, []);

    // Cargar SLA config y usuarios una sola vez
    useEffect(() => {
        (async () => {
            const users = await WorkflowService.getPlatformUsers();
            if (users) setPlatformUsers(users);

            const org = await orgService.getSettings().catch(() => null);
            if (org?.org_id) {
                const { data } = await supabase
                    .from('sla_config')
                    .select('ticket_type, max_hours, threshold_pct')
                    .eq('org_id', org.org_id);
                if (data) {
                    const map: Record<string, SlaConfig> = {};
                    data.forEach((r: any) => { map[r.ticket_type.toUpperCase()] = { max_hours: r.max_hours, threshold_pct: r.threshold_pct }; });
                    setSlaMap(map);
                }
            }
        })();
    }, []);

    const loadPage = useCallback(async () => {
        setLoading(true);
        try {
            let query = supabase
                .from('workflow_processes')
                .select(`
                    id, reference_id, created_at, title, process_type, status, metadata, escalation_level,
                    workflow_activities(name, status, workflow_workitems(id, participant_id, status))
                `, { count: 'exact' })
                .gte('created_at', dateRange.start)
                .lte('created_at', dateRange.end + 'T23:59:59')
                .order('created_at', { ascending: false })
                .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

            if (filterEscalated === 'yes') query = query.gte('escalation_level', 2);
            if (filterEscalated === 'no') query = query.lt('escalation_level', 2);
            if (filterBarrio) query = (query as any).ilike('metadata->>barrio', `%${filterBarrio}%`);
            if (searchTerm) query = (query as any).or(
                `reference_id.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%,metadata->>nombre_cliente.ilike.%${searchTerm}%`
            );

            const { data, error, count } = await query;
            if (!error && data) {
                setProcesses(data as any[]);
                setTotalCount(count || 0);
            }
        } finally {
            setLoading(false);
        }
    }, [dateRange, page, filterEscalated, filterBarrio, searchTerm]);

    useEffect(() => {
        setPage(0);
    }, [dateRange, filterEscalated, filterBarrio, searchTerm]);

    useEffect(() => {
        loadPage();
    }, [loadPage]);

    // ── Filtro de técnico en cliente (ya mapeado)
    const filtered = filterTech
        ? processes.filter(p => {
            const tech = (p.metadata?.nombre_tecnico || p.metadata?.email_tecnico || '').toLowerCase();
            return tech.includes(filterTech.toLowerCase());
        })
        : processes;

    // ── Selección bulk
    const allSelected = filtered.length > 0 && filtered.every(p => selectedIds.has(p.id));
    const toggleAll = () => {
        if (allSelected) {
            setSelectedIds(prev => { const s = new Set(prev); filtered.forEach(p => s.delete(p.id)); return s; });
        } else {
            setSelectedIds(prev => { const s = new Set(prev); filtered.forEach(p => s.add(p.id)); return s; });
        }
    };
    const toggleOne = (id: string) => {
        setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
    };

    const handleBulkReassign = async () => {
        if (!bulkTech || selectedIds.size === 0) return;
        setBulkReassigning(true);
        setBulkResult(null);
        const ids = Array.from(selectedIds);

        const updates = ids.map(id =>
            supabase
                .from('workflow_processes')
                .update({ escalation_level: 1, updated_at: new Date().toISOString() })
                .eq('id', id)
        );
        const settled = await Promise.allSettled(updates);
        const ok = settled.filter(r => r.status === 'fulfilled').length;
        const fail = settled.length - ok;
        setBulkResult(`${ok} ticket${ok !== 1 ? 's' : ''} reasignado${ok !== 1 ? 's' : ''} a ${bulkTech}${fail > 0 ? ` · ${fail} fallaron` : ''}.`);
        setSelectedIds(new Set());
        setBulkTech('');
        setBulkReassigning(false);
        loadPage();
    };

    const totalPages = Math.ceil(totalCount / PAGE_SIZE);

    return (
        <div className="space-y-6">
            <OperationsHeader
                title="Supervisión"
                description="Consola de administración y seguimiento de procesos operativos."
                onSyncComplete={loadPage}
            />

            {/* ── Panel de filtros ── */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-sm">
                <div className="flex flex-wrap gap-3 items-end">
                    {/* Rango de fechas */}
                    <div className="flex items-center gap-2 text-xs text-zinc-500 font-medium bg-zinc-50 px-3 py-2 rounded-xl border border-zinc-100">
                        <Calendar size={12} className="text-zinc-400" />
                        <input
                            type="date"
                            value={dateRange.start}
                            onChange={e => setDateRange(p => ({ ...p, start: e.target.value }))}
                            className="bg-transparent border-none p-0 text-xs focus:ring-0 text-zinc-700 font-bold cursor-pointer w-28"
                        />
                        <span className="text-zinc-300">→</span>
                        <input
                            type="date"
                            value={dateRange.end}
                            onChange={e => setDateRange(p => ({ ...p, end: e.target.value }))}
                            className="bg-transparent border-none p-0 text-xs focus:ring-0 text-zinc-700 font-bold cursor-pointer w-28"
                        />
                        {loading && <RefreshCcw size={12} className="animate-spin text-blue-500 ml-1" />}
                    </div>

                    {/* Búsqueda */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="ID, cliente..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-44 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro técnico */}
                    <div className="relative">
                        <Users className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="Técnico..."
                            value={filterTech}
                            onChange={e => setFilterTech(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-40 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro barrio */}
                    <div className="relative">
                        <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="Barrio / Zona..."
                            value={filterBarrio}
                            onChange={e => setFilterBarrio(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-40 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro escalamiento */}
                    <select
                        value={filterEscalated}
                        onChange={e => setFilterEscalated(e.target.value as any)}
                        className="bg-white border border-zinc-200 rounded-xl py-2 px-3 text-xs font-bold outline-none focus:border-zinc-400 cursor-pointer text-zinc-700"
                    >
                        <option value="all">Todos (interno + externo)</option>
                        <option value="yes">Solo Escalados ≥N2</option>
                        <option value="no">Solo Internos N1</option>
                    </select>

                    <span className="ml-auto text-[11px] font-bold text-zinc-400">
                        {totalCount.toLocaleString()} registros
                    </span>
                </div>
            </div>

            {/* ── Bulk reassign panel ── */}
            {selectedIds.size > 0 && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 flex flex-wrap items-center gap-3">
                    <span className="text-xs font-black text-indigo-700 uppercase">
                        {selectedIds.size} ticket{selectedIds.size !== 1 ? 's' : ''} seleccionado{selectedIds.size !== 1 ? 's' : ''}
                    </span>
                    <input
                        type="text"
                        placeholder="Nuevo técnico / email..."
                        value={bulkTech}
                        onChange={e => setBulkTech(e.target.value)}
                        className="flex-1 min-w-[180px] border border-indigo-300 rounded-xl px-3 py-2 text-xs font-medium outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                    />
                    <button
                        onClick={handleBulkReassign}
                        disabled={!bulkTech || bulkReassigning}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase transition-all active:scale-95 hover:bg-indigo-700 disabled:opacity-50"
                    >
                        {bulkReassigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Users className="w-3.5 h-3.5" />}
                        Reasignar
                    </button>
                    <button onClick={() => setSelectedIds(new Set())} className="text-zinc-400 hover:text-zinc-600 transition-colors">
                        <X size={16} />
                    </button>
                    {bulkResult && (
                        <span className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                            <AlertCircle size={12} /> {bulkResult}
                        </span>
                    )}
                </div>
            )}

            {/* ── Tabla principal ── */}
            <div className="bg-white border border-zinc-200 rounded-3xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-zinc-50 border-b border-zinc-200">
                            <tr>
                                <th className="p-3 w-10">
                                    <button onClick={toggleAll} className="text-zinc-400 hover:text-indigo-600 transition-colors">
                                        {allSelected ? <CheckSquare size={15} className="text-indigo-600" /> : <Square size={15} />}
                                    </button>
                                </th>
                                <th className="p-4 text-left text-[10px] uppercase font-bold tracking-widest text-zinc-400">ID / Cliente</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Creación</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Asunto</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Barrio</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Nivel</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Responsable</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Estado</th>
                                <th className="p-4 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">SLA</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                            {loading && processes.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="p-12 text-center text-zinc-400 text-xs font-medium animate-pulse">
                                        Cargando datos operativos...
                                    </td>
                                </tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="p-12 text-center text-zinc-400 text-xs font-medium">
                                        No se encontraron registros.
                                    </td>
                                </tr>
                            ) : (
                                filtered.map(p => {
                                    // ── Resolución de técnico
                                    const currentWorkItems = (p.workflow_activities || [])
                                        .filter((a: any) => a.status === 'Active')
                                        .flatMap((a: any) => a.workflow_workitems)
                                        .filter((wi: any) => wi.status === 'Active' || wi.status === 'PE');
                                    const responsibleName = currentWorkItems.map((wi: any) => {
                                        const u = platformUsers.find((user: any) =>
                                            user.id === wi.participant_id || user.email === wi.participant_id
                                        );
                                        return u ? u.display_name : wi.participant_id;
                                    }).join(', ') || p.metadata?.nombre_tecnico || 'POR ASIGNAR';

                                    // ── SLA dinámico
                                    const ticketType = p.title?.split(' - ')[0] || p.metadata?.asunto || p.process_type || '';
                                    const sla = getSlaInfo(p.created_at, ticketType, slaMap);

                                    const isSelected = selectedIds.has(p.id);

                                    return (
                                        <tr
                                            key={p.id}
                                            className={clsx(
                                                'transition-colors group cursor-pointer',
                                                sla.status === 'critical' && 'animate-pulse-subtle bg-red-50/40',
                                                sla.status === 'warning' && 'bg-amber-50/30',
                                                isSelected && 'bg-indigo-50',
                                                !isSelected && sla.status === 'ok' && 'hover:bg-zinc-50'
                                            )}
                                            onClick={() => toggleOne(p.id)}
                                        >
                                            {/* Checkbox */}
                                            <td className="p-3 text-center">
                                                {isSelected
                                                    ? <CheckSquare size={15} className="text-indigo-600 mx-auto" />
                                                    : <Square size={15} className="text-zinc-300 mx-auto group-hover:text-zinc-500" />
                                                }
                                            </td>

                                            {/* ID / Cliente */}
                                            <td className="p-4">
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-bold uppercase text-zinc-900 leading-tight">
                                                        {p.metadata?.nombre_cliente || (p.title.includes(' - ') ? p.title.split(' - ')[1] : p.title)}
                                                    </span>
                                                    <span className="text-[10px] font-bold text-zinc-500 font-mono bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-200 w-fit mt-1">
                                                        #{p.reference_id || p.id.split('-')[0]}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Creación */}
                                            <td className="p-4 text-center">
                                                <div className="flex flex-col items-center">
                                                    <span className="text-[10px] font-bold text-zinc-500 font-mono">
                                                        {new Date(p.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}
                                                    </span>
                                                    <span className="text-[8px] text-zinc-400 font-mono">
                                                        {new Date(p.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Asunto */}
                                            <td className="p-4 text-center">
                                                <div className="max-w-[140px] mx-auto text-[9px] font-bold uppercase text-zinc-600 bg-zinc-50 px-2 py-1.5 rounded-lg border border-zinc-200 truncate" title={ticketType}>
                                                    {ticketType || p.process_type}
                                                </div>
                                            </td>

                                            {/* Barrio */}
                                            <td className="p-4 text-center">
                                                <span className="text-[10px] font-medium text-zinc-500 truncate max-w-[100px] block">
                                                    {p.metadata?.barrio || p.metadata?.zona || '—'}
                                                </span>
                                            </td>

                                            {/* Nivel */}
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'text-[9px] font-bold px-2 py-1 rounded-md uppercase border tracking-wide',
                                                    (p.escalation_level || 0) === 0 && 'bg-blue-50 text-blue-700 border-blue-100',
                                                    (p.escalation_level || 0) === 1 && 'bg-cyan-50 text-cyan-700 border-cyan-100',
                                                    (p.escalation_level || 0) === 2 && 'bg-orange-50 text-orange-700 border-orange-100',
                                                    (p.escalation_level || 0) >= 3 && 'bg-red-50 text-red-700 border-red-100',
                                                )}>
                                                    N{p.escalation_level || 0}
                                                </span>
                                            </td>

                                            {/* Responsable */}
                                            <td className="p-4 text-center">
                                                <span className="text-[10px] font-bold text-zinc-600 uppercase truncate max-w-[120px] bg-zinc-50 px-2 py-1 rounded border border-zinc-200 block mx-auto">
                                                    {responsibleName}
                                                </span>
                                            </td>

                                            {/* Estado */}
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'px-2 py-1 rounded-full text-[9px] font-bold uppercase inline-flex items-center gap-1 border',
                                                    p.status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                                        p.status === 'in_progress' ? 'bg-blue-50 text-blue-700 border-blue-100' :
                                                            'bg-zinc-50 text-zinc-500 border-zinc-100'
                                                )}>
                                                    <div className={clsx('w-1.5 h-1.5 rounded-full',
                                                        p.status === 'completed' ? 'bg-emerald-500' :
                                                            p.status === 'in_progress' ? 'bg-blue-500' : 'bg-zinc-400'
                                                    )} />
                                                    {p.metadata?.nombre_estado || p.status || 'Abierto'}
                                                </span>
                                            </td>

                                            {/* SLA semáforo dinámico */}
                                            <td className="p-4 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    {/* Barra de progreso */}
                                                    <div className="w-16 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                                                        <div
                                                            className={clsx(
                                                                'h-full rounded-full transition-all',
                                                                sla.status === 'critical' && 'bg-red-500 animate-pulse',
                                                                sla.status === 'warning' && 'bg-amber-400',
                                                                sla.status === 'ok' && 'bg-emerald-400'
                                                            )}
                                                            style={{ width: `${Math.min(sla.pct, 100)}%` }}
                                                        />
                                                    </div>
                                                    <span className={clsx(
                                                        'text-[9px] font-black font-mono',
                                                        sla.status === 'critical' && 'text-red-600',
                                                        sla.status === 'warning' && 'text-amber-600',
                                                        sla.status === 'ok' && 'text-zinc-400'
                                                    )}>
                                                        {sla.hoursOpen}h / {sla.maxHours}h
                                                    </span>
                                                    {sla.status === 'critical' && (
                                                        <span className="text-[8px] font-black text-red-600 uppercase tracking-wider animate-pulse">VENCIDO</span>
                                                    )}
                                                    {sla.status === 'warning' && (
                                                        <span className="text-[8px] font-black text-amber-500 uppercase tracking-wider">ALERTA</span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {/* ── Paginación ── */}
                {totalPages > 1 && (
                    <div className="border-t border-zinc-100 px-6 py-3 flex items-center justify-between">
                        <span className="text-xs text-zinc-400 font-medium">
                            Página {page + 1} de {totalPages} · {totalCount.toLocaleString()} registros
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                disabled={page === 0 || loading}
                                className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 transition-all"
                            >
                                <ChevronLeft size={14} />
                            </button>
                            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                                const pg = page < 4 ? i : page - 3 + i;
                                if (pg >= totalPages) return null;
                                return (
                                    <button
                                        key={pg}
                                        onClick={() => setPage(pg)}
                                        className={clsx(
                                            'w-7 h-7 rounded-lg text-xs font-bold transition-all',
                                            pg === page ? 'bg-zinc-900 text-white' : 'border border-zinc-200 text-zinc-500 hover:bg-zinc-50'
                                        )}
                                    >
                                        {pg + 1}
                                    </button>
                                );
                            })}
                            <button
                                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={page >= totalPages - 1 || loading}
                                className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 transition-all"
                            >
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

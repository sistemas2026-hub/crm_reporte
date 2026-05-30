import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    User, Phone, MapPin, Wifi, CreditCard, AlertTriangle,
    ChevronDown, ChevronUp, ExternalLink, ArrowLeft,
    Loader2, Activity, CheckCircle2, Clock, RefreshCcw,
    DollarSign, FileText, Zap
} from 'lucide-react';
import { WisphubService } from '../lib/wisphub';
import { WisphubCache } from '../lib/wisphubCache';
import { supabase } from '../lib/supabase';
import clsx from 'clsx';

export function CustomerLifeCycle() {
    const { id_servicio } = useParams<{ id_servicio: string }>();
    const navigate = useNavigate();

    // ── Tiempo 1: identidad + tickets
    const [clientDetail, setClientDetail] = useState<any>(null);
    const [loadingClient, setLoadingClient] = useState(true);
    const [tickets, setTickets] = useState<any[]>([]);
    const [processes, setProcesses] = useState<any[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    // ── Tiempo 2: financiero
    const [invoices, setInvoices] = useState<any[]>([]);
    const [saldo, setSaldo] = useState<number | null>(null);
    const [loadingFinancial, setLoadingFinancial] = useState(true);

    const loadData = useCallback(async () => {
        if (!id_servicio) return;
        setLoadingClient(true);

        // Tiempo 1a: datos del cliente desde WispHub
        const detail = await WisphubService.getServiceDetail(id_servicio).catch(() => null);
        setClientDetail(detail);

        // Tiempo 1b: tickets del cliente desde caché
        let cached = WisphubCache.getCached();
        if (cached.length === 0) cached = await WisphubCache.getAll().catch(() => []);
        const clientTickets = cached.filter(t =>
            String(t.id_servicio ?? t.servicio ?? '') === String(id_servicio)
        );
        setTickets(clientTickets.sort((a: any, b: any) => Number(b.id) - Number(a.id)));

        // Tiempo 1c: procesos operativos desde Supabase
        if (clientTickets.length > 0) {
            const refIds = clientTickets.map((t: any) => String(t.id));
            const { data } = await supabase
                .from('workflow_processes')
                .select('id, reference_id, created_at, status, metadata, escalation_level')
                .eq('process_type', 'Ticket AXCES')
                .in('reference_id', refIds)
                .order('created_at', { ascending: false });
            setProcesses(data || []);
        }

        setLoadingClient(false);

        // Tiempo 2: datos financieros en background
        setLoadingFinancial(true);
        Promise.all([
            WisphubService.getInvoices(Number(id_servicio)).catch(() => []),
            WisphubService.getClientBalance(Number(id_servicio)).catch(() => 0),
        ]).then(([invs, bal]) => {
            setInvoices((invs as any[]).slice(0, 6));
            setSaldo(bal as number);
        }).finally(() => setLoadingFinancial(false));
    }, [id_servicio]);

    useEffect(() => { loadData(); }, [loadData]);

    // ── Cálculo "Cliente Crítico"
    const now = Date.now();
    const ticketsLast30 = tickets.filter(t => {
        const created = new Date(t.fecha_apertura || t.created || '').getTime();
        return !isNaN(created) && now - created < 30 * 24 * 3600 * 1000;
    });
    const isCritical = ticketsLast30.length > 2;

    // ── Mapeo proceso por ticket reference_id
    const procByRef = Object.fromEntries(processes.map(p => [String(p.reference_id), p]));

    // ── Helpers
    const stateColor = (estado: any) => {
        const name = (typeof estado === 'object' ? estado?.nombre : String(estado || '')).toLowerCase();
        if (name.includes('activo') || name.includes('active')) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
        if (name.includes('suspend') || name.includes('cortado')) return 'bg-red-100 text-red-800 border-red-200';
        return 'bg-zinc-100 text-zinc-700 border-zinc-200';
    };

    const fmtDate = (d?: string) => {
        if (!d) return '—';
        const dt = new Date(d);
        return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    const fmtCurrency = (n?: number | string) => {
        const v = Number(n || 0);
        return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
    };

    if (loadingClient && !clientDetail) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground font-medium">Cargando expediente del cliente...</p>
                </div>
            </div>
        );
    }

    const estadoNombre = typeof clientDetail?.estado === 'object'
        ? clientDetail?.estado?.nombre ?? 'Desconocido'
        : String(clientDetail?.estado ?? 'Desconocido');

    const coords = clientDetail?.latitud && clientDetail?.longitud
        ? `${clientDetail.latitud},${clientDetail.longitud}`
        : null;

    return (
        <div className="space-y-6 max-w-7xl">

            {/* ── Breadcrumb ── */}
            <div className="flex items-center gap-3">
                <button
                    onClick={() => navigate(-1)}
                    className="flex items-center gap-1.5 text-xs font-bold text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                    <ArrowLeft size={14} /> Volver
                </button>
                <span className="text-zinc-300">/</span>
                <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Hoja de Vida del Cliente</span>
            </div>

            {/* ── Header: Identidad del Cliente ── */}
            <div className="bg-white border border-zinc-200 rounded-3xl p-6 shadow-sm">
                {isCritical && (
                    <div className="mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-2.5 animate-pulse">
                        <AlertTriangle size={14} className="text-red-600 shrink-0" />
                        <span className="text-xs font-black text-red-700 uppercase tracking-wide">
                            ⚠️ Cliente Crítico — {ticketsLast30.length} fallas en los últimos 30 días
                        </span>
                    </div>
                )}

                <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
                            <User size={26} className="text-primary" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black uppercase text-zinc-900 leading-tight">
                                {clientDetail?.nombre || `Servicio #${id_servicio}`}
                            </h1>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <span className="text-[10px] font-bold font-mono text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded border border-zinc-200">
                                    ID #{id_servicio}
                                </span>
                                {clientDetail?.cedula && (
                                    <span className="text-[10px] font-bold text-zinc-500">
                                        C.C. {clientDetail.cedula}
                                    </span>
                                )}
                                <span className={clsx(
                                    'text-[10px] font-black uppercase px-2.5 py-1 rounded-full border',
                                    stateColor(clientDetail?.estado)
                                )}>
                                    {estadoNombre}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {coords && (
                            <a
                                href={`https://www.google.com/maps?q=${coords}`}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-1.5 text-[10px] font-black uppercase px-3 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-xl hover:bg-blue-100 transition-all"
                            >
                                <MapPin size={12} /> Ver en Maps
                            </a>
                        )}
                        <button
                            onClick={loadData}
                            className="p-2 rounded-xl border border-zinc-200 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 transition-all"
                            title="Refrescar"
                        >
                            <RefreshCcw size={14} />
                        </button>
                    </div>
                </div>

                {/* Grid de campos */}
                <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                        { icon: <Phone size={13} />, label: 'Teléfono', value: clientDetail?.telefono || clientDetail?.movil },
                        { icon: <MapPin size={13} />, label: 'Dirección', value: clientDetail?.direccion },
                        { icon: <Wifi size={13} />, label: 'Plan', value: clientDetail?.plan_internet?.nombre || clientDetail?.plan },
                        { icon: <Wifi size={13} />, label: 'IP', value: clientDetail?.ip },
                        { icon: <Activity size={13} />, label: 'MAC / ONU', value: clientDetail?.mac || clientDetail?.onu_mac || clientDetail?.router?.mac },
                        { icon: <Clock size={13} />, label: 'Instalación', value: fmtDate(clientDetail?.fecha_instalacion) },
                        { icon: <MapPin size={13} />, label: 'Barrio / Zona', value: clientDetail?.barrio || clientDetail?.zona },
                        { icon: <FileText size={13} />, label: 'Email', value: clientDetail?.email },
                    ].map(f => f.value ? (
                        <div key={f.label} className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1 text-[9px] font-black text-zinc-400 uppercase tracking-widest">
                                {f.icon} {f.label}
                            </span>
                            <span className="text-xs font-bold text-zinc-800 truncate" title={String(f.value)}>
                                {f.value}
                            </span>
                        </div>
                    ) : null)}
                </div>
            </div>

            {/* ── Dos columnas ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* ── Columna izquierda: Historial Técnico ── */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xs font-black uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                            <ClipboardListIcon size={13} /> Historial Técnico
                            <span className="px-1.5 py-0.5 bg-zinc-100 rounded-full text-[9px] font-black text-zinc-500 border border-zinc-200">
                                {tickets.length}
                            </span>
                        </h2>
                    </div>

                    {loadingClient ? (
                        <div className="flex items-center justify-center py-10 gap-2 text-zinc-400">
                            <Loader2 size={16} className="animate-spin" />
                            <span className="text-xs">Cargando tickets...</span>
                        </div>
                    ) : tickets.length === 0 ? (
                        <div className="bg-white border border-zinc-100 rounded-2xl p-8 text-center">
                            <p className="text-xs text-zinc-400 font-medium">Sin tickets registrados para este servicio.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {tickets.map((t: any) => {
                                const proc = procByRef[String(t.id)];
                                const isOpen = expandedId === String(t.id);
                                const signal = proc?.metadata?.potencia || proc?.metadata?.signal;
                                const hasEscalation = (proc?.escalation_level || 0) >= 2;
                                const isFinished = t.id_estado === 3 || t.id_estado === 4
                                    || t.nombre_estado?.toLowerCase().includes('resuel')
                                    || t.nombre_estado?.toLowerCase().includes('cerrad');

                                return (
                                    <div
                                        key={t.id}
                                        className={clsx(
                                            'bg-white border rounded-2xl overflow-hidden transition-all',
                                            isOpen ? 'border-zinc-300 shadow-sm' : 'border-zinc-100 hover:border-zinc-200'
                                        )}
                                    >
                                        {/* Row header */}
                                        <button
                                            onClick={() => setExpandedId(isOpen ? null : String(t.id))}
                                            className="w-full flex items-center gap-3 p-4 text-left"
                                        >
                                            <div className={clsx(
                                                'w-2 h-2 rounded-full shrink-0',
                                                isFinished ? 'bg-emerald-400' : 'bg-blue-400'
                                            )} />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-[10px] font-bold font-mono text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-200">
                                                        #{t.id}
                                                    </span>
                                                    {hasEscalation && (
                                                        <span className="text-[9px] font-black text-orange-700 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">
                                                            N{proc.escalation_level}
                                                        </span>
                                                    )}
                                                    <span className="text-[10px] font-bold text-zinc-600 truncate max-w-[200px]">
                                                        {t.asunto || t.nombre_asunto || 'Sin asunto'}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-2 mt-1 text-[9px] text-zinc-400 font-medium">
                                                    <Clock size={9} />
                                                    {fmtDate(t.fecha_apertura || t.created)}
                                                    {t.nombre_tecnico && (
                                                        <><span>·</span><span>{t.nombre_tecnico}</span></>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                {signal && (
                                                    <span className="text-[9px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                        <Activity size={9} /> {signal} dBm
                                                    </span>
                                                )}
                                                {isOpen ? <ChevronUp size={14} className="text-zinc-400" /> : <ChevronDown size={14} className="text-zinc-300" />}
                                            </div>
                                        </button>

                                        {/* Expanded detail */}
                                        {isOpen && (
                                            <div className="px-4 pb-4 border-t border-zinc-100 pt-3 space-y-3">
                                                {/* Process metadata */}
                                                {proc?.metadata && (
                                                    <div className="grid grid-cols-2 gap-3">
                                                        {[
                                                            { label: 'Estado', value: t.nombre_estado },
                                                            { label: 'Técnico', value: t.nombre_tecnico },
                                                            { label: 'Barrio', value: proc.metadata.barrio || t.barrio },
                                                            { label: 'Escalado A', value: proc.metadata.escalated_to },
                                                            { label: 'Inicio', value: proc.metadata.started_at ? fmtDate(proc.metadata.started_at) : undefined },
                                                            { label: 'Potencia Óptica', value: signal ? `${signal} dBm` : undefined },
                                                        ].map(f => f.value ? (
                                                            <div key={f.label} className="flex flex-col gap-0.5">
                                                                <span className="text-[9px] font-black text-zinc-400 uppercase">{f.label}</span>
                                                                <span className="text-[11px] font-bold text-zinc-700">{f.value}</span>
                                                            </div>
                                                        ) : null)}
                                                    </div>
                                                )}
                                                {/* Descripción del ticket */}
                                                {(t.descripcion || proc?.metadata?.descripcion) && (
                                                    <div>
                                                        <span className="text-[9px] font-black text-zinc-400 uppercase">Descripción</span>
                                                        <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                                                            {t.descripcion || proc?.metadata?.descripcion}
                                                        </p>
                                                    </div>
                                                )}
                                                {/* Solución / última respuesta */}
                                                {t.solucion && (
                                                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                                                        <span className="text-[9px] font-black text-emerald-600 uppercase">Solución</span>
                                                        <p className="text-[11px] text-emerald-800 mt-0.5 leading-relaxed">{t.solucion}</p>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* ── Columna derecha: Historial Financiero ── */}
                <div className="space-y-4">
                    <h2 className="text-xs font-black uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                        <DollarSign size={13} /> Historial Financiero
                    </h2>

                    {/* Saldo actual */}
                    <div className={clsx(
                        'rounded-2xl border p-5',
                        saldo !== null && saldo > 0
                            ? 'bg-red-50 border-red-200'
                            : 'bg-emerald-50 border-emerald-200'
                    )}>
                        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Saldo Pendiente</span>
                        {loadingFinancial ? (
                            <div className="flex items-center gap-2 mt-2">
                                <Loader2 size={14} className="animate-spin text-zinc-400" />
                                <span className="text-xs text-zinc-400">Consultando...</span>
                            </div>
                        ) : (
                            <p className={clsx(
                                'text-2xl font-black mt-1',
                                saldo !== null && saldo > 0 ? 'text-red-700' : 'text-emerald-700'
                            )}>
                                {saldo !== null ? fmtCurrency(saldo) : '—'}
                            </p>
                        )}
                    </div>

                    {/* Tabla de facturas */}
                    <div className="bg-white border border-zinc-100 rounded-2xl overflow-hidden">
                        <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                                Últimas Facturas
                            </span>
                            {loadingFinancial && <Loader2 size={12} className="animate-spin text-zinc-400" />}
                        </div>
                        {loadingFinancial && invoices.length === 0 ? (
                            <div className="p-6 text-center text-xs text-zinc-400">Cargando facturas...</div>
                        ) : invoices.length === 0 ? (
                            <div className="p-6 text-center text-xs text-zinc-400">Sin facturas registradas.</div>
                        ) : (
                            <table className="w-full text-xs">
                                <thead className="bg-zinc-50">
                                    <tr>
                                        <th className="px-4 py-2 text-left text-[9px] font-black uppercase tracking-widest text-zinc-400">#</th>
                                        <th className="px-4 py-2 text-left text-[9px] font-black uppercase tracking-widest text-zinc-400">Periodo</th>
                                        <th className="px-4 py-2 text-right text-[9px] font-black uppercase tracking-widest text-zinc-400">Monto</th>
                                        <th className="px-4 py-2 text-center text-[9px] font-black uppercase tracking-widest text-zinc-400">Estado</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-50">
                                    {invoices.map((inv: any, i: number) => {
                                        const paid = inv.estado === 'pagado' || inv.pagado === true || inv.saldo_restante === 0;
                                        return (
                                            <tr key={inv.id || i} className="hover:bg-zinc-50 transition-colors">
                                                <td className="px-4 py-2.5 font-mono text-zinc-500 text-[10px]">{inv.id || inv.numero || i + 1}</td>
                                                <td className="px-4 py-2.5 font-medium text-zinc-700">
                                                    {inv.mes || inv.periodo || fmtDate(inv.fecha_emision || inv.fecha)}
                                                </td>
                                                <td className="px-4 py-2.5 text-right font-black text-zinc-900">
                                                    {fmtCurrency(inv.total || inv.monto || inv.valor)}
                                                </td>
                                                <td className="px-4 py-2.5 text-center">
                                                    <span className={clsx(
                                                        'text-[9px] font-black uppercase px-2 py-0.5 rounded-full border',
                                                        paid
                                                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                            : 'bg-red-50 text-red-700 border-red-200'
                                                    )}>
                                                        {paid ? 'Pagado' : 'Pendiente'}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// Inline icon to avoid extra import
function ClipboardListIcon({ size }: { size: number }) {
    return <FileText size={size} />;
}

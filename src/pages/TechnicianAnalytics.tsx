import { useEffect, useState, useMemo } from 'react';
import {
    Users,
    Clock,
    Briefcase,
    BarChart3,
    FileDown,
    RefreshCcw,
    AlertTriangle,
    Package,
    CheckCircle2,
    XCircle,
    ChevronDown,
    ChevronUp,
    Repeat2
} from 'lucide-react';
import { WisphubCache } from '../lib/wisphubCache';
import { supabase } from '../lib/supabase';
import * as XLSX from 'xlsx';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Cell,
    Legend
} from 'recharts';
import clsx from 'clsx';

// ─── Types ─────────────────────────────────────────────────────────────────
interface TechStat {
    name: string;
    isField: boolean;
    // Volumen
    total: number;
    resolved: number;
    open: number;
    // Tiempo
    avgHours: number;
    maxHours: number;
    histogramData: { range: string; count: number }[];
    // Calidad
    reiteratives: number;
    critico: number;
    amarillo: number;
    verde: number;
    // Materiales
    materialsCount: number;
    materialItems: { name: string; qty: number; category: string }[];
    // Especialidad
    topSubject: string;
    subjectBreakdown: { name: string; count: number }[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const HOUR_RANGES = [
    { label: '0-4h', min: 0, max: 4 },
    { label: '4-24h', min: 4, max: 24 },
    { label: '1-3d', min: 24, max: 72 },
    { label: '3-7d', min: 72, max: 168 },
    { label: '+7d', min: 168, max: Infinity }
];

function buildHistogram(hoursArr: number[]) {
    return HOUR_RANGES.map(r => ({
        range: r.label,
        count: hoursArr.filter(h => h >= r.min && h < r.max).length
    }));
}

function KpiCard({ icon: Icon, label, value, sub, color = 'text-blue-900', bg = 'bg-slate-50' }: any) {
    return (
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="flex items-center gap-3 mb-3">
                <div className={`p-2.5 ${bg} ${color} rounded-xl border border-slate-100`}>
                    <Icon size={18} />
                </div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
            </div>
            <p className="text-3xl font-black text-slate-900">{value}</p>
            {sub && <p className="text-[10px] font-bold text-slate-400 uppercase mt-1">{sub}</p>}
        </div>
    );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export function TechnicianAnalytics() {
    const [loading, setLoading] = useState(true);
    // NOTA: no hay setter — este contador nunca se actualiza, así que el
    // indicador de progreso siempre muestra 0/0. Pendiente de revisar.
    const [loadProgress] = useState({ current: 0, total: 0 });
    const [techStats, setTechStats] = useState<TechStat[]>([]);
    const [selectedTech, setSelectedTech] = useState<TechStat | null>(null);
    const [typeFilter, setTypeFilter] = useState<'all' | 'field' | 'office'>('all');
    const [metricSort, setMetricSort] = useState<'total' | 'avgHours' | 'reiteratives' | 'materialsCount'>('total');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
    const [isSyncing, setIsSyncing] = useState(false);
    const [monthFilter, setMonthFilter] = useState<string>(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

    useEffect(() => {
        const init = async () => {
            await loadData();
            handleBackgroundSync();
        };
        init();
    }, []);

    useEffect(() => {
        loadData();
    }, [monthFilter]);

    const handleBackgroundSync = async () => {
        setIsSyncing(true);
        try {
            await WisphubCache.refresh();
            await loadData();
        } finally {
            setIsSyncing(false);
        }
    };

    const loadData = async () => {
        if (techStats.length === 0) setLoading(true);
        try {
            // ── Date range for selected month ──────────────────────────────
            const [year, month] = monthFilter.split('-').map(Number);
            const startOfMonth = new Date(year, month - 1, 1).toISOString();
            const endOfMonth = new Date(year, month, 0, 23, 59, 59).toISOString();

            // ── 1. Fetch all data ──────────────────────────────────────────
            const startDate = new Date(year, month - 1, 1);
            const endDate = new Date(year, month, 0, 23, 59, 59);

            const [allWisphubTickets, { data: profiles }, { data: rawMovements }] = await Promise.all([
                WisphubCache.getAll(),
                supabase
                    .from('profiles')
                    .select('id, full_name, wisphub_id, is_field_tech'),
                supabase
                    .from('inventory_movements')
                    .select(`
                        id,
                        quantity,
                        destination_holder_id,
                        inventory_assets!inventory_movements_asset_id_fkey (
                            id,
                            inventory_items (
                                name,
                                inventory_categories (
                                    name
                                )
                            )
                        )
                    `)
                    .gte('created_at', startOfMonth)
                    .lte('created_at', endOfMonth)
            ]);

            const tickets = allWisphubTickets.filter(t => {
                if (!t.fecha_creacion) return false;
                const d = new Date(t.fecha_creacion);
                return d >= startDate && d <= endDate;
            });

            // ── 2. Profiles Maps ───────────────────────────────────────────
            const profileByName = (profiles || []).reduce((acc: any, p: any) => {
                const k = (p.full_name || '').toLowerCase().trim();
                acc[k] = p;
                return acc;
            }, {});

            const profileById = (profiles || []).reduce((acc: any, p: any) => {
                if (p.id) acc[p.id] = p;
                return acc;
            }, {});

            // ── 3. Normalize Inventory Movements ───────────────────────────
            const movements = (rawMovements || []).map((m: any) => {
                const asset = m.inventory_assets;
                const item = asset?.inventory_items;
                const category = item?.inventory_categories;
                
                return {
                    quantity: m.quantity,
                    destination_holder_id: m.destination_holder_id,
                    asset_name: item?.name || 'Desconocido',
                    category_name: category?.name || 'Sin categoría'
                };
            });

            // ── 4. Group tickets by technician ─────────────────────────────
            const grouped: Record<string, {
                name: string; isField: boolean;
                total: number; resolved: number; open: number;
                hours: number[]; reiteratives: number;
                verde: number; amarillo: number; critico: number;
                subjects: Record<string, number>;
                // track client references for reiterative detection
                clientRefs: Record<string, number>;
            }> = {};

            for (const t of tickets) {
                const tech = (t.tecnico || t.nombre_tecnico || '').trim();
                if (!tech || tech.toLowerCase() === 'sin asignar' || tech === '') continue;

                if (!grouped[tech]) {
                    const profile = profileByName[tech.toLowerCase().trim()];
                    grouped[tech] = {
                        name: tech,
                        isField: profile?.is_field_tech || false,
                        total: 0, resolved: 0, open: 0,
                        hours: [], reiteratives: 0,
                        verde: 0, amarillo: 0, critico: 0,
                        subjects: {}, clientRefs: {}
                    };
                }

                const g = grouped[tech];
                g.total++;
                const hrs = Number(t.horas_abierto || 0);
                if (hrs > 0) g.hours.push(hrs);

                const statusId = Number(t.id_estado);
                if (statusId === 3 || statusId === 4) g.resolved++;
                else g.open++;

                if (t.sla_status === 'critico') g.critico++;
                else if (t.sla_status === 'amarillo') g.amarillo++;
                else g.verde++;

                const subj = (t.asunto || 'Otros').trim();
                g.subjects[subj] = (g.subjects[subj] || 0) + 1;

                // Reiteratives: same client has >1 ticket with same technician
                const clientId = (t.cedula || t.servicio || '').toString();
                if (clientId) {
                    g.clientRefs[clientId] = (g.clientRefs[clientId] || 0) + 1;
                    if (g.clientRefs[clientId] === 2) g.reiteratives++; // only count once
                }
            }

            // ── 5. Group materials by technician ───────────────────────────
            const materialByTech: Record<string, Record<string, { qty: number; category: string }>> = {};

            for (const m of movements) {
                const holderId = m.destination_holder_id;
                if (!holderId) continue;
                const profile = profileById[holderId];
                if (!profile) continue;
                const techName = profile.full_name?.trim();
                if (!techName) continue;

                if (!materialByTech[techName]) materialByTech[techName] = {};
                
                const itemName = m.asset_name;
                if (!materialByTech[techName][itemName]) {
                    materialByTech[techName][itemName] = { qty: 0, category: m.category_name };
                }
                materialByTech[techName][itemName].qty += Number(m.quantity || 1);
            }

            // ── 6. Build TechStat array ────────────────────────────────────
            const statsArray: TechStat[] = Object.values(grouped).map(g => {
                const avgHours = g.hours.length > 0
                    ? Math.round(g.hours.reduce((a, b) => a + b, 0) / g.hours.length)
                    : 0;
                const maxHours = g.hours.length > 0 ? Math.max(...g.hours) : 0;

                const subjectBreakdown = Object.entries(g.subjects)
                    .map(([name, count]) => ({ name, count }))
                    .sort((a, b) => b.count - a.count);

                const topSubject = subjectBreakdown[0]?.name || 'Generalista';

                const matItemsObj = materialByTech[g.name] || {};
                const matItems = Object.entries(matItemsObj).map(([name, data]) => ({
                    name,
                    qty: data.qty,
                    category: data.category
                }));
                const materialsCount = matItems.reduce((sum, i) => sum + i.qty, 0);

                return {
                    name: g.name,
                    isField: g.isField,
                    total: g.total,
                    resolved: g.resolved,
                    open: g.open,
                    avgHours,
                    maxHours,
                    histogramData: buildHistogram(g.hours),
                    reiteratives: g.reiteratives,
                    critico: g.critico,
                    amarillo: g.amarillo,
                    verde: g.verde,
                    materialsCount,
                    materialItems: matItems.sort((a, b) => b.qty - a.qty),
                    topSubject,
                    subjectBreakdown
                };
            });

            const sorted = statsArray.sort((a, b) => b.total - a.total);
            setTechStats(sorted);
            if (!selectedTech && sorted.length > 0) setSelectedTech(sorted[0]);

        } catch (err) {
            console.error('[TechAnalytics] Error:', err);
        } finally {
            setLoading(false);
        }
    };

    // ── Derived data ─────────────────────────────────────────────────────────
    const filteredStats = useMemo(() => {
        let arr = techStats;
        if (typeFilter === 'field') arr = arr.filter(t => t.isField);
        if (typeFilter === 'office') arr = arr.filter(t => !t.isField);

        return [...arr].sort((a, b) => {
            const va = (a as any)[metricSort];
            const vb = (b as any)[metricSort];
            return sortDir === 'desc' ? vb - va : va - vb;
        });
    }, [techStats, typeFilter, metricSort, sortDir]);

    const globalStats = useMemo(() => ({
        totalTickets: filteredStats.reduce((s, t) => s + t.total, 0),
        avgHours: filteredStats.length > 0
            ? Math.round(filteredStats.reduce((s, t) => s + t.avgHours, 0) / filteredStats.length)
            : 0,
        totalReiteratives: filteredStats.reduce((s, t) => s + t.reiteratives, 0),
        totalMaterials: filteredStats.reduce((s, t) => s + t.materialsCount, 0),
        worstTime: filteredStats.length > 0
            ? filteredStats.reduce((p, c) => c.avgHours > p.avgHours ? c : p, filteredStats[0])
            : null,
    }), [filteredStats]);

    const timeComparisonData = useMemo(() =>
        filteredStats.map(t => ({
            name: t.name.split(' ')[0],
            'Prom. Hrs': t.avgHours,
            'Reiterativos': t.reiteratives,
        })).slice(0, 10)
    , [filteredStats]);

    const exportToExcel = () => {
        if (!techStats.length) return;
        const data = filteredStats.map((s, idx) => ({
            Ranking: idx + 1,
            Técnico: s.name,
            Tipo: s.isField ? 'Campo' : 'Oficina',
            Tickets_Mes: s.total,
            Resueltos: s.resolved,
            Pendientes: s.open,
            Prom_Horas_Resolución: s.avgHours,
            Max_Horas_Resolución: s.maxHours,
            Tickets_Reiterativos: s.reiteratives,
            SLA_Verde: s.verde,
            SLA_Amarillo: s.amarillo,
            SLA_Critico: s.critico,
            Materiales_Usados: s.materialsCount,
            Especialidad_Principal: s.topSubject
        }));
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Análisis Técnicos');
        XLSX.writeFile(wb, `Analisis_Tecnicos_${monthFilter}.xlsx`);
    };

    const handleSortChange = (col: typeof metricSort) => {
        if (metricSort === col) {
            setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        } else {
            setMetricSort(col);
            setSortDir('desc');
        }
    };

    const SortIcon = ({ col }: { col: typeof metricSort }) => {
        if (metricSort !== col) return null;
        return sortDir === 'desc' ? <ChevronDown size={12} className="inline ml-1" /> : <ChevronUp size={12} className="inline ml-1" />;
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center h-[60vh] space-y-6">
            <div className="relative w-24 h-24">
                <div className="absolute inset-0 border-4 border-primary/20 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
            <p className="text-muted-foreground animate-pulse font-black text-lg uppercase tracking-widest">
                {loadProgress.total > 0 ? `Cargando ${loadProgress.current} de ${loadProgress.total} tickets...` : 'Procesando datos...'}
            </p>
        </div>
    );

    return (
        <div className="p-6 space-y-8 max-w-[1600px] mx-auto">

            {/* ── HEADER ────────────────────────────────────────────────── */}
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
                        <Users className="text-blue-900" size={24} />
                        Análisis Real de Técnicos
                    </h1>
                    <p className="text-slate-500 text-sm font-medium mt-1">
                        Métricas objetivas: tiempos de resolución, reiterativos y consumo de materiales
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    {/* Month picker */}
                    <input
                        type="month"
                        value={monthFilter}
                        onChange={e => setMonthFilter(e.target.value)}
                        className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-900/20 outline-none shadow-sm"
                    />
                    {/* Field/Office filter */}
                    <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                        {(['all', 'field', 'office'] as const).map(f => (
                            <button
                                key={f}
                                onClick={() => setTypeFilter(f)}
                                className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all ${typeFilter === f ? 'bg-white text-blue-900 shadow-sm border border-blue-100' : 'text-slate-500 hover:text-slate-900'}`}
                            >
                                {f === 'all' ? 'Todos' : f === 'field' ? '🚜 Campo' : '🏢 Oficina'}
                            </button>
                        ))}
                    </div>
                    <button onClick={exportToExcel} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 transition-all font-bold text-xs shadow-sm">
                        <FileDown size={14} /> Excel
                    </button>
                    <button onClick={handleBackgroundSync} disabled={isSyncing} className="flex items-center gap-2 px-4 py-2 bg-blue-900 text-white rounded-xl hover:bg-blue-950 transition-all font-bold text-xs shadow-md disabled:opacity-50">
                        <RefreshCcw size={14} className={isSyncing ? 'animate-spin' : ''} />
                        {isSyncing ? `Sync ${loadProgress.current}/${loadProgress.total}` : 'Sync'}
                    </button>
                </div>
            </header>

            {/* ── GLOBAL KPI CARDS ─────────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard icon={Briefcase} label="Total Tickets Mes" value={globalStats.totalTickets} sub="Todos los técnicos" />
                <KpiCard icon={Clock} label="Prom. Hrs Resolución" value={`${globalStats.avgHours}h`} sub="Promedio global" color="text-amber-700" bg="bg-amber-50" />
                <KpiCard icon={Repeat2} label="Tickets Reiterativos" value={globalStats.totalReiteratives} sub="Mismo cliente → mismo técnico" color="text-red-700" bg="bg-red-50" />
                <KpiCard icon={Package} label="Materiales Utilizados" value={globalStats.totalMaterials} sub="Unidades transferidas" color="text-emerald-700" bg="bg-emerald-50" />
            </div>

            {/* ── COMPARISON CHART ─────────────────────────────────────── */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-6 flex items-center gap-2">
                    <BarChart3 size={14} /> Tiempo Promedio de Resolución vs. Reiterativos por Técnico
                </h3>
                <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={timeComparisonData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                            <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontWeight: 700 }} />
                            <YAxis yAxisId="left" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#94a3b8' }} />
                            <YAxis yAxisId="right" orientation="right" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#fca5a5' }} />
                            <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '11px' }} />
                            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '10px', fontWeight: 700 }} />
                            <Bar yAxisId="left" dataKey="Prom. Hrs" fill="#1e3a8a" radius={[4, 4, 0, 0]} barSize={22} />
                            <Bar yAxisId="right" dataKey="Reiterativos" fill="#ef4444" radius={[4, 4, 0, 0]} barSize={22} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* ── RANKING TABLE + DETAIL PANEL ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

                {/* Ranking Table */}
                <div className="lg:col-span-3 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="p-5 border-b border-slate-100 bg-slate-50/50">
                        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-500">Ranking de Técnicos</h3>
                        <p className="text-[10px] text-slate-400 mt-1">Clic en una columna para ordenar · Clic en una fila para ver detalle</p>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-white text-[10px] uppercase text-slate-400 font-bold tracking-widest border-b border-slate-100">
                                <tr>
                                    <th className="p-4 text-center w-12">#</th>
                                    <th className="p-4">Técnico</th>
                                    <th
                                        className="p-4 text-center cursor-pointer hover:text-slate-700 transition select-none"
                                        onClick={() => handleSortChange('total')}
                                        title="Total de tickets asignados en el mes"
                                    >
                                        Tickets <SortIcon col="total" />
                                    </th>
                                    <th
                                        className="p-4 text-center cursor-pointer hover:text-slate-700 transition select-none"
                                        onClick={() => handleSortChange('avgHours')}
                                        title="Tiempo promedio (en horas) para cerrar un ticket"
                                    >
                                        Prom. Hrs <SortIcon col="avgHours" />
                                    </th>
                                    <th
                                        className="p-4 text-center cursor-pointer hover:text-slate-700 transition select-none"
                                        onClick={() => handleSortChange('reiteratives')}
                                        title="Cantidad de clientes que volvieron a tener un ticket con el mismo técnico"
                                    >
                                        Reiterativos <SortIcon col="reiteratives" />
                                    </th>
                                    <th
                                        className="p-4 text-center cursor-pointer hover:text-slate-700 transition select-none"
                                        onClick={() => handleSortChange('materialsCount')}
                                        title="Unidades de materiales (conectores, equipos, fibra, etc.) asignadas"
                                    >
                                        Materiales <SortIcon col="materialsCount" />
                                    </th>
                                    <th className="p-4 text-center" title="SLA: Verde = a tiempo, Amarillo = en riesgo, Rojo = crítico">SLA (%)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {filteredStats.map((tech, idx) => {
                                    const slaRate = tech.total > 0 ? Math.round((tech.verde / tech.total) * 100) : 0;
                                    const isSelected = selectedTech?.name === tech.name;
                                    return (
                                        <tr
                                            key={idx}
                                            onClick={() => setSelectedTech(tech)}
                                            className={clsx(
                                                'transition-colors cursor-pointer',
                                                isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'
                                            )}
                                        >
                                            <td className="p-4 text-center">
                                                <div className={clsx(
                                                    'w-7 h-7 rounded-full flex items-center justify-center font-black text-[10px]',
                                                    idx === 0 ? 'bg-yellow-100 text-yellow-700 border border-yellow-200' :
                                                    idx === 1 ? 'bg-slate-200 text-slate-600' :
                                                    idx === 2 ? 'bg-orange-100 text-orange-700' :
                                                    'bg-slate-50 text-slate-400 border border-slate-100'
                                                )}>
                                                    {idx + 1}
                                                </div>
                                            </td>
                                            <td className="p-4">
                                                <p className="font-bold text-xs uppercase text-slate-900">{tech.name}</p>
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    {tech.isField && <span className="text-[9px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded font-bold border border-blue-100">Campo</span>}
                                                    <span className="text-[9px] text-slate-400 font-bold truncate max-w-[100px]">{tech.topSubject}</span>
                                                </div>
                                            </td>
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'text-sm font-black',
                                                    tech.total > 20 ? 'text-blue-900' : 'text-slate-700'
                                                )}>{tech.total}</span>
                                                <p className="text-[8px] text-slate-400 font-bold">{tech.resolved}✓ {tech.open}↻</p>
                                            </td>
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'text-sm font-black',
                                                    tech.avgHours > 72 ? 'text-red-600' :
                                                    tech.avgHours > 24 ? 'text-amber-600' : 'text-emerald-600'
                                                )}>{tech.avgHours}h</span>
                                            </td>
                                            <td className="p-4 text-center">
                                                {tech.reiteratives > 0
                                                    ? <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-50 text-red-700 rounded-lg text-xs font-black border border-red-100">
                                                        <AlertTriangle size={10} /> {tech.reiteratives}
                                                      </span>
                                                    : <span className="text-emerald-600 font-bold text-xs">✓ 0</span>
                                                }
                                            </td>
                                            <td className="p-4 text-center">
                                                {tech.materialsCount > 0
                                                    ? <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-800 rounded-lg text-xs font-black border border-amber-100">
                                                        <Package size={10} /> {tech.materialsCount}
                                                      </span>
                                                    : <span className="text-slate-400 text-xs font-bold">—</span>
                                                }
                                            </td>
                                            <td className="p-4 text-center">
                                                <div className="flex flex-col items-center">
                                                    <span className={clsx(
                                                        'text-sm font-black',
                                                        slaRate >= 80 ? 'text-emerald-600' :
                                                        slaRate >= 50 ? 'text-amber-600' : 'text-red-600'
                                                    )}>{slaRate}%</span>
                                                    <div className="w-12 h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                                                        <div
                                                            className={clsx('h-full rounded-full', slaRate >= 80 ? 'bg-emerald-500' : slaRate >= 50 ? 'bg-amber-500' : 'bg-red-500')}
                                                            style={{ width: `${slaRate}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Detail Panel */}
                {selectedTech && (
                    <div className="lg:col-span-2 space-y-4 animate-in slide-in-from-right duration-300">

                        {/* Tech header */}
                        <div className="bg-blue-900 text-white p-6 rounded-3xl shadow-lg shadow-blue-900/20">
                            <p className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-1">Perfil Detallado</p>
                            <h2 className="text-xl font-black uppercase leading-tight">{selectedTech.name}</h2>
                            <div className="flex items-center gap-2 mt-2">
                                <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full font-bold uppercase">
                                    {selectedTech.isField ? '🚜 Campo' : '🏢 Oficina'}
                                </span>
                                <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded-full font-bold truncate max-w-[140px]">
                                    {selectedTech.topSubject}
                                </span>
                            </div>
                        </div>

                        {/* Key metrics */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Tickets Mes</p>
                                <p className="text-2xl font-black text-blue-900">{selectedTech.total}</p>
                                <div className="flex gap-2 mt-1">
                                    <span className="text-[9px] text-emerald-600 font-bold flex items-center gap-0.5"><CheckCircle2 size={9}/> {selectedTech.resolved}</span>
                                    <span className="text-[9px] text-orange-500 font-bold flex items-center gap-0.5"><XCircle size={9}/> {selectedTech.open}</span>
                                </div>
                            </div>
                            <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Prom. Resolución</p>
                                <p className={clsx('text-2xl font-black', selectedTech.avgHours > 72 ? 'text-red-600' : selectedTech.avgHours > 24 ? 'text-amber-600' : 'text-emerald-600')}>
                                    {selectedTech.avgHours}h
                                </p>
                                <p className="text-[9px] text-slate-400 font-bold mt-1">Máx: {selectedTech.maxHours}h</p>
                            </div>
                            <div className="bg-white p-4 rounded-2xl border border-red-100 shadow-sm">
                                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Reiterativos</p>
                                <p className={clsx('text-2xl font-black', selectedTech.reiteratives > 0 ? 'text-red-600' : 'text-emerald-600')}>
                                    {selectedTech.reiteratives}
                                </p>
                                <p className="text-[9px] text-slate-400 font-bold mt-1">Clientes repetidos</p>
                            </div>
                            <div className="bg-white p-4 rounded-2xl border border-amber-100 shadow-sm">
                                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Materiales</p>
                                <p className="text-2xl font-black text-amber-700">{selectedTech.materialsCount}</p>
                                <p className="text-[9px] text-slate-400 font-bold mt-1">{selectedTech.materialItems.length} tipo(s)</p>
                            </div>
                        </div>

                        {/* Resolution time histogram */}
                        <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-3">Distribución de Tiempos de Resolución</p>
                            <div className="h-[120px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={selectedTech.histogramData} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                                        <XAxis dataKey="range" fontSize={9} axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontWeight: 700 }} />
                                        <YAxis fontSize={9} axisLine={false} tickLine={false} tick={{ fill: '#94a3b8' }} />
                                        <Tooltip contentStyle={{ fontSize: '10px', borderRadius: '8px' }} />
                                        <Bar dataKey="count" radius={[3, 3, 0, 0]} barSize={28}>
                                            {selectedTech.histogramData.map((_entry, i) => (
                                                <Cell
                                                    key={i}
                                                    fill={
                                                        i === 0 ? '#10b981' :
                                                        i === 1 ? '#3b82f6' :
                                                        i === 2 ? '#f59e0b' :
                                                        i === 3 ? '#f97316' : '#ef4444'
                                                    }
                                                />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* Materials breakdown */}
                        {selectedTech.materialItems.length > 0 && (
                            <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                                <p className="text-[10px] font-black text-slate-400 uppercase mb-3 flex items-center gap-1.5">
                                    <Package size={11} /> Materiales Usados
                                </p>
                                <div className="space-y-2">
                                    {selectedTech.materialItems.slice(0, 5).map((m, i) => (
                                        <div key={i} className="flex justify-between items-center text-xs">
                                            <div className="flex-1 min-w-0">
                                                <p className="font-bold text-slate-800 truncate">{m.name}</p>
                                                <p className="text-[9px] text-slate-400">{m.category}</p>
                                            </div>
                                            <span className="ml-2 px-2 py-0.5 bg-amber-50 text-amber-800 font-black rounded border border-amber-200 text-[10px]">{m.qty} u.</span>
                                        </div>
                                    ))}
                                    {selectedTech.materialItems.length > 5 && (
                                        <p className="text-[9px] text-slate-400 text-center font-bold pt-1">
                                            +{selectedTech.materialItems.length - 5} materiales más
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Subject breakdown */}
                        <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-3">Tipo de Tickets Atendidos</p>
                            <div className="space-y-1.5">
                                {selectedTech.subjectBreakdown.slice(0, 5).map((s, i) => (
                                    <div key={i} className="flex items-center gap-2">
                                        <div className="flex-1">
                                            <div className="flex justify-between items-center mb-0.5">
                                                <span className="text-[10px] font-bold text-slate-700 truncate">{s.name}</span>
                                                <span className="text-[9px] font-black text-slate-500">{s.count}</span>
                                            </div>
                                            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-blue-900 rounded-full"
                                                    style={{ width: `${(s.count / selectedTech.total) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* SLA breakdown */}
                        <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-3">Distribución SLA</p>
                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="p-2 bg-emerald-50 rounded-xl border border-emerald-100">
                                    <p className="text-lg font-black text-emerald-700">{selectedTech.verde}</p>
                                    <p className="text-[8px] font-black text-emerald-600 uppercase">Verde</p>
                                </div>
                                <div className="p-2 bg-amber-50 rounded-xl border border-amber-100">
                                    <p className="text-lg font-black text-amber-700">{selectedTech.amarillo}</p>
                                    <p className="text-[8px] font-black text-amber-600 uppercase">En riesgo</p>
                                </div>
                                <div className="p-2 bg-red-50 rounded-xl border border-red-100">
                                    <p className="text-lg font-black text-red-700">{selectedTech.critico}</p>
                                    <p className="text-[8px] font-black text-red-600 uppercase">Crítico</p>
                                </div>
                            </div>
                        </div>

                    </div>
                )}
            </div>
        </div>
    );
}

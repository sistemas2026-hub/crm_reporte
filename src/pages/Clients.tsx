import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Users, RefreshCcw, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { WisphubService, type WispHubClient } from '../lib/wisphub';

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 400;

interface ColFilters {
    nombre: string;
    cedula: string;
    estado: string;
    plan: string;
}

export function Clients() {
    const [clients, setClients] = useState<WispHubClient[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState<ColFilters>({ nombre: '', cedula: '', estado: '', plan: '' });
    const [apiResults, setApiResults] = useState<WispHubClient[]>([]);
    const [searching, setSearching] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const loadPage = useCallback(async (p: number) => {
        setLoading(true);
        try {
            const { results, count } = await WisphubService.getAllClients(p, PAGE_SIZE);
            setClients(results);
            setTotal(count);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPage(page); }, [page, loadPage]);

    const hasFilter = Object.values(filters).some(v => v.trim().length > 0);
    // El query principal para la API es nombre o cedula (los más útiles para búsqueda global)
    const apiQuery = (filters.nombre || filters.cedula).trim().toLowerCase();

    // API search con debounce cuando cambia nombre o cédula
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (apiQuery.length < 2) { setApiResults([]); return; }

        debounceRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                const results = await WisphubService.searchClients(apiQuery);
                setApiResults(results);
            } finally {
                setSearching(false);
            }
        }, DEBOUNCE_MS);

        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [apiQuery]);

    // Fuente base: si hay resultados de API los usamos, sino la página actual
    const base = apiResults.length > 0 ? apiResults : clients;

    // Filtro multi-columna sobre la fuente base (instantáneo, sin blancos)
    const displayList = hasFilter
        ? base.filter(c => {
            const n = filters.nombre.trim().toLowerCase();
            const cd = filters.cedula.trim().toLowerCase();
            const es = filters.estado.trim().toLowerCase();
            const pl = filters.plan.trim().toLowerCase();
            if (n && !(c.nombre || '').toLowerCase().includes(n)) return false;
            if (cd && !(c.cedula || '').includes(cd)) return false;
            if (es && !(c.estado || '').toLowerCase().includes(es)) return false;
            if (pl && !(c.plan_internet?.nombre || '').toLowerCase().includes(pl)) return false;
            return true;
        })
        : clients;

    const totalPages = Math.ceil(total / PAGE_SIZE);

    const setCol = (col: keyof ColFilters, val: string) => {
        setFilters(prev => ({ ...prev, [col]: val }));
        if (col === 'nombre' || col === 'cedula') setApiResults([]);
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-zinc-900 flex items-center justify-center">
                        <Users size={18} className="text-white" />
                    </div>
                    <div>
                        <h1 className="text-lg font-black uppercase tracking-widest text-zinc-900">Clientes</h1>
                        <p className="text-[11px] text-zinc-400 font-medium">
                            {hasFilter
                                ? `${displayList.length} resultado${displayList.length !== 1 ? 's' : ''}${searching ? ' · buscando…' : ''}`
                                : `${total.toLocaleString()} clientes registrados`}
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => loadPage(page)}
                    disabled={loading}
                    className="flex items-center gap-2 px-3 py-2.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                >
                    <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
                    Actualizar
                </button>
            </div>

            <div className="bg-white border border-zinc-200 rounded-3xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-zinc-50 border-b border-zinc-200">
                            {/* Etiquetas */}
                            <tr>
                                <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400 w-24">#</th>
                                <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Nombre</th>
                                <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Cédula</th>
                                <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Estado</th>
                                <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Plan</th>
                            </tr>
                            {/* Inputs de filtro por columna */}
                            <tr>
                                <td className="px-4 pb-3" />
                                <td className="px-4 pb-3">
                                    <ColSearch
                                        value={filters.nombre}
                                        onChange={v => setCol('nombre', v)}
                                        placeholder="Buscar nombre..."
                                        loading={searching && !!filters.nombre}
                                    />
                                </td>
                                <td className="px-4 pb-3">
                                    <ColSearch
                                        value={filters.cedula}
                                        onChange={v => setCol('cedula', v)}
                                        placeholder="Buscar cédula..."
                                        loading={searching && !!filters.cedula && !filters.nombre}
                                    />
                                </td>
                                <td className="px-4 pb-3">
                                    <ColSearch
                                        value={filters.estado}
                                        onChange={v => setCol('estado', v)}
                                        placeholder="Buscar estado..."
                                    />
                                </td>
                                <td className="px-4 pb-3">
                                    <ColSearch
                                        value={filters.plan}
                                        onChange={v => setCol('plan', v)}
                                        placeholder="Buscar plan..."
                                    />
                                </td>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                            {loading && !hasFilter ? (
                                <tr>
                                    <td colSpan={5} className="p-12 text-center">
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 size={20} className="animate-spin text-zinc-400" />
                                            <span className="text-xs text-zinc-400 font-medium">Cargando clientes...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : displayList.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="p-12 text-center text-xs text-zinc-400 font-medium">
                                        {hasFilter ? 'No se encontraron clientes.' : 'Sin datos.'}
                                    </td>
                                </tr>
                            ) : (
                                displayList.map(c => (
                                    <tr key={`${c.id_servicio}-${c.cedula}`} className="hover:bg-zinc-50 transition-colors">
                                        <td className="px-4 py-3">
                                            <span className="text-[10px] font-bold text-zinc-400 font-mono">
                                                #{c.id_servicio}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Highlight text={c.nombre || '—'} query={filters.nombre} />
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-sm font-mono font-semibold text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-lg">
                                                <Highlight text={c.cedula || '—'} query={filters.cedula} />
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${
                                                c.estado?.toLowerCase() === 'activo'
                                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                    : 'bg-zinc-100 text-zinc-500 border-zinc-200'
                                            }`}>
                                                <Highlight text={c.estado || '—'} query={filters.estado} />
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-xs text-zinc-600 font-medium">
                                                <Highlight text={c.plan_internet?.nombre || '—'} query={filters.plan} />
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {!hasFilter && totalPages > 1 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100">
                        <span className="text-[11px] text-zinc-400 font-medium">
                            Página {page} de {totalPages} · {total.toLocaleString()} clientes
                        </span>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1 || loading}
                                className="p-2 rounded-xl hover:bg-zinc-100 text-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                <ChevronLeft size={15} />
                            </button>
                            <span className="px-3 py-1.5 text-xs font-black text-zinc-700 bg-zinc-100 rounded-xl min-w-[2.5rem] text-center">
                                {page}
                            </span>
                            <button
                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                disabled={page === totalPages || loading}
                                className="p-2 rounded-xl hover:bg-zinc-100 text-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                <ChevronRight size={15} />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function ColSearch({ value, onChange, placeholder, loading }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    loading?: boolean;
}) {
    return (
        <div className="relative">
            {loading
                ? <Loader2 size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 animate-spin" />
                : <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-300" />
            }
            <input
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-zinc-200 rounded-lg outline-none focus:border-zinc-400 bg-white font-medium placeholder:text-zinc-300 transition-colors"
            />
        </div>
    );
}

function Highlight({ text, query }: { text: string; query: string }) {
    const q = query.trim().toLowerCase();
    if (!q || !text) return <>{text}</>;
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return <>{text}</>;
    return (
        <>
            {text.slice(0, idx)}
            <mark className="bg-yellow-200 text-zinc-900 rounded px-0.5 not-italic">{text.slice(idx, idx + q.length)}</mark>
            {text.slice(idx + q.length)}
        </>
    );
}

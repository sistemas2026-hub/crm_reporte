import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Loader2, Users, RefreshCcw, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { WisphubService, type WispHubClient } from '../lib/wisphub';

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 350;

export function Clients() {
    const [clients, setClients] = useState<WispHubClient[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [searchResults, setSearchResults] = useState<WispHubClient[]>([]);
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

    useEffect(() => {
        loadPage(page);
    }, [page, loadPage]);

    // Live search con debounce
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);

        const q = query.trim();
        if (!q) { setSearchResults([]); return; }

        debounceRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                const results = await WisphubService.searchClients(q);
                setSearchResults(results);
            } finally {
                setSearching(false);
            }
        }, DEBOUNCE_MS);

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [query]);

    const isSearching = query.trim().length > 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const displayList = isSearching ? searchResults : clients;

    return (
        <div className="space-y-6">
            {/* Header con búsqueda integrada */}
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 shrink-0">
                    <div className="w-10 h-10 rounded-2xl bg-zinc-900 flex items-center justify-center">
                        <Users size={18} className="text-white" />
                    </div>
                    <div>
                        <h1 className="text-lg font-black uppercase tracking-widest text-zinc-900">Clientes</h1>
                        <p className="text-[11px] text-zinc-400 font-medium">
                            {isSearching
                                ? searching
                                    ? 'Buscando...'
                                    : `${searchResults.length} resultado${searchResults.length !== 1 ? 's' : ''} para "${query.trim()}"`
                                : `${total.toLocaleString()} clientes registrados`}
                        </p>
                    </div>
                </div>

                {/* Campo de búsqueda live */}
                <div className="relative flex-1 max-w-sm">
                    {searching
                        ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 animate-spin" size={14} />
                        : <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
                    }
                    <input
                        type="text"
                        placeholder="Escribir nombre o cédula..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        className="w-full pl-9 pr-8 py-2.5 text-sm border border-zinc-200 rounded-xl outline-none focus:border-zinc-400 bg-white font-medium placeholder:text-zinc-300 shadow-sm"
                        autoFocus
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-300 hover:text-zinc-500 transition-colors"
                        >
                            <X size={13} />
                        </button>
                    )}
                </div>

                <button
                    onClick={() => loadPage(page)}
                    disabled={loading}
                    className="flex items-center gap-2 px-3 py-2.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 rounded-xl text-xs font-bold transition-all disabled:opacity-50 shrink-0"
                >
                    <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
                    Actualizar
                </button>
            </div>

            {/* Tabla */}
            <div className="bg-white border border-zinc-200 rounded-3xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-zinc-50 border-b border-zinc-200">
                            <tr>
                                <th className="p-4 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">#</th>
                                <th className="p-4 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Nombre</th>
                                <th className="p-4 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Cédula</th>
                                <th className="p-4 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Estado</th>
                                <th className="p-4 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Plan</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                            {(loading && !isSearching) || (searching && isSearching) ? (
                                <tr>
                                    <td colSpan={5} className="p-12 text-center">
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 size={20} className="animate-spin text-zinc-400" />
                                            <span className="text-xs text-zinc-400 font-medium">
                                                {searching ? 'Buscando...' : 'Cargando clientes...'}
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            ) : displayList.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="p-12 text-center text-xs text-zinc-400 font-medium">
                                        {isSearching ? 'No se encontraron clientes.' : 'Sin datos.'}
                                    </td>
                                </tr>
                            ) : (
                                displayList.map(c => (
                                    <tr key={c.id_servicio} className="hover:bg-zinc-50 transition-colors">
                                        <td className="p-4">
                                            <span className="text-[10px] font-bold text-zinc-400 font-mono">
                                                #{c.id_servicio}
                                            </span>
                                        </td>
                                        <td className="p-4">
                                            <span className="text-sm font-bold text-zinc-900 uppercase">
                                                {c.nombre || '—'}
                                            </span>
                                        </td>
                                        <td className="p-4">
                                            <span className="text-sm font-mono font-semibold text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-lg">
                                                {c.cedula || '—'}
                                            </span>
                                        </td>
                                        <td className="p-4">
                                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${
                                                c.estado?.toLowerCase() === 'activo'
                                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                    : 'bg-zinc-100 text-zinc-500 border-zinc-200'
                                            }`}>
                                                {c.estado || '—'}
                                            </span>
                                        </td>
                                        <td className="p-4">
                                            <span className="text-xs text-zinc-600 font-medium">
                                                {c.plan_internet?.nombre || '—'}
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Paginación (oculta mientras se busca) */}
                {!isSearching && totalPages > 1 && (
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

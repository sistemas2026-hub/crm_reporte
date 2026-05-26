import { useState, useEffect, useCallback, useRef } from 'react';
import {
    Loader2, Users, RefreshCcw, ChevronLeft, ChevronRight,
    Search, Plus, X, Paperclip, TicketCheck
} from 'lucide-react';
import { WisphubService, type WispHubClient, type WispHubStaff } from '../lib/wisphub';
import { WisphubCache } from '../lib/wisphubCache';

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 400;

const PRIORIDADES = [
    { id: 1, label: 'Baja' },
    { id: 2, label: 'Media' },
    { id: 3, label: 'Alta' },
    { id: 4, label: 'Urgente' },
];

interface ColFilters { nombre: string; cedula: string; estado: string; plan: string; }

// ─── Combobox (input + dropdown filtrable) ────────────────────────────────────

interface ComboOption { value: string; label: string; }

function Combobox({ value, onChange, options, displayValue, placeholder }: {
    value: string;
    onChange: (v: string) => void;
    options: ComboOption[];
    displayValue: (v: string) => string;
    placeholder?: string;
}) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
                setQuery('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const filtered = query.trim()
        ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
        : options;

    return (
        <div ref={containerRef} className="relative">
            <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                <input
                    type="text"
                    value={open ? query : displayValue(value)}
                    onChange={e => { setQuery(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    placeholder={placeholder}
                    className="w-full pl-9 pr-3 py-2.5 text-sm border border-zinc-200 rounded-xl outline-none focus:border-zinc-400 bg-white font-medium text-zinc-800 placeholder:text-zinc-300"
                />
            </div>
            {open && filtered.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-zinc-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                    {filtered.map(o => (
                        <button
                            key={o.value}
                            type="button"
                            onMouseDown={() => { onChange(o.value); setOpen(false); setQuery(''); }}
                            className={`w-full text-left px-3 py-2 text-sm font-medium transition-colors first:rounded-t-xl last:rounded-b-xl ${
                                o.value === value ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-50'
                            }`}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Modal crear ticket ────────────────────────────────────────────────────────

interface TicketModalProps {
    client: WispHubClient;
    onClose: () => void;
}

function TicketModal({ client, onClose }: TicketModalProps) {
    const [subjects, setSubjects] = useState<string[]>([]);
    const [staff, setStaff] = useState<WispHubStaff[]>([]);
    const [loadingMeta, setLoadingMeta] = useState(true);

    const [asunto, setAsunto] = useState('');
    const [tecnico, setTecnico] = useState('');
    const [descripcion, setDescripcion] = useState('');
    const [prioridad, setPrioridad] = useState(1);
    const [file, setFile] = useState<File | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        (async () => {
            const [subjs, staffList] = await Promise.all([
                WisphubService.getTicketSubjects().catch(() => [] as string[]),
                WisphubService.getStaff().catch(() => [] as WispHubStaff[]),
            ]);
            setSubjects(subjs);
            setStaff(staffList);
            if (subjs.length) setAsunto(subjs[0]);
            setLoadingMeta(false);
        })();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!asunto || !descripcion.trim()) { setError('Asunto y descripción son obligatorios.'); return; }
        setError('');
        setSubmitting(true);
        try {
            const result = await WisphubService.createTicket({
                servicio: client.id_servicio,
                asunto,
                descripcion: descripcion.trim(),
                prioridad,
                technicianId: tecnico || undefined,
                file: file || undefined,
            });
            if (result?.success) {
                setSuccess(true);
                WisphubCache.refresh();
                setTimeout(onClose, 1800);
            } else {
                setError(result?.message || 'Error al crear el ticket. Intenta de nuevo.');
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-zinc-900 flex items-center justify-center shrink-0">
                            <TicketCheck size={16} className="text-white" />
                        </div>
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">Nuevo Ticket</p>
                            <h2 className="text-sm font-black text-zinc-900 uppercase leading-tight">
                                {client.nombre}
                            </h2>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-xl hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-all">
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1">
                    {loadingMeta ? (
                        <div className="flex items-center justify-center h-48 gap-3 text-zinc-400">
                            <Loader2 size={18} className="animate-spin" />
                            <span className="text-xs font-medium">Cargando formulario...</span>
                        </div>
                    ) : success ? (
                        <div className="flex flex-col items-center justify-center h-48 gap-3">
                            <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
                                <TicketCheck size={26} className="text-emerald-600" />
                            </div>
                            <p className="text-sm font-black text-zinc-800">Ticket creado correctamente</p>
                            <p className="text-xs text-zinc-400">Cerrando...</p>
                        </div>
                    ) : (
                        <form id="ticket-form" onSubmit={handleSubmit} className="p-6 space-y-5">
                            {/* Asunto */}
                            <Field label="Asunto" required>
                                <Combobox
                                    value={asunto}
                                    onChange={setAsunto}
                                    options={subjects.map(s => ({ value: s, label: s }))}
                                    displayValue={v => v}
                                    placeholder="Buscar asunto..."
                                />
                            </Field>

                            {/* Técnico */}
                            <Field label="Técnico">
                                <Combobox
                                    value={tecnico}
                                    onChange={setTecnico}
                                    options={[
                                        { value: '', label: '— Sin asignar —' },
                                        ...staff.map(s => ({ value: s.usuario, label: `${s.nombre} (${s.usuario})` })),
                                    ]}
                                    displayValue={v => v
                                        ? (staff.find(s => s.usuario === v)?.nombre ?? v)
                                        : '— Sin asignar —'
                                    }
                                    placeholder="Buscar técnico..."
                                />
                            </Field>

                            {/* Prioridad + Estado en fila */}
                            <div className="grid grid-cols-2 gap-4">
                                <Field label="Prioridad">
                                    <select
                                        value={prioridad}
                                        onChange={e => setPrioridad(Number(e.target.value))}
                                        className="w-full px-3 py-2.5 text-sm border border-zinc-200 rounded-xl outline-none focus:border-zinc-400 bg-white font-medium text-zinc-800"
                                    >
                                        {PRIORIDADES.map(p => (
                                            <option key={p.id} value={p.id}>{p.label}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label="Estado">
                                    <div className="px-3 py-2.5 text-sm border border-zinc-100 rounded-xl bg-zinc-50 text-zinc-500 font-medium">
                                        Nuevo
                                    </div>
                                </Field>
                            </div>

                            {/* Descripción */}
                            <Field label="Descripción" required>
                                <textarea
                                    value={descripcion}
                                    onChange={e => setDescripcion(e.target.value)}
                                    rows={4}
                                    placeholder="Describe el problema o la solicitud..."
                                    className="w-full px-3 py-2.5 text-sm border border-zinc-200 rounded-xl outline-none focus:border-zinc-400 bg-white font-medium resize-none placeholder:text-zinc-300"
                                />
                            </Field>

                            {/* Adjuntar archivo */}
                            <Field label="Adjuntar archivo">
                                <div
                                    onClick={() => fileRef.current?.click()}
                                    className="flex items-center gap-3 px-3 py-2.5 border border-dashed border-zinc-300 rounded-xl cursor-pointer hover:border-zinc-400 hover:bg-zinc-50 transition-all"
                                >
                                    <Paperclip size={14} className="text-zinc-400 shrink-0" />
                                    <span className="text-xs text-zinc-500 font-medium truncate">
                                        {file ? file.name : 'Seleccionar imagen, PDF o Word...'}
                                    </span>
                                    {file && (
                                        <button
                                            type="button"
                                            onClick={ev => { ev.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                                            className="ml-auto text-zinc-300 hover:text-zinc-500"
                                        >
                                            <X size={13} />
                                        </button>
                                    )}
                                </div>
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept="image/*,.pdf,.doc,.docx"
                                    className="hidden"
                                    onChange={e => setFile(e.target.files?.[0] || null)}
                                />
                            </Field>

                            {error && (
                                <p className="text-xs font-bold text-red-600 bg-red-50 border border-red-100 px-3 py-2 rounded-xl">
                                    {error}
                                </p>
                            )}
                        </form>
                    )}
                </div>

                {/* Footer */}
                {!success && !loadingMeta && (
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-100">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-5 py-2.5 text-xs font-bold text-zinc-600 hover:bg-zinc-100 rounded-xl transition-all"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            form="ticket-form"
                            disabled={submitting}
                            className="flex items-center gap-2 px-6 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-black uppercase tracking-wide transition-all active:scale-95 disabled:opacity-50"
                        >
                            {submitting
                                ? <><Loader2 size={13} className="animate-spin" /> Creando...</>
                                : <><TicketCheck size={13} /> Crear Ticket</>
                            }
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Helpers UI ───────────────────────────────────────────────────────────────

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[11px] font-black uppercase tracking-widest text-zinc-500">
                {label}{required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            {children}
        </div>
    );
}

function ColSearch({ value, onChange, placeholder, loading }: {
    value: string; onChange: (v: string) => void; placeholder: string; loading?: boolean;
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

// ─── Página principal ─────────────────────────────────────────────────────────

export function Clients() {
    const [clients, setClients] = useState<WispHubClient[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState<ColFilters>({ nombre: '', cedula: '', estado: '', plan: '' });
    const [apiResults, setApiResults] = useState<WispHubClient[]>([]);
    const [searching, setSearching] = useState(false);
    const [ticketClient, setTicketClient] = useState<WispHubClient | null>(null);
    const [selectedClient, setSelectedClient] = useState<WispHubClient | null>(null);
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
    const apiQuery = (filters.nombre || filters.cedula).trim().toLowerCase();

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

    const base = apiResults.length > 0 ? apiResults : clients;
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
        <>
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
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => loadPage(page)}
                            disabled={loading}
                            className="flex items-center gap-2 px-3 py-2.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                        >
                            <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
                            Actualizar
                        </button>
                        <button
                            onClick={() => selectedClient && setTicketClient(selectedClient)}
                            disabled={!selectedClient}
                            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-700 text-white rounded-xl text-xs font-black uppercase tracking-wide transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <Plus size={13} />
                            {selectedClient ? `Ticket — ${selectedClient.nombre.split(' ')[0]}` : 'Crear Ticket'}
                        </button>
                    </div>
                </div>

                <div className="bg-white border border-zinc-200 rounded-3xl overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-zinc-50 border-b border-zinc-200">
                                <tr>
                                    <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400 w-24">#</th>
                                    <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Nombre</th>
                                    <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Cédula</th>
                                    <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Estado</th>
                                    <th className="px-4 pt-4 pb-1 text-left text-[10px] uppercase font-black tracking-widest text-zinc-400">Plan</th>
                                </tr>
                                <tr>
                                    <td className="px-4 pb-3" />
                                    <td className="px-4 pb-3">
                                        <ColSearch value={filters.nombre} onChange={v => setCol('nombre', v)} placeholder="Buscar nombre..." loading={searching && !!filters.nombre} />
                                    </td>
                                    <td className="px-4 pb-3">
                                        <ColSearch value={filters.cedula} onChange={v => setCol('cedula', v)} placeholder="Buscar cédula..." loading={searching && !!filters.cedula && !filters.nombre} />
                                    </td>
                                    <td className="px-4 pb-3">
                                        <ColSearch value={filters.estado} onChange={v => setCol('estado', v)} placeholder="Buscar estado..." />
                                    </td>
                                    <td className="px-4 pb-3">
                                        <ColSearch value={filters.plan} onChange={v => setCol('plan', v)} placeholder="Buscar plan..." />
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
                                    displayList.map(c => {
                                        const isSelected = selectedClient?.id_servicio === c.id_servicio;
                                        return (
                                            <tr
                                                key={`${c.id_servicio}-${c.cedula}`}
                                                onClick={() => setSelectedClient(isSelected ? null : c)}
                                                className={`cursor-pointer transition-colors ${
                                                    isSelected
                                                        ? 'bg-zinc-900'
                                                        : 'hover:bg-zinc-50'
                                                }`}
                                            >
                                                <td className="px-4 py-3">
                                                    <span className={`text-[10px] font-bold font-mono ${isSelected ? 'text-zinc-400' : 'text-zinc-400'}`}>
                                                        #{c.id_servicio}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`text-sm font-bold uppercase ${isSelected ? 'text-white' : 'text-zinc-900'}`}>
                                                        <Highlight text={c.nombre || '—'} query={filters.nombre} />
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`text-sm font-mono font-semibold px-2 py-0.5 rounded-lg ${isSelected ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-100 text-zinc-700'}`}>
                                                        <Highlight text={c.cedula || '—'} query={filters.cedula} />
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${
                                                        isSelected
                                                            ? 'bg-zinc-700 text-zinc-200 border-zinc-600'
                                                            : c.estado?.toLowerCase() === 'activo'
                                                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                                : 'bg-zinc-100 text-zinc-500 border-zinc-200'
                                                    }`}>
                                                        <Highlight text={c.estado || '—'} query={filters.estado} />
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`text-xs font-medium ${isSelected ? 'text-zinc-300' : 'text-zinc-600'}`}>
                                                        <Highlight text={c.plan_internet?.nombre || '—'} query={filters.plan} />
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })
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
                                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || loading}
                                    className="p-2 rounded-xl hover:bg-zinc-100 text-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                                    <ChevronLeft size={15} />
                                </button>
                                <span className="px-3 py-1.5 text-xs font-black text-zinc-700 bg-zinc-100 rounded-xl min-w-[2.5rem] text-center">{page}</span>
                                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages || loading}
                                    className="p-2 rounded-xl hover:bg-zinc-100 text-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                                    <ChevronRight size={15} />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {ticketClient && (
                <TicketModal client={ticketClient} onClose={() => setTicketClient(null)} />
            )}
        </>
    );
}

import { useEffect, useState, useMemo } from 'react';
import { WisphubService, whNormalize } from '../lib/wisphub';
import { supabase } from '../lib/supabase';
import { useWisphubTickets } from '../hooks/useWisphubTickets';
import {
    AlertTriangle,
    Clock,
    CheckCircle2,
    TrendingUp,
    X,
    ChevronUp,
    ChevronDown,
    ArrowUpDown,
    Shield,
    MessageSquare,
    Send,
    User,
    Calendar,
    Info,
    Activity,
    FileText,
    Wifi,
    Tag,
    UserPlus,
    CalendarDays,
    Link as LinkIcon,
    Search,
    SlidersHorizontal
} from 'lucide-react';


import { TicketTimeline } from '../components/dashboard/TicketTimeline';

import { useLocation } from 'react-router-dom';

type FilterType = 'todos' | 'vencidos' | 'riesgo' | 'dia';
type SortConfig = { key: string; direction: 'asc' | 'desc' } | null;


export function OperationsDashboard() {
    const location = useLocation();

    // Read initial filters from navigation state (if any)
    const initialFilter = (location.state as any)?.filter || 'todos';
    const initialSearchId = (location.state as any)?.searchId || '';

    const [activeFilter, setActiveFilter] = useState<FilterType>(initialFilter);

    // Sync searchId from navigation state reactively
    useEffect(() => {
        const stateSearchId = (location.state as any)?.searchId;
        if (stateSearchId !== undefined && stateSearchId !== null) {
            setSearchId(String(stateSearchId));
            // Asegurarse de que el filtro global esté en 'todos' para ver el ticket
            setActiveFilter('todos');
        }
    }, [location.state]);
    const [filterSubject, setFilterSubject] = useState<string>('');
    const [filterTechnician, setFilterTechnician] = useState<string>('');
    const [searchId, setSearchId] = useState<string>(initialSearchId);
    const [currentPage, setCurrentPage] = useState(1);
    const [sortConfig, setSortConfig] = useState<SortConfig>(null);
    const [showFilters, setShowFilters] = useState(false);

    // Consulta directa a WispHub — todos los estados (1=Nuevo, 2=En Progreso, 3=Resuelto, 4=Cerrado)
    const { tickets: allTickets, loading: isValidating, refresh: mutate, lastUpdated } = useWisphubTickets(
        { status: ['1', '2', '3', '4'] },
        { autoRefresh: true, refreshIntervalMs: 5 * 60 * 1000 }
    );

    // Asuntos (catálogo estático de WispHub, se cargan una sola vez)
    const [subjects, setSubjects] = useState<any[]>([]);
    useEffect(() => {
        WisphubService.getTicketSubjects().then(setSubjects).catch(() => {});
    }, []);

    const stats = useMemo(() => allTickets.reduce((acc: any, t: any) => {
        acc.total++;
        if (t.sla_status === 'critico') acc.critico++;
        else if (t.sla_status === 'amarillo') acc.amarillo++;
        else acc.verde++;
        return acc;
    }, { total: 0, critico: 0, amarillo: 0, verde: 0 }), [allTickets]);

    // Extraer lista de técnicos únicos
    const uniqueTechnicians = useMemo(() => {
        const techs = new Set<string>();
        allTickets.forEach((t: any) => {
            const name = t.nombre_tecnico || 'Sin asignar';
            techs.add(name);
        });
        return Array.from(techs).sort();
    }, [allTickets]);

    // Ticket Detail State
    const [selectedTicket, setSelectedTicket] = useState<any>(null);
    const [ticketDetail, setTicketDetail] = useState<any>(null);
    const [comments, setComments] = useState<any[]>([]);
    const [loadingComments, setLoadingComments] = useState(false);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [newNote, setNewNote] = useState('');
    const [sendingNote, setSendingNote] = useState(false);
    const [previewImage, setPreviewImage] = useState<string | null>(null);

    const formatDiff = (start: string | null, end: string | null) => {
        if (!start || !end) return null;
        try {
            // Intentar parsear formato WispHub DD/MM/YYYY HH:MM:SS
            const parseWH = (str: string) => {
                if (str.includes('/')) {
                    const [d, m, y, h, min] = str.split(/[\/\s:]/);
                    return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
                }
                return new Date(str).getTime();
            };
            const diffMs = parseWH(end) - parseWH(start);
            if (diffMs < 0) return null;
            const mins = Math.floor(diffMs / 60000);
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        } catch (e) { return null; }
    };

    const renderSafe = (val: any, fallback: string = 'N/A') => {
        if (val === null || val === undefined) return fallback;
        if (typeof val === 'object') {
            return val.nombre || val.username || val.text || val.asunto || String(val.id || '');
        }
        return String(val);
    };

    const [statusFilter, setStatusFilter] = useState<'all' | 'nuevo' | 'en-proceso'>('all');
    const itemsPerPage = 15;

    const filteredTickets = useMemo(() => {
        let result = [...allTickets];

        // Primary Filters (SLA & Subject)
        result = result.filter(t => {
            const matchesSLA =
                activeFilter === 'todos' ? true :
                    activeFilter === 'vencidos' ? t.sla_status === 'critico' :
                        activeFilter === 'riesgo' ? t.sla_status === 'amarillo' :
                            activeFilter === 'dia' ? t.sla_status === 'verde' : true;

            const matchesSubject = filterSubject ?
                whNormalize(t.asunto) === whNormalize(filterSubject) : true;

            const matchesTechnician = filterTechnician ?
                whNormalize(t.nombre_tecnico || 'Sin asignar') === whNormalize(filterTechnician) : true;

            // Status Filter (Nuevo / En Proceso)
            const matchesStatus =
                statusFilter === 'all' ? true :
                    statusFilter === 'nuevo' ? Number(t.id_estado) === 1 :
                        statusFilter === 'en-proceso' ? Number(t.id_estado) === 2 : true;

            // ID Search Filter
            const matchesId = searchId ? String(t.id).includes(searchId) : true;

            return matchesSLA && matchesSubject && matchesTechnician && matchesStatus && matchesId;
        });

        // Sort
        if (sortConfig) {
            result.sort((a, b) => {
                let aValue = a[sortConfig.key];
                let bValue = b[sortConfig.key];

                // Handle numeric values
                if (sortConfig.key === 'id' || sortConfig.key === 'horas_abierto') {
                    aValue = Number(aValue) || 0;
                    bValue = Number(bValue) || 0;
                } else {
                    aValue = String(aValue || '').toLowerCase();
                    bValue = String(bValue || '').toLowerCase();
                }

                if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return result;
    }, [allTickets, activeFilter, filterSubject, filterTechnician, sortConfig, statusFilter, searchId]);

    // Reset page when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [activeFilter, filterSubject, filterTechnician, statusFilter, searchId, sortConfig]);

    const resetFilters = () => {
        setActiveFilter('todos');
        setFilterSubject('');
        setFilterTechnician('');
        setSearchId('');
        setSortConfig(null);
        setCurrentPage(1);
    };

    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const handleTicketClick = async (ticket: any) => {
        setSelectedTicket(ticket);
        setLoadingComments(true);
        setLoadingDetail(true);
        setComments([]);
        setTicketDetail(null);
        try {
            const [detail, ticketComments] = await Promise.all([
                WisphubService.getTicketDetail(ticket.id),
                WisphubService.getTicketComments(ticket.id)
            ]);

            // Si el objeto de la lista ya tiene servicio_completo, lo usamos inicialmente
            if (ticket.servicio_completo) {
                detail.servicio_completo = ticket.servicio_completo;
            }

            // Si el ticket no trae el servicio completo, o necesitamos refrescarlo, lo buscamos
            if (detail && (detail.servicio || detail.id_servicio) && (!detail.servicio_completo || !detail.servicio_completo.ip)) {
                const serviceId = detail.servicio || detail.id_servicio;
                const serviceDetail = await WisphubService.getServiceDetail(serviceId);
                if (serviceDetail) {
                    detail.servicio_completo = { ...detail.servicio_completo, ...serviceDetail };
                }
            }

            setTicketDetail(detail);
            setComments(ticketComments);
        } catch (error) {
            console.error("Error loading ticket data:", error);
        } finally {
            setLoadingComments(false);
            setLoadingDetail(false);
        }
    };

    const handleAddNote = async () => {
        if (!newNote.trim() || !selectedTicket) return;
        setSendingNote(true);
        try {
            const success = await WisphubService.addTicketComment(selectedTicket.id, newNote);
            if (success) {
                // Refresh comments
                const ticketComments = await WisphubService.getTicketComments(selectedTicket.id);
                setComments(ticketComments);
                setNewNote('');
            }
        } catch (error) {
            console.error("Error adding note:", error);
        } finally {
            setSendingNote(false);
        }
    };

    const totalPages = Math.ceil(filteredTickets.length / itemsPerPage);
    const paginatedTickets = filteredTickets.slice(
        (currentPage - 1) * itemsPerPage,
        currentPage * itemsPerPage
    );

    const startIndex = filteredTickets.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0;
    const endIndex = Math.min(currentPage * itemsPerPage, filteredTickets.length);



    // Ya no bloqueamos la interfaz con el spinner si tenemos datos (aunque sean viejos)
    // Solo mostramos el spinner si es la PRIMERA vez absoluta que entra el usuario (sin caché)
    const initialLoading = !activeData && isValidating;

    if (initialLoading) return (
        <div className="flex flex-col items-center justify-center h-[60vh] space-y-4">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            <p className="text-muted-foreground animate-pulse font-medium text-lg uppercase tracking-widest font-black">
                Cargando datos operativos...
            </p>
        </div>
    );

    return (
        <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8 border-b border-slate-200 pb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-3">
                        <Activity className="text-blue-900" size={24} />
                        Control de SLA y Trazabilidad
                        <span className="text-xs bg-blue-50 text-blue-700 px-3 py-1 rounded-full border border-blue-100 uppercase font-bold tracking-wider">{new Date().toLocaleString('es-ES', { month: 'long' })}</span>
                    </h1>
                    <div className="flex items-center gap-3 mt-1 ml-9">
                        <p className="text-slate-500 text-sm font-medium">Gestión Operativa y Seguimiento de Productividad Mensual</p>
                        {isValidating && swrData && (
                            <span className="flex items-center gap-1 text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100 animate-pulse">
                                <Activity size={10} className="animate-spin" /> SINCRONIZANDO
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex gap-3 ml-9 md:ml-0">
                    {(activeFilter !== 'todos' || filterSubject !== '' || filterTechnician !== '' || sortConfig !== null || searchId !== '') && (
                        <button
                            onClick={() => {
                                resetFilters();
                                setFilterSubject('');
                                setFilterTechnician('');
                                setSearchId('');
                            }}
                            className="flex items-center justify-center w-10 h-10 bg-white text-slate-400 rounded-xl hover:bg-slate-50 hover:text-slate-600 transition-all border border-slate-200 shadow-sm"
                            title="Resetear Filtros"
                        >
                            <X size={18} />
                        </button>
                    )}
                    <button
                        onClick={() => mutate()}
                        disabled={isValidating}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-900 text-white rounded-xl hover:bg-blue-950 transition-all font-bold text-xs shadow-md shadow-blue-900/10 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isValidating && swrData ? (
                            <Activity size={14} className="animate-spin" />
                        ) : (
                            <Clock size={14} />
                        )}
                        {isValidating && swrData ? 'Sincronizando...' : 'Actualizar'}
                    </button>
                </div>
            </header>

            {/* KPI Cards as Filters */}
            {/* KPI Cards as Filters */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <button
                    onClick={() => setActiveFilter('vencidos')}
                    className={`p-6 rounded-2xl border-y border-r border-l-4 transition-all text-left flex flex-col justify-between shadow-sm hover:shadow-md h-32 ${activeFilter === 'vencidos' ? 'bg-red-50/50 border-red-200 border-l-red-500 ring-1 ring-red-100' : 'bg-white border-slate-200 border-l-red-500 hover:border-red-200'}`}
                >
                    <div className="flex justify-between items-start w-full">
                        <div className={`p-2.5 rounded-xl ${activeFilter === 'vencidos' ? 'bg-red-100 text-red-700' : 'bg-red-50 text-red-600'}`}>
                            <AlertTriangle size={22} strokeWidth={2.5} />
                        </div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-red-600/80">Vencidos &gt;48h</span>
                    </div>
                    <div>
                        <p className={`text-4xl font-black tracking-tight ${activeFilter === 'vencidos' ? 'text-red-700' : 'text-slate-800'}`}>{stats.critico}</p>
                    </div>
                </button>

                <button
                    onClick={() => setActiveFilter('riesgo')}
                    className={`p-6 rounded-2xl border-y border-r border-l-4 transition-all text-left flex flex-col justify-between shadow-sm hover:shadow-md h-32 ${activeFilter === 'riesgo' ? 'bg-orange-50/50 border-orange-200 border-l-orange-500 ring-1 ring-orange-100' : 'bg-white border-slate-200 border-l-orange-500 hover:border-orange-200'}`}
                >
                    <div className="flex justify-between items-start w-full">
                        <div className={`p-2.5 rounded-xl ${activeFilter === 'riesgo' ? 'bg-orange-100 text-orange-700' : 'bg-orange-50 text-orange-600'}`}>
                            <Clock size={22} strokeWidth={2.5} />
                        </div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-orange-600/80">Riesgo 24-48h</span>
                    </div>
                    <div>
                        <p className={`text-4xl font-black tracking-tight ${activeFilter === 'riesgo' ? 'text-orange-700' : 'text-slate-800'}`}>{stats.amarillo}</p>
                    </div>
                </button>

                <button
                    onClick={() => setActiveFilter('dia')}
                    className={`p-6 rounded-2xl border-y border-r border-l-4 transition-all text-left flex flex-col justify-between shadow-sm hover:shadow-md h-32 ${activeFilter === 'dia' ? 'bg-emerald-50/50 border-emerald-200 border-l-emerald-500 ring-1 ring-emerald-100' : 'bg-white border-slate-200 border-l-emerald-500 hover:border-emerald-200'}`}
                >
                    <div className="flex justify-between items-start w-full">
                        <div className={`p-2.5 rounded-xl ${activeFilter === 'dia' ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-50 text-emerald-600'}`}>
                            <CheckCircle2 size={22} strokeWidth={2.5} />
                        </div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-600/80">Al Día &lt;24h</span>
                    </div>
                    <div>
                        <p className={`text-4xl font-black tracking-tight ${activeFilter === 'dia' ? 'text-emerald-700' : 'text-slate-800'}`}>{stats.verde}</p>
                    </div>
                </button>

                <button
                    onClick={() => setActiveFilter('todos')}
                    className={`p-6 rounded-2xl border-y border-r border-l-4 transition-all text-left flex flex-col justify-between shadow-sm hover:shadow-md h-32 ${activeFilter === 'todos' ? 'bg-blue-50/50 border-blue-200 border-l-blue-600 ring-1 ring-blue-100' : 'bg-white border-slate-200 border-l-blue-600 hover:border-blue-200'}`}
                >
                    <div className="flex justify-between items-start w-full">
                        <div className={`p-2.5 rounded-xl ${activeFilter === 'todos' ? 'bg-blue-100 text-blue-700' : 'bg-blue-50 text-blue-600'}`}>
                            <TrendingUp size={22} strokeWidth={2.5} />
                        </div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-blue-600/80">Total Tickets</span>
                    </div>
                    <div>
                        <p className={`text-4xl font-black tracking-tight ${activeFilter === 'todos' ? 'text-blue-900' : 'text-slate-800'}`}>{stats.total}</p>
                    </div>
                </button>
            </div>



            {/* Main Table Section */}
            <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
                <div className="p-6 border-b border-slate-200 bg-slate-50/80 flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-white rounded-lg border border-slate-200 shadow-sm">
                            <Shield className="text-blue-900" size={16} />
                        </div>
                        <h2 className="font-extrabold text-xs uppercase tracking-widest text-slate-700">Supervisión Operativa</h2>
                        <span className="text-[10px] font-black bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-md border border-blue-200 ml-2 shadow-sm">
                            {filteredTickets.length} ITEMS
                        </span>
                    </div>

                    <div className="flex items-center gap-3 w-full md:w-auto">
                        <div className="relative group flex-1 md:flex-none">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-900 transition-colors" size={14} />
                            <input
                                type="text"
                                placeholder="Buscar ID..."
                                value={searchId}
                                onChange={(e) => setSearchId(e.target.value)}
                                className="pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-blue-900/10 focus:border-blue-900/50 w-full md:w-48 transition-all text-slate-700 placeholder:text-slate-400 shadow-sm"
                            />
                        </div>

                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border shadow-sm ${showFilters ? 'bg-blue-900 text-white border-blue-900 shadow-blue-900/20' : 'bg-white hover:bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-800'}`}
                        >
                            <SlidersHorizontal size={14} />
                            Filtros
                            {(filterSubject || filterTechnician || statusFilter !== 'all') && (
                                <span className="flex h-2 w-2 rounded-full bg-orange-500 animate-pulse ml-1"></span>
                            )}
                        </button>
                    </div>
                </div>

                {/* Retractable Filter Panel */}
                <div
                    className={`overflow-hidden transition-all duration-300 ease-in-out border-b border-slate-100 bg-slate-50/50 ${showFilters ? 'max-h-64 opacity-100 border-opacity-100' : 'max-h-0 opacity-0 border-opacity-0'}`}
                >
                    <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="space-y-2">
                            <label className="text-[9px] font-bold uppercase text-slate-400 tracking-widest flex items-center gap-2">
                                <Tag size={12} className="text-blue-900" /> Asunto del Ticket
                            </label>
                            <div className="relative">
                                <select
                                    value={filterSubject}
                                    onChange={(e) => setFilterSubject(e.target.value)}
                                    className="appearance-none bg-white border border-slate-200 text-xs font-bold rounded-xl px-4 py-2.5 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 w-full transition-all text-slate-700 shadow-sm"
                                >
                                    <option value="">Todos los Asuntos</option>
                                    {subjects.map((s: string) => (
                                        <option key={s} value={s}>{s}</option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={14} />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-[9px] font-bold uppercase text-slate-400 tracking-widest flex items-center gap-2">
                                <User size={12} className="text-blue-900" /> Técnico Asignado
                            </label>
                            <div className="relative">
                                <select
                                    value={filterTechnician}
                                    onChange={(e) => setFilterTechnician(e.target.value)}
                                    className="appearance-none bg-white border border-slate-200 text-xs font-bold rounded-xl px-4 py-2.5 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 w-full transition-all text-slate-700 shadow-sm"
                                >
                                    <option value="">Todos los Técnicos</option>
                                    {uniqueTechnicians.map((t: string) => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={14} />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-[9px] font-bold uppercase text-slate-400 tracking-widest flex items-center gap-2">
                                <Activity size={12} className="text-blue-900" /> Estado del Flujo
                            </label>
                            <div className="flex bg-white border border-slate-200 p-1 rounded-xl h-[38px] shadow-sm">
                                <button
                                    onClick={() => setStatusFilter('all')}
                                    className={`flex-1 text-[9px] font-bold uppercase rounded-lg transition-all ${statusFilter === 'all' ? 'bg-slate-100 text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    Todos
                                </button>
                                <button
                                    onClick={() => setStatusFilter('nuevo')}
                                    className={`flex-1 text-[9px] font-bold uppercase rounded-lg transition-all ${statusFilter === 'nuevo' ? 'bg-blue-50 text-blue-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    Abiertos
                                </button>
                                <button
                                    onClick={() => setStatusFilter('en-proceso')}
                                    className={`flex-1 text-[9px] font-bold uppercase rounded-lg transition-all ${statusFilter === 'en-proceso' ? 'bg-orange-50 text-orange-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    En Proceso
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50/80 border-b border-slate-200 text-[10px] uppercase text-slate-500 font-extrabold tracking-widest sticky top-0 z-10 backdrop-blur-sm">
                            <tr>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-left first:rounded-tl-none" onClick={() => handleSort('id')}>
                                    <div className="flex items-center gap-2">
                                        ID {sortConfig?.key === 'id' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-left" onClick={() => handleSort('nombre_cliente')}>
                                    <div className="flex items-center gap-2">
                                        CLIENTE {sortConfig?.key === 'nombre_cliente' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-left" onClick={() => handleSort('asunto')}>
                                    <div className="flex items-center gap-2">
                                        ASUNTO {sortConfig?.key === 'asunto' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-center" onClick={() => handleSort('nombre_estado')}>
                                    <div className="flex items-center justify-center gap-2">
                                        ESTADO {sortConfig?.key === 'nombre_estado' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-center" onClick={() => handleSort('id_prioridad')}>
                                    <div className="flex items-center justify-center gap-2">
                                        PRIORIDAD {sortConfig?.key === 'id_prioridad' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group text-left" onClick={() => handleSort('nombre_tecnico')}>
                                    <div className="flex items-center gap-2">
                                        TÉCNICO {sortConfig?.key === 'nombre_tecnico' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                                <th className="p-5 text-center cursor-pointer hover:bg-slate-100/50 hover:text-blue-900 transition-colors group last:rounded-tr-none" onClick={() => handleSort('horas_abierto')}>
                                    <div className="flex items-center justify-center gap-2">
                                        SLA {sortConfig?.key === 'horas_abierto' && (sortConfig.direction === 'asc' ? <ChevronUp size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />)}
                                        {!sortConfig && <ArrowUpDown size={12} className="opacity-0 group-hover:opacity-100 text-blue-900/40" />}
                                    </div>
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {paginatedTickets.map((ticket) => (
                                <tr
                                    key={ticket.id}
                                    className="group hover:bg-slate-50 cursor-pointer transition-colors"
                                    onClick={() => handleTicketClick(ticket)}
                                >
                                    <td className="p-4">
                                        <div className="font-extrabold text-blue-900 text-lg leading-none">#{ticket.id}</div>
                                        <div className="text-[9px] text-slate-400 font-bold mt-1 uppercase tracking-tighter">Ticket ID</div>
                                    </td>
                                    <td className="p-4">
                                        <div className="font-bold text-[13px] uppercase text-slate-700 leading-tight group-hover:text-blue-900 transition-colors">{ticket.nombre_cliente}</div>
                                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-medium mt-1 bg-white border border-slate-100 px-2 py-0.5 rounded-md w-fit shadow-sm">
                                            <Calendar size={10} className="text-slate-400" />
                                            {ticket.fecha_creacion ? new Date(ticket.fecha_creacion).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                                        </div>
                                    </td>
                                    <td className="p-4">
                                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-600 bg-slate-50 border border-slate-100 px-2 py-1 rounded inline-block max-w-[200px] truncate">
                                            {ticket.asunto}
                                        </div>
                                    </td>
                                    <td className="p-4 text-center">
                                        <span className={`px-2 py-0.5 rounded-full text-[8px] font-bold uppercase border tracking-widest shadow-sm ${Number(ticket.id_estado) === 3 ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                                            Number(ticket.id_estado) === 2 ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                                'bg-blue-50 text-blue-600 border-blue-100'
                                            }`}>
                                            {ticket.nombre_estado}
                                        </span>
                                    </td>
                                    <td className="p-4 text-center">
                                        <span className={`px-2 py-0.5 rounded-full text-[8px] font-bold uppercase border tracking-widest shadow-sm ${Number(ticket.id_prioridad) === 3 ? 'bg-red-50 text-red-600 border-red-100' :
                                            Number(ticket.id_prioridad) === 2 ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                                Number(ticket.id_prioridad) === 4 ? 'bg-purple-50 text-purple-600 border-purple-100' :
                                                    'bg-blue-50 text-blue-600 border-blue-100'
                                            }`}>
                                            {ticket.prioridad}
                                        </span>
                                    </td>
                                    <td className="p-4">
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 border border-slate-200">
                                                <User size={12} />
                                            </div>
                                            <span className="text-[10px] font-bold uppercase text-slate-600">{ticket.nombre_tecnico || 'Sin asignar'}</span>
                                        </div>
                                    </td>
                                    <td className="p-4">
                                        <div className="flex flex-col items-center w-full max-w-[80px] mx-auto">
                                            <div className="text-lg font-black font-mono tracking-tighter tabular-nums mb-1 text-slate-700">{ticket.horas_abierto}H</div>

                                            {/* SLA Progress Bar */}
                                            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mb-1.5 border border-slate-100">
                                                <div
                                                    className={`h-full rounded-full transition-all ${ticket.sla_status === 'critico' ? 'bg-red-500 w-full' :
                                                        ticket.sla_status === 'amarillo' ? 'bg-orange-500 w-[75%]' :
                                                            'bg-emerald-500 w-[40%]'
                                                        }`}
                                                ></div>
                                            </div>

                                            <div className={`px-2 py-0 rounded-md text-[8px] font-bold uppercase border tracking-wider w-full text-center ${ticket.sla_status === 'critico' ? 'bg-red-50 text-red-600 border-red-100' :
                                                ticket.sla_status === 'amarillo' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                                    'bg-emerald-50 text-emerald-600 border-emerald-100'
                                                }`}>
                                                {ticket.sla_status === 'critico' ? 'Vencido' : ticket.sla_status === 'amarillo' ? 'Riesgo' : 'OK'}
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                <div className="p-4 border-t border-slate-100 bg-white flex flex-col sm:flex-row justify-between items-center gap-4">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Mostrando <span className="text-slate-900">{startIndex}</span> a <span className="text-slate-900">{endIndex}</span> de <span className="text-blue-900">{filteredTickets.length}</span> registros
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            className="p-2 bg-white border border-slate-200 rounded-xl text-slate-400 hover:text-blue-900 hover:border-blue-900 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:border-slate-200 transition-all shadow-sm"
                        >
                            <ChevronDown className="rotate-90" size={16} />
                        </button>
                        <div className="flex items-center gap-1">
                            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                let pageNum = i + 1;
                                if (totalPages > 5 && currentPage > 3) {
                                    pageNum = currentPage - 3 + i + 1;
                                }
                                if (pageNum > totalPages) return null;
                                return (
                                    <button
                                        key={pageNum}
                                        onClick={() => setCurrentPage(pageNum)}
                                        className={`w-8 h-8 rounded-xl text-[10px] font-black transition-all ${currentPage === pageNum ? 'bg-blue-900 text-white shadow-md shadow-blue-900/20' : 'bg-white border border-slate-200 text-slate-500 hover:border-blue-900 hover:text-blue-900'}`}
                                    >
                                        {pageNum}
                                    </button>
                                );
                            })}
                        </div>
                        <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                            className="p-2 bg-white border border-slate-200 rounded-xl text-slate-400 hover:text-blue-900 hover:border-blue-900 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:border-slate-200 transition-all shadow-sm"
                        >
                            <ChevronDown className="-rotate-90" size={16} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Ticket Detail Drawer */}
            {
                selectedTicket && (
                    <div className="fixed inset-0 z-50 flex justify-end">
                        <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm transition-opacity" onClick={() => setSelectedTicket(null)}></div>
                        <div className="relative w-full max-w-lg bg-white border-l border-slate-200 h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
                            {/* Drawer Header */}
                            <div className="p-6 border-b border-slate-100 bg-slate-50/50">
                                <div className="flex justify-between items-start mb-4">
                                    <div className="p-2 bg-white border border-slate-200 rounded-xl text-blue-900 shadow-sm">
                                        <Shield size={24} />
                                    </div>
                                    <button onClick={() => setSelectedTicket(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-600">
                                        <X size={20} />
                                    </button>
                                </div>
                                <h2 className="text-2xl font-black text-slate-900">Ticket #{selectedTicket.id}</h2>
                                <p className="text-xs font-bold text-blue-700 bg-blue-50 px-2 py-1 rounded w-fit mt-2 uppercase tracking-wide border border-blue-100">{selectedTicket.asunto}</p>
                            </div>

                            {/* Information Sections */}
                            <div className="flex-1 overflow-y-auto custom-scrollbar bg-white">
                                {loadingDetail ? (
                                    <div className="p-8 space-y-6">
                                        <div className="h-4 bg-slate-100 animate-pulse rounded w-1/3"></div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="h-16 bg-slate-100 animate-pulse rounded-2xl"></div>
                                            <div className="h-16 bg-slate-100 animate-pulse rounded-2xl"></div>
                                        </div>
                                        <div className="h-32 bg-slate-100 animate-pulse rounded-2xl"></div>
                                    </div>
                                ) : (
                                    <div className="p-6 space-y-8">
                                        {/* Ticket General Info Section */}
                                        <section className="space-y-4">
                                            <h3 className="text-[10px] font-black uppercase tracking-[.25em] text-slate-400 flex items-center gap-2">
                                                <Tag size={12} className="text-blue-900" /> INFORMACIÓN TICKET
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <CheckCircle2 size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Estado / Prioridad</span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${(ticketDetail?.id_estado || selectedTicket.id_estado) === 3 ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-blue-50 text-blue-600 border-blue-100'}`}>
                                                            {renderSafe(ticketDetail?.nombre_estado || selectedTicket.nombre_estado, 'Abierto')}
                                                        </span>
                                                        <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border bg-orange-50 text-orange-600 border-orange-100">
                                                            {renderSafe(ticketDetail?.nombre_prioridad || selectedTicket.prioridad, 'Alta')}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <Calendar size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Creado</span>
                                                    </div>
                                                    <p className="text-xs font-bold text-slate-700">
                                                        {renderSafe(ticketDetail?.fecha_creacion ? new Date(ticketDetail.fecha_creacion).toLocaleString() : null, 'N/A')}
                                                    </p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <UserPlus size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Creado por</span>
                                                    </div>
                                                    <p className="text-xs font-bold truncate text-slate-700">
                                                        {renderSafe(ticketDetail?.user_creado, 'Sistema')}
                                                    </p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <User size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Técnico</span>
                                                    </div>
                                                    <p className="text-xs font-bold truncate text-slate-700">
                                                        {renderSafe(ticketDetail?.nombre_tecnico || selectedTicket.nombre_tecnico, 'Sin asignar')}
                                                    </p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <Clock size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Inicio Trayecto</span>
                                                    </div>
                                                    <p className="text-[10px] font-bold text-slate-700">
                                                        {renderSafe(ticketDetail?.fecha_inicio ? new Date(ticketDetail.fecha_inicio).toLocaleString() : null, 'No iniciada')}
                                                    </p>
                                                </div>
                                                {ticketDetail?.fecha_llegada && (
                                                    <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100 flex flex-col justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2 text-blue-600">
                                                                <Activity size={12} />
                                                                <span className="text-[9px] font-bold uppercase">Llegada al Sitio</span>
                                                            </div>
                                                            <p className="text-[10px] font-bold text-blue-900">
                                                                {renderSafe(ticketDetail.fecha_llegada, 'N/A')}
                                                            </p>
                                                        </div>
                                                        <div className="mt-4 pt-2 border-t border-blue-100/50">
                                                            <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest">Trayecto: </span>
                                                            <span className="text-[10px] font-black text-blue-700">{formatDiff(ticketDetail.fecha_inicio, ticketDetail.fecha_llegada) || '---'}</span>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col justify-between">
                                                    <div>
                                                        <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                            <CheckCircle2 size={12} />
                                                            <span className="text-[9px] font-bold uppercase">Fin de Trabajo</span>
                                                        </div>
                                                        <p className="text-[10px] font-bold text-slate-700">
                                                            {renderSafe(ticketDetail?.fecha_final || ticketDetail?.fecha_termino ? new Date(ticketDetail.fecha_final || ticketDetail.fecha_termino).toLocaleString() : null, 'En ejecución')}
                                                        </p>
                                                    </div>
                                                    {ticketDetail?.fecha_llegada && (ticketDetail?.fecha_final || ticketDetail?.fecha_termino) && (
                                                        <div className="mt-4 pt-2 border-t border-slate-200">
                                                            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">En Sitio: </span>
                                                            <span className="text-[10px] font-black text-emerald-600 font-mono">{formatDiff(ticketDetail.fecha_llegada, ticketDetail.fecha_final || ticketDetail.fecha_termino) || '---'}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </section>

                                        {/* Client Info Section */}
                                        <section className="space-y-4">
                                            <h3 className="text-[10px] font-black uppercase tracking-[.25em] text-slate-400 flex items-center gap-2">
                                                <User size={12} className="text-blue-900" /> INFORMACIÓN CLIENTE
                                            </h3>
                                            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-3">
                                                <div className="flex justify-between items-center border-b border-slate-200 pb-2">
                                                    <span className="text-[9px] font-bold uppercase text-slate-500">Nombre</span>
                                                    <span className="text-xs font-bold text-slate-800">{renderSafe(ticketDetail?.nombre_cliente || ticketDetail?.servicio_completo?.nombre, 'No disponible')}</span>
                                                </div>
                                                <div className="flex justify-between items-center border-b border-slate-200 pb-2">
                                                    <span className="text-[9px] font-bold uppercase text-slate-500">Cédula / DNI</span>
                                                    <span className="text-xs font-bold text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.cedula, 'No disponible')}</span>
                                                </div>
                                                <div className="flex justify-between items-center border-b border-slate-200 pb-2">
                                                    <span className="text-[9px] font-bold uppercase text-slate-500">Dirección</span>
                                                    <span className="text-xs font-bold text-right ml-4 text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.direccion, 'No disponible')}</span>
                                                </div>
                                                <div className="flex justify-between items-center">
                                                    <span className="text-[9px] font-bold uppercase text-slate-500">Teléfono / Email</span>
                                                    <div className="text-right">
                                                        <p className="text-xs font-bold text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.telefono, 'No disponible')}</p>
                                                        <p className="text-[9px] text-slate-500">{renderSafe(ticketDetail?.servicio_completo?.email, '')}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Service Technical Info Section */}
                                        <section className="space-y-4">
                                            <h3 className="text-[10px] font-black uppercase tracking-[.25em] text-slate-400 flex items-center gap-2">
                                                <Activity size={12} className="text-blue-900" /> INFORMACIÓN SERVICIO
                                            </h3>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <Shield size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Usuario de Red</span>
                                                    </div>
                                                    <p className="text-xs font-bold truncate text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.usuario_rb || ticketDetail?.servicio_completo?.usuario, 'No disponible')}</p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <Info size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Nº IP</span>
                                                    </div>
                                                    <p className="text-xs font-mono font-bold text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.ip || selectedTicket?.servicio_completo?.ip, 'Sin IP')}</p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 col-span-2">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <Wifi size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Plan Internet</span>
                                                    </div>
                                                    <p className="text-xs font-bold text-slate-800">
                                                        {renderSafe(ticketDetail?.servicio_completo?.plan_internet?.nombre ||
                                                            selectedTicket?.servicio_completo?.plan_internet?.nombre ||
                                                            ticketDetail?.servicio_completo?.plan_internet, 'Sin Plan')}
                                                    </p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <LinkIcon size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Router / AP</span>
                                                    </div>
                                                    <p className="text-xs font-bold truncate text-slate-800">
                                                        {renderSafe(ticketDetail?.servicio_completo?.modelo_router_wifi ||
                                                            selectedTicket?.servicio_completo?.modelo_router_wifi ||
                                                            ticketDetail?.servicio_completo?.router ||
                                                            ticketDetail?.servicio_completo?.modelo_router, 'N/A')}
                                                    </p>
                                                    <p className="text-[9px] font-medium text-slate-500 truncate">
                                                        {renderSafe(ticketDetail?.servicio_completo?.sectorial?.nombre ||
                                                            selectedTicket?.servicio_completo?.sectorial?.nombre ||
                                                            ticketDetail?.servicio_completo?.ap, 'Sin Nodo')}
                                                    </p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                    <div className="flex items-center gap-2 mb-2 text-slate-500">
                                                        <CalendarDays size={12} />
                                                        <span className="text-[9px] font-bold uppercase">Instalación / Zona</span>
                                                    </div>
                                                    <p className="text-xs font-bold truncate text-slate-800">{renderSafe(ticketDetail?.servicio_completo?.fecha_instalacion, 'N/A')}</p>
                                                    <p className="text-[9px] font-medium text-slate-500 truncate">{renderSafe(ticketDetail?.servicio_completo?.zona, 'N/A')}</p>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Ticket Description */}
                                        <section className="space-y-4">
                                            <h3 className="text-[10px] font-black uppercase tracking-[.25em] text-slate-400 flex items-center gap-2">
                                                <FileText size={12} className="text-blue-900" /> Descripción del Ticket
                                            </h3>
                                            <div className="bg-blue-50/50 p-5 rounded-3xl border border-blue-100 relative overflow-hidden group">
                                                <div className="absolute top-0 right-0 p-3 opacity-5 text-blue-900">
                                                    <FileText size={64} />
                                                </div>
                                                <div
                                                    className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap relative z-10 description-content cursor-pointer font-medium"
                                                    onClick={(e) => {
                                                        const target = e.target as HTMLElement;
                                                        if (target.tagName === 'IMG') {
                                                            setPreviewImage((target as HTMLImageElement).src);
                                                        }
                                                    }}
                                                    dangerouslySetInnerHTML={{
                                                        __html: ticketDetail?.descripcion || 'Sin descripción detallada por el momento.'
                                                    }}
                                                />
                                            </div>
                                        </section>

                                        {/* Comments Section */}
                                        <section className="space-y-4">
                                            <h3 className="text-[10px] font-black uppercase tracking-[.25em] text-slate-400 flex items-center gap-2">
                                                <MessageSquare size={12} className="text-blue-900" /> Historial de Comentarios
                                            </h3>

                                            {loadingComments ? (
                                                <div className="flex flex-col items-center justify-center py-12 space-y-3">
                                                    <div className="w-8 h-8 border-3 border-blue-900 border-t-transparent rounded-full animate-spin"></div>
                                                    <p className="text-[10px] font-black text-slate-400 uppercase">Cargando bitácora...</p>
                                                </div>
                                            ) : comments.length === 0 ? (
                                                <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-3xl opacity-60">
                                                    <p className="text-xs font-bold text-slate-400">No hay comentarios en este ticket aún.</p>
                                                </div>
                                            ) : (
                                                <div className="space-y-4">
                                                    <TicketTimeline
                                                        comments={comments.map(c => ({
                                                            nombre_tecnico: c.nombre_usuario || 'Sistema',
                                                            fecha: c.fecha,
                                                            descripcion: c.comentario
                                                        }))}
                                                        ticketDate={ticketDetail?.fecha_creacion || selectedTicket.fecha_creacion}
                                                        ticketAuthor={ticketDetail?.nombre_tecnico || selectedTicket.nombre_tecnico || 'Sistema'}
                                                    />
                                                </div>
                                            )}
                                        </section>
                                    </div>
                                )}
                            </div>

                            {/* Quick Note Input */}
                            <div className="p-6 border-t border-slate-100 bg-white">
                                <div className="relative">
                                    <textarea
                                        value={newNote}
                                        onChange={(e) => setNewNote(e.target.value)}
                                        placeholder="Escribe una nota rápida o actualización..."
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 pr-12 text-sm focus:ring-2 focus:ring-blue-900/10 outline-none resize-none h-24 font-medium transition-all focus:bg-white text-slate-700 placeholder:text-slate-400"
                                    ></textarea>
                                    <button
                                        onClick={handleAddNote}
                                        disabled={!newNote.trim() || sendingNote}
                                        className="absolute bottom-4 right-4 p-2 bg-blue-900 text-white rounded-xl hover:scale-110 active:scale-95 disabled:opacity-30 disabled:hover:scale-100 transition-all shadow-lg shadow-blue-900/20"
                                    >
                                        {sendingNote ? (
                                            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                        ) : (
                                            <Send size={18} />
                                        )}
                                    </button>
                                </div>
                                <p className="text-[9px] font-bold text-slate-400 mt-3 uppercase text-center">Las notas se sincronizan automáticamente con WispHub</p>
                            </div>
                        </div>
                    </div>
                )
            }
            {/* Image Preview Modal */}
            {
                previewImage && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/90 animate-in fade-in duration-200 backdrop-blur-sm">
                        <button
                            onClick={() => setPreviewImage(null)}
                            className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors backdrop-blur-md"
                        >
                            <X size={32} />
                        </button>
                        <img
                            src={previewImage || ''}
                            alt="Preview"
                            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                        />
                    </div>
                )
            }
        </div >
    );
}

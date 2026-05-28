import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { getRecordingLinkUrl } from '../../lib/jamInit';
import { supabase, safeGetUser } from '../../lib/supabase';
import {
    LogOut,
    Moon,
    Sun,
    ChevronDown,
    ChevronUp,
    User as UserIcon,
    Search as SearchIcon,
    Menu,
    Loader2,
    UserPlus,
    ShieldAlert,
    Bell,
    CheckCircle2,
    Info,
    AlertTriangle,
    Bug
} from 'lucide-react';
import { NAV_GROUPS } from '../../config/menu';
import { WisphubService, type WispHubClient } from '../../lib/wisphub';
import { WisphubCache } from '../../lib/wisphubCache';
import { NotificationService, type Notification } from '../../lib/notifications';
import { WorkflowService } from '../../lib/workflowService';
import clsx from 'clsx';
import { useState, useEffect, useRef } from 'react';
import { MobileSidebar } from './MobileSidebar';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface Toast {
    id: string;
    message: string;
    type: 'success' | 'error' | 'info' | 'loading' | 'warning';
    description?: string;
}

interface SidebarProps {
    navGroups: any[];
    expandedGroups: Record<string, boolean>;
    toggleGroup: (title: string) => void;
    location: any;
    isAdmin: boolean;
    userEmail: string | null;
    handleLogout: () => void;
    toggleTheme: () => void;
    theme: 'light' | 'dark';
    hasCriticalTickets: boolean;
}

function SidebarContent({
    navGroups,
    expandedGroups,
    toggleGroup,
    location,
    isAdmin,
    userEmail,
    handleLogout,
    toggleTheme,
    theme,
    hasCriticalTickets
}: SidebarProps) {
    return (
        <div className="flex flex-col h-full bg-[#11101d] text-white">
            {/* Logo/Brand Section */}
            <div className="px-6 py-8 flex items-center justify-center">
                <img
                    src="/logo-white.png"
                    alt="RapiLink SAS"
                    className="h-10 w-auto object-contain"
                />
            </div>

            {/* Main Navigation */}
            <nav className="flex-1 px-4 py-4 space-y-2 overflow-y-auto custom-scrollbar">
                {/* Groups with Accordion */}
                {navGroups.map((group) => {
                    const isExpanded = expandedGroups[group.title];
                    const isAnyActive = group.items.some((item: any) => location.pathname === item.to);

                    return (
                        <div key={group.title} className="space-y-1">
                            <button
                                onClick={() => toggleGroup(group.title)}
                                className={clsx(
                                    "w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 group",
                                    isAnyActive ? "text-white" : "text-gray-400 hover:bg-white/10 hover:text-white"
                                )}
                            >
                                <div className="flex items-center gap-4">
                                    <group.icon className="w-5 h-5 transition-transform group-hover:scale-110" />
                                    <span>{group.title}</span>
                                </div>
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>

                            {isExpanded && (
                                <div className="ml-4 pl-4 border-l border-white/5 space-y-1 py-1 animate-in fade-in slide-in-from-top-2 duration-200">
                                    {group.items.map((item: any) => (
                                        <NavLink
                                            key={item.to}
                                            to={item.to}
                                            className={({ isActive }) =>
                                                clsx(
                                                    "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-all duration-200",
                                                    isActive
                                                        ? "text-white font-semibold flex items-center gap-3"
                                                        : "text-gray-500 hover:text-gray-300 flex items-center gap-3"
                                                )
                                            }
                                        >
                                            <item.icon className="w-4 h-4" />
                                            <span className="flex-1">{item.label}</span>
                                            {item.to === '/operaciones/trazabilidad' && hasCriticalTickets && (
                                                <span className="relative flex h-2 w-2">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
                                                </span>
                                            )}
                                        </NavLink>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </nav>

            {/* Profile Footer */}
            <div className="p-4 bg-[#1d1b31] border-t border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 px-2">
                    <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary">
                        <UserIcon className="w-6 h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate text-white">{userEmail?.split('@')[0]}</p>
                        <p className="text-[10px] text-gray-500 uppercase">{isAdmin ? 'Admin' : 'Agente'}</p>
                    </div>
                    <button onClick={handleLogout} className="p-2 text-gray-400 hover:text-white"><LogOut size={16} /></button>
                </div>
                <button onClick={toggleTheme} className="w-full flex items-center gap-3 px-4 py-2 rounded-xl text-xs font-bold text-gray-400 hover:bg-white/5 hover:text-white transition-all group">
                    {theme === 'light' ? <Moon size={14} className="group-hover:rotate-12 transition-transform" /> : <Sun size={14} className="group-hover:rotate-45 transition-transform" />}
                    <span>{theme === 'light' ? 'Mesa de Noche' : 'Luz de Día'}</span>
                </button>
                {import.meta.env.VITE_JAM_RECORDING_LINK_ID && (
                    <button
                        onClick={() => window.open(getRecordingLinkUrl(), '_blank')}
                        className="w-full flex items-center gap-3 px-4 py-2 rounded-xl text-xs font-bold text-gray-400 hover:bg-white/5 hover:text-red-400 transition-all group"
                    >
                        <Bug size={14} className="group-hover:scale-110 transition-transform" />
                        <span>Reportar Bug</span>
                    </button>
                )}
            </div>
        </div>
    );
}

export function Layout() {
    const navigate = useNavigate();
    const location = useLocation();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('theme');
            if (saved === 'dark' || saved === 'light') return saved;
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        return 'light';
    });

    const [isAdmin, setIsAdmin] = useState(false);
    const [userEmail, setUserEmail] = useState<string | null>(null);
    const [allowedMenus, setAllowedMenus] = useState<string[]>(["Dashboard"]);
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
        'Escalamiento': true,
        'Gestión Operativa': true,
        'Inventario': true,
        'Gestión Comercial': true,
        'Reportes': true,
        'Administración': false
    });

    // Global Search State
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<WispHubClient[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [hasCriticalTickets, setHasCriticalTickets] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [showNotifications, setShowNotifications] = useState(false);
    const notificationsRef = useRef<HTMLDivElement>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);

    useEffect(() => {
        const handleToast = (e: any) => {
            const { message, type, description, id, duration } = e.detail;
            const toastId = id || Math.random().toString(36).substr(2, 9);

            setToasts(prev => {
                // If ID exists, update it. If not, add new.
                const exists = prev.find(t => t.id === toastId);
                if (exists) {
                    return prev.map(t => t.id === toastId ? { ...t, message, type, description } : t);
                }
                return [...prev, { id: toastId, message, type, description }];
            });

            if (type !== 'loading' && duration !== 0) {
                setTimeout(() => {
                    setToasts(prev => prev.filter(t => t.id !== toastId));
                }, duration || 4000);
            }
        };

        window.addEventListener('app:toast' as any, handleToast);
        return () => window.removeEventListener('app:toast' as any, handleToast);
    }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
                setShowNotifications(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (userEmail) {
            loadNotifications();
            let subscription: any;

            supabase.auth.getSession().then(({ data: { session } }) => {
                if (session?.user) {
                    // TODO: Re-enable Realtime when server supports WSS (WebSocket)
                    // Currently disabled to prevent console errors on VPS deployment without WSS support.
                    /*
                    subscription = NotificationService.subscribeToNotifications(session.user.id, (newNotif) => {
                        setNotifications(prev => [newNotif, ...prev]);
                    });
                    */
                }
            });

            return () => {
                if (subscription?.unsubscribe) subscription.unsubscribe();
            };
        }
    }, [userEmail]);

    const loadNotifications = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            const data = await NotificationService.getNotifications(user.id);
            setNotifications(data);
        }
    };

    const handleMarkAsRead = async (id: string) => {
        await NotificationService.markAsRead(id);
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    };

    const handleMarkAllRead = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await NotificationService.markAllAsRead(user.id);
            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        }
    };

    useEffect(() => {
        checkCriticalTickets();
        const interval = setInterval(checkCriticalTickets, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, []);

    const checkCriticalTickets = async () => {
        try {
            const tickets = await WisphubCache.getAll();

            const critical = tickets.filter((t: any) =>
                t.sla_status === 'critico' &&
                (Number(t.id_estado) === 1 || Number(t.id_estado) === 2 || Number(t.id_estado) === 5)
            );

            setHasCriticalTickets(critical.length > 0);

            // Generar notificaciones para tickets críticos si no existen
            if (critical.length > 0) {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    for (const ticket of critical) {
                        const title = `🚨 SLA CRÍTICO: ${ticket.asunto} (#${ticket.id})`;
                        const message = `El ticket del cliente ${ticket.nombre_cliente} ha excedido el tiempo permitido.\n\nTécnico: ${ticket.nombre_tecnico || 'Sin asignar'}\nEstado: ${ticket.nombre_estado}`;

                        // Verificar si ya existe una notificación reciente para este ticket
                        const alreadyNotified = notifications.some(n => n.title.includes(ticket.id.toString()));

                        if (!alreadyNotified) {
                            await NotificationService.createNotification({
                                user_id: user.id,
                                title,
                                message,
                                type: 'sla_warning',
                                link: '/operaciones/trazabilidad'
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error checking critical tickets:", error);
        }
    };

    useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove('light', 'dark');
        root.classList.add(theme);
        localStorage.setItem('theme', theme);
    }, [theme]);

    useEffect(() => {
        checkUser();
    }, []);

    const checkUser = async () => {
        try {
            const { data: { user }, error } = await safeGetUser();
            if (error) throw error;
            if (user) {
                setUserEmail(user.email || null);
                if (user.user_metadata?.role === 'admin') {
                    setIsAdmin(true);
                }

                // Load Menu Permissions from Profile
                const { data: profile, error: profileError } = await supabase
                    .from('profiles')
                    .select('allowed_menus')
                    .eq('id', user.id)
                    .maybeSingle();

                if (profileError) {
                    if (profileError.message?.includes('aborted')) return;
                    throw profileError;
                }

                if (profile?.allowed_menus) {
                    setAllowedMenus(profile.allowed_menus);
                }
                setProfileLoaded(true);
            }
        } catch (e) {
            console.error('[Layout:Auth] ❌ Error en checkUser:', e);
        }
    };

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    const toggleGroup = (title: string) => {
        setExpandedGroups(prev => ({
            ...prev,
            [title]: !prev[title]
        }));
    };

    // Close mobile menu on route change
    useEffect(() => {
        setMobileMenuOpen(false);
    }, [location.pathname]);

    const handleLogout = async () => {
        (window as any).__isIntentionalLogout = true;
        await supabase.auth.signOut();
        navigate('/login');
    };

    const handleGlobalSearch = async (query: string) => {
        setSearchQuery(query);
        if (query.length < 3) {
            setSearchResults([]);
            setShowResults(false);
            return;
        }

        setIsSearching(true);
        setShowResults(true);
        try {
            const results = await WisphubService.searchClients(query);
            setSearchResults(results);
        } catch (error) {
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const handleSelectClient = (client: WispHubClient) => {
        setSearchQuery('');
        setShowResults(false);
        navigate('/gestion', { state: { selectedClient: client } });
    };

    const navGroups = NAV_GROUPS.map(group => ({
        ...group,
        items: group.items.filter(item => {
            // Si es admin total, ve todo lo que no sea adminOnly (que se filtra abajo)
            // o si el grupo/ítem está explícitamente permitido
            if (isAdmin) return true;

            // Verificamos si el título del grupo o la etiqueta del ítem están permitidos
            // Esto mantiene compatibilidad con el sistema actual basado en nombres
            return allowedMenus.includes(group.title) || allowedMenus.includes(item.label);
        })
    })).filter(group => {
        // Regla de oro: Si es solo admin y no eres admin, fuera.
        if (group.adminOnly && !isAdmin) return false;
        // Si el grupo se quedó sin ítems permitidos, no lo mostramos.
        return group.items.length > 0;
    });

    // Regla de Protección: Redirección si la ruta no está permitida
    useEffect(() => {
        if (!profileLoaded) return; // Esperar a que el perfil cargue

        const currentPath = location.pathname;
        if (currentPath === '/' || currentPath === '/login' || isAdmin) return;

        const allAllowedPaths = navGroups.flatMap((g: any) => g.items.map((i: any) => i.to));

        // Verificación flexible (por ejemplo, permitir sub-rutas de Inventario si el módulo está activo)
        const isAllowed = allAllowedPaths.some((path: string) =>
            currentPath === path || currentPath.startsWith(path + '/')
        );

        if (!isAllowed) {
            console.warn(`Acceso denegado a ${currentPath}. Redirigiendo...`);
            navigate('/');
        }
    }, [location.pathname, navGroups, isAdmin, profileLoaded]);


    return (
        <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans">
            {/* Desktop Sidebar - Hidden on mobile, visible on lg */}
            <aside className="hidden lg:flex w-64 border-r border-border bg-[#11101d] flex-col shrink-0">
                <SidebarContent
                    navGroups={navGroups}
                    expandedGroups={expandedGroups}
                    toggleGroup={toggleGroup}
                    location={location}
                    isAdmin={isAdmin}
                    userEmail={userEmail}
                    handleLogout={handleLogout}
                    toggleTheme={toggleTheme}
                    theme={theme}
                    hasCriticalTickets={hasCriticalTickets}
                />
            </aside>

            {/* Mobile Header - Visible only on mobile */}
            <div className="lg:hidden fixed top-0 left-0 right-0 h-16 border-b border-border bg-[#11101d] text-white flex items-center justify-between px-4 z-40">
                <div className="flex items-center">
                    <img
                        src="/logo-white.png"
                        alt="RapiLink SAS"
                        className="h-8 w-auto object-contain"
                    />
                </div>
                <button
                    onClick={() => setMobileMenuOpen(true)}
                    className="p-2 hover:bg-muted rounded-md"
                >
                    <Menu className="w-6 h-6" />
                </button>
            </div>

            {/* Desktop Header / Top Bar */}
            <div className="hidden lg:flex fixed top-0 left-64 right-0 h-16 bg-card/80 backdrop-blur-md border-b border-border items-center px-8 z-30 justify-between">
                <div className="flex-1 max-w-md">
                    {location.pathname === '/gestion' && (
                        <div className="relative w-full group">
                            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors">
                                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <SearchIcon className="w-4 h-4" />}
                            </div>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => handleGlobalSearch(e.target.value)}
                                onFocus={() => searchQuery.length >= 3 && setShowResults(true)}
                                placeholder="Buscar cliente por nombre o cédula..."
                                className="w-full bg-muted/50 border border-border rounded-xl py-2 pl-10 pr-4 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                            />

                            {showResults && (
                                <div className="absolute top-full left-0 right-0 mt-2 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                                    {searchResults.length > 0 ? (
                                        <div className="max-h-80 overflow-y-auto custom-scrollbar">
                                            {searchResults.map((client) => (
                                                <button
                                                    key={client.id_servicio}
                                                    onClick={() => handleSelectClient(client)}
                                                    className="w-full flex items-center gap-4 p-4 hover:bg-primary/[0.04] transition-colors border-b border-border last:border-0 text-left"
                                                >
                                                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                                        <UserPlus size={18} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-black uppercase truncate">{client.nombre}</p>
                                                        <p className="text-[10px] text-muted-foreground font-bold">C.C. {client.cedula} • ID: {client.id_servicio}</p>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    ) : !isSearching && (
                                        <div className="p-8 text-center">
                                            <p className="text-xs font-bold text-muted-foreground">No se encontraron clientes para tu búsqueda.</p>
                                        </div>
                                    )}

                                    {searchQuery.length >= 3 && (
                                        <div className="p-3 bg-muted/50 border-t border-border flex justify-center">
                                            <button
                                                onClick={() => setShowResults(false)}
                                                className="text-[9px] font-black uppercase text-muted-foreground hover:text-primary transition-colors"
                                            >
                                                Cerrar resultados
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-4">
                    {/* Notification Bell */}
                    <div className="relative" ref={notificationsRef}>
                        <button
                            onClick={() => setShowNotifications(!showNotifications)}
                            className="p-2 hover:bg-muted rounded-xl transition-colors relative group"
                        >
                            <Bell className={clsx(
                                "w-5 h-5 transition-transform group-hover:rotate-12",
                                notifications.some(n => !n.is_read) ? "text-primary" : "text-muted-foreground"
                            )} />
                            {notifications.some(n => !n.is_read) && (
                                <span className="absolute top-2 right-2 flex h-2.5 w-2.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                                </span>
                            )}
                        </button>

                        {showNotifications && (
                            <div className="absolute top-full right-0 mt-2 w-80 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 z-50">
                                <div className="p-4 border-b border-border flex justify-between items-center bg-muted/30">
                                    <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                                        <Bell size={14} className="text-primary" /> Central de Alertas
                                    </h3>
                                    <button
                                        onClick={handleMarkAllRead}
                                        className="text-[9px] font-black uppercase text-primary hover:underline"
                                    >
                                        Marcar todo como leído
                                    </button>
                                </div>
                                <div className="max-h-96 overflow-y-auto custom-scrollbar">
                                    {notifications.length > 0 ? (
                                        notifications.map((n) => (
                                            <div
                                                key={n.id}
                                                onClick={() => {
                                                    handleMarkAsRead(n.id);
                                                    if (n.type === 'sla_warning') {
                                                        setSelectedNotification(n);
                                                    } else if (n.link) {
                                                        navigate(n.link);
                                                    }
                                                    setShowNotifications(false);
                                                }}
                                                className={clsx(
                                                    "p-4 border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted/30",
                                                    !n.is_read ? "bg-primary/[0.03] border-l-2 border-l-primary" : "opacity-80"
                                                )}
                                            >
                                                <div className="flex justify-between items-start mb-1">
                                                    <p className={clsx(
                                                        "text-xs font-bold leading-tight",
                                                        !n.is_read ? "text-foreground" : "text-muted-foreground"
                                                    )}>{n.title}</p>
                                                    <span className="text-[8px] font-bold text-muted-foreground whitespace-nowrap ml-2">
                                                        {formatDistanceToNow(new Date(n.created_at), { addSuffix: true, locale: es })}
                                                    </span>
                                                </div>
                                                <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{n.message}</p>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="p-12 text-center">
                                            <p className="text-xs font-bold text-muted-foreground">No tienes notificaciones pendientes.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="text-right hidden xl:block">
                        <p className="text-[10px] font-black text-muted-foreground uppercase leading-none mb-1">Usuario Actual</p>
                        <p className="text-xs font-black uppercase text-foreground">{userEmail?.split('@')[0]}</p>
                    </div>
                    <button
                        onClick={() => navigate('/configuracion')}
                        className="p-2 hover:bg-muted rounded-xl transition-colors group flex items-center gap-2"
                        title="Editar Perfil"
                    >
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors">
                            <UserIcon size={20} />
                        </div>
                        <div className="flex flex-col text-left">
                            <span className="text-[10px] font-black text-primary uppercase leading-tight">Perfil</span>
                            <span className="text-[9px] font-bold text-muted-foreground uppercase leading-tight">Configurar</span>
                        </div>
                    </button>
                </div>
            </div>

            {/* Mobile Sidebar Portal */}
            <MobileSidebar isOpen={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}>
                <SidebarContent
                    navGroups={navGroups}
                    expandedGroups={expandedGroups}
                    toggleGroup={toggleGroup}
                    location={location}
                    isAdmin={isAdmin}
                    userEmail={userEmail}
                    handleLogout={handleLogout}
                    toggleTheme={toggleTheme}
                    theme={theme}
                    hasCriticalTickets={hasCriticalTickets}
                />
            </MobileSidebar>

            {/* Main Content */}
            <main className="flex-1 overflow-auto bg-background relative w-full pt-16">
                <div className={clsx(
                    "mx-auto h-full",
                    location.pathname === '/operaciones/despacho' ? "max-w-none p-0" : "max-w-7xl p-4 md:p-8"
                )}>
                    <Outlet />
                </div>
            </main>

            {/* Global Toasts Tray */}
            <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 min-w-[320px] max-w-md pointer-events-none">
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        className={clsx(
                            "pointer-events-auto flex items-start gap-4 p-4 rounded-2xl shadow-2xl border backdrop-blur-xl animate-in slide-in-from-right-8 duration-300",
                            toast.type === 'success' ? "bg-emerald-600 border-emerald-500 text-white" :
                                toast.type === 'error' ? "bg-red-600 border-red-500 text-white" :
                                    toast.type === 'loading' ? "bg-indigo-600 border-indigo-500 text-white" :
                                        toast.type === 'warning' ? "bg-amber-500 border-amber-400 text-white" :
                                            "bg-slate-700 border-slate-600 text-white"
                        )}
                    >
                        <div className="shrink-0 mt-0.5">
                            {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-white" />}
                            {toast.type === 'error' && <AlertTriangle className="w-5 h-5 text-white" />}
                            {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-white" />}
                            {toast.type === 'info' && <Info className="w-5 h-5 text-white" />}
                            {toast.type === 'loading' && <Loader2 className="w-5 h-5 animate-spin text-white" />}
                        </div>
                        <div className="flex flex-col gap-1">
                            <p className="text-sm font-black leading-tight uppercase tracking-tight text-white">{toast.message}</p>
                            {toast.description && <p className="text-[11px] font-bold opacity-90 leading-snug text-white/90">{toast.description}</p>}
                        </div>
                    </div>
                ))}
            </div>

            {/* Notification Detail Modal */}
            {selectedNotification && (
                <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-300">
                    <div
                        className="bg-card w-full max-w-lg rounded-3xl border border-border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6 border-b border-border bg-muted/30 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-primary/10 rounded-xl text-primary">
                                    <Bell size={20} />
                                </div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-foreground">Detalle de Alerta</h3>
                            </div>
                            <button
                                onClick={() => setSelectedNotification(null)}
                                className="p-2 hover:bg-muted rounded-full transition-colors"
                            >
                                <ChevronDown className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-8 space-y-6">
                            <div className="space-y-2">
                                <span className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">Asunto</span>
                                <p className="text-xl font-black text-foreground leading-tight">
                                    {selectedNotification.title}
                                </p>
                            </div>

                            <div className="space-y-4 p-6 bg-muted/30 rounded-2xl border border-border/50">
                                <div className="flex items-start gap-4">
                                    <div className="p-2 bg-red-500/10 rounded-lg text-red-500 shrink-0">
                                        <ShieldAlert size={18} />
                                    </div>
                                    <div className="space-y-3 w-full">
                                        <div>
                                            <p className="text-xs font-bold text-muted-foreground uppercase">Descripción del Incidente</p>
                                            <p className="text-sm font-medium leading-relaxed text-foreground">
                                                {selectedNotification.message.split('\n\n')[0]}
                                            </p>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/10">
                                            <div>
                                                <p className="text-[10px] font-black text-muted-foreground uppercase opacity-70">Técnico</p>
                                                <p className="text-xs font-black text-foreground truncate">
                                                    {selectedNotification.message.match(/Técnico: (.*)/)?.[1] || 'Sin asignar'}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-black text-muted-foreground uppercase opacity-70">Estado</p>
                                                <p className="text-xs font-black text-primary truncate">
                                                    {selectedNotification.message.match(/Estado: (.*)/)?.[1] || 'Pendiente'}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-4 pt-4 border-t border-border/50">
                                    <div className="flex-1">
                                        <p className="text-[10px] font-black text-muted-foreground uppercase">Fecha de Alerta</p>
                                        <p className="text-xs font-bold">{new Date(selectedNotification.created_at).toLocaleString('es-ES', {
                                            day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
                                        })}</p>
                                    </div>
                                    <div className="px-3 py-1 bg-red-500/10 text-red-600 text-[10px] font-black rounded-full uppercase">
                                        Alta Prioridad
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <button
                                    onClick={() => setSelectedNotification(null)}
                                    className="px-6 py-4 bg-muted text-muted-foreground font-black rounded-2xl hover:bg-muted/80 transition-all text-xs uppercase"
                                >
                                    Cerrar
                                </button>
                                <button
                                    onClick={() => {
                                        if (selectedNotification.link) {
                                            // Extraer ID: busca (#ID), ID al final, o número de 5+ cifras
                                            const match = selectedNotification.title.match(/\(#?(\d+)\)/) ||
                                                selectedNotification.title.match(/#(\d+)/) ||
                                                selectedNotification.message.match(/#(\d+)/);

                                            const ticketId = match ? match[1] : '';
                                            navigate(selectedNotification.link, { state: { searchId: ticketId } });
                                        }
                                        setSelectedNotification(null);
                                    }}
                                    className="px-6 py-4 bg-primary text-primary-foreground font-black rounded-2xl hover:opacity-90 transition-all text-xs uppercase shadow-xl shadow-primary/20 flex items-center justify-center gap-2"
                                >
                                    Gestionar Ticket
                                    <LogOut className="w-4 h-4 rotate-180" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

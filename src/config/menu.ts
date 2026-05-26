import {
    LayoutDashboard,
    Kanban,
    FileText,
    Calendar,
    Phone,
    Settings,
    History,
    Megaphone,
    Shield,
    BarChart3,
    ClipboardList,
    ShieldAlert,
    Box,
    Package,
    Truck,
    LayoutGrid,
    Search as SearchIcon,
    Clock,
    Activity,
    Radio,
    Users
} from 'lucide-react';

export interface MenuItem {
    id: string;
    to: string;
    label: string;
    icon: any;
}

export interface NavGroup {
    title: string;
    icon: any;
    items: MenuItem[];
    adminOnly?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
    {
        title: 'Clientes',
        icon: Users,
        items: [
            { id: 'clients', to: '/clientes', icon: Users, label: 'Clientes' },
        ]
    },
    {
        title: 'Escalamiento',
        icon: Activity,
        items: [
            { id: 'my-tasks', to: '/operaciones/mis-tareas', icon: ClipboardList, label: 'Mis Tareas' },
            { id: 'supervision', to: '/operaciones/supervision', icon: ShieldAlert, label: 'Supervisión' },
        ]
    },
    {
        title: 'Gestión Operativa',
        icon: Shield,
        items: [
            { id: 'dispatch', to: '/operaciones/despacho', icon: Truck, label: 'Despacho Inteligente' },
            { id: 'productivity', to: '/operaciones/productividad', icon: BarChart3, label: 'Productividad' },
            { id: 'traceability', to: '/operaciones/trazabilidad', icon: Clock, label: 'Control de Trazabilidad' },
            { id: 'analytics', to: '/operaciones/tecnicos', icon: BarChart3, label: 'Analíticas Técnicas' },
        ]
    },
    {
        title: 'Gestión Comercial',
        icon: Megaphone,
        items: [
            { id: 'dashboard', to: '/', icon: LayoutDashboard, label: 'Dashboard' },
            { id: 'campaigns', to: '/campanas', icon: Megaphone, label: 'Gestor de Campañas' },
            { id: 'voice-ai', to: '/voice-ai', icon: Radio, label: 'Voice AI — Sofía' },
            { id: 'pipeline', to: '/pipeline', icon: Kanban, label: 'Pipeline' },
            { id: 'manual-mgmt', to: '/gestion', icon: Phone, label: 'Gestión Manual' },
            { id: 'history', to: '/historial', icon: History, label: 'Historial' },
        ]
    },
    {
        title: 'Inventario',
        icon: Box,
        items: [
            { id: 'inventory-dashboard', to: '/operaciones/inventario', icon: LayoutDashboard, label: 'Dashboard' },
            { id: 'inventory-stock', to: '/operaciones/inventario/stock', icon: Package, label: 'Existencias y Entradas' },
            { id: 'inventory-assignments', to: '/operaciones/inventario/asignaciones', icon: Truck, label: 'Entrega a Técnicos' },
            { id: 'inventory-catalog', to: '/operaciones/inventario/catalogo', icon: Box, label: 'Catálogo Maestro' },
            { id: 'inventory-scanner', to: '/operaciones/inventario/escaner', icon: SearchIcon, label: 'Consultar Serial' },
            { id: 'inventory-kits', to: '/operaciones/inventario/kits', icon: LayoutGrid, label: 'Kits / Plantillas' },
            { id: 'inventory-slips', to: '/operaciones/inventario/actas', icon: FileText, label: 'Actas / Entregas' },
            { id: 'inventory-movements', to: '/operaciones/inventario/movimientos', icon: History, label: 'Registro de Movimientos' },
            { id: 'inventory-analytics-consumption', to: '/operaciones/inventario/analiticas', icon: BarChart3, label: 'Analíticas de Consumo' },
        ]

    },
    {
        title: 'Reportes',
        icon: FileText,
        items: [
            { id: 'daily-reports', to: '/reportes/diario', icon: FileText, label: 'Reportes Diarios' },
            { id: 'weekly-reports', to: '/reportes/semanal', icon: Calendar, label: 'Reporte Semanal' },
        ]
    },
    {
        title: 'Administración',
        icon: Settings,
        adminOnly: true,
        items: [
            { id: 'config', to: '/configuracion', icon: Settings, label: 'Configuración' },
        ]
    }
];

import { Activity, RefreshCw } from 'lucide-react';
import React, { useState } from 'react';
import { WorkflowService } from '../../lib/workflowService';
import clsx from 'clsx';

interface OperationsHeaderProps {
    title: string;
    description: string;
    onSyncComplete?: () => void;
    customAction?: React.ReactNode;
}

export function OperationsHeader({ title, description, onSyncComplete, customAction }: OperationsHeaderProps) {
    const [isSyncing, setIsSyncing] = useState(false);

    const [syncMode, setSyncMode] = useState<'quick' | 'full' | null>(null);

    const handleQuickSync = async () => {
        if (isSyncing) return;
        setIsSyncing(true);
        setSyncMode('quick');
        try {
            await WorkflowService.radarSyncToday();
            if (onSyncComplete) onSyncComplete();
        } finally {
            setIsSyncing(false);
            setSyncMode(null);
        }
    };

    const handleFullSync = async () => {
        if (isSyncing) return;
        setIsSyncing(true);
        setSyncMode('full');
        try {
            await WorkflowService.fullMirrorResync();
            if (onSyncComplete) onSyncComplete();
        } finally {
            setIsSyncing(false);
            setSyncMode(null);
        }
    };

    return (
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8 border-b border-zinc-100 pb-6">
            <div className="flex flex-col gap-1 w-full md:w-auto">
                <h1 className="text-xl md:text-2xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
                    <Activity className="text-zinc-900" size={24} />
                    {title}
                </h1>
                <p className="text-zinc-500 text-[10px] md:text-sm font-medium ml-9">{description}</p>
            </div>
            <div className="flex flex-wrap gap-2 items-center ml-9 md:ml-0">
                {customAction}
                <button
                    onClick={handleQuickSync}
                    disabled={isSyncing}
                    className={clsx(
                        "px-4 py-2 rounded-xl font-bold text-[10px] uppercase tracking-wide flex items-center gap-2 transition-all border",
                        isSyncing ? "bg-zinc-100 text-zinc-400 border-zinc-200" : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 shadow-sm"
                    )}
                    title="Sincronización rápida: tickets creados hoy"
                >
                    <RefreshCw size={14} className={syncMode === 'quick' ? "animate-spin" : ""} />
                    {syncMode === 'quick' ? "Sincronizando..." : "Rápida (7d)"}
                </button>
                <button
                    onClick={handleFullSync}
                    disabled={isSyncing}
                    className={clsx(
                        "px-4 py-2 rounded-xl font-bold text-[10px] uppercase tracking-wide flex items-center gap-2 transition-all shadow-sm hover:shadow",
                        isSyncing ? "bg-zinc-100 text-zinc-400" : "bg-zinc-900 text-white hover:bg-black"
                    )}
                    title="Sincronización global: trae TODOS los tickets activos de WispHub sin importar fecha"
                >
                    <RefreshCw size={14} className={syncMode === 'full' ? "animate-spin" : ""} />
                    {syncMode === 'full' ? "Descargando..." : "Total (∞)"}
                </button>
            </div>
        </header>
    );
}

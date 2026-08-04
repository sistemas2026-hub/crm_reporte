import { useState, useEffect } from 'react';
import { Truck, Plus, X, Loader2, Lock, AlertTriangle, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { MttoService, type MttoVehiculo } from '../lib/mttoService';
import type { MttoTipoVehiculo } from '../types/database';
import { toast } from '../lib/mttoLabels';

/**
 * Administración de la flota: crear vehículos y editar su ficha.
 *
 * Los datos que quedaron en NULL a propósito en la semilla (placa, número de
 * motor, número de chasis, vencimientos de SOAT y tecnomecánica, responsable)
 * se cargan desde aquí. Solo el admin del módulo puede escribir; el RLS de
 * mtto_vehiculo lo garantiza del lado del servidor.
 */

const TIPO_LABEL: Record<MttoTipoVehiculo, string> = {
    motocarro: 'Motocarro',
    moto_trailer: 'Moto con tráiler',
};

const diasParaVencer = (fecha: string | null): number | null => {
    if (!fecha) return null;
    return Math.ceil((new Date(fecha).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
};

type FormState = {
    codigo: string;
    tipo: MttoTipoVehiculo;
    placa: string;
    marca: string;
    linea: string;
    anio: string;
    cilindraje: string;
    num_motor: string;
    num_chasis: string;
    soat_vence: string;
    tecno_vence: string;
    responsable_id: string;
    activo: boolean;
};

const vacio: FormState = {
    codigo: '', tipo: 'motocarro', placa: '', marca: '', linea: '', anio: '',
    cilindraje: '', num_motor: '', num_chasis: '', soat_vence: '', tecno_vence: '',
    responsable_id: '', activo: true,
};

const desdeVehiculo = (v: MttoVehiculo): FormState => ({
    codigo: v.codigo,
    tipo: v.tipo,
    placa: v.placa ?? '',
    marca: v.marca ?? '',
    linea: v.linea ?? '',
    anio: v.anio?.toString() ?? '',
    cilindraje: v.cilindraje?.toString() ?? '',
    num_motor: v.num_motor ?? '',
    num_chasis: v.num_chasis ?? '',
    soat_vence: v.soat_vence ?? '',
    tecno_vence: v.tecno_vence ?? '',
    responsable_id: v.responsable_id ?? '',
    activo: v.activo,
});

// Convierte '' a null para no guardar cadenas vacías donde debe haber NULL
const oNulo = (s: string) => (s.trim() === '' ? null : s.trim());

export function MaintenanceFleetAdmin() {
    const [loading, setLoading] = useState(true);
    const [vehiculos, setVehiculos] = useState<MttoVehiculo[]>([]);
    const [perfiles, setPerfiles] = useState<{ id: string; full_name: string | null }[]>([]);
    const [esAdmin, setEsAdmin] = useState(false);

    const [modalAbierto, setModalAbierto] = useState(false);
    const [editando, setEditando] = useState<MttoVehiculo | null>(null);
    const [form, setForm] = useState<FormState>(vacio);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState('');

    const cargar = async () => {
        setLoading(true);
        try {
            const [ctx, vs, ps] = await Promise.all([
                MttoService.getMiContexto(),
                MttoService.listVehiculos(false), // incluye inactivos
                MttoService.listPerfiles().catch(() => []),
            ]);
            setEsAdmin(ctx.esAdmin);
            setVehiculos(vs);
            setPerfiles(ps);
        } catch (e: any) {
            toast('Error al cargar la flota', 'error', e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, []);

    const abrirNuevo = () => {
        setEditando(null);
        setForm(vacio);
        setError('');
        setModalAbierto(true);
    };

    const abrirEdicion = (v: MttoVehiculo) => {
        setEditando(v);
        setForm(desdeVehiculo(v));
        setError('');
        setModalAbierto(true);
    };

    const guardar = async () => {
        if (!form.codigo.trim()) { setError('El código es obligatorio (ej: MC-01)'); return; }
        setGuardando(true);
        setError('');

        const payload = {
            codigo: form.codigo.trim().toUpperCase(),
            tipo: form.tipo,
            placa: oNulo(form.placa)?.toUpperCase() ?? null,
            marca: oNulo(form.marca),
            linea: oNulo(form.linea),
            anio: form.anio ? Number(form.anio) : null,
            cilindraje: form.cilindraje ? Number(form.cilindraje) : null,
            num_motor: oNulo(form.num_motor),
            num_chasis: oNulo(form.num_chasis),
            soat_vence: oNulo(form.soat_vence),
            tecno_vence: oNulo(form.tecno_vence),
            responsable_id: form.responsable_id || null,
            activo: form.activo,
        };

        try {
            if (editando) {
                await MttoService.updateVehiculo(editando.id, payload);
                toast('Vehículo actualizado', 'success');
            } else {
                await MttoService.createVehiculo(payload);
                toast('Vehículo creado', 'success');
            }
            setModalAbierto(false);
            cargar();
        } catch (e: any) {
            // El código es único por organización
            const msg = /duplicate key|unique/i.test(e.message || '')
                ? `Ya existe un vehículo con el código ${payload.codigo}`
                : e.message;
            setError(msg || 'No se pudo guardar');
        } finally {
            setGuardando(false);
        }
    };

    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

    if (loading) {
        return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando flota...</div>;
    }

    return (
        <div className="p-4 md:p-6 max-w-3xl mx-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
                        <Truck className="w-6 h-6 text-primary" /> Flota de Vehículos
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        {vehiculos.length} vehículo{vehiculos.length !== 1 ? 's' : ''} registrado{vehiculos.length !== 1 ? 's' : ''}
                    </p>
                </div>
                {esAdmin && (
                    <button onClick={abrirNuevo}
                        className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-3 rounded-xl font-semibold shadow-sm active:scale-95 transition-transform min-h-[44px]">
                        <Plus className="w-5 h-5" /> <span className="hidden sm:inline">Nuevo</span>
                    </button>
                )}
            </div>

            {!esAdmin && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
                    <Lock className="w-4 h-4 shrink-0" /> Solo lectura — se requiere rol de administrador del módulo para crear o editar vehículos.
                </div>
            )}

            <div className="space-y-2">
                {vehiculos.length === 0 && (
                    <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-xl">
                        <Truck className="w-10 h-10 mx-auto mb-2 opacity-40" />
                        No hay vehículos registrados.
                    </div>
                )}
                {vehiculos.map((v) => {
                    const dSoat = diasParaVencer(v.soat_vence);
                    const dTecno = diasParaVencer(v.tecno_vence);
                    const alerta = (dSoat !== null && dSoat <= 30) || (dTecno !== null && dTecno <= 30);
                    const responsable = perfiles.find((p) => p.id === v.responsable_id);
                    return (
                        <div key={v.id}
                            className={clsx('bg-card border rounded-xl p-4', alerta ? 'border-red-500/50' : 'border-border', !v.activo && 'opacity-60')}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-bold">{v.codigo}</span>
                                        <span className="text-xs text-muted-foreground">{TIPO_LABEL[v.tipo]}</span>
                                        {!v.activo && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-border text-muted-foreground">Inactivo</span>}
                                        {alerta && (
                                            <span className="text-[11px] font-bold text-red-600 dark:text-red-400 flex items-center gap-1">
                                                <AlertTriangle className="w-3 h-3" /> Vencimiento próximo
                                            </span>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-sm">
                                        <Dato label="Placa" value={v.placa} />
                                        <Dato label="Marca / línea" value={[v.marca, v.linea].filter(Boolean).join(' ') || null} />
                                        <Dato label="No. motor" value={v.num_motor} />
                                        <Dato label="No. chasis" value={v.num_chasis} />
                                        <Dato label="SOAT vence" value={v.soat_vence ? new Date(v.soat_vence).toLocaleDateString('es-CO') : null} alerta={dSoat !== null && dSoat <= 30} />
                                        <Dato label="Tecnomecánica" value={v.tecno_vence ? new Date(v.tecno_vence).toLocaleDateString('es-CO') : null} alerta={dTecno !== null && dTecno <= 30} />
                                        <Dato label="Responsable" value={responsable?.full_name ?? null} />
                                        <Dato label="Año / cilindraje" value={[v.anio, v.cilindraje ? `${v.cilindraje}cc` : null].filter(Boolean).join(' · ') || null} />
                                    </div>
                                </div>
                                {esAdmin && (
                                    <button onClick={() => abrirEdicion(v)}
                                        className="p-2.5 text-muted-foreground hover:text-primary min-h-[44px] min-w-[44px] shrink-0" title="Editar ficha">
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {modalAbierto && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => !guardando && setModalAbierto(false)} />
                    <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="font-bold text-lg">{editando ? `Editar ${editando.codigo}` : 'Nuevo vehículo'}</h3>
                            <button onClick={() => setModalAbierto(false)} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <Campo label="Código *">
                                    <input value={form.codigo} onChange={(e) => set('codigo', e.target.value)}
                                        placeholder="MC-01" className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                                <Campo label="Tipo *">
                                    <select value={form.tipo} onChange={(e) => set('tipo', e.target.value as MttoTipoVehiculo)}
                                        className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]">
                                        <option value="motocarro">Motocarro</option>
                                        <option value="moto_trailer">Moto con tráiler</option>
                                    </select>
                                </Campo>
                            </div>

                            <Campo label="Placa">
                                <input value={form.placa} onChange={(e) => set('placa', e.target.value)}
                                    placeholder="ABC12D" className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] uppercase" />
                            </Campo>

                            <div className="grid grid-cols-2 gap-3">
                                <Campo label="Marca">
                                    <input value={form.marca} onChange={(e) => set('marca', e.target.value)}
                                        className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                                <Campo label="Línea">
                                    <input value={form.linea} onChange={(e) => set('linea', e.target.value)}
                                        className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                                <Campo label="Año">
                                    <input type="number" value={form.anio} onChange={(e) => set('anio', e.target.value)}
                                        placeholder="2023" className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                                <Campo label="Cilindraje (cc)">
                                    <input type="number" value={form.cilindraje} onChange={(e) => set('cilindraje', e.target.value)}
                                        placeholder="200" className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                            </div>

                            <Campo label="Número de motor">
                                <input value={form.num_motor} onChange={(e) => set('num_motor', e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                            </Campo>
                            <Campo label="Número de chasis">
                                <input value={form.num_chasis} onChange={(e) => set('num_chasis', e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                            </Campo>

                            <div className="grid grid-cols-2 gap-3">
                                <Campo label="SOAT vence">
                                    <input type="date" value={form.soat_vence} onChange={(e) => set('soat_vence', e.target.value)}
                                        className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                                <Campo label="Tecnomecánica vence">
                                    <input type="date" value={form.tecno_vence} onChange={(e) => set('tecno_vence', e.target.value)}
                                        className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                                </Campo>
                            </div>

                            <Campo label="Responsable">
                                <select value={form.responsable_id} onChange={(e) => set('responsable_id', e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]">
                                    <option value="">Sin asignar</option>
                                    {perfiles.map((p) => (
                                        <option key={p.id} value={p.id}>{p.full_name || p.id}</option>
                                    ))}
                                </select>
                            </Campo>

                            <label className="flex items-center gap-2 text-sm min-h-[44px]">
                                <input type="checkbox" checked={form.activo} onChange={(e) => set('activo', e.target.checked)} className="w-5 h-5" />
                                Vehículo activo (aparece al crear órdenes)
                            </label>

                            {error && <p className="text-sm text-destructive">{error}</p>}
                        </div>

                        <div className="p-4 border-t border-border">
                            <button onClick={guardar} disabled={guardando}
                                className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                                {guardando && <Loader2 className="w-4 h-4 animate-spin" />}
                                {editando ? 'Guardar cambios' : 'Crear vehículo'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function Dato({ label, value, alerta }: { label: string; value: string | null; alerta?: boolean }) {
    return (
        <div>
            <span className="text-xs text-muted-foreground">{label}: </span>
            <span className={clsx('font-medium', !value && 'text-muted-foreground italic', alerta && 'text-red-600 dark:text-red-400 font-bold')}>
                {value || 'Sin dato'}
            </span>
        </div>
    );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="text-sm font-medium block mb-1">{label}</label>
            {children}
        </div>
    );
}

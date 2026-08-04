import { useState, useEffect } from 'react';
import { Users, Plus, X, Loader2, Lock, KeyRound, Pencil, ShieldAlert, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { MttoService, type MttoFirmante } from '../lib/mttoService';
import type { MttoRol } from '../types/database';
import { toast } from '../lib/mttoLabels';

/**
 * Personal de mantenimiento: personas que pueden revisar y aprobar órdenes
 * SIN tener cuenta de la plataforma. Se identifican con un PIN propio.
 *
 * El PIN inicial lo asigna el administrador, así que hasta que la persona lo
 * cambie (desde la pantalla de firma), quien lo creó podría firmar en su
 * nombre. La lista lo marca de forma visible para que no pase desapercibido.
 */

const ROL_LABEL: Record<MttoRol, string> = {
    mecanico: 'Mecánico',
    encargado: 'Encargado de flota',
    aprobador: 'Aprobador',
    admin: 'Administrador del módulo',
};

export function MaintenanceSignersAdmin() {
    const [loading, setLoading] = useState(true);
    const [firmantes, setFirmantes] = useState<MttoFirmante[]>([]);
    const [esAdmin, setEsAdmin] = useState(false);

    const [modalAbierto, setModalAbierto] = useState(false);
    const [editando, setEditando] = useState<MttoFirmante | null>(null);
    const [nombre, setNombre] = useState('');
    const [documento, setDocumento] = useState('');
    const [cargo, setCargo] = useState('');
    const [rol, setRol] = useState<MttoRol>('encargado');
    const [activo, setActivo] = useState(true);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState('');

    const [modalPin, setModalPin] = useState<MttoFirmante | null>(null);
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [guardandoPin, setGuardandoPin] = useState(false);

    const cargar = async () => {
        setLoading(true);
        try {
            const [ctx, fs] = await Promise.all([
                MttoService.getMiContexto(),
                MttoService.listFirmantes(),
            ]);
            setEsAdmin(ctx.esAdmin);
            setFirmantes(fs);
        } catch (e: any) {
            toast('Error al cargar el personal', 'error', e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, []);

    const abrirNuevo = () => {
        setEditando(null);
        setNombre(''); setDocumento(''); setCargo(''); setRol('encargado'); setActivo(true);
        setError('');
        setModalAbierto(true);
    };

    const abrirEdicion = (f: MttoFirmante) => {
        setEditando(f);
        setNombre(f.nombre);
        setDocumento(f.documento ?? '');
        setCargo(f.cargo ?? '');
        setRol(f.rol);
        setActivo(f.activo);
        setError('');
        setModalAbierto(true);
    };

    const guardar = async () => {
        if (!nombre.trim()) { setError('El nombre es obligatorio'); return; }
        setGuardando(true);
        setError('');
        const payload = {
            nombre: nombre.trim(),
            documento: documento.trim() || null,
            cargo: cargo.trim() || null,
            rol,
            activo,
        };
        try {
            if (editando) {
                await MttoService.actualizarFirmante(editando.id, payload);
                toast('Personal actualizado', 'success');
            } else {
                const creado = await MttoService.crearFirmante(payload);
                toast('Persona registrada', 'success', 'Ahora asígnele un PIN para que pueda firmar.');
                setModalAbierto(false);
                await cargar();
                setModalPin(creado);
                setPin(''); setPinConfirm('');
                setGuardando(false);
                return;
            }
            setModalAbierto(false);
            cargar();
        } catch (e: any) {
            setError(e.message || 'No se pudo guardar');
        } finally {
            setGuardando(false);
        }
    };

    const guardarPin = async () => {
        if (!modalPin) return;
        if (!/^\d{4,6}$/.test(pin)) { toast('El PIN debe tener entre 4 y 6 dígitos', 'error'); return; }
        if (pin !== pinConfirm) { toast('Los PIN no coinciden', 'error'); return; }
        setGuardandoPin(true);
        try {
            await MttoService.asignarPinFirmante(modalPin.id, pin);
            toast('PIN asignado', 'success', `Entrégueselo a ${modalPin.nombre} y pídale que lo cambie al firmar.`);
            setModalPin(null);
            setPin(''); setPinConfirm('');
            cargar();
        } catch (e: any) {
            toast('No se pudo asignar el PIN', 'error', e.message);
        } finally {
            setGuardandoPin(false);
        }
    };

    if (loading) {
        return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando personal...</div>;
    }

    // Esta pantalla asigna los PIN de firma, así que no se muestra en modo
    // solo lectura: quien no sea administrador del módulo no ve ni la lista
    // de personas ni el estado de sus PIN. Entrar por URL directa tampoco
    // sirve. La escritura, además, está bloqueada por RLS del lado del
    // servidor, así que esto es defensa en profundidad, no la única barrera.
    if (!esAdmin) {
        return (
            <div className="p-6 max-w-md mx-auto text-center py-24">
                <Lock className="w-12 h-12 mx-auto mb-3 text-muted-foreground" />
                <h1 className="font-bold text-lg mb-1">Acceso restringido</h1>
                <p className="text-sm text-muted-foreground">
                    Solo un administrador del módulo de mantenimiento puede ver y asignar
                    los PIN de firma. Si necesita acceso, pídaselo a un administrador.
                </p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-6 max-w-3xl mx-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
                        <Users className="w-6 h-6 text-primary" /> Personal de Mantenimiento
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Personas que firman con PIN, sin cuenta de la plataforma
                    </p>
                </div>
                {esAdmin && (
                    <button onClick={abrirNuevo}
                        className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-3 rounded-xl font-semibold shadow-sm active:scale-95 transition-transform min-h-[44px]">
                        <Plus className="w-5 h-5" /> <span className="hidden sm:inline">Nueva persona</span>
                    </button>
                )}
            </div>

            <div className="mb-4 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2 leading-relaxed">
                Estas personas <strong>no pueden iniciar sesión</strong>: solo firman revisiones y aprobaciones
                con su PIN, desde el celular del mecánico. Quien tenga cuenta propia no necesita estar aquí —
                ese caso se maneja con su rol en el módulo.
            </div>

            <div className="space-y-2">
                {firmantes.length === 0 && (
                    <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-xl">
                        <Users className="w-10 h-10 mx-auto mb-2 opacity-40" />
                        Todavía no hay personal registrado.
                    </div>
                )}
                {firmantes.map((f) => (
                    <div key={f.id} className={clsx('bg-card border border-border rounded-xl p-4', !f.activo && 'opacity-60')}>
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold">{f.nombre}</span>
                                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-border text-muted-foreground">
                                        {ROL_LABEL[f.rol]}
                                    </span>
                                    {!f.activo && <span className="text-[11px] text-muted-foreground">Inactivo</span>}
                                </div>
                                <div className="text-sm text-muted-foreground mt-0.5">
                                    {f.documento ? `C.C. ${f.documento}` : 'Sin documento'}
                                    {f.cargo ? ` · ${f.cargo}` : ''}
                                </div>

                                <div className="mt-2 text-xs">
                                    {!f.tiene_pin ? (
                                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold">
                                            <ShieldAlert className="w-3.5 h-3.5" /> Sin PIN — no puede firmar todavía
                                        </span>
                                    ) : f.pin_definido_por_admin ? (
                                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                            <ShieldAlert className="w-3.5 h-3.5" /> PIN asignado por el administrador — pendiente que la persona lo cambie
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                            <ShieldCheck className="w-3.5 h-3.5" /> PIN cambiado por la persona — solo ella lo conoce
                                        </span>
                                    )}
                                </div>
                            </div>

                            {esAdmin && (
                                <div className="flex flex-col gap-1 shrink-0">
                                    <button onClick={() => abrirEdicion(f)} title="Editar datos"
                                        className="p-2.5 text-muted-foreground hover:text-primary min-h-[44px] min-w-[44px]">
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                    <button onClick={() => { setModalPin(f); setPin(''); setPinConfirm(''); }}
                                        title={f.tiene_pin ? 'Restablecer PIN' : 'Asignar PIN'}
                                        className="p-2.5 text-muted-foreground hover:text-primary min-h-[44px] min-w-[44px]">
                                        <KeyRound className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Alta / edición */}
            {modalAbierto && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => !guardando && setModalAbierto(false)} />
                    <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="font-bold text-lg">{editando ? 'Editar persona' : 'Nueva persona'}</h3>
                            <button onClick={() => setModalAbierto(false)} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div>
                                <label className="text-sm font-medium block mb-1">Nombre completo *</label>
                                <input value={nombre} onChange={(e) => setNombre(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Documento</label>
                                <input value={documento} onChange={(e) => setDocumento(e.target.value)}
                                    placeholder="Cédula" className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Cargo</label>
                                <input value={cargo} onChange={(e) => setCargo(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Rol en el módulo *</label>
                                <select value={rol} onChange={(e) => setRol(e.target.value as MttoRol)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]">
                                    <option value="encargado">Encargado de flota (revisa)</option>
                                    <option value="aprobador">Aprobador (autoriza el gasto)</option>
                                    <option value="admin">Administrador del módulo</option>
                                    <option value="mecanico">Mecánico</option>
                                </select>
                                <p className="text-xs text-muted-foreground mt-1">
                                    El rol define qué paso puede firmar. Un mecánico sin cuenta no puede crear
                                    órdenes; para eso sí se necesita usuario de la plataforma.
                                </p>
                            </div>
                            <label className="flex items-center gap-2 text-sm min-h-[44px]">
                                <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} className="w-5 h-5" />
                                Activo (puede firmar)
                            </label>
                            {error && <p className="text-sm text-destructive">{error}</p>}
                        </div>
                        <div className="p-4 border-t border-border">
                            <button onClick={guardar} disabled={guardando}
                                className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                                {guardando && <Loader2 className="w-4 h-4 animate-spin" />}
                                {editando ? 'Guardar cambios' : 'Registrar y asignar PIN'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Asignar / restablecer PIN */}
            {modalPin && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => !guardandoPin && setModalPin(null)} />
                    <div className="relative w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="font-bold text-lg flex items-center gap-2"><KeyRound className="w-5 h-5" /> PIN de {modalPin.nombre}</h3>
                            <button onClick={() => setModalPin(null)} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Entréguele este PIN en persona y pídale que lo cambie la primera vez que firme.
                                Mientras usted lo conozca, podría firmarse en su nombre.
                            </p>
                            <div>
                                <label className="text-sm font-medium block mb-1">PIN (4 a 6 dígitos)</label>
                                <input type="password" inputMode="numeric" maxLength={6} value={pin}
                                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] tracking-widest text-center text-lg" />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Confirmar PIN</label>
                                <input type="password" inputMode="numeric" maxLength={6} value={pinConfirm}
                                    onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] tracking-widest text-center text-lg" />
                            </div>
                        </div>
                        <div className="p-4 border-t border-border">
                            <button onClick={guardarPin} disabled={guardandoPin}
                                className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                                {guardandoPin && <Loader2 className="w-4 h-4 animate-spin" />}
                                Asignar PIN
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, Loader2, Search, DollarSign, Lock, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import { MttoService, type CatalogoSistemaConArreglos } from '../lib/mttoService';
import { toast } from '../lib/mttoLabels';

/**
 * Pantalla de administración del catálogo de arreglos: los precios de
 * referencia se sembraron en NULL a propósito — aquí es donde el
 * admin del módulo los carga con sus valores reales. Solo admin
 * (profiles.role='admin' o mtto_usuario_rol.rol='admin') puede
 * guardar cambios; el RLS de mtto_catalogo_arreglo lo garantiza.
 */
export function MaintenanceCatalogAdmin() {
    const [loading, setLoading] = useState(true);
    const [catalogo, setCatalogo] = useState<CatalogoSistemaConArreglos[]>([]);
    const [busqueda, setBusqueda] = useState('');
    const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
    const [esAdmin, setEsAdmin] = useState(false);
    const [formNuevoSistema, setFormNuevoSistema] = useState(false);
    const [nombreNuevoSistema, setNombreNuevoSistema] = useState('');
    const [guardandoSistema, setGuardandoSistema] = useState(false);

    const cargar = async () => {
        setLoading(true);
        try {
            const [ctx, cat] = await Promise.all([MttoService.getMiContexto(), MttoService.getCatalogo()]);
            setEsAdmin(ctx.esAdmin);
            setCatalogo(cat);
        } catch (e: any) {
            toast('Error al cargar el catálogo', 'error', e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, []);

    const grupos = useMemo(() => {
        const q = busqueda.trim().toLowerCase();
        return catalogo
            .map((s) => ({ ...s, arreglos: s.arreglos.filter((a) => !q || a.nombre.toLowerCase().includes(q)) }))
            .filter((s) => s.arreglos.length > 0);
    }, [catalogo, busqueda]);

    const sinPrecio = catalogo.reduce((acc, s) => acc + s.arreglos.filter((a) => a.precio_repuesto_ref === null && a.precio_mo_ref === null).length, 0);

    const toggle = (id: string) => setAbiertos((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const crearSistema = async () => {
        if (!nombreNuevoSistema.trim()) return;
        setGuardandoSistema(true);
        try {
            await MttoService.crearSistema({ nombre: nombreNuevoSistema.trim(), orden: catalogo.length + 1 });
            toast('Sistema creado', 'success');
            setNombreNuevoSistema('');
            setFormNuevoSistema(false);
            cargar();
        } catch (e: any) {
            toast('No se pudo crear el sistema', 'error', e.message);
        } finally {
            setGuardandoSistema(false);
        }
    };

    if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando catálogo...</div>;

    return (
        <div className="p-4 md:p-6 max-w-3xl mx-auto">
            <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2 mb-1">
                <DollarSign className="w-6 h-6 text-primary" /> Catálogo de Arreglos — Precios de Referencia
            </h1>
            <p className="text-sm text-muted-foreground mb-4">
                {sinPrecio > 0 ? `${sinPrecio} arreglo(s) todavía sin precio cargado.` : 'Todos los arreglos tienen precio de referencia.'}
            </p>

            <div className="mb-4 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2 leading-relaxed">
                <strong>Vida útil:</strong> cuánto dura el repuesto que se instala, en kilómetros y/o
                meses. Al cerrar una orden, el sistema anota qué se cambió y avisa cuando toque
                reemplazarlo. Déjelo vacío en lo que no es cambio de pieza (diagnósticos, soldaduras).
            </div>

            {!esAdmin && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
                    <Lock className="w-4 h-4 shrink-0" /> Solo lectura — se requiere rol de administrador del módulo para editar precios.
                </div>
            )}

            <div className="flex gap-2 mb-4">
                <div className="relative flex-1">
                    <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                        value={busqueda}
                        onChange={(e) => setBusqueda(e.target.value)}
                        placeholder="Buscar arreglo..."
                        className="w-full border border-border rounded-lg pl-9 pr-3 py-2.5 bg-card min-h-[44px]"
                    />
                </div>
                {esAdmin && (
                    <button
                        onClick={() => setFormNuevoSistema((v) => !v)}
                        className="flex items-center gap-1.5 bg-muted text-foreground px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px] whitespace-nowrap"
                    >
                        <Plus className="w-4 h-4" /> Sistema
                    </button>
                )}
            </div>

            {formNuevoSistema && (
                <div className="mb-4 bg-card border border-border rounded-xl p-3 flex items-center gap-2">
                    <input
                        autoFocus
                        value={nombreNuevoSistema}
                        onChange={(e) => setNombreNuevoSistema(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && crearSistema()}
                        placeholder="Nombre del nuevo sistema (ej: Frenos)"
                        className="flex-1 border border-border rounded-lg px-3 py-2 bg-background text-sm min-h-[44px]"
                    />
                    <button onClick={crearSistema} disabled={guardandoSistema || !nombreNuevoSistema.trim()}
                        className="bg-primary text-primary-foreground px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px] disabled:opacity-60">
                        {guardandoSistema ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Crear'}
                    </button>
                    <button onClick={() => setFormNuevoSistema(false)} className="p-2.5 min-h-[44px] min-w-[44px]"><X className="w-4 h-4" /></button>
                </div>
            )}

            <div className="space-y-2">
                {grupos.map((sistema) => (
                    <div key={sistema.id} className="bg-card border border-border rounded-xl overflow-hidden">
                        <button onClick={() => toggle(sistema.id)} className="w-full flex items-center justify-between p-3 min-h-[44px]">
                            <span className="font-semibold text-sm">{sistema.nombre}</span>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">{sistema.arreglos.length} arreglo(s)</span>
                                <ChevronDown className={clsx('w-4 h-4 transition-transform', (abiertos.has(sistema.id) || busqueda) && 'rotate-180')} />
                            </div>
                        </button>
                        {(abiertos.has(sistema.id) || !!busqueda) && (
                            <div className="border-t border-border divide-y divide-border">
                                {sistema.arreglos.map((a) => (
                                    <ArregloRow key={a.id} arreglo={a} puedeEditar={esAdmin} onGuardado={cargar} />
                                ))}
                                {esAdmin && <NuevoArregloRow sistemaId={sistema.id} onCreado={cargar} />}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function NuevoArregloRow({ sistemaId, onCreado }: { sistemaId: string; onCreado: () => void }) {
    const [abierto, setAbierto] = useState(false);
    const [nombre, setNombre] = useState('');
    const [precioRepuesto, setPrecioRepuesto] = useState('');
    const [precioMo, setPrecioMo] = useState('');
    const [guardando, setGuardando] = useState(false);

    const crear = async () => {
        if (!nombre.trim()) return;
        setGuardando(true);
        try {
            await MttoService.crearArreglo({
                sistema_id: sistemaId,
                nombre: nombre.trim(),
                precio_repuesto_ref: precioRepuesto === '' ? null : Number(precioRepuesto),
                precio_mo_ref: precioMo === '' ? null : Number(precioMo),
            });
            toast('Arreglo agregado', 'success');
            setNombre(''); setPrecioRepuesto(''); setPrecioMo(''); setAbierto(false);
            onCreado();
        } catch (e: any) {
            toast('No se pudo agregar el arreglo', 'error', e.message);
        } finally {
            setGuardando(false);
        }
    };

    if (!abierto) {
        return (
            <button onClick={() => setAbierto(true)} className="w-full flex items-center gap-1.5 p-3 text-sm text-primary font-semibold min-h-[44px]">
                <Plus className="w-4 h-4" /> Agregar arreglo
            </button>
        );
    }

    return (
        <div className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 bg-muted/30">
            <input
                autoFocus
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Nombre del arreglo"
                className="flex-1 border border-border rounded-lg px-3 py-2 bg-background text-sm min-h-[40px]"
            />
            <div className="flex items-center gap-2">
                <input type="number" value={precioRepuesto} onChange={(e) => setPrecioRepuesto(e.target.value)}
                    placeholder="Repuesto COP" className="w-28 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[40px]" />
                <input type="number" value={precioMo} onChange={(e) => setPrecioMo(e.target.value)}
                    placeholder="M.O. COP" className="w-28 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[40px]" />
                <button onClick={crear} disabled={guardando || !nombre.trim()}
                    className="bg-primary text-primary-foreground px-3 py-2 rounded-lg text-sm font-semibold min-h-[40px] disabled:opacity-60">
                    {guardando ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Guardar'}
                </button>
                <button onClick={() => setAbierto(false)} className="p-2 min-h-[40px] min-w-[40px]"><X className="w-4 h-4" /></button>
            </div>
        </div>
    );
}

function ArregloRow({ arreglo, puedeEditar, onGuardado }: { arreglo: CatalogoSistemaConArreglos['arreglos'][number]; puedeEditar: boolean; onGuardado: () => void }) {
    const [precioRepuesto, setPrecioRepuesto] = useState(arreglo.precio_repuesto_ref?.toString() ?? '');
    const [precioMo, setPrecioMo] = useState(arreglo.precio_mo_ref?.toString() ?? '');
    const [vidaKm, setVidaKm] = useState(arreglo.vida_util_km?.toString() ?? '');
    const [vidaMeses, setVidaMeses] = useState(arreglo.vida_util_meses?.toString() ?? '');
    const [guardando, setGuardando] = useState(false);

    const guardar = async () => {
        if (!puedeEditar) return;
        setGuardando(true);
        try {
            await MttoService.updateArreglo(arreglo.id, {
                precio_repuesto_ref: precioRepuesto === '' ? null : Number(precioRepuesto),
                precio_mo_ref: precioMo === '' ? null : Number(precioMo),
                vida_util_km: vidaKm === '' ? null : Number(vidaKm),
                vida_util_meses: vidaMeses === '' ? null : Number(vidaMeses),
            });
            onGuardado();
        } catch (e: any) {
            toast('No se pudo guardar el precio', 'error', e.message);
        } finally {
            setGuardando(false);
        }
    };

    return (
        <div className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="flex-1 text-sm">{arreglo.nombre}</div>
            <div className="flex items-center gap-2">
                <div>
                    <label className="text-[10px] text-muted-foreground block">Repuesto</label>
                    <input type="number" value={precioRepuesto} disabled={!puedeEditar} onChange={(e) => setPrecioRepuesto(e.target.value)} onBlur={guardar}
                        className="w-28 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px] disabled:opacity-60" placeholder="COP" />
                </div>
                <div>
                    <label className="text-[10px] text-muted-foreground block">Mano de obra</label>
                    <input type="number" value={precioMo} disabled={!puedeEditar} onChange={(e) => setPrecioMo(e.target.value)} onBlur={guardar}
                        className="w-28 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px] disabled:opacity-60" placeholder="COP" />
                </div>
                <div>
                    <label className="text-[10px] text-muted-foreground block">Dura (km)</label>
                    <input type="number" value={vidaKm} disabled={!puedeEditar} onChange={(e) => setVidaKm(e.target.value)} onBlur={guardar}
                        className="w-24 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px] disabled:opacity-60" placeholder="—" />
                </div>
                <div>
                    <label className="text-[10px] text-muted-foreground block">Dura (meses)</label>
                    <input type="number" value={vidaMeses} disabled={!puedeEditar} onChange={(e) => setVidaMeses(e.target.value)} onBlur={guardar}
                        className="w-24 border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px] disabled:opacity-60" placeholder="—" />
                </div>
                {guardando && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>
        </div>
    );
}

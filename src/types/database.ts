export type Json =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Json | undefined }
    | Json[]

// ── Módulo de Mantenimiento Vehicular (mtto_*) ──────────────────────────────
export type MttoTipoVehiculo = 'motocarro' | 'moto_trailer'
export type MttoRol = 'mecanico' | 'encargado' | 'aprobador' | 'admin'
export type MttoTipoServicio = 'preventivo' | 'correctivo' | 'emergencia' | 'diagnostico' | 'alistamiento'
export type MttoEstadoItem = 'B' | 'R' | 'M' | 'NA'
export type MttoEstadoHallazgo = Exclude<MttoEstadoItem, 'B'>
export type MttoEstadoOrden =
    | 'borrador'
    | 'en_revision'
    | 'en_aprobacion'
    | 'aprobada'
    | 'rechazada'
    | 'en_ejecucion'
    | 'cerrada'
    | 'anulada'
export type MttoPrioridad = 'alta' | 'media' | 'baja'
export type MttoDecision = 'aprobado' | 'aprobado_parcial' | 'no_aprobado'

export type Database = {
    public: {
        Tables: {
            inventory_categories: {
                Row: {
                    id: string
                    name: string
                    description: string | null
                    unit_type: string | null
                    created_at: string | null
                }
                Insert: {
                    id?: string
                    name: string
                    description?: string | null
                    unit_type?: string | null
                    created_at?: string | null
                }
                Update: {
                    id?: string
                    name?: string
                    description?: string | null
                    unit_type?: string | null
                    created_at?: string | null
                }
            }
            inventory_items: {
                Row: {
                    id: string
                    category_id: string | null
                    name: string
                    sku: string | null
                    min_stock_level: number | null
                    brand: string | null
                    model_name: string | null
                    description_technical: string | null
                    unit_cost: number | null
                    currency: string | null
                    warranty_days: number | null
                    image_url: string | null
                    created_at: string | null
                }
                Insert: {
                    id?: string
                    category_id?: string | null
                    name: string
                    sku?: string | null
                    min_stock_level?: number | null
                    brand?: string | null
                    model_name?: string | null
                    description_technical?: string | null
                    unit_cost?: number | null
                    currency?: string | null
                    warranty_days?: number | null
                    image_url?: string | null
                    created_at?: string | null
                }
                Update: {
                    id?: string
                    category_id?: string | null
                    name?: string
                    sku?: string | null
                    min_stock_level?: number | null
                    brand?: string | null
                    model_name?: string | null
                    description_technical?: string | null
                    unit_cost?: number | null
                    currency?: string | null
                    warranty_days?: number | null
                    image_url?: string | null
                    created_at?: string | null
                }
            }
            inventory_assets: {
                Row: {
                    id: string
                    item_id: string | null
                    serial_number: string
                    mac_address: string | null
                    status: string | null
                    current_holder_id: string | null
                    current_location: string | null
                    last_movement_id: string | null
                    created_at: string | null
                }
                Insert: {
                    id?: string
                    item_id?: string | null
                    serial_number: string
                    mac_address?: string | null
                    status?: string | null
                    current_holder_id?: string | null
                    current_location?: string | null
                    last_movement_id?: string | null
                    created_at?: string | null
                }
                Update: {
                    id?: string
                    item_id?: string | null
                    serial_number?: string
                    mac_address?: string | null
                    status?: string | null
                    current_holder_id?: string | null
                    current_location?: string | null
                    last_movement_id?: string | null
                    created_at?: string | null
                }
            }
            inventory_movements: {
                Row: {
                    id: string
                    asset_id: string | null
                    origin_holder_id: string | null
                    destination_holder_id: string | null
                    client_reference: string | null
                    movement_type: string
                    created_at: string | null
                    notes: string | null
                }
                Insert: {
                    id?: string
                    asset_id?: string | null
                    origin_holder_id?: string | null
                    destination_holder_id?: string | null
                    client_reference?: string | null
                    movement_type: string
                    created_at?: string | null
                    notes?: string | null
                }
                Update: {
                    id?: string
                    asset_id?: string | null
                    origin_holder_id?: string | null
                    destination_holder_id?: string | null
                    client_reference?: string | null
                    movement_type?: string
                    created_at?: string | null
                    notes?: string | null
                }
            }
            mtto_usuario_rol: {
                Row: {
                    usuario_id: string
                    org_id: string
                    rol: MttoRol
                    nombre: string | null
                    documento: string | null
                    cargo: string | null
                    activo: boolean
                    created_at: string
                }
                Insert: {
                    usuario_id: string
                    org_id?: string
                    rol: MttoRol
                    nombre?: string | null
                    documento?: string | null
                    cargo?: string | null
                    activo?: boolean
                    created_at?: string
                }
                Update: {
                    usuario_id?: string
                    org_id?: string
                    rol?: MttoRol
                    nombre?: string | null
                    documento?: string | null
                    cargo?: string | null
                    activo?: boolean
                    created_at?: string
                }
            }
            mtto_vehiculo: {
                Row: {
                    id: string
                    org_id: string
                    codigo: string
                    tipo: MttoTipoVehiculo
                    placa: string | null
                    marca: string | null
                    linea: string | null
                    anio: number | null
                    cilindraje: number | null
                    num_motor: string | null
                    num_chasis: string | null
                    soat_vence: string | null
                    tecno_vence: string | null
                    responsable_id: string | null
                    activo: boolean
                    created_at: string
                }
                Insert: {
                    id?: string
                    org_id?: string
                    codigo: string
                    tipo: MttoTipoVehiculo
                    placa?: string | null
                    marca?: string | null
                    linea?: string | null
                    anio?: number | null
                    cilindraje?: number | null
                    num_motor?: string | null
                    num_chasis?: string | null
                    soat_vence?: string | null
                    tecno_vence?: string | null
                    responsable_id?: string | null
                    activo?: boolean
                    created_at?: string
                }
                Update: {
                    id?: string
                    org_id?: string
                    codigo?: string
                    tipo?: MttoTipoVehiculo
                    placa?: string | null
                    marca?: string | null
                    linea?: string | null
                    anio?: number | null
                    cilindraje?: number | null
                    num_motor?: string | null
                    num_chasis?: string | null
                    soat_vence?: string | null
                    tecno_vence?: string | null
                    responsable_id?: string | null
                    activo?: boolean
                    created_at?: string
                }
            }
            mtto_checklist_seccion: {
                Row: {
                    id: string
                    orden: number
                    nombre: string
                    aplica: MttoTipoVehiculo[] | null
                }
                Insert: {
                    id?: string
                    orden: number
                    nombre: string
                    aplica?: MttoTipoVehiculo[] | null
                }
                Update: {
                    id?: string
                    orden?: number
                    nombre?: string
                    aplica?: MttoTipoVehiculo[] | null
                }
            }
            mtto_checklist_item: {
                Row: {
                    id: string
                    seccion_id: string
                    orden: number
                    nombre: string
                    critico: boolean
                    aplica: MttoTipoVehiculo[] | null
                    activo: boolean
                }
                Insert: {
                    id?: string
                    seccion_id: string
                    orden: number
                    nombre: string
                    critico?: boolean
                    aplica?: MttoTipoVehiculo[] | null
                    activo?: boolean
                }
                Update: {
                    id?: string
                    seccion_id?: string
                    orden?: number
                    nombre?: string
                    critico?: boolean
                    aplica?: MttoTipoVehiculo[] | null
                    activo?: boolean
                }
            }
            mtto_catalogo_sistema: {
                Row: {
                    id: string
                    orden: number
                    nombre: string
                }
                Insert: {
                    id?: string
                    orden: number
                    nombre: string
                }
                Update: {
                    id?: string
                    orden?: number
                    nombre?: string
                }
            }
            mtto_catalogo_arreglo: {
                Row: {
                    id: string
                    sistema_id: string
                    nombre: string
                    precio_repuesto_ref: number | null
                    precio_mo_ref: number | null
                    activo: boolean
                }
                Insert: {
                    id?: string
                    sistema_id: string
                    nombre: string
                    precio_repuesto_ref?: number | null
                    precio_mo_ref?: number | null
                    activo?: boolean
                }
                Update: {
                    id?: string
                    sistema_id?: string
                    nombre?: string
                    precio_repuesto_ref?: number | null
                    precio_mo_ref?: number | null
                    activo?: boolean
                }
            }
            mtto_orden: {
                Row: {
                    id: string
                    org_id: string
                    numero: string | null
                    vehiculo_id: string
                    fecha: string
                    kilometraje: number | null
                    tipo_servicio: MttoTipoServicio
                    taller: string | null
                    motivo: string | null
                    diagnostico: string | null
                    estado: MttoEstadoOrden
                    iva_tasa: number
                    creado_por: string
                    enviado_at: string | null
                    revisado_por: string | null
                    revisado_at: string | null
                    obs_encargado: string | null
                    aprobado_por: string | null
                    aprobado_at: string | null
                    decision: MttoDecision | null
                    obs_aprobador: string | null
                    valor_aprobado: number | null
                    cerrado_at: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    org_id?: string
                    numero?: string | null
                    vehiculo_id: string
                    fecha?: string
                    kilometraje?: number | null
                    tipo_servicio: MttoTipoServicio
                    taller?: string | null
                    motivo?: string | null
                    diagnostico?: string | null
                    estado?: MttoEstadoOrden
                    iva_tasa?: number
                    creado_por?: string
                    enviado_at?: string | null
                    revisado_por?: string | null
                    revisado_at?: string | null
                    obs_encargado?: string | null
                    aprobado_por?: string | null
                    aprobado_at?: string | null
                    decision?: MttoDecision | null
                    obs_aprobador?: string | null
                    valor_aprobado?: number | null
                    cerrado_at?: string | null
                    created_at?: string
                }
                Update: {
                    id?: string
                    org_id?: string
                    numero?: string | null
                    vehiculo_id?: string
                    fecha?: string
                    kilometraje?: number | null
                    tipo_servicio?: MttoTipoServicio
                    taller?: string | null
                    motivo?: string | null
                    diagnostico?: string | null
                    estado?: MttoEstadoOrden
                    iva_tasa?: number
                    creado_por?: string
                    enviado_at?: string | null
                    revisado_por?: string | null
                    revisado_at?: string | null
                    obs_encargado?: string | null
                    aprobado_por?: string | null
                    aprobado_at?: string | null
                    decision?: MttoDecision | null
                    obs_aprobador?: string | null
                    valor_aprobado?: number | null
                    cerrado_at?: string | null
                    created_at?: string
                }
            }
            mtto_orden_hallazgo: {
                Row: {
                    id: string
                    orden_id: string
                    item_id: string
                    estado: MttoEstadoHallazgo
                    observacion: string | null
                    creado_por: string
                    created_at: string
                }
                Insert: {
                    id?: string
                    orden_id: string
                    item_id: string
                    estado: MttoEstadoHallazgo
                    observacion?: string | null
                    creado_por?: string
                    created_at?: string
                }
                Update: {
                    id?: string
                    orden_id?: string
                    item_id?: string
                    estado?: MttoEstadoHallazgo
                    observacion?: string | null
                    creado_por?: string
                    created_at?: string
                }
            }
            mtto_orden_foto: {
                Row: {
                    id: string
                    hallazgo_id: string
                    path: string
                    mime: string | null
                    bytes: number | null
                    subido_por: string
                    created_at: string
                }
                Insert: {
                    id?: string
                    hallazgo_id: string
                    path: string
                    mime?: string | null
                    bytes?: number | null
                    subido_por?: string
                    created_at?: string
                }
                Update: {
                    id?: string
                    hallazgo_id?: string
                    path?: string
                    mime?: string | null
                    bytes?: number | null
                    subido_por?: string
                    created_at?: string
                }
            }
            mtto_orden_reparacion: {
                Row: {
                    id: string
                    orden_id: string
                    hallazgo_id: string | null
                    arreglo_id: string | null
                    descripcion: string
                    sistema: string | null
                    repuesto: string | null
                    cantidad: number
                    valor_unitario: number
                    mano_obra: number
                    prioridad: MttoPrioridad
                    autorizado: boolean
                    subtotal_repuestos: number
                    total: number
                    created_at: string
                }
                Insert: {
                    id?: string
                    orden_id: string
                    hallazgo_id?: string | null
                    arreglo_id?: string | null
                    descripcion: string
                    sistema?: string | null
                    repuesto?: string | null
                    cantidad?: number
                    valor_unitario?: number
                    mano_obra?: number
                    prioridad?: MttoPrioridad
                    autorizado?: boolean
                    created_at?: string
                }
                Update: {
                    id?: string
                    orden_id?: string
                    hallazgo_id?: string | null
                    arreglo_id?: string | null
                    descripcion?: string
                    sistema?: string | null
                    repuesto?: string | null
                    cantidad?: number
                    valor_unitario?: number
                    mano_obra?: number
                    prioridad?: MttoPrioridad
                    autorizado?: boolean
                    created_at?: string
                }
            }
            mtto_orden_evento: {
                Row: {
                    id: string
                    orden_id: string
                    usuario_id: string
                    accion: string
                    detalle: Json
                    created_at: string
                }
                Insert: {
                    id?: string
                    orden_id: string
                    usuario_id: string
                    accion: string
                    detalle?: Json
                    created_at?: string
                }
                Update: {
                    id?: string
                    orden_id?: string
                    usuario_id?: string
                    accion?: string
                    detalle?: Json
                    created_at?: string
                }
            }
        }
        Views: {
            mtto_v_orden_total: {
                Row: {
                    orden_id: string
                    numero: string | null
                    subtotal_repuestos: number
                    subtotal_mano_obra: number
                    subtotal: number
                    iva: number
                    total: number
                }
            }
            mtto_v_orden_resumen: {
                Row: {
                    orden_id: string
                    numero: string | null
                    vehiculo_id: string
                    bueno: number
                    regular: number
                    malo: number
                    no_aplica: number
                    tiene_critico_malo: boolean | null
                }
            }
            mtto_v_costo_vehiculo: {
                Row: {
                    vehiculo_id: string
                    codigo: string
                    mes: string
                    total_mes: number
                }
            }
        }
        Functions: {
            [_ in never]: never
        }
        Enums: {
            mtto_tipo_vehiculo: MttoTipoVehiculo
            mtto_rol: MttoRol
            mtto_tipo_servicio: MttoTipoServicio
            mtto_estado_item: MttoEstadoItem
            mtto_estado_orden: MttoEstadoOrden
            mtto_prioridad: MttoPrioridad
            mtto_decision: MttoDecision
        }
    }
}

export type StrategicLocation = 'campo' | 'oficina';

// Valores aceptados como sinónimos — cubre errores tipográficos y variantes en inglés
const CAMPO_VARIANTS  = new Set(['campo', 'field', 'tecnico campo', 'technician']);
const OFICINA_VARIANTS = new Set(['oficina', 'office', 'staff', 'admin']);

export function normalizeStrategicLocation(value: unknown): StrategicLocation | null {
    if (value === null || value === undefined || value === '') return null;
    const v = String(value).toLowerCase().trim();
    if (CAMPO_VARIANTS.has(v))  return 'campo';
    if (OFICINA_VARIANTS.has(v)) return 'oficina';
    return null;
}

// Devuelve 'campo' | 'oficina' con fallback a is_field_tech si el campo no existe aún
export function resolveStrategicLocation(
    strategic_location: unknown,
    is_field_tech?: boolean
): StrategicLocation {
    return normalizeStrategicLocation(strategic_location)
        ?? (is_field_tech ? 'campo' : 'oficina');
}

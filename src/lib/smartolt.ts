import { orgService } from './orgService';

export interface SmartOLTOnuStatus {
    id: number;
    sn: string;
    name: string;
    status: 'online' | 'offline' | 'power_failure' | 'los';
    signal_dbm: number;
    olt_name: string;
    pon_port: string;
    last_online_change: string;
}

// Helper interno: fetch a SmartOLT via Edge Function (prod) o Vite proxy (dev)
async function smartoltFetch(path: string, options?: RequestInit): Promise<Response> {
    const baseUrl = import.meta.env.DEV ? '/api/smartolt' : orgService.getSmartOLTProxyUrl();
    const authHeader = await orgService.getAuthHeader();
    return fetch(`${baseUrl}/${path}`, {
        ...options,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(authHeader ? { 'Authorization': authHeader } : {}),
            ...(options?.headers || {}),
        },
    });
}

export const SmartOLTService = {
    /**
     * Verifica si un serial (SN) está registrado y online en la OLT.
     * Útil para validar instalaciones de inventario en tiempo real.
     */
    async verifyAssetStatus(serialNumber: string): Promise<any | null> {
        try {
            // SANITIZACIÓN CRÍTICA: Eliminar espacios copiados/pegados por error
            const cleanSn = serialNumber ? serialNumber.toString().trim().toUpperCase() : '';
            if (!cleanSn) return null;

            // Endpoint plural confirmado mediante diagnóstico
            const response = await smartoltFetch(`onu/get_onus_details_by_sn/${cleanSn}`);

            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error('Error al conectar con SmartOLT');
            }

            const data = await response.json();

            if (data.status === true && data.onus && data.onus.length > 0) {
                const onu = data.onus[0];
                return {
                    id: onu.unique_external_id,
                    sn: onu.sn || cleanSn,
                    name: onu.name,
                    status: onu.status.toLowerCase(),
                    signal_dbm: parseFloat(onu.signal_1490) || parseFloat(onu.signal) || 0,
                    olt_name: onu.olt_name,
                    pon_port: onu.pon_port,
                    mac: onu.mac_address || onu.mac || "",
                    last_online_change: onu.last_online_change
                };
            }
            return null;
        } catch (error) {
            console.error('SmartOLT Error:', error);
            return null;
        }
    },

    /**
     * Obtiene la señal detallada de un equipo.
     */
    async getOnuSignal(serialNumber: string): Promise<{ rx: number | null, tx: number | null } | null> {
        try {
            // 1. Intentar buscar en equipos YA PROVISIONADOS
            const status = await this.verifyAssetStatus(serialNumber);

            if (status && status.id) {
                // Es un equipo activo, podemos pedir señal en tiempo real
                const response = await smartoltFetch(`onu/get_onu_signal/${status.id}`);
                if (!response.ok) return { rx: status.signal_dbm || null, tx: null };

                const data = await response.json();
                if (data.status && data.onu_signal_1490) {
                    const rx = parseFloat(data.onu_signal_1490.replace(' dBm', ''));
                    const tx = data.onu_signal_1310 ? parseFloat(data.onu_signal_1310.replace(' dBm', '')) : null;
                    return {
                        rx: isNaN(rx) ? status.signal_dbm : rx,
                        tx: isNaN(tx!) ? null : tx
                    };
                }
                return { rx: status.signal_dbm || null, tx: null };
            }

            // 2. Si no es provisionado, buscar en DEPOSITO / NO CONFIGURADOS
            // Estos equipos NO tienen ID para pedir señal realtime, pero la lista trae la última señal
            const unconfigured = await this.getUnconfiguredOnus();
            // Normalizar para buscar
            const normSN = this.normalizeSerialNumber(serialNumber).trim().toUpperCase();

            const match = unconfigured.find(u => {
                const uSn = this.normalizeSerialNumber(u.sn).trim().toUpperCase();
                return uSn === normSN || uSn.includes(normSN);
            });

            if (match) {
                // SmartOLT suele mandar la señal en el objeto de unconfigured
                // Si no viene, devolvemos null y el UI deberá pedir manual o justificación
                const signal = (match as any).signal ? parseFloat((match as any).signal) : null;
                return { rx: signal, tx: null };
            }

            return null;
        } catch (error) {
            console.error('Error fetching real-time signal:', error);
            return null;
        }
    },

    /**
     * Obtiene lista de ONUs no configuradas (sin asignar a cliente).
     * Útil para detectar equipos nuevos durante instalaciones.
     */
    async getUnconfiguredOnus(): Promise<Array<{ sn: string; mac: string; olt_name?: string; pon_port?: string }>> {
        try {
            const response = await smartoltFetch('onu/unconfigured_onus');

            if (!response.ok) {
                console.warn('[SmartOLT] No se pudieron obtener ONUs no configuradas');
                return [];
            }

            const data = await response.json();

            // La API puede devolver diferentes estructuras, adaptamos a nuestra interfaz
            // Fix 26/01: API devuelve { response: [...] }
            const results = data.response || data.onus || (Array.isArray(data) ? data : []);

            if (Array.isArray(results)) {
                return results.map((onu: any) => ({
                    sn: onu.serial_number || onu.sn || '',
                    mac: onu.mac_address || onu.mac || '',
                    olt_name: onu.olt_name || onu.olt || (`OLT ID: ${onu.olt_id}`),
                    pon_port: onu.pon_port || (onu.board && onu.port ? `${onu.board}/${onu.port}` : onu.port) || '',
                    signal: onu.signal || onu.signal_value || null // Fix 26/01: Mapear señal
                }));
            }

            return [];
        } catch (error) {
            console.error('[SmartOLT] Error al obtener ONUs no configuradas:', error);
            return [];
        }
    },

    /**
     * Normaliza un número de serie que puede venir en formato Hexadecimal (scanners)
     * a formato Vendor ID + Hex (formato SmartOLT).
     * Ej: 43445443AFB334D1 -> CDTCAFB334D1
     */
    /**
     * Autoriza una ONU en la OLT.
     * Requiere datos de ubicación (board/port) y detalles del cliente (external_id).
     */
    async authorizeOnu(payload: {
        olt_id: string | number;
        board: string | number;
        port: string | number;
        sn: string;
        onu_type: string;
        zone_id: string | number;
        name: string;
        external_id: string | number;
        vlan?: number;
    }): Promise<{ status: boolean; message?: string; error?: string }> {
        try {
            const response = await smartoltFetch('onu/authorize_onu', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                return { status: false, message: data.error || data.message || 'Error al autorizar en SmartOLT' };
            }

            return data; // Esperamos { status: true, ... }
        } catch (error: any) {
            console.error('[SmartOLT] Authorize Error:', error);
            return { status: false, message: error.message || 'Error de conexión con SmartOLT' };
        }
    },

    normalizeSerialNumber(input: string): string {
        if (!input) return input;
        const cleanInput = input.trim().toUpperCase();

        // Patrón: 16 caracteres hexadecimales exactos
        const hexPattern = /^[0-9A-F]{16}$/;

        if (hexPattern.test(cleanInput)) {
            try {
                // Intentar decodificar los primeros 8 chars (4 bytes) a ASCII
                const vendorHex = cleanInput.substring(0, 8);
                let vendorAscii = '';

                for (let i = 0; i < vendorHex.length; i += 2) {
                    const code = parseInt(vendorHex.substring(i, i + 2), 16);
                    // Validar rango imprimible básico (A-Z, 0-9) para evitar falsos positivos
                    // 48-57 (0-9), 65-90 (A-Z), 97-122 (a-z)
                    // Permitimos un rango un poco más amplio por si acaso, pero típicamente es A-Z
                    if (code < 32 || code > 126) {
                        throw new Error('Non-printable');
                    }
                    vendorAscii += String.fromCharCode(code);
                }

                const suffix = cleanInput.substring(8);
                return vendorAscii + suffix;
            } catch (e) {
                // Si falla la conversión, devolver original
                return cleanInput;
            }
        }

        return cleanInput;
    }
};

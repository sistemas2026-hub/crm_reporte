const OFFICE_COORDS_KEY = 'tech_office_coords_v1';

export interface OfficeCoords {
    lat: number;
    lng: number;
    label?: string;
}

export const geoService = {
    getOfficeCoords(): OfficeCoords | null {
        try {
            const raw = localStorage.getItem(OFFICE_COORDS_KEY);
            if (!raw) return null;
            return JSON.parse(raw) as OfficeCoords;
        } catch {
            return null;
        }
    },

    setOfficeCoords(coords: OfficeCoords): void {
        localStorage.setItem(OFFICE_COORDS_KEY, JSON.stringify(coords));
    },

    clearOfficeCoords(): void {
        localStorage.removeItem(OFFICE_COORDS_KEY);
    },

    /** Haversine distance in km between two lat/lng points */
    haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
        const R = 6371;
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lng - a.lng);
        const sinDlat = Math.sin(dLat / 2);
        const sinDlon = Math.sin(dLon / 2);
        const h =
            sinDlat * sinDlat +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDlon * sinDlon;
        return R * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    },

    /** Returns distance in km from office to a point, or null if office not configured */
    distanceFromOffice(ticketLat: number, ticketLng: number): number | null {
        const office = this.getOfficeCoords();
        if (!office) return null;
        return this.haversineKm(office, { lat: ticketLat, lng: ticketLng });
    },
};

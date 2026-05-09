import { WorkflowService } from './workflowService';

const DB_NAME = 'ISP_Sync_Queue';
const STORE_NAME = 'pending_syncs';

export interface PendingSync {
    id: string; // ticketId o workItemId
    type: 'COMPLETE' | 'ESCALATE';
    data: {
        workItemId: string;
        resolution: string;
        files?: (File | Blob)[];
        materials?: { asset_id: string, quantity: number }[];
        targetTechnicianId?: string;
        priority?: number;
        statusId?: number;
        signal?: string;
    };
    timestamp: number;
    attempts: number;
    error?: string;
}

class SyncQueueService {
    private db: IDBDatabase | null = null;

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onerror = () => reject(request.error);
        });
    }

    async addToQueue(sync: PendingSync) {
        const db = await this.getDB();
        return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({ ...sync, attempts: 0 });

            request.onsuccess = () => {
                console.log(`[SyncQueue] Tarea añadida a la cola: ${sync.id}`);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getQueue(): Promise<PendingSync[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async removeFromQueue(id: string) {
        const db = await this.getDB();
        return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => {
                console.log(`[SyncQueue] Tarea eliminada de la cola: ${id}`);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async processQueue() {
        if (!navigator.onLine) return; // No procesar si estamos oficialmente offline

        const queue = await this.getQueue();
        if (queue.length === 0) return;

        console.log(`[SyncQueue] Procesando ${queue.length} tareas pendientes...`);

        // Fotos tienen prioridad de ancho de banda: items con archivos van primero
        const sorted = [...queue].sort((a, b) => {
            const aHasFiles = (a.data.files?.length ?? 0) > 0 ? 0 : 1;
            const bHasFiles = (b.data.files?.length ?? 0) > 0 ? 0 : 1;
            return aHasFiles - bHasFiles;
        });

        for (const sync of sorted) {
            try {
                let success = false;
                if (sync.type === 'COMPLETE') {
                    // 1. Re-registrar materiales si existen
                    if (sync.data.materials && sync.data.materials.length > 0) {
                        try {
                            await WorkflowService.trackMaterialConsumption(sync.id, sync.data.materials);
                        } catch (e) {
                            console.warn('[SyncQueue] Inventario ya reportado o error, continuando...', e);
                        }
                    }
                    // 2. Intentar finalizar
                    success = await WorkflowService.completeAndSyncWorkItem(
                        sync.data.workItemId,
                        sync.data.resolution,
                        {
                            files: sync.data.files,
                            statusId: sync.data.statusId,
                            signal: sync.data.signal
                        }
                    );
                } else if (sync.type === 'ESCALATE') {
                    success = await WorkflowService.escalateWorkItem(
                        sync.data.workItemId,
                        sync.data.resolution,
                        sync.data.targetTechnicianId,
                        {
                            priority: sync.data.priority,
                            file: sync.data.files?.[0]
                        }
                    );
                }

                if (success) {
                    await this.removeFromQueue(sync.id);
                } else {
                    await this.updateAttempts(sync);
                }
            } catch (error) {
                console.error(`[SyncQueue] Error procesando ${sync.id}:`, error);
                await this.updateAttempts(sync);
            }
        }
    }

    private async updateAttempts(sync: PendingSync) {
        const db = await this.getDB();
        return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            sync.attempts += 1;
            sync.error = 'Falló el último intento de sincronización';
            const request = store.put(sync);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

export const syncQueueService = new SyncQueueService();

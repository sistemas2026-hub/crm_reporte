/**
 * IndexedDB draft service with AES-GCM encryption.
 * Key is derived from the technician's user ID via PBKDF2.
 * Call draftService.init(userId) once after auth before saving/reading drafts.
 */

const DB_NAME = 'isp_reports_drafts';
const STORE_NAME = 'ticket_drafts';
const DB_VERSION = 2; // Bumped: v2 uses encrypted per-file ArrayBuffers
const PBKDF2_SALT = 'isp-drafts-v2-salt-2025';
const PBKDF2_ITERATIONS = 100_000;

interface EncryptedFile {
    iv: ArrayBuffer;
    data: ArrayBuffer;
    name: string;
    type: string;
    lastModified: number;
    encrypted: boolean;
}

class DraftService {
    private db: IDBDatabase | null = null;
    private cryptoKey: CryptoKey | null = null;
    private initPromise: Promise<void> | null = null;

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event: any) => {
                const db = event.target.result as IDBDatabase;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };

            request.onsuccess = (event: any) => {
                this.db = event.target.result as IDBDatabase;
                resolve(this.db!);
            };

            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /** Initialize encryption key from technician user ID. Call once after login. */
    async init(userId: string): Promise<void> {
        if (this.cryptoKey) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                if (!crypto?.subtle) {
                    console.warn('[DraftService] Web Crypto not available — drafts stored unencrypted.');
                    return;
                }
                const encoder = new TextEncoder();
                const keyMaterial = await crypto.subtle.importKey(
                    'raw',
                    encoder.encode(userId),
                    'PBKDF2',
                    false,
                    ['deriveKey']
                );
                this.cryptoKey = await crypto.subtle.deriveKey(
                    {
                        name: 'PBKDF2',
                        salt: encoder.encode(PBKDF2_SALT),
                        iterations: PBKDF2_ITERATIONS,
                        hash: 'SHA-256',
                    },
                    keyMaterial,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['encrypt', 'decrypt']
                );
                console.log('[DraftService] 🔐 Clave de encriptación lista.');
            } catch (e) {
                console.warn('[DraftService] Error derivando clave de encriptación:', e);
            }
        })();

        return this.initPromise;
    }

    private async encryptBuffer(buffer: ArrayBuffer): Promise<{ iv: ArrayBuffer; data: ArrayBuffer; encrypted: true }> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.cryptoKey!,
            buffer
        );
        return { iv: iv.buffer, data: encrypted, encrypted: true };
    }

    private async decryptBuffer(iv: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
        return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            this.cryptoKey!,
            data
        );
    }

    /** Saves files as encrypted blobs. Clears any previous draft for this ticket. */
    async saveDraft(ticketId: string, files: File[]): Promise<void> {
        if (!ticketId || files.length === 0) return;
        const db = await this.getDB();

        const encryptedFiles: EncryptedFile[] = await Promise.all(
            files.map(async (file) => {
                const buffer = await file.arrayBuffer();
                if (this.cryptoKey) {
                    const { iv, data } = await this.encryptBuffer(buffer);
                    return { iv, data, name: file.name, type: file.type, lastModified: file.lastModified, encrypted: true };
                }
                // Fallback: store unencrypted
                return { iv: new ArrayBuffer(0), data: buffer, name: file.name, type: file.type, lastModified: file.lastModified, encrypted: false };
            })
        );

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(encryptedFiles, ticketId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /** Retrieves and decrypts draft files for a ticket. Returns [] if not found or decryption fails. */
    async getDraft(ticketId: string): Promise<File[]> {
        if (!ticketId) return [];
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(ticketId);

            request.onsuccess = async () => {
                const stored = request.result;
                if (!stored || !Array.isArray(stored)) {
                    resolve([]);
                    return;
                }

                try {
                    const files = await Promise.all(
                        stored.map(async (item: EncryptedFile) => {
                            let buffer: ArrayBuffer;

                            if (item.encrypted && this.cryptoKey) {
                                buffer = await this.decryptBuffer(item.iv, item.data);
                            } else {
                                // Unencrypted fallback or legacy format
                                if (item.data) {
                                    buffer = item.data;
                                } else {
                                    // Legacy v1 format: item was { blob, name, type, lastModified }
                                    const legacy = item as any;
                                    buffer = await (legacy.blob as Blob).arrayBuffer();
                                }
                            }

                            return new File([buffer], item.name, {
                                type: item.type,
                                lastModified: item.lastModified,
                            });
                        })
                    );
                    resolve(files);
                } catch (e) {
                    console.warn('[DraftService] Error desencriptando borrador (clave incorrecta o datos corruptos):', e);
                    resolve([]);
                }
            };

            request.onerror = () => reject(request.error);
        });
    }

    /** Deletes the draft for a ticket. Only call after receiving confirmed HTTP 200. */
    async clearDraft(ticketId: string): Promise<void> {
        if (!ticketId) return;
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(ticketId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

export const draftService = new DraftService();

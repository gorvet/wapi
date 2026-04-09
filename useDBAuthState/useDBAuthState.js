import { WAProto as proto, initAuthCreds, BufferJSON } from 'baileys';
import MySQLAuthStore from './mysql-auth-store.js';

const authJsonReviver = (key, value) => {
    if (value?.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }

    return BufferJSON.reviver(key, value);
};

const useDBAuthState = async (sessionId, options = {}) => {
    if (!sessionId) {
        throw new Error('sessionId is required to manage authentication state.');
    }

    const storage = options.storage ?? new MySQLAuthStore();

    // Cargar credenciales iniciales o generar nuevas si no existen
    const dataRaw = await storage.getCredsData(sessionId, 'creds') || JSON.stringify((0, initAuthCreds)(), BufferJSON.replacer);
    const creds = JSON.parse(dataRaw, authJsonReviver);

    let saveTimer = null;
    let keysTimer = null;
    let allKeysCache = null;
    let keysLoaded = false;
    let keysDirty = false;
    let lastCredsString = dataRaw;
    let lastKeysString = '';

    const loadAllKeys = async () => {
        if (keysLoaded) {
            return allKeysCache;
        }

        const allKeysRaw = await storage.getCredsData(sessionId, 'session_keys');
        lastKeysString = allKeysRaw || '{}';

        if (!allKeysRaw) {
            allKeysCache = {};
            keysLoaded = true;
            return allKeysCache;
        }

        try {
            allKeysCache = JSON.parse(allKeysRaw, authJsonReviver) || {};
        } catch {
            console.warn(`[AUTH] session_keys corrupto para ${sessionId}; se reinicia cache`);
            allKeysCache = {};
        }

        keysLoaded = true;
        return allKeysCache;
    };

    const flushKeys = async () => {
        if (!keysLoaded || !keysDirty) {
            return;
        }

        const nextKeysString = JSON.stringify(allKeysCache, BufferJSON.replacer);
        if (nextKeysString === lastKeysString) {
            keysDirty = false;
            return;
        }

        await storage.setCredsData(sessionId, nextKeysString, 'session_keys');
        lastKeysString = nextKeysString;
        keysDirty = false;
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const allKeys = await loadAllKeys();

                    ids.forEach((id) => {
                        let value = allKeys[`${type}-${id}`] ?? null;
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    });

                    return data;
                },

                set: async (patch) => {
                    const allKeys = await loadAllKeys();

                    for (const category in patch) {
                        for (const id in patch[category]) {
                            const value = patch[category][id];
                            const key = `${category}-${id}`;
                            if (value === null || value === undefined) {
                                delete allKeys[key];
                            } else {
                                allKeys[key] = value;
                            }
                        }
                    }

                    keysDirty = true;
                    if (keysTimer) {
                        clearTimeout(keysTimer);
                    }

                    keysTimer = setTimeout(async () => {
                        try {
                            await flushKeys();
                        } catch (e) {
                            console.warn('[AUTH] keys.set fallo (reintenta en proximo patch):', e?.code || e?.message);
                        }
                    }, 1200);
                },
            },
        },

        // Guardar credenciales en la base de datos
        saveCreds: async () => {
            if (saveTimer) {
                clearTimeout(saveTimer);
            }

            saveTimer = setTimeout(async () => {
                try {
                    const dataString = JSON.stringify(creds, BufferJSON.replacer);
                    if (dataString === lastCredsString) {
                        return;
                    }
                    await storage.setCredsData(sessionId, dataString, 'creds');
                    lastCredsString = dataString;
                } catch (e) {
                    // No matar el proceso por lock/timeout.
                    console.warn('[AUTH] saveCreds fallo (se reintenta en proxima senal):', e?.code || e?.message);
                }
            }, 1200);
        },
    };
};

export default useDBAuthState;

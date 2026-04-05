import { readdir, existsSync, rmSync } from 'fs';
import { useMultiFileAuthState } from 'baileys';
import makeInMemoryStore from '../store/memory-store.js';
import makeMySQLStore from '../store/mysql-store.js';
import useDBAuthState from '../useDBAuthState/useDBAuthState.js';
import MySQLAuthStore from '../useDBAuthState/mysql-auth-store.js';
import { isEncryptionEnabled } from './crypto.js';

const rawDriver = (process.env.SESSION_STORAGE_DRIVER ?? 'mysql').toLowerCase();
const driver = ['mysql', 'json'].includes(rawDriver) ? rawDriver : 'mysql';
const isMySQL = driver === 'mysql';

if (rawDriver !== driver) {
    console.warn(`[STORAGE] SESSION_STORAGE_DRIVER invalido: "${rawDriver}". Se usara "${driver}".`);
}

const authStore = isMySQL ? new MySQLAuthStore() : null;

const toArrayFromDir = (path) =>
    new Promise((resolve, reject) => {
        readdir(path, (err, files) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(files);
        });
    });

const buildCommonStoreOptions = () => ({
    preserveDataDuringSync: true,
    backupBeforeSync: false,
    incrementalSave: true,
    maxMessagesPerChat: 150,
    autoSaveInterval: 10000,
});

const removeLocalSessionFiles = (sessionId, sessionsDir) => {
    const sessionFile = 'md_' + sessionId;
    const storeFile = `${sessionId}_store.json`;
    const rmOptions = { force: true, recursive: true };

    const authPath = sessionsDir(sessionFile);
    const storePath = sessionsDir(storeFile);

    if (existsSync(authPath)) {
        rmSync(authPath, rmOptions);
    }

    if (existsSync(storePath)) {
        rmSync(storePath, rmOptions);
    }
};

const createSessionPersistence = async (sessionId, sessionsDir) => {
    const sessionFile = 'md_' + sessionId;
    const commonStoreOptions = buildCommonStoreOptions();

    const store = isMySQL
        ? makeMySQLStore({
              ...commonStoreOptions,
              sessionId,
          })
        : makeInMemoryStore({
              ...commonStoreOptions,
              storeFile: sessionsDir(`${sessionId}_store.json`),
          });

    const authState = isMySQL
        ? await useDBAuthState(sessionId, { storage: authStore })
        : await useMultiFileAuthState(sessionsDir(sessionFile));

    if (isMySQL) {
        await store?.readFromMySQL(sessionId);
    } else {
        store?.readFromFile(sessionsDir(`${sessionId}_store.json`));
    }

    return {
        store,
        state: authState.state,
        saveCreds: authState.saveCreds,
    };
};

const deleteSessionPersistence = async (sessionId, sessionsDir) => {
    if (isMySQL && authStore) {
        await authStore.deleteCredsData(sessionId);
        return;
    }

    removeLocalSessionFiles(sessionId, sessionsDir);
};

const listRecoverableSessionIds = async (sessionsDir) => {
    if (isMySQL && authStore) {
        return authStore.getAllSessionIds();
    }

    if (!existsSync(sessionsDir())) {
        return [];
    }

    const files = await toArrayFromDir(sessionsDir());
    const sessionIds = [];

    for (const file of files) {
        if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
            continue;
        }

        const filename = file.replace('.json', '');
        sessionIds.push(filename.substring(3));
    }

    return sessionIds;
};

const markStoreDirty = (store) => {
    store?.markDirty?.();
};

const getPersistenceInfo = () => ({
    driver,
    isMySQL,
    encryptionEnabled: isEncryptionEnabled(),
});

export {
    createSessionPersistence,
    deleteSessionPersistence,
    getPersistenceInfo,
    listRecoverableSessionIds,
    markStoreDirty,
};

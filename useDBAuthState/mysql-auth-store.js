import mysql from 'mysql2/promise';
import { decryptText, encryptText } from '../persistence/crypto.js';

// --- Mutex en memoria por session_id (serializa escrituras dentro del proceso) ---
const _memQueues = new Map();
const getEnv = (key, fallback = '') => {
  const raw = process.env[key];
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  return value === '' ? fallback : value;
};

function withSessionMutex(sessionId, task) {
  const prev = _memQueues.get(sessionId) || Promise.resolve();
  const next = prev.then(() => task());
  _memQueues.set(sessionId, next.catch(() => {}));
  return next.finally(() => {
    if (_memQueues.get(sessionId) === next) _memQueues.delete(sessionId);
  });
}

 
export default class MySQLAuthStore {
    constructor() {
        if (!MySQLAuthStore.pool) {
            const dbPoolLimit = Number.parseInt(process.env.DB_POOL_LIMIT ?? '30', 10);
            const dbPort = Number.parseInt(getEnv('DB_PORT', '3306'), 10);
            MySQLAuthStore.pool = mysql.createPool({
                host: getEnv('DB_HOST', '127.0.0.1'),
                port: Number.isNaN(dbPort) ? 3306 : dbPort,
                user: getEnv('DB_USER', 'root'),
                password: getEnv('DB_PASWD', ''),
                database: getEnv('DB_NAME', 'baileys_api'),
                waitForConnections: true,
                connectionLimit: Number.isNaN(dbPoolLimit) ? 30 : dbPoolLimit,
                queueLimit: 0,
                connectTimeout: 20000,
            });
        }

        this.pool = MySQLAuthStore.pool;
   
    }

    async getAllSessionIds() {
    const query = `
        SELECT session_id 
        FROM wa_sessions
        WHERE creds IS NOT NULL
    `;
    try {
        const [rows] = await this.pool.query(query); // Ejecuta la consulta
        return rows.map(row => row.session_id); // Extrae y devuelve todos los session_id
    } catch (error) {
        console.error('Error retrieving session IDs:', error);
        throw error; // Relanza el error para que sea manejado por el llamador
    }
}

	// Guardar credenciales en la base de datos
async setCredsData(sessionId, dataString, col /* 'creds' | 'session_keys' */) {
  if (!sessionId || typeof sessionId !== 'string') {
    console.warn('[AUTH] sessionId inválido para setCredsData');
    return;
  }

  // Valida columna por seguridad
  if (!['creds', 'session_keys'].includes(col)) {
    console.warn('[AUTH] Columna inválida para wa_sessions:', col);
    return;
  }

  // Serializa dentro del proceso por session_id
  return withSessionMutex(sessionId, async () => {
    const conn = await this.pool.getConnection();  // ← OJO: conexión dentro del mutex
    try {
      // Sesión “más amable” con bloqueos
      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.query('SET SESSION innodb_lock_wait_timeout = 10');

      // Lock asesor corto para evitar encolar conexiones por largos periodos
      const LOCK_KEY = `wa_sessions:${sessionId}`;
      const lockWaitSeconds = Number.parseInt(process.env.DB_LOCK_WAIT_SECONDS ?? '2', 10);
      const lockTimeout = Number.isNaN(lockWaitSeconds) ? 2 : lockWaitSeconds;
      const [r] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_KEY, lockTimeout]);
      const got = r?.[0]?.got === 1 ? 1 : 0;

      // Si no se logró el lock, NO tumbes el proceso
      if (!got) {
        console.warn(`[AUTH] Lock ocupado: ${LOCK_KEY} — guardado omitido (reintento en próximo evento)`);
        return; // ← sin throw
      }

      // Área crítica mínima: UPSERT de una sola columna
      const sql = `
        INSERT INTO wa_sessions (session_id, ${col})
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})
      `;
      const payload = encryptText(dataString);
      await conn.query(sql, [sessionId, payload]);

    } finally {
      // Suelta lock y cierra conexión aunque falle el query
      try { await conn.query('DO RELEASE_LOCK(?)', [`wa_sessions:${sessionId}`]); } catch {}
      conn.release();
    }
  });
}



    // Obtener credenciales o claves ('creds' o 'session_keys')
    async getCredsData(sessionId, col) {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('Invalid sessionId: It must be a non-empty string.');
        }

        if (!['creds', 'session_keys'].includes(col)) {
            throw new Error(`Invalid column name: ${col}`);
        }

        const query = `
            SELECT ${col}
            FROM wa_sessions
            WHERE session_id = ?
        `;
        try {
            const [rows] = await this.pool.query(query, [sessionId]);
            if (rows.length > 0) {
                const value = rows[0][col];
                return decryptText(value)
            }
            return null; // Si no hay filas para este `sessionId`
        } catch (error) {
            console.error('Error retrieving data:', error);
            throw error;
        }
    }



   // Eliminar una fila completa de la base de datos
  async deleteCredsData(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Invalid sessionId: It must be a non-empty string.');
    }

    const query = `
        DELETE FROM wa_sessions
        WHERE session_id = ?
    `;

    try {
        await this.pool.query(query, [sessionId]);
    } catch (error) {
        console.error('Error deleting row:', error);
        throw error;
    }
}

     
}

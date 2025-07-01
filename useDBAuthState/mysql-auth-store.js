import mysql from 'mysql2/promise';
 
export default class MySQLAuthStore {
    constructor() {
        this.pool = mysql.createPool({
            host: 'localhost',
            user: process.env.DB_USER,
            password: process.env.DB_PASWD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 15000,
        });
   
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
    async setCredsData(sessionId, value, col) {

        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('Invalid sessionId: It must be a non-empty string.');
        }

        if (!value) {
            throw new Error('Invalid value: It cannot be null or undefined.');
        }

        if (!['creds', 'session_keys'].includes(col)) {
            throw new Error(`Invalid column name: ${col}`);
        }

        const query = `
            INSERT INTO wa_sessions (session_id, ${col}) 
            VALUES (?, ?) 
            ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})
        `;

        try {
            const serializedValue = value 
            await this.pool.query(query, [sessionId, serializedValue]);
        } catch (error) {
            console.error('Error saving data:', error);
            throw error;
        }
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
                return value
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

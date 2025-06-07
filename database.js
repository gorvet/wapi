// database.js
import mysql from 'mysql2';
import { encrypt, decrypt } from './encryption.js';


// Configuración del pool de conexiones (mejor que una conexión única)
const dbConfig = {
    host: 'localhost',
    user:  process.env.DB_USER,
    password: process.env.DB_PASWD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 500,  // Limitamos el número de conexiones concurrentes
    queueLimit: 0,
    connectTimeout: 10000, // Tiempo de espera en milisegundos (10 segundos) para conectar al servidor MySQL

};

// Crear un pool de conexiones
const pool = mysql.createPool(dbConfig);

const parseAndDecryptSessionData = (sessionData) => {
    let { iv, encryptedData } = sessionData;
    let decryptedData = decrypt(encryptedData, iv);
    return JSON.parse(decryptedData);
};


// Función para obtener los datos de la sesión desde la base de datos

const readFromDatabase = async (sessionId) => {
    try {
        const [rows] = await pool.promise().query(
            'SELECT * FROM wasessions WHERE session_id = ?',
            [sessionId]
        );
        if (rows.length > 0 && rows[0].session_data != null) {
            const sessionData = parseAndDecryptSessionData(JSON.parse(rows[0].session_data));
            return sessionData;
        } else {
            throw new Error('Session not found');
        }
    } catch (err) {
        throw new Error(`Error al leer los datos: ${err.message}`);
    }
};


 
 
const writeToDatabase = async (sessionId, sessionData) => {
    const encryptedSessionData = JSON.stringify(encrypt(JSON.stringify(sessionData)));
    try {
        const query = `
            INSERT INTO wasessions (session_id, session_data)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE session_data = ?`;
        await pool.promise().query(query, [sessionId, encryptedSessionData, encryptedSessionData]);
    } catch (err) {
        console.error(`Error al guardar los datos en sesión (${sessionId}): ${err.message}`);
    }
};

 
const deleteFromDatabase = async (sessionId) => {
    try {
        const query = `DELETE FROM wasessions WHERE session_id = ?`;
        const [results] = await pool.promise().query(query, [sessionId]);
        return results.affectedRows > 0
            ? 'Sesión eliminada correctamente'
            : 'No se encontró la sesión especificada';
    } catch (err) {
        throw new Error(`Error al eliminar la sesión: ${err.message}`);
    }
};





export { readFromDatabase, writeToDatabase,deleteFromDatabase };
 
 
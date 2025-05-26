import mysql from 'mysql2/promise';

// Configuración del pool de conexiones MySQL
const dbConfig = mysql.createPool({
    host: 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASWD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
});

// Clase para manejar el almacenamiento de credenciales en MySQL
class MySQLStorage {

        // Obtener todos los session_id de la tabla wa_sessions
static async getAllSessionIds() {
    const query = `
        SELECT session_id 
        FROM wa_sessions
        WHERE creds IS NOT NULL
    `;

    try {
        const [rows] = await dbConfig.query(query); // Ejecuta la consulta
        return rows.map(row => row.session_id); // Extrae y devuelve todos los session_id
    } catch (error) {
        console.error('Error retrieving session IDs:', error);
        throw error; // Relanza el error para que sea manejado por el llamador
    }
}




    // Guardar datos en la base de datos
    static async setCredsData(sessionId, value, col) {
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
            const serializedValue = value //JSON.stringify(value)
           
            await dbConfig.query(query, [sessionId, serializedValue]);
        } catch (error) {
            console.error('Error saving data:', error);
            throw error;
        }
    }

    // Obtener datos de la base de datos
    static async getCredsData(sessionId, col) {

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
            const [rows] = await dbConfig.query(query, [sessionId]);
            if (rows.length > 0) {
                const value = rows[0][col];
                return value //? JSON.parse(value) : null; // Deserializa si no está vacío
            }
            return null; // Si no hay filas para este `sessionId`
        } catch (error) {
            console.error('Error retrieving data:', error);
            throw error;
        }
    }

     // Eliminar una fila completa de la base de datos
static async deleteCredsData(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Invalid sessionId: It must be a non-empty string.');
    }

    const query = `
        DELETE FROM wa_sessions
        WHERE session_id = ?
    `;

    try {
        await dbConfig.query(query, [sessionId]);
    } catch (error) {
        console.error('Error deleting row:', error);
        throw error;
    }
}

    static async setUserData(sessionId, sessionData) {
         //console.log("el sessionData",sessionData)
     if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Invalid sessionId: It must be a non-empty string.');
    }

    if (!sessionData || typeof sessionData !== 'object') {
        throw new Error('Invalid value: sessionData must be a non-null object.');
    }

    // Desestructura los datos necesarios
    const { chats = [], contacts = {}, messages = {}, labels = [], labelAssociations = [] } = sessionData;
      //console.log("sessionData",sessionData)
     //console.log("el  chats",chats)
       //console.log("el  messages",messages)
    // Consulta SQL
    const query = `
        INSERT INTO wa_sessions (session_id, chats, messages, labels, labelAssociations, fstore) 
        VALUES (?, ?, ?, ?, ?, ?) 
        ON DUPLICATE KEY UPDATE 
            chats = VALUES(chats), 
            messages = VALUES(messages), 
            labels = VALUES(labels), 
            labelAssociations = VALUES(labelAssociations), 
            fstore = VALUES(fstore)
    `;

    try {
        // Serializa los datos
        const serializedStore = JSON.stringify(sessionData);
        const serializedChats = JSON.stringify([...chats]);
        const serializedMessages = JSON.stringify([...messages]);
        const serializedLabels = JSON.stringify([...labels]);
        const serializedLabelAssociations = JSON.stringify([...labelAssociations]);

        // Ejecuta la consulta
        await dbConfig.query(query, [
            sessionId,
            serializedChats,
            serializedMessages,
            serializedLabels,
            serializedLabelAssociations,
            serializedStore,
        ]);

        //console.log('Datos de la sesión guardados exitosamente para:', sessionId);
    } catch (error) {
        console.error('Error guardando datos de la sesión:', error);
        throw error;
    }
}


    static async getUserData(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Invalid sessionId: It must be a non-empty string.');
    }

    const query = `
        SELECT fstore 
        FROM wa_sessions 
        WHERE session_id = ?
    `;

    try {
        // Ejecuta la consulta con el `sessionId` como parámetro
        const [rows] = await dbConfig.query(query, [sessionId]);

        // Verifica si hay datos
        if (rows.length === 0) {
            //console.log('No se encontraron filas para el session_id:', sessionId);
            return null; // Retorna explícitamente null si no hay resultados
        }

        const row = rows[0];
        console.log('Row recibido:', row.fstore);

        // Intenta deserializar el campo `fstore` completo
        let parsedFstore;
        try {
            parsedFstore = JSON.parse(row.fstore); // Deserializa `fstore` una sola vez
            console.log('Deserializado correctamente:', parsedFstore);
        } catch (error) {
            console.error('Error al deserializar fstore:', error.message);
            throw new Error('El dato fstore no es un JSON válido.');
        }

        // Devuelve el objeto deserializado directamente, sin volver a parsear sus propiedades
        return {
            chats: new Map(parsedFstore.chats || []),
            contacts: new Map(parsedFstore.contacts || []),
            messages: new Map(parsedFstore.messages || []),
            labels: new Map(parsedFstore.labels || []),
            labelAssociations: new Map(parsedFstore.labelAssociations || []),
        };
    } catch (error) {
        console.error('Error retrieving user data:', error);
        throw error;
    }
}



 static async setContacts(sessionId, newContacts) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Invalid sessionId: It must be a non-empty string.');
    }

    if (!Array.isArray(newContacts) || newContacts.some(contact => !contact.id || !contact.name)) {
        throw new Error('Invalid newContacts: It must be an array of objects with "id" and "name" properties.');
    }

    const selectQuery = `SELECT chats FROM wa_sessions WHERE session_id = ?`;
    const updateQuery = `
        INSERT INTO wa_sessions (session_id, chats) 
        VALUES (?, ?) 
        ON DUPLICATE KEY UPDATE chats = VALUES(chats)
    `;

    try {
        // Obtén los datos actuales
        const [rows] = await dbConfig.query(selectQuery, [sessionId]);
        let contacts = [];

        if (rows.length > 0 && rows[0].chats) {
            // Si ya hay datos en la columna `chats`, parsea el JSON
            contacts = JSON.parse(rows[0].chats);
        }

        // Agregar solo contactos nuevos que no existan ya
        newContacts.forEach(newContact => {
            // Verifica si el contacto ya existe para evitar duplicados
            const contactExists = contacts.some(contact => contact.id === newContact.id);
            if (!contactExists) {
                // Añadir el nuevo contacto
                contacts.push(newContact);
            }
        });

        // Serializa el JSON actualizado
        const updatedChats = JSON.stringify(contacts);

        // Actualiza la base de datos
        await dbConfig.query(updateQuery, [sessionId, updatedChats]);

        //console.log(`Lista de contactos añadida exitosamente para la sesión: ${sessionId}`);
    } catch (error) {
        //console.error('Error guardando los contactos:', error);
        throw error;
    }
}





}

export default MySQLStorage;

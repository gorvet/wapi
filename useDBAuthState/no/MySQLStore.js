// MySQLStore.js
import { EventEmitter } from 'events';
import mysql from 'mysql2/promise';

export default class MySQLStore extends EventEmitter {
  constructor(autoSaveInterval = 60000) {
    super();
this.pool = mysql.createPool({
      host: 'localhost',
      user: process.env.DB_USER,
      password: process.env.DB_PASWD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 30000,
    });
this.autoSaveInterval = autoSaveInterval;
    this._startAutoSave();
      }

_startAutoSave() {
    if (this.autoSaveInterval > 0) {
      this.autoSaveTimer = setInterval(() => {
        if (this.lastSessionId && this.lastSock) {
          this.saveFullStore(this.lastSessionId, this.lastSock).catch(console.error);
        }
      }, this.autoSaveInterval);
    }
  }

 async bind(sock, sessionId) {
    this.lastSessionId = sessionId;
    this.lastSock = sock;

    sock.ev.on('chats.upsert', chats => this.saveChats(sessionId, chats));
    sock.ev.on('messages.upsert', m => this.saveMessages(sessionId, m.messages));
    sock.ev.on('contacts.upsert', contacts => this.saveContacts(sessionId, contacts));
    sock.ev.on('groups.update', groups => this.saveGroups(sessionId, groups));

    await this.preload(sessionId, sock);
  }

  
 async saveChats(sessionId, chats) {
    await this.pool.query(
      `INSERT INTO wa_sessions (session_id, chats) VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE chats = VALUES(chats)`,
      [sessionId, JSON.stringify(chats)]
    );
  }


async saveMessages(sessionId, messages) {
    await this.pool.query(
      `INSERT INTO wa_sessions (session_id, messages) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE messages = VALUES(messages)`,
      [sessionId, JSON.stringify(messages)]
    );
  }

async saveContacts(sessionId, contacts) {
    await this.pool.query(
      `INSERT INTO wa_sessions (session_id, contacts) VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE contacts = VALUES(contacts)`,
      [sessionId, JSON.stringify(contacts)]
    );
  }
  
async saveFullStore(sock,sessionId) {
    const fullStore = {
      chats: Array.from(sock.chats.entries()),
      contacts: Array.from(sock.contacts.entries()),
      messages: Array.from(sock.messages.entries()),
      groupMetadata: Array.from(sock.groupMetadata.entries()),
    };
    await this.pool.query(
      `INSERT INTO wa_sessions (session_id, fstore) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE fstore = VALUES(fstore)`,
      [sessionId, JSON.stringify(fullStore)]
    );
  }
   
  async loadChats(sessionId) {
  const [rows] = await this.pool.query(`
    SELECT chats FROM wa_sessions WHERE session_id = ?
  `, [sessionId]);

  if (rows.length && rows[0].chats) {
    return JSON.parse(rows[0].chats);
  }

  return [];
}


  async loadMessages(sessionId) {
    const [rows] = await this.pool.query(`SELECT messages FROM wa_sessions WHERE session_id = ?`, [sessionId]);
    return rows.map(r => JSON.parse(r.data));
  }
  

  async loadContacts(sessionId) {
    const [rows] = await this.pool.query(`SELECT contacts FROM wa_sessions WHERE session_id = ?`, [sessionId]);
    return rows.map(r => JSON.parse(r.data));
  }

  async loadGroups(sessionId) {
    const [rows] = await this.pool.query(`SELECT contacts FROM wa_sessions WHERE session_id = ?`, [sessionId]);
    return rows.map(r => JSON.parse(r.data));
  }
 // Métodos opcionales si deseas precargar los datos al iniciar
  async preload(sock) {
    const chats = await this.loadChats()
    const contacts = await this.loadContacts()
    const groups = await this.loadGroups()

    for (const c of chats) sock.chats.set(c.id, c)
    for (const c of contacts) sock.contacts.set(c.id, c)
    for (const g of groups) sock.groupMetadata.set(g.id, g)
  }


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
                return value //? JSON.parse(value) : null; // Deserializa si no está vacío
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

 
// Guardar datos en la base de datos
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
            const serializedValue = value //JSON.stringify(value)
           
            await this.pool.query(query, [sessionId, serializedValue]);
        } catch (error) {
            console.error('Error saving data:', error);
            throw error;
        }
    }

 

}


import connection from './db.js';

// Función para guardar los datos de la sesión en la base de datos
function saveSession(sessionId, credentials, sessionKeys, chats, contacts, messages, labels, labelAssociations) {
  const query = `INSERT INTO wa_sessions (session_id, credentials, session_keys, chats, contacts, messages, labels, labelAssociations)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE 
                 credentials = VALUES(credentials), 
                 session_keys = VALUES(session_keys), 
                 chats = VALUES(chats), 
                 contacts = VALUES(contacts), 
                 messages = VALUES(messages), 
                 labels = VALUES(labels), 
                 labelAssociations = VALUES(labelAssociations), 
                 updated_at = CURRENT_TIMESTAMP`;

  const values = [sessionId, credentials, sessionKeys, chats, contacts, messages, labels, labelAssociations];

  db.execute(query, values, (err, results) => {
    if (err) {
      console.error('Error saving session:', err);
    } else {
      console.log('Session saved/updated successfully.');
    }
  });
}

// Función para cargar los datos de la sesión desde la base de datos
function loadSession(sessionId, callback) {
  const query = `SELECT * FROM wa_sessions WHERE session_id = ?`;

  db.execute(query, [sessionId], (err, results) => {
    if (err) {
      console.error('Error loading session:', err);
      callback(err, null);
    } else {
      if (results.length > 0) {
        callback(null, results[0]);
      } else {
        callback('Session not found', null);
      }
    }
  });
}

 export { saveSession, loadSession };

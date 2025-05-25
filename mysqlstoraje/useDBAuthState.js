import MySQLStorage from './mysqlStorage.js';

import { WAProto as proto, initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

//import { initAuthCreds } from './node_modules/@whiskeysockets/baileys/lib/Utils/auth-utils.js'; // Asegúrate de incluir la extensión .js
//import WAProto from './node_modules/@whiskeysockets/baileys/WAProto/index.js'; // Importa el módulo completo
//const { proto } = WAProto;

const useDBAuthState = async (sessionId) => {
    if (!sessionId) {
        throw new Error('sessionId is required to manage authentication state.');
    }
    
    // Cargar credenciales iniciales o generar nuevas si no existen
     const dataRaw = await MySQLStorage.getCredsData(sessionId, 'creds')  || JSON.stringify((0, initAuthCreds)());
     const creds = JSON.parse(dataRaw, BufferJSON.reviver);

      return { 
        state: {
            creds,
            keys: {
                get: async (type, ids) => { 
                    const data = {};
                    const allKeysRaw = await MySQLStorage.getCredsData(sessionId, 'session_keys') //|| '{}';
                    if (!allKeysRaw) {
                        console.error('No se encontraron datos de claves para la sesión:', sessionId);
                        return {}; // Devuelve un objeto vacío si no se encuentran datos
                    }
                    const allKeys = JSON.parse(allKeysRaw, BufferJSON.reviver);


                     ids.forEach((id) => {
                        let value = allKeys[`${type}-${id}`] || null;
                         // Si es una clave específica, convertirla al formato adecuado
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    });

                    return data;
                },

                // Guardar claves en la base de datos
                set: async (data) => {   
                      const allKeys = {};
                     for (const category in data) {
                         for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                allKeys[`${category}-${id}`] = value;
                            }
                            //const dataString = JSON.stringify(data, BufferJSON.replacer);
                            //tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                      const allKeysString= JSON.stringify(allKeys, BufferJSON.replacer);
                      //await Promise.all(allKeys);
                     await MySQLStorage.setCredsData(sessionId, allKeysString, 'session_keys');
                },
            },
        },

        // Guardar credenciales en la base de datos
        saveCreds: async () => {
            const dataString = JSON.stringify(creds, BufferJSON.replacer);
            await MySQLStorage.setCredsData(sessionId, dataString, 'creds'); //se jonsifica el mysql...js
        },
    };
};
export default useDBAuthState;

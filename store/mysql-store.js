import { jidNormalizedUser, toNumber, isJidUser } from 'baileys';
import { EventEmitter } from 'events';
import mysql from 'mysql2/promise';

class ConcurrentStore extends EventEmitter {
    constructor(options = {}) {
        super();

        this.config = {
            maxMessagesPerChat: options.maxMessagesPerChat || 5000,
            autoSaveInterval: options.autoSaveInterval || 60000,
            batchSize: options.batchSize || 500,
            sessionId: options.sessionId || "",//?,
            // **New options for data preservation**
            preserveDataDuringSync: options.preserveDataDuringSync !== false, // true by default
            backupBeforeSync: options.backupBeforeSync !== false, // true by default
            incrementalSave: options.incrementalSave !== false, // true by default
            ...options
        };
        this.sessionId = this.config.sessionId;
        this.pool = mysql.createPool({
            host: 'localhost',
            user: process.env.DB_USER,
            password: process.env.DB_PASWD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 30,
            queueLimit: 0,
            connectTimeout: 15000,
    });

        // **Main stores**
        this.chats = new Map();
        this.messages = new Map();
        this.contacts = new Map();
        this.groupMetadata = new Map();

        // **Synchronization control**
        this.isProcessingHistory = false;
        this.syncStartTime = null;
        this.hasInitialData = false;

        
        // **Concurrency control**
        this.writeLocks = new Map();
        this.pendingWrites = new Set();
        this.isWriting = false;
        this.lastSuccessfulSave = null;

        // **Metrics**
        this.stats = {
            totalMessages: 0,
            totalChats: 0,
            totalContacts: 0,
            lastSave: null,
            operations: 0
        };

        // **Intelligent auto-save that preserves data**
        if (this.config.autoSaveInterval > 0) {
            this.autoSaveTimer = setInterval(() => {
                this.smartAutoSave().catch(console.error);
            }, this.config.autoSaveInterval);
        }
    }

    // **Auto-save inteligente que no borra datos durante sync**
    async smartAutoSave() {
        // Do not save if we are in the middle of a heavy synchronization
        if (this.isProcessingHistory && this.syncStartTime &&
            (Date.now() - this.syncStartTime) < 30000) { // First 30 seconds of sync
            // console.log('⏳ Skipping auto-save during initial sync phase');
            return;
        }

        // Only save if we have valid data
        if (this.hasValidData()) {
            await this.writeToMySQL();
        }
    }
 
    //**Check if we have valid data to save**
    hasValidData() {
        return this.chats.size > 0 || this.messages.size > 0 || this.contacts.size > 0;
    }

     
    // **IMPROVED METHOD: processHistorySet with data preservation**
    async processHistorySet(historyData) {
        const {
            chats: newChats = [],
            contacts: newContacts = [],
            messages: newMessages = [],
            isLatest = false,
            syncType = 0,
            progress = 0
        } = historyData;

        if (syncType === 6) {
            // console.log(`📱 On-demand history sync: ${newMessages.length} messages`);
            return;
        }

        // **Mark start of synchronization**
        if (!this.isProcessingHistory) {
            this.isProcessingHistory = true;
            this.syncStartTime = Date.now();
        }

        try {
            // console.log(`🔄 Processing history: ${newChats.length} chats, ${newContacts.length} contacts, ${newMessages.length} messages (${progress}%)`);

            // **Solo limpiar si realmente tenemos datos nuevos significativos**
            if (isLatest && (newChats.length > 10 || newMessages.length > 100)) {
                // console.log('🧹 Clearing for latest sync with significant data...');
                this.chats.clear();
                this.messages.clear();
            }  

            // **Process new data**
            const promises = [];

            if (newChats.length > 0) {
                promises.push(this.processChatsOptimized(newChats));
            }

            if (newContacts.length > 0) {
                promises.push(this.processContactsOptimized(newContacts));
            }

            if (newMessages.length > 0) {
                promises.push(this.processMessagesOptimized(newMessages));
            }

            await Promise.all(promises);

            // **Update Stats**
            this.updateStats();

            const processingTime = Date.now() - this.syncStartTime;
            // console.log(`✅ History batch processed in ${processingTime}ms`);

            if (this.config.incrementalSave && this.hasValidData() && processingTime > 5000) {
                await this.writeToMySQL();
                // console.log('💾 Incremental save completed');
            }

            this.emit('store.history-processed', {
                chats: newChats.length,
                contacts: newContacts.length,
                messages: newMessages.length,
                processingTime,
                isLatest,
                syncType,
                progress
            });

        } catch (error) {
            // console.error('❌ Error processing history set:', error);

            

            this.emit('store.error', error);
        } finally {
            // **End synchronization process**
            if (isLatest || progress >= 100) {
                await this.finalizeSyncProcess();
            }
        }
    }

    // **End synchronization process**
    async finalizeSyncProcess() {
        try {
            const totalTime = Date.now() - this.syncStartTime;
            console.log(`🏁 Sync process completed in ${totalTime}ms`);

            // **Final save only if we have valid data**
            if (this.hasValidData()) {
                await this.writeToMySQL();
                // console.log('💾 Final save completed');
            }  

        } catch (error) {
            // console.error('❌ Error finalizing sync:', error);
        } finally {
            this.isProcessingHistory = false;
            this.syncStartTime = null;
        }
    }

    

    // **Secure writing that preserves data**
    async writeToMySQL() {
        const sessionId = this.sessionId;
        

        if (this.isWriting) {
            this.pendingWrites.add(sessionId);
            return;
        }

        if (!this.hasValidData()) {
            // console.log('⚠️ Skipping write - no valid data to save');
            return;
        }

        try {
            this.isWriting = true;
            await this.acquireWriteLock('mysql');

            const data = await this.serializeStoreData();
            const fstore = JSON.stringify(data);
            const chats = JSON.stringify(data.chats || []);
            const contacts = JSON.stringify(data.contacts || []);
            const messages = JSON.stringify(data.messages || {});
            console.log("insertando store para" + sessionId)
            //console.log(fstore)

            await this.pool.execute(
                `INSERT INTO wa_sessions (session_id, fstore, chats, contacts, messages)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                fstore = VALUES(fstore),
                chats = VALUES(chats),
                contacts = VALUES(contacts),
                messages = VALUES(messages)`,
                [sessionId, fstore, chats, contacts, messages]
            );
            console.log("✅ Query ejecutada (o al menos no reventó)");

            this.stats.lastSave = new Date();
            this.lastSuccessfulSave = Date.now();

            this.emit('store.saved', {
                sessionId,
                size: fstore.length,
                timestamp: this.stats.lastSave
            });

        } catch (error) {
            this.emit('store.error', error);
        } finally {
            this.isWriting = false;
            this.releaseWriteLock('mysql');

            // Procesar escrituras pendientes
            if (this.pendingWrites.size > 0) {
                const nextSessionId = this.pendingWrites.values().next().value;
                this.pendingWrites.delete(nextSessionId);
                setImmediate(() => this.writeToMySQL(nextSessionId));
            }   
        }
    }

     
 
    // **Read datas from db**
    async readFromMySQL(sessionId) {
        try {
            await this.acquireWriteLock('mysql');
            
            const [rows] = await this.pool.execute(
            'SELECT fstore FROM wa_sessions WHERE session_id = ? LIMIT 1',
            [sessionId]
            );  
            const raw = rows?.[0]?.fstore;

            // Verifica que exista y no esté vacío o corrupto
            if (!raw || typeof raw !== 'string' || raw.trim().length < 10) {
                // console.log('⚠️ No se encontró contenido válido en la base de datos para '+ sessionId);
                return;
            }

            let data;
            try {
                data = JSON.parse(raw);
            } catch (err) {
                throw new Error('❌ El contenido de fstore no es un JSON válido');
            }

            if (!this.validateStoreData(data)) {
                throw new Error('❌ Estructura de datos inválida en el store');
            }

            await this.loadStoreData(data);

            this.stats.lastSave = new Date();
            this.hasInitialData = true;

            // console.log(`✅ Store cargado desde MySQL: ${this.stats.totalChats} chats, ${this.stats.totalMessages} mensajes, ${this.stats.totalContacts} contactos`);

            this.emit('store.loaded', { source: 'mysql', sessionId });

            } catch (error) {
                this.emit('store.error', error);
            } finally {
                this.releaseWriteLock('mysql');
        }
    }
 

    // **Other methods optimized...**
    async processChatsOptimized(newChats) {
        let processed = 0;
        const batchSize = Math.min(1000, newChats.length);

        for (let i = 0; i < newChats.length; i += batchSize) {
            const batch = newChats.slice(i, i + batchSize);

            for (const chat of batch) {
                if (!this.chats.has(chat.id)) {
                    this.chats.set(chat.id, {
                        ...chat,
                        syncedAt: Date.now()
                    });
                    processed++;
                }
            }

            if (i + batchSize < newChats.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        if (processed > 0) {
            console.log(`📋 Processed ${processed} chats`);
        }
    }

    async processContactsOptimized(newContacts) {
        let processed = 0;
        const batchSize = Math.min(2000, newContacts.length);

        for (let i = 0; i < newContacts.length; i += batchSize) {
            const batch = newContacts.slice(i, i + batchSize);

            for (const contact of batch) {
                try {
                    const jid = jidNormalizedUser(contact.id);

                     if (!isJidUser(jid)) {
                        continue;
                    }

                    this.contacts.set(jid, {
                        ...contact,
                        lastUpdated: Date.now()
                    });
                    processed++;
                } catch (error) {
                    // Mute individual errors
                }
            }

            if (i + batchSize < newContacts.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        if (processed > 0) {
            console.log(`👥 Processed ${processed} contacts`);
        }
    }

    async processMessagesOptimized(newMessages) {
        let processed = 0;
        const messagesByChat = new Map();

        // Group by chat
        for (const msg of newMessages) {
            try {
                const jid = jidNormalizedUser(msg.key.remoteJid);
                if (!messagesByChat.has(jid)) {
                    messagesByChat.set(jid, []);
                }
                messagesByChat.get(jid).push(msg);
            } catch (error) {
                // Mute individual errors
            }
        }

        // Process by chat
        for (const [jid, chatMessages] of messagesByChat.entries()) {
            const added = await this.processChatMessages(jid, chatMessages);
            processed += added;
        }

        // if (processed > 0) {
        //     console.log(`💬 Processed ${processed} messages`);
        // }
    }

    async processChatMessages(jid, chatMessages) {
        if (!this.messages.has(jid)) {
            this.messages.set(jid, new Map());
        }

        const existingMessages = this.messages.get(jid);
        let added = 0;

        for (const msg of chatMessages) {
            if (!existingMessages.has(msg.key.id)) {
                existingMessages.set(msg.key.id, {
                    ...msg,
                    timestamp: Date.now(),
                    indexed: true
                });
                added++;
            }
        }

        // Aplicar límite
        if (existingMessages.size > this.config.maxMessagesPerChat) {
            const sortedMessages = Array.from(existingMessages.entries())
                .sort(([, a], [, b]) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

            const toDelete = sortedMessages.slice(0, existingMessages.size - this.config.maxMessagesPerChat);
            toDelete.forEach(([id]) => existingMessages.delete(id));
        }

        return added;
    }

    // **Binding con preservación de datos**
    bind(ev) {
        ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
            if (this.isProcessingHistory && newMessages.length > 100) {
                return; // Skip durante sync pesado
            }

            try {
                await this.processBatch(newMessages.map(msg => ({
                    jid: jidNormalizedUser(msg.key.remoteJid),
                    msg,
                    type
                })), type);
            } catch (error) {
                console.error('Error processing messages.upsert:', error);
            }
        });

        ev.on('messaging-history.set', async (historyData) => {
            try {
                await this.processHistorySet(historyData);
            } catch (error) {
                console.error('Error processing messaging-history.set:', error);
                this.emit('store.error', error);
            }
        });

        // Resto de eventos...
        ev.on('chats.upsert', async (newChats) => {
            if (this.isProcessingHistory) return;

            try {
                for (const chat of newChats) {
                    await this.upsertChat(chat);
                }
            } catch (error) {
                console.error('Error processing chats.upsert:', error);
            }
        });

        ev.on('chats.update', async (updates) => {
            try {
                for (const update of updates) {
                    await this.updateChat(update);
                }
            } catch (error) {
                console.error('Error processing chats.update:', error);
            }
        });

        ev.on('chats.set', async ({ chats: newChats }) => {
            try {
                for (const chat of newChats) {
                    await this.upsertChat(chat);
                }
            } catch (error) {
                console.error('Error processing chats.set:', error);
            }
        });

        ev.on('chats.delete', async (deletions) => {
            try {
                for (const chatId of deletions) {
                    this.chats.delete(chatId);
                    this.messages.delete(chatId);
                }
                this.updateStats();
            } catch (error) {
                // console.error('Error processing chats.delete:', error);
            }
        });

        ev.on('contacts.upsert', async (newContacts) => {
            try {
                await this.processContactsUpsert(newContacts);
            } catch (error) {
                // console.error('Error processing contacts.upsert:', error);
            }
        });

        ev.on('groups.update', async (updates) => {
            try {
                for (const update of updates) {
                    await this.updateGroupMetadata(update);
                }
            } catch (error) {
                // console.error('Error processing groups.update:', error);
            }
        });
    }


    async updateChat(update) {
        const existing = this.chats.get(update.id);

        if (existing) {
            if (update.unreadCount > 0) {
                update.unreadCount = (existing.unreadCount || 0) + update.unreadCount;
            }

            Object.assign(existing, {
                ...update,
                lastUpdated: Date.now()
            });

            this.emit('store.chat-updated', update);
        }
    }

    // **Método auxiliar para procesar contactos**
    async processContactsUpsert(newContacts) {
        let processed = 0;

        for (const contact of newContacts) {
            try {
                const jid = jidNormalizedUser(contact.id);
                const existing = this.contacts.get(jid);

                this.contacts.set(jid, {
                    ...(existing || {}),
                    ...contact,
                    lastUpdated: Date.now()
                });

                processed++;
            } catch (error) {
                console.error('Error processing contact:', contact.id, error);
            }
        }

        return processed;
    }

    // **Auxiliary methods**
    async addMessage(jid, message) {

        if (message.fromMe) {
            if (message?.message?.protocolMessage?.historySyncNotification) {
                return; // Do not process protocol messages
            }
        }

        const normalizedJid = jidNormalizedUser(jid);

        if (!this.messages.has(normalizedJid)) {
            this.messages.set(normalizedJid, new Map());
        }

        const chatMessages = this.messages.get(normalizedJid);
        chatMessages.set(message.key.id, {
            ...message,
            timestamp: Date.now(),
            indexed: true
        });

        if (chatMessages.size > this.config.maxMessagesPerChat) {
            const sortedMessages = Array.from(chatMessages.entries())
                .sort(([, a], [, b]) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

            const toDelete = sortedMessages.slice(0, chatMessages.size - this.config.maxMessagesPerChat);
            toDelete.forEach(([id]) => chatMessages.delete(id));
        }

        this.stats.totalMessages++;
        this.stats.operations++;

        if (!this.isProcessingHistory) {
            this.emit('store.message-added', { jid: normalizedJid, message });
        }
    }

    async processBatch(batch, type) {
        const promises = batch.map(async ({ jid, msg }) => {
            await this.addMessage(jid, msg);

            if (type === 'notify' && !this.chats.has(jid)) {
                await this.upsertChat({
                    id: jid,
                    conversationTimestamp: toNumber(msg.messageTimestamp),
                    unreadCount: 1
                });
            }
        });

        await Promise.all(promises);
    }

    async upsertChat(chat) {
        const existing = this.chats.get(chat.id);

        if (existing) {
            Object.assign(existing, {
                ...chat,
                lastUpdated: Date.now()
            });
        } else {
            this.chats.set(chat.id, {
                ...chat,
                createdAt: Date.now(),
                lastUpdated: Date.now()
            });
            this.stats.totalChats++;
        }

        if (!this.isProcessingHistory) {
            this.emit('store.chat-upserted', chat);
        }
    }

    updateStats() {
        this.stats.totalChats = this.chats.size;
        this.stats.totalContacts = this.contacts.size;
        this.stats.totalMessages = Array.from(this.messages.values())
            .reduce((total, chatMsgs) => total + chatMsgs.size, 0);
    }

    async acquireWriteLock(key) {
        while (this.writeLocks.has(key)) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.writeLocks.set(key, true);
    }

    releaseWriteLock(key) {
        this.writeLocks.delete(key);
    }

    validateStoreData(data) {
        return data &&
            typeof data === 'object' &&
            (Array.isArray(data.chats) || typeof data.chats === 'object') &&
            typeof data.messages === 'object' &&
            typeof data.contacts === 'object';
    }

    async loadStoreData(data) {
        // Load chats
        if (Array.isArray(data.chats)) {
            for (const [jid, chat] of data.chats) {
                this.chats.set(jid, chat);
            }
        }

        // Load messages
        for (const [jid, msgs] of Object.entries(data.messages || {})) {
            this.messages.set(jid, new Map(msgs));
        }

        // Load contacts
        if (Array.isArray(data.contacts)) {
            for (const [jid, contact] of data.contacts) {
                this.contacts.set(jid, contact);
            }
        } else {
            for (const [jid, contact] of Object.entries(data.contacts || {})) {
                this.contacts.set(jid, contact);
            }
        }

        // Load group metadata
        if (data.groupMetadata) {
            for (const [jid, meta] of data.groupMetadata) {
                this.groupMetadata.set(jid, meta);
            }
        }

        this.updateStats();
    }

    async serializeStoreData() {
        return {
            version: '2.0',
            timestamp: Date.now(),
            chats: [...this.chats.entries()],
            messages: Object.fromEntries(
                [...this.messages.entries()].map(([jid, msgs]) => [
                    jid,
                    [...msgs.entries()]
                ])
            ),
            contacts: [...this.contacts.entries()],
            groupMetadata: [...this.groupMetadata.entries()],
            stats: this.stats
        };
    }

    getStats() {
        return {
            ...this.stats,
            isProcessingHistory: this.isProcessingHistory,
            hasInitialData: this.hasInitialData,
            lastSuccessfulSave: this.lastSuccessfulSave,
            memoryUsage: process.memoryUsage(),
            uptime: process.uptime()
        };
    }

    async cleanup() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }

        if (this.hasValidData()) {
            await this.writeToMySQL(); 
        }

        this.removeAllListeners();
    }

    // Compatibility methods
    async fetchGroupMetadata(jid, sock) {
        try {
            const metadata = await sock.groupMetadata(jid);
            await this.updateGroupMetadata(metadata);
            return metadata;
        } catch (err) {
            // console.error('Failed to fetch group metadata:', err.message);
            return null;
        }
    }

    async updateGroupMetadata(update) {
        const existing = this.groupMetadata.get(update.id);

        this.groupMetadata.set(update.id, {
            ...(existing || {}),
            ...update,
            lastUpdated: Date.now()
        });

        if (!this.isProcessingHistory) {
            this.emit('store.group-updated', update);
        }
    }

    getLastMessage(jid) {
        const normalizedJid = jidNormalizedUser(jid);
        const chatMessages = this.messages.get(normalizedJid);

        if (!chatMessages || chatMessages.size === 0) return null;

        const msgsArray = Array.from(chatMessages.values());
        return msgsArray.sort((a, b) =>
            (b.messageTimestamp || 0) - (a.messageTimestamp || 0)
        )[0];
    }

    getContactList(type = 'all') {
        if (type === 'saved') {
            return Array.from(this.contacts.values())
                .filter(contact => contact?.name && isJidUser(contact.id))
                .map(contact => contact.id);
        }

        if (type === 'all') {
            return Array.from(this.contacts.keys())
                .filter(jid => isJidUser(jid))
                .map(jid => jid);
        }

        if (type === 'conversations') {
            return Array.from(this.contacts.values())
                .filter(contact => contact?.id && isJidUser(contact.id))
                .map(contact => contact.id);
        }
        return [];
    }

    async loadMessages(jid, messageId = null, options = {}) {
        const {
            limit = 50,
            offset = 0,
            before = null,
            after = null,
            sortOrder = 'desc'
        } = options;

        const normalizedJid = jidNormalizedUser(jid);
        const chatMessages = this.messages.get(normalizedJid);

        if (!chatMessages) return [];

        // **If messageId is provided, search for that specific message**
        if (messageId) {
            const message = chatMessages.get(messageId);
            return message ? [message] : [];
        }

        // **Original behavior if there is no messageId**
        let msgsArray = Array.from(chatMessages.values());

        if (before) {
            msgsArray = msgsArray.filter(msg =>
                (msg.messageTimestamp || 0) < before
            );
        }

        if (after) {
            msgsArray = msgsArray.filter(msg =>
                (msg.messageTimestamp || 0) > after
            );
        }

        msgsArray.sort((a, b) => {
            const dateA = a.messageTimestamp || 0;
            const dateB = b.messageTimestamp || 0;
            return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        });

        return msgsArray.slice(offset, offset + limit);
    }
}

function makeMySQLStore(options = {}) {
    return new ConcurrentStore(options);
}

export default makeMySQLStore;
export { ConcurrentStore };

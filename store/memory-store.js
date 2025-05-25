import fs from 'fs';
import path from 'path';
import proto from 'baileys'
import { jidNormalizedUser, toNumber } from 'baileys';

function makeInMemoryStore() {
    const chats = new Map();
    const messages = new Map(); // { jid: Map<id, msg> }
    const contacts = {};
    const groupMetadata = new Map();

    const bind = (ev) => {
        ev.on('messages.upsert', ({ messages: newMessages, type }) => {
            switch (type) {
                case 'append':
                case 'notify':
                    for (const msg of newMessages) {
                        const jid = jidNormalizedUser(msg.key.remoteJid);
                        
                        if (!messages.has(jid)) {
                            messages.set(jid, new Map());
                        }
                        const list = messages.get(jid);
        
                        list.set(msg.key.id, msg);

                        if (type === 'notify' && !chats.has(jid)) {
                            ev.emit('chats.upsert', [
                                {
                                    id: jid,
                                    conversationTimestamp: toNumber(msg.messageTimestamp),
                                    unreadCount: 1
                                }
                            ]);
                        }
                    }
                    break;
            }
        });

        ev.on('messaging-history.set', ({
            chats: newChats,
            contacts: newContacts,
            messages: newMessages,
            isLatest,
            syncType
        }) => {
            if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                return;
            }

            if (isLatest) {
                chats.clear();

                for (const jid of messages.keys()) {
                    messages.delete(jid);
                }
            }

            let chatsAdded = 0;
            for (const chat of newChats) {
                if (!chats.has(chat.id)) {
                    chats.set(chat.id, chat);
                    chatsAdded++;
                }
            }

            const oldContacts = contactsUpsert(newContacts);
            if (isLatest) {
                for (const jid of oldContacts) {
                    delete contacts[jid];
                }
            }

            for (const msg of newMessages) {
                const jid = msg.key.remoteJid;
                const list = assertMessageList(jid);
                list.set(msg.key.id, msg);
            }

        });


        ev.on('chats.upsert', newChats => {
            for (const chat of newChats) {
                chats.set(chat.id, chat);
            }
        });

        ev.on('chats.update', updates => {
            for (let update of updates) {
                const existing = chats.get(update.id);

                if (existing) {
                    if (update.unreadCount > 0) {
                        update = { ...update }; 
                        update.unreadCount = (existing.unreadCount || 0) + update.unreadCount;
                    }

                    Object.assign(existing, update);
                } 
            }
        });

        ev.on('chats.set', ({ chats: newChats }) => {
            for (const chat of newChats) {
                chats.set(chat.id, chat);
            }
        });

        ev.on('chats.delete', deletions => {
            for (const item of deletions) {
                if (chats.has(item)) {
                    chats.delete(item);
                }
            }
        });

        ev.on('contacts.upsert', (newContacts) => {
            for (const contact of newContacts) {
                contacts[contact.id] = contact;
            }
        });

        ev.on('groups.update', (updates) => {
            for (const update of updates) {
                if (groupMetadata.has(update.id)) {
                    const current = groupMetadata.get(update.id);
                    groupMetadata.set(update.id, { ...current, ...update });
                } else {
                    groupMetadata.set(update.id, update);
                }
            }
        });
    };

    const readFromFile = (file = path.resolve(__dirname, '../baileys_store.json')) => {
        if (!fs.existsSync(file)) {
            return;
        };

        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            for (const [jid, chat] of raw.chats || []) chats.set(jid, chat);
            for (const [jid, msgs] of Object.entries(raw.messages || {})) {
                messages.set(jid, new Map(msgs));
            }
            Object.assign(contacts, raw.contacts || {});
            for (const [jid, meta] of raw.groupMetadata || []) groupMetadata.set(jid, meta);
        } catch (err) {
            console.error('Failed to read store:', err.message);
        }
    };

    const writeToFile = (file = path.resolve(__dirname, '../baileys_store.json')) => {
        try {
            const data = {
                chats: [...chats.entries()],
                messages: Object.fromEntries(
                    [...messages.entries()].map(([jid, msgs]) => [jid, [...msgs.entries()]])
                ),
                contacts,
                groupMetadata: [...groupMetadata.entries()]
            };
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('Failed to write store:', err.message);
        }
    };

    const loadMessage = async (jid, id) => {
        const msgs = messages.get(jid);
        if (!msgs) return undefined;
        return msgs.get(id);
    };

    const fetchGroupMetadata = async (jid, sock) => {
        try {
            const metadata = await sock.groupMetadata(jid);
            groupMetadata.set(jid, metadata);
            return metadata;
        } catch (err) {
            console.error('Failed to fetch group metadata:', err.message);
            return null;
        }
    };

    return {
        chats,
        messages,
        contacts,
        groupMetadata,
        bind,
        readFromFile,
        writeToFile,
        loadMessage,
        fetchGroupMetadata,
    };
}

export default makeInMemoryStore;
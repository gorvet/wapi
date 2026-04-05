import { rmSync, readdir, existsSync } from 'fs'
import { join } from 'path'
import pino from 'pino'
import makeWASocketModule, {
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay,
    downloadMediaMessage,
    getAggregateVotesInPollMessage,
    fetchLatestBaileysVersion,
    WAMessageStatus,
} from 'baileys'

import proto from 'baileys'

import makeInMemoryStore from './store/memory-store.js'

import { toDataURL } from 'qrcode'
import __dirname from './dirname.js'
import response from './response.js'
import { downloadImage } from './utils/download.js'
import axios from 'axios'
import NodeCache from 'node-cache'

import https from 'https';

import makeMySQLStore from './store/mysql-store.js';
import MySQLAuthStore from './useDBAuthState/mysql-auth-store.js';

import useDBAuthState from './useDBAuthState/useDBAuthState.js';

const msgRetryCounterCache = new NodeCache()

const sessions = new Map()
const retries = new Map()
const creatingSessions = new Set()

const SESSION_STORAGE_DRIVER_RAW = (process.env.SESSION_STORAGE_DRIVER ?? 'mysql').toLowerCase()
const SESSION_STORAGE_DRIVER = ['mysql', 'json'].includes(SESSION_STORAGE_DRIVER_RAW)
    ? SESSION_STORAGE_DRIVER_RAW
    : 'mysql'
const IS_MYSQL_STORAGE = SESSION_STORAGE_DRIVER === 'mysql'
const authStore = IS_MYSQL_STORAGE ? new MySQLAuthStore() : null

if (SESSION_STORAGE_DRIVER_RAW !== SESSION_STORAGE_DRIVER) {
    console.warn(
        `[STORAGE] SESSION_STORAGE_DRIVER invalido: "${SESSION_STORAGE_DRIVER_RAW}". Se usara "${SESSION_STORAGE_DRIVER}".`,
    )
}

const APP_WEBHOOK_ALLOWED_EVENTS = (process.env.APP_WEBHOOK_ALLOWED_EVENTS ?? 'ALL').split(',')

const sessionsDir = (sessionId = '') => {
    return join(__dirname, 'sessions', sessionId ? sessionId : '')
}

const removeLocalSessionFiles = (sessionId) => {
    const sessionFile = 'md_' + sessionId
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    const authPath = sessionsDir(sessionFile)
    const storePath = sessionsDir(storeFile)

    if (existsSync(authPath)) {
        rmSync(authPath, rmOptions)
    }

    if (existsSync(storePath)) {
        rmSync(storePath, rmOptions)
    }
}

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const isSessionConnected = (sessionId) => {
    return sessions.get(sessionId)?.ws?.socket?.readyState === 1
}

const shouldReconnect = (sessionId) => {
    const maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let attempts = retries.get(sessionId) ?? 0

    // MaxRetries = maxRetries < 1 ? 1 : maxRetries
    if (attempts < maxRetries || maxRetries === -1) {
        ++attempts

        console.log('Reconnecting...', { attempts, sessionId })
        retries.set(sessionId, attempts)

        return true
    }

    return false
}

const callWebhook = async (instance, eventType, eventData) => {
    if (APP_WEBHOOK_ALLOWED_EVENTS.includes('ALL') || APP_WEBHOOK_ALLOWED_EVENTS.includes(eventType)) {
        await webhook(instance, eventType, eventData)
    }
}

const webhook = async (instance, type, data) => {
    if (process.env.APP_WEBHOOK_URL) {
        axios
            .post(`${process.env.APP_WEBHOOK_URL}`, {
                instance,
                type,
                data,
            }, {
                 headers: {
                    'X-Webhook-Wapi': process.env.AUTHENTICATION_GLOBAL_AUTH_TOKEN
                     // Agregar cabecera personalizada
                },
                httpsAgent: new https.Agent({  
                rejectUnauthorized: false
             })
            })
            .then((success) => {
                return success
            })
            .catch((error) => {
                return error
            })
    }
}

const closeSessionResources = async (
    sessionId,
    options = { deleteAuth: false, clearRetry: true },
) => {
    const { deleteAuth = false, clearRetry = true } = options
    const session = sessions.get(sessionId)

    sessions.delete(sessionId)
    if (clearRetry) {
        retries.delete(sessionId)
    }

    if (session?.store?.cleanup) {
        try {
            await session.store.cleanup()
        } catch (error) {
            console.error(`Error cleaning store for ${sessionId}:`, error?.message || error)
        }
    }

    try {
        session?.ev?.removeAllListeners?.()
    } catch {
    }

    try {
        session?.end?.()
    } catch {
    }

    try {
        session?.ws?.close?.()
    } catch {
    }

    if (deleteAuth) {
        if (IS_MYSQL_STORAGE && authStore) {
            try {
                await authStore.deleteCredsData(sessionId)
                console.log('Fila eliminada con exito de la base de datos.')
            } catch (error) {
                console.error('Error al eliminar la fila de la base de datos:', error)
            }
        } else {
            try {
                removeLocalSessionFiles(sessionId)
            } catch (error) {
                console.error('Error al eliminar archivos de sesion local:', error)
            }
        }
    }
}
const createSession = async (sessionId, res = null, options = { usePairingCode: false, phoneNumber: '' }) => {
    if (creatingSessions.has(sessionId)) {
        return
    }

    creatingSessions.add(sessionId)
    try {
        if (isSessionExists(sessionId)) {
            await closeSessionResources(sessionId, { deleteAuth: false, clearRetry: false })
        }

    const sessionFile = 'md_' + sessionId

    const logger = pino({ level: 'silent' })

    /*const store = makeInMemoryStore({
        preserveDataDuringSync: true,
        backupBeforeSync: false,
        incrementalSave: true,
        maxMessagesPerChat: 150,
        autoSaveInterval: 10000,
        storeFile: sessionsDir(`${sessionId}_store.json`)
    });*/

    const commonStoreOptions = {
        preserveDataDuringSync: true,
        backupBeforeSync: false,
        incrementalSave: true,
        maxMessagesPerChat: 150,
        autoSaveInterval: 10000,
    }

    const store = IS_MYSQL_STORAGE
        ? makeMySQLStore({
            ...commonStoreOptions,
            sessionId,
        })
        : makeInMemoryStore({
            ...commonStoreOptions,
            storeFile: sessionsDir(`${sessionId}_store.json`),
        })

    const { state, saveCreds } = IS_MYSQL_STORAGE
        ? await useDBAuthState(sessionId)
        : await useMultiFileAuthState(sessionsDir(sessionFile))

    // Fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

    // Load store
    if (IS_MYSQL_STORAGE) {
        await store?.readFromMySQL(sessionId)
    } else {
        store?.readFromFile(sessionsDir(`${sessionId}_store.json`))
    }

    // Make both Node and Bun compatible
    const makeWASocket = makeWASocketModule.default ?? makeWASocketModule;

    /**
     * @type {import('baileys').AnyWASocket}
     */
    const wa = makeWASocket({
        version,
        printQRInTerminal: false,
        mobile: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage,
    })
    store?.bind(wa.ev)
    sessions.set(sessionId, { ...wa, store })

    if (options.usePairingCode && !wa.authState.creds.registered) {
        if (!wa.authState.creds.account) {
            await wa.waitForConnectionUpdate((update) => {
                return Boolean(update.qr)
            })
            const code = await wa.requestPairingCode(options.phoneNumber)
            if (res && !res.headersSent && code !== undefined) {
                response(res, 200, true, 'Verify on your phone and enter the provided code.', { code })
            } else {
                response(res, 500, false, 'Unable to create session.')
            }
        }
    }

    wa.ev.on('creds.update', saveCreds)

    wa.ev.on('chats.set', ({ chats }) => {
        callWebhook(sessionId, 'CHATS_SET', chats)
    })

    wa.ev.on('chats.upsert', (c) => {
        callWebhook(sessionId, 'CHATS_UPSERT', c)
    })

    wa.ev.on('chats.delete', (c) => {
        callWebhook(sessionId, 'CHATS_DELETE', c)
    })

    wa.ev.on('chats.update', (c) => {
        callWebhook(sessionId, 'CHATS_UPDATE', c)
    })

    wa.ev.on('labels.association', (l) => {
        callWebhook(sessionId, 'LABELS_ASSOCIATION', l)
    })

    wa.ev.on('labels.edit', (l) => {
        callWebhook(sessionId, 'LABELS_EDIT', l)
    })

    // Automatically read incoming messages, uncomment below codes to enable this behaviour
    wa.ev.on('messages.upsert', async (m) => {
        const messages = m.messages.filter((m) => {
            return m.key.fromMe === false
        })
        if (messages.length > 0) {
            const messageTmp = await Promise.all(
                messages.map(async (msg) => {
                    try {
                        const typeMessage = Object.keys(msg.message)[0]
                        if (msg?.status) {
                            msg.status = WAMessageStatus[msg?.status] ?? 'UNKNOWN'
                        }

                        if (
                            ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage'].includes(typeMessage) &&
                            process.env.APP_WEBHOOK_FILE_IN_BASE64 === 'true'
                        ) {
                            const mediaMessage = await getMessageMedia(wa, msg)

                            const fieldsToConvert = [
                                'fileEncSha256',
                                'mediaKey',
                                'fileSha256',
                                'jpegThumbnail',
                                'thumbnailSha256',
                                'thumbnailEncSha256',
                                'streamingSidecar',
                            ]

                            fieldsToConvert.forEach((field) => {
                                if (msg.message[typeMessage]?.[field] !== undefined) {
                                    msg.message[typeMessage][field] = convertToBase64(msg.message[typeMessage][field])
                                }
                            })

                            return {
                                ...msg,
                                message: {
                                    [typeMessage]: {
                                        ...msg.message[typeMessage],
                                        fileBase64: mediaMessage.base64,
                                    },
                                },
                            }
                        }

                        return msg
                    } catch {
                        return {}
                    }
                }),
            )

            callWebhook(sessionId, 'MESSAGES_UPSERT', messageTmp)
        }
    })

    wa.ev.on('messages.delete', async (m) => {
        callWebhook(sessionId, 'MESSAGES_DELETE', m)
    })

    wa.ev.on('messages.update', async (m) => {
        for (const { key, update } of m) {
            const msg = await getMessage(key)

            if (!msg) {
                continue
            }

            update.status = WAMessageStatus[update.status]
            const messagesUpdate = [
                {
                    key,
                    update,
                    message: msg,
                },
            ]
            callWebhook(sessionId, 'MESSAGES_UPDATE', messagesUpdate)
        }
    })

    wa.ev.on('message-receipt.update', async (m) => {
        for (const { key, messageTimestamp, pushName, broadcast, update } of m) {
            if (update?.pollUpdates) {
                const pollCreation = await getMessage(key)
                if (pollCreation) {
                    const pollMessage = await getAggregateVotesInPollMessage({
                        message: pollCreation,
                        pollUpdates: update.pollUpdates,
                    })
                    update.pollUpdates[0].vote = pollMessage
                    callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', [
                        { key, messageTimestamp, pushName, broadcast, update },
                    ])
                    return
                }
            }
        }

        callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', m)
    })

    wa.ev.on('messages.reaction', async (m) => {
        callWebhook(sessionId, 'MESSAGES_REACTION', m)
    })

    wa.ev.on('messages.media-update', async (m) => {
        callWebhook(sessionId, 'MESSAGES_MEDIA_UPDATE', m)
    })

    wa.ev.on('messaging-history.set', async (m) => {
        callWebhook(sessionId, 'MESSAGING_HISTORY_SET', m)
    })

    wa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        const statusCode = lastDisconnect?.error?.output?.statusCode

        callWebhook(sessionId, 'CONNECTION_UPDATE', update)

        if (connection === 'open') {
            retries.delete(sessionId)

            let removedContacts = 0
            for (const [jid, contacto] of store.contacts.entries()) {
                if (!(contacto?.name || contacto?.verifiedName) || jid.includes('@g.us') || jid.includes('@lid')) {
                    store.contacts.delete(jid)
                    removedContacts++
                }
            }

            if (removedContacts > 0) {
                store.markDirty?.()
            }
        }

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                return await deleteSession(sessionId)
            }

            await closeSessionResources(sessionId, { deleteAuth: false, clearRetry: false })
            setTimeout(
                () => {
                    createSession(sessionId, res)
                },
                statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0),
            )
        }

        if (qr) {
            if (res && !res.headersSent) {
                callWebhook(sessionId, 'QRCODE_UPDATED', update)

                try {
                    const qrcode = await toDataURL(qr)
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qrcode })
                    return
                } catch {
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await wa.logout()
            } catch {
            } finally {
                await deleteSession(sessionId)
            }
        }
    })

    wa.ev.on('groups.upsert', async (m) => {
        callWebhook(sessionId, 'GROUPS_UPSERT', m)
    })

    wa.ev.on('groups.update', async (m) => {
        callWebhook(sessionId, 'GROUPS_UPDATE', m)
    })

    wa.ev.on('group-participants.update', async (m) => {
        callWebhook(sessionId, 'GROUP_PARTICIPANTS_UPDATE', m)
    })

    wa.ev.on('blocklist.set', async (m) => {
        callWebhook(sessionId, 'BLOCKLIST_SET', m)
    })

    wa.ev.on('blocklist.update', async (m) => {
        callWebhook(sessionId, 'BLOCKLIST_UPDATE', m)
    })

    wa.ev.on('contacts.set', async (c) => {
        callWebhook(sessionId, 'CONTACTS_SET', c)
    })

    wa.ev.on('contacts.upsert', async (c) => {
        callWebhook(sessionId, 'CONTACTS_UPSERT', c)
    })

    wa.ev.on('contacts.update', async (c) => {
        callWebhook(sessionId, 'CONTACTS_UPDATE', c)
    })

    wa.ev.on('presence.update', async (p) => {
        callWebhook(sessionId, 'PRESENCE_UPDATE', p)
    })

    async function getMessage(key) {
        if (store) {
            const msg = await store.loadMessages(key.remoteJid, key.id)
            return msg?.message || undefined
        }

        // Only if store is present
        return proto.Message.fromObject({})
    }
    } finally {
        creatingSessions.delete(sessionId)
    }
}

/**
 * @returns {(import('baileys').AnyWASocket|null)}
 */
const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const getListSessions = () => {
    return [...sessions.keys()]
}

const deleteSession = async (sessionId) => {
   /* const sessionFile = 'md_' + sessionId
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    rmSync(sessionsDir(sessionFile), rmOptions)
    rmSync(sessionsDir(storeFile), rmOptions)*/
    await closeSessionResources(sessionId, { deleteAuth: true, clearRetry: true })

    /*aqui colocar el delet section*/
}

const getChatList = (sessionId, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net'
    const chats = getSession(sessionId).store.chats
    return [...chats.values()].filter(chat => chat.id.endsWith(filter))
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const isExists = async (session, jid, isGroup = false) => {
    try {
        let result

        if (isGroup) {
            result = await session.groupMetadata(jid)

            return Boolean(result.id)
        }

        ;[result] = await session.onWhatsApp(jid)

        return result.exists
    } catch {
        return false
    }
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const sendMessage = async (session, receiver, message, options = {}, delayMs = 1000) => {
    try {
        await delay(parseInt(delayMs))
        return await session.sendMessage(receiver, message, options)
    } catch (err) {
        return Promise.reject(err) // eslint-disable-line prefer-promise-reject-errors
    }
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const updateProfileStatus = async (session, status) => {
    try {
        return await session.updateProfileStatus(status)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const updateProfileName = async (session, name) => {
    try {
        return await session.updateProfileName(name)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const getProfilePicture = async (session, jid, type = 'image') => {
    try {
        return await session.profilePictureUrl(jid, type)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const blockAndUnblockUser = async (session, jid, block) => {
    try {
        return await session.updateBlockStatus(jid, block)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@s.whatsapp.net')
}

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group
    }

    let formatted = group.replace(/[^\d-]/g, '')

    return (formatted += '@g.us')
}

const cleanup = () => {
    console.log('Running cleanup before exit.')

    sessions.forEach((session, sessionId) => {
        closeSessionResources(sessionId, { deleteAuth: false, clearRetry: false }).catch((error) => {
            console.error(`Error on cleanup for ${sessionId}:`, error?.message || error)
        })
    })
}

const getGroupsWithParticipants = async (session) => {
    return session.groupFetchAllParticipating()
}

const participantsUpdate = async (session, jid, participants, action) => {
    return session.groupParticipantsUpdate(jid, participants, action)
}

const updateSubject = async (session, jid, subject) => {
    return session.groupUpdateSubject(jid, subject)
}

const updateDescription = async (session, jid, description) => {
    return session.groupUpdateDescription(jid, description)
}

const settingUpdate = async (session, jid, settings) => {
    return session.groupSettingUpdate(jid, settings)
}

const leave = async (session, jid) => {
    return session.groupLeave(jid)
}

const inviteCode = async (session, jid) => {
    return session.groupInviteCode(jid)
}

const revokeInvite = async (session, jid) => {
    return session.groupRevokeInvite(jid)
}

const metaData = async (session, req) => {
    return session.groupMetadata(req.groupId)
}

const acceptInvite = async (session, req) => {
    return session.groupAcceptInvite(req.invite)
}

const profilePicture = async (session, jid, urlImage) => {
    const image = await downloadImage(urlImage)
    return session.updateProfilePicture(jid, { url: image })
}

const readMessage = async (session, keys) => {
    return session.readMessages(keys)
}

const getStoreMessage = async (session, messageId, remoteJid) => {
    try {
        return await session.store.loadMessages(remoteJid, messageId)
    } catch {
        // eslint-disable-next-line prefer-promise-reject-errors
        return Promise.reject(null)
    }
}

const getMessageMedia = async (session, message) => {
    try {
        const messageType = Object.keys(message.message)[0]
        const mediaMessage = message.message[messageType]
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            { reuploadRequest: session.updateMediaMessage },
        )

        return {
            messageType,
            fileName: mediaMessage.fileName ?? '',
            caption: mediaMessage.caption ?? '',
            size: {
                fileLength: mediaMessage.fileLength,
                height: mediaMessage.height ?? 0,
                width: mediaMessage.width ?? 0,
            },
            mimetype: mediaMessage.mimetype,
            base64: buffer.toString('base64'),
        }
    } catch {
        // eslint-disable-next-line prefer-promise-reject-errors
        return Promise.reject(null)
    }
}

const convertToBase64 = (arrayBytes) => {
    const byteArray = new Uint8Array(arrayBytes)
    return Buffer.from(byteArray).toString('base64')
}

/*const init = () => {
    readdir(sessionsDir(), (err, files) => {
        if (err) {
            throw err
        }

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
                continue
            }

            const filename = file.replace('.json', '')
            const sessionId = filename.substring(3)
            console.log('Recovering session: ' + sessionId)
            createSession(sessionId)
        }
    })
}*/
const init = () => {
    if (IS_MYSQL_STORAGE && authStore) {
        authStore.getAllSessionIds()
            .then((sessionIds) => {
                if (!sessionIds || sessionIds.length === 0) {
                    console.log('No sessions found to recover.')
                    return
                }

                for (const sessionId of sessionIds) {
                    console.log('Recovering session: ' + sessionId)
                    createSession(sessionId)
                }
            })
            .catch((error) => {
                console.error('Error recovering sessions:', error)
            })
        return
    }

    if (!existsSync(sessionsDir())) {
        console.log('No local sessions directory found to recover.')
        return
    }

    readdir(sessionsDir(), (err, files) => {
        if (err) {
            console.error('Error recovering local sessions:', err)
            return
        }

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
                continue
            }

            const filename = file.replace('.json', '')
            const sessionId = filename.substring(3)
            console.log('Recovering session: ' + sessionId)
            createSession(sessionId)
        }
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    getListSessions,
    deleteSession,
    getChatList,
    getGroupsWithParticipants,
    isExists,
    sendMessage,
    updateProfileStatus,
    updateProfileName,
    getProfilePicture,
    formatPhone,
    formatGroup,
    cleanup,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    revokeInvite,
    metaData,
    acceptInvite,
    profilePicture,
    readMessage,
    init,
    isSessionConnected,
    getMessageMedia,
    getStoreMessage,
    blockAndUnblockUser,
}

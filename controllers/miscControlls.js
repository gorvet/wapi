import {
    updateProfileStatus,
    updateProfileName,
    getSession,
    getProfilePicture,
    formatPhone,
    formatChatJid,
    profilePicture,
    blockAndUnblockUser,
    sendMessage,
} from './../whatsapp.js'
import response from './../response.js'

import { compareAndFilter, fileExists, isUrlValid } from './../utils/functions.js'

const setProfileStatus = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        await updateProfileStatus(session, req.body.status)
        response(res, 200, true, 'The status has been updated successfully')
    } catch {
        response(res, 500, false, 'Failed to update status')
    }
}

const setProfileName = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        await updateProfileName(session, req.body.name)
        response(res, 200, true, 'The name has been updated successfully')
    } catch {
        response(res, 500, false, 'Failed to update name')
    }
}

const setProfilePicture = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        const { url } = req.body
        session.user.phone = session.user.id.split(':')[0].split('@')[0]
        await profilePicture(session, session.user.phone + '@s.whatsapp.net', url)
        response(res, 200, true, 'Update profile picture successfully.')
    } catch {
        response(res, 500, false, 'Failed Update profile picture.')
    }
}

const getProfile = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)

        session.user.phone = session.user.id.split(':')[0].split('@')[0]
        session.user.image = await session.profilePictureUrl(session.user.id, 'image')
        session.user.status = await session.fetchStatus(session.user.phone + '@s.whatsapp.net')

        response(res, 200, true, 'The information has been obtained successfully.', session.user)
    } catch {
        response(res, 500, false, 'Could not get the information')
    }
}

const getProfilePictureUser = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        const isGroup = req.body.isGroup ?? false
        const jid = formatChatJid(req.body.jid, isGroup)

        const imagen = await getProfilePicture(session, jid, 'image')

        response(res, 200, true, 'The image has been obtained successfully.', imagen)
    } catch (err) {
        if (err === null) {
            return response(res, 404, false, 'the user or group not have image')
        }

        response(res, 500, false, 'Could not get the information')
    }
}

const blockAndUnblockContact = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        const { jid, isBlock } = req.body
        const jidFormat = formatChatJid(jid)
        const blockFormat = isBlock === true ? 'block' : 'unblock'
        await blockAndUnblockUser(session, jidFormat, blockFormat)
        response(res, 200, true, 'The contact has been blocked or unblocked successfully')
    } catch {
        response(res, 500, false, 'Failed to block or unblock contact')
    }
}
const shareStory = async (req, res) => {
    const session = getSession(res.locals.sessionId);
    const {
        receiver,
        message,
        options = {
            backgroundColor: "#103529",
            font: 12
        }
    } = req.body;

    const statusJid = 'status@broadcast';
    const typesMessage = ['image', 'video', 'audio'];
    let finalReceivers = [];
    if (session?.user?.id) {
        finalReceivers.push(formatPhone(session.user.id));
    }
    
    if (!receiver || (typeof receiver === 'string' && receiver.length === 0)) {
        return response(res, 400, false, 'The receiver number does not exist.');
    }
    if (receiver === 'all_contacts') {
        const contacts = session.store.getContactList('saved')
        
        if (contacts.length === 0) {
            return response(res, 400, false, 'No contacts found.');
        }

        finalReceivers.push(...contacts);
    }

    if (typeof receiver === 'string') {
        if (receiver === session.user.id) {
            return response(res, 400, false, 'You cannot send a message to yourself.');
        }

        if (receiver !== 'all_contacts') {
            finalReceivers.push(formatPhone(receiver));
        }


    } else if (Array.isArray(receiver)) {
        if (receiver.length === 0) {
            return response(res, 400, false, 'The receiver list is empty.');
        }

        const invalidReceiver = receiver.find(r => typeof r !== 'string');
        if (invalidReceiver) {
            return response(res, 400, false, 'All receivers must be strings.');
        }

        finalReceivers.push(...receiver.map(r => formatPhone(r)));
    }

    const optionsBroadcast = {
        backgroundColor: options.backgroundColor || "#103529",
        font: options.font || 12,
        broadcast: true,
        statusJidList: finalReceivers,
    }

    const filterTypeMessage = compareAndFilter(Object.keys(message), typesMessage);

    try {
        if (filterTypeMessage.length > 0) {
            const mediaType = filterTypeMessage[0];
            const url = message[mediaType]?.url;

            if (!url || url.length === 0) {
                return response(res, 400, false, 'The URL is invalid or empty.');
            }

            if (!isUrlValid(url) && !fileExists(url)) {
                return response(res, 400, false, 'The file or URL does not exist.');
            }
        }


        //const chunks = chunkArray(finalReceivers, 300);

        /*for (const group of chunks) {
            try {
                await sendMessage(session, statusJid, message, {
                    ...optionsBroadcast,
                    statusJidList: group
                }, 0); // 500 ms delay por bloque
                
            } catch (err) {
                console.warn('❌ Falló el envío para grupo:', group, '\nError:', err?.message || err);
            }
        }*/
        await sendMessage(session, statusJid, message, optionsBroadcast, 0);

        return response(res, 200, true, 'The story status has been successfully sent.');
    } catch (err){
            console.error('❌ Error en shareStory:', err);
        return response(res, 500, false, 'Failed to send the story status.');
    }
};

const chunkArray = (arr, size) =>
    arr.reduce((acc, _, i) => (i % size ? acc : [...acc, arr.slice(i, i + size)]), []);


export {
    setProfileStatus,
    setProfileName,
    setProfilePicture,
    getProfile,
    getProfilePictureUser,
    blockAndUnblockContact,
    shareStory,
}

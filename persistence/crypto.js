import crypto from 'crypto';

const ENCRYPTION_PREFIX = 'enc:v1:gcm:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const encryptionEnabled = (process.env.DB_ENCRYPTION_ENABLED ?? 'false').toLowerCase() === 'true';
const rawEncryptionKey = process.env.DB_ENCRYPTION_KEY ?? process.env.AUTHENTICATION_GLOBAL_AUTH_TOKEN ?? '';

let cachedKey = null;

const getKey = () => {
    if (cachedKey) {
        return cachedKey;
    }

    if (!rawEncryptionKey) {
        throw new Error(
            '[CRYPTO] DB_ENCRYPTION_ENABLED=true pero no hay DB_ENCRYPTION_KEY (ni AUTHENTICATION_GLOBAL_AUTH_TOKEN).',
        );
    }

    cachedKey = crypto.createHash('sha256').update(rawEncryptionKey).digest();
    return cachedKey;
};

export const isEncryptionEnabled = () => encryptionEnabled;

export const encryptText = (plainText) => {
    if (!encryptionEnabled || plainText == null) {
        return plainText;
    }

    const source = String(plainText);
    if (source.startsWith(ENCRYPTION_PREFIX)) {
        return source;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

    const encrypted = Buffer.concat([cipher.update(source, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${ENCRYPTION_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

export const decryptText = (storedText) => {
    if (storedText == null) {
        return storedText;
    }

    const source = String(storedText);
    if (!source.startsWith(ENCRYPTION_PREFIX)) {
        return source;
    }

    if (!encryptionEnabled) {
        console.warn('[CRYPTO] Valor cifrado detectado con DB_ENCRYPTION_ENABLED=false. Se intentara descifrar para compatibilidad.');
    }

    try {
        const payload = source.slice(ENCRYPTION_PREFIX.length);
        const parts = payload.split(':');
        if (parts.length !== 3) {
            throw new Error('Formato de payload cifrado inválido');
        }

        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');

        if (iv.length !== IV_LENGTH) {
            throw new Error('IV inválido');
        }
        if (tag.length !== TAG_LENGTH) {
            throw new Error('Tag inválido');
        }

        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return plain.toString('utf8');
    } catch (error) {
        console.error('[CRYPTO] Error descifrando valor almacenado:', error?.message || error);
        return source;
    }
};

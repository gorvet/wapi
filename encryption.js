// encryption.js
import crypto from 'crypto';

// Clave secreta para encriptar y desencriptar los datos
const secretKey = process.env.AUTHENTICATION_GLOBAL_AUTH_TOKEN

// Asegurando que la clave tenga una longitud de 32 bytes (256 bits)
const hash = crypto.createHash('sha256');
hash.update(secretKey);
const finalKey = hash.digest();

const algorithm = 'aes-256-ctr'; // Algoritmo de encriptación
const ivLength = 16; // Longitud del IV para AES-256-CTR

// Función para generar un IV aleatorio
function generateIv() {
  return crypto.randomBytes(ivLength);  // Genera un IV de 16 bytes
}

// Función para encriptar
function encrypt(text) {
  const iv = generateIv();  // Genera un IV aleatorio
  const cipher = crypto.createCipheriv(algorithm, Buffer.from(finalKey, 'utf-8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Retornamos el IV y los datos encriptados juntos en un objeto
  return { iv: iv.toString('hex'), encryptedData: encrypted };
}

// Función para desencriptar
function decrypt(encryptedData, iv) {
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(finalKey, 'utf-8'), Buffer.from(iv, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Exporta las funciones
export { encrypt, decrypt };



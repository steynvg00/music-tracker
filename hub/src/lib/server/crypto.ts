import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token encryption at rest, byte-compatible with lib/token_store.py:
 *   blob = 0x01 || iv (12) || AES-256-GCM ciphertext || tag (16),  aad = "rotor:<client>:<field>"
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {}

export function parseKey(raw: string): Buffer {
	const s = raw.trim();
	const urlsafe = /[-_]/.test(s);
	const key = Buffer.from(s, urlsafe ? 'base64url' : 'base64');
	if (key.length !== 32) throw new CryptoError(`TOKEN_ENC_KEY must decode to 32 bytes, got ${key.length}`);
	return key;
}

export function aadFor(client: string, field: string): Buffer {
	return Buffer.from(`rotor:${client}:${field}`);
}

export function encrypt(plaintext: string, key: Buffer, aad: Buffer, iv: Buffer = randomBytes(IV_BYTES)): Buffer {
	if (iv.length !== IV_BYTES) throw new CryptoError('IV must be 12 bytes');
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), iv, ct, cipher.getAuthTag()]);
}

export function decrypt(blob: Uint8Array, key: Buffer, aad: Buffer): string {
	const data = Buffer.from(blob);
	if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== VERSION) {
		throw new CryptoError('unknown token blob format');
	}
	const iv = data.subarray(1, 1 + IV_BYTES);
	const tag = data.subarray(data.length - TAG_BYTES);
	const ct = data.subarray(1 + IV_BYTES, data.length - TAG_BYTES);
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
	} catch {
		throw new CryptoError('token blob failed authentication (wrong key or tampered)');
	}
}

/** URL-safe random token (default 256 bits). */
export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function hmac(secret: string, data: string): Buffer {
	return createHmac('sha256', secret).update(data).digest();
}

/** PKCE S256 code challenge (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** value.signature, both base64url. */
export function sign(value: string, secret: string): string {
	return `${value}.${hmac(secret, value).toString('base64url')}`;
}

export function unsign(signed: string, secret: string): string | null {
	const i = signed.lastIndexOf('.');
	if (i <= 0) return null;
	const value = signed.slice(0, i);
	return safeEqual(signed, sign(value, secret)) ? value : null;
}

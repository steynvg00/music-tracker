import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aadFor, decrypt, encrypt, parseKey, pkceChallenge, sign, unsign, CryptoError } from './crypto';

const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../tests/fixtures/token_vector.json', import.meta.url)), 'utf8')) as {
	key_b64: string;
	iv_hex: string;
	aad: string;
	plaintext: string;
	blob_hex: string;
};
const key = parseKey(V.key_b64);

describe('token encryption (byte-compatible with lib/token_store.py)', () => {
	it('decrypts the blob Python produced', () => {
		expect(decrypt(Buffer.from(V.blob_hex, 'hex'), key, Buffer.from(V.aad))).toBe(V.plaintext);
	});
	it('produces the same blob as Python for a fixed IV', () => {
		expect(encrypt(V.plaintext, key, Buffer.from(V.aad), Buffer.from(V.iv_hex, 'hex')).toString('hex')).toBe(V.blob_hex);
	});
	it('binds ciphertext to client and field', () => {
		const blob = encrypt('tok', key, aadFor('hub', 'refresh_token'));
		expect(decrypt(blob, key, aadFor('hub', 'refresh_token'))).toBe('tok');
		expect(() => decrypt(blob, key, aadFor('cron', 'refresh_token'))).toThrow(CryptoError);
		expect(() => decrypt(blob, key, aadFor('hub', 'access_token'))).toThrow(CryptoError);
	});
	it('detects tampering and wrong keys', () => {
		const blob = Buffer.from(V.blob_hex, 'hex');
		blob[20] = blob[20]! ^ 1;
		expect(() => decrypt(blob, key, Buffer.from(V.aad))).toThrow(CryptoError);
		expect(() => decrypt(Buffer.from(V.blob_hex, 'hex'), Buffer.alloc(32), Buffer.from(V.aad))).toThrow(CryptoError);
	});
	it('validates key length', () => {
		expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(CryptoError);
		expect(parseKey(Buffer.alloc(32, 250).toString('base64url')).length).toBe(32);
	});
});

describe('PKCE and signing', () => {
	it('matches the RFC 7636 appendix B example', () => {
		expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});
	it('sign/unsign round-trips and rejects tampering', () => {
		const s = sign('payload', 'secret');
		expect(unsign(s, 'secret')).toBe('payload');
		expect(unsign(s, 'other')).toBeNull();
		expect(unsign(s.replace('payload', 'paylaod'), 'secret')).toBeNull();
		expect(unsign('nodot', 'secret')).toBeNull();
	});
});

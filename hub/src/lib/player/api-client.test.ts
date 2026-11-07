import { describe, expect, it } from 'vitest';
import { ApiFailure, apiGet } from './api-client';

const respond = (body: string, status = 200) => (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('api-client', () => {
	it('returns the parsed body on success', async () => {
		await expect(apiGet('/x', respond('{"rows":[1]}'))).resolves.toEqual({ rows: [1] });
	});
	it('a 2xx with an unreadable body throws instead of returning { error } as data', async () => {
		const p = apiGet<{ rows: number[] }>('/x', respond('{"rows":[1', 200));
		await expect(p).rejects.toBeInstanceOf(ApiFailure);
		await expect(p).rejects.toMatchObject({ status: 502, body: { error: 'bad_response' } });
	});
	it('errors keep their status and body', async () => {
		await expect(apiGet('/x', respond('{"error":"not_found"}', 404))).rejects.toMatchObject({ status: 404, body: { error: 'not_found' } });
		await expect(apiGet('/x', respond('<html>', 500))).rejects.toMatchObject({ status: 500 });
	});
	it('204 is no content', async () => {
		await expect(apiGet('/x', (async () => new Response(null, { status: 204 })) as unknown as typeof fetch)).resolves.toBeUndefined();
	});
});

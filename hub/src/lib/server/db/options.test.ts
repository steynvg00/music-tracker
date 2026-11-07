import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHubPool, isLocalDatabaseUrl, poolOptions, txPoolOptions } from './options';

describe('hub DB pool options (v0.83.1: Supavisor transaction + session mode)', () => {
	it('never pipelines and never prepares named statements', () => {
		const o = poolOptions({ local: false });
		expect(o.max_pipeline).toBe(0); // 0 = nothing pipelined behind the active query
		expect(o.prepare).toBe(false);
		expect(o.ssl).toBe('require');
		expect(o.max).toBeGreaterThan(1); // concurrency comes from the pool, not from pipelining
	});

	it('postgres.js really takes them (no connection is opened by creating the pool)', () => {
		const sql = postgres('postgres://u:p@db.example.invalid:6543/postgres', poolOptions({ local: false }));
		// ParsedOptions' type doesn't list max_pipeline, but the runtime object carries it.
		const parsed = sql.options as unknown as { max_pipeline: number; prepare: boolean };
		expect(parsed.max_pipeline).toBe(0);
		expect(parsed.prepare).toBe(false);
		void sql.end({ timeout: 0 });
	});

	it('only local URLs skip TLS', () => {
		expect(isLocalDatabaseUrl('postgresql://postgres@127.0.0.1:55432/rotor_e2e')).toBe(true);
		expect(isLocalDatabaseUrl('postgresql://postgres.x:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')).toBe(false);
		expect(poolOptions({ local: true }).ssl).toBe(false);
	});

	it('transactions use their own pool (max_pipeline 1: postgres.js begin() hangs at 0)', async () => {
		expect(txPoolOptions({ local: false }).max_pipeline).toBe(1);
		expect(txPoolOptions({ local: false }).prepare).toBe(false);
		const sql = createHubPool('postgres://u:p@db.example.invalid:6543/postgres');
		expect((sql.options as unknown as { max_pipeline: number }).max_pipeline).toBe(0);
		expect(typeof sql.begin).toBe('function');
		await sql.end({ timeout: 0 });
	});
});

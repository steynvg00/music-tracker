import postgres from 'postgres';
import { config } from '$lib/server/env';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or a transaction: both are tagged-template query functions. */
export type Queryable = Sql | Tx;

let pool: Sql | null = null;

/**
 * Supabase Supavisor transaction pooler (port 6543): `prepare: false` is required in
 * transaction mode. Connects as the table owner, which bypasses the deny-all RLS on
 * every table (04-architecture.md §3.5). The browser never talks to the DB.
 */
export function db(): Sql {
	if (pool) return pool;
	const url = config().databaseUrl;
	const local = /@(localhost|127\.0\.0\.1)[:/]|host=\/|sslmode=disable/.test(url);
	pool = postgres(url, {
		prepare: false,
		max: 3,
		idle_timeout: 20,
		connect_timeout: 10,
		ssl: local ? false : 'require',
		connection: { application_name: 'rotor-hub' }
	});
	return pool;
}

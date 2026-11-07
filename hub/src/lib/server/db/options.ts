/**
 * postgres.js options for the hub's pool (v0.83.1 hotfix). Plain module, no $lib imports, so the
 * E2E pipeline test (hub/e2e/tests/hotfix.spec.ts) checks exactly what production uses.
 *
 * Supabase Supavisor, both modes:
 *   - transaction mode (port 6543): every statement may run on a different Postgres backend.
 *     `prepare: false` (no named statements) is not enough on its own: postgres.js PIPELINES
 *     concurrent queries on one connection (Parse/Bind/Execute of query 2 is sent before query
 *     1's ReadyForQuery). The pooler can hand those messages to different backends, and Postgres
 *     answers "bind message supplies N parameters, but prepared statement requires M" — what
 *     production /api/home hit (its Promise.all runs ~8 queries at once).
 *     `max_pipeline: 0` sends one query per connection at a time; concurrency comes from the
 *     pool (`max`) instead. Note the off-by-one in postgres.js (3.4.x, connection.js): the limit
 *     counts queries pipelined BEHIND the active one, so `max_pipeline: 1` still allows two in
 *     flight. The E2E wire-protocol probe (HF-1) measured exactly that.
 *   - BUT postgres.js can't run a transaction with `max_pipeline: 0`: `sql.begin()` hands the
 *     transaction its connection from inside the same `sent.length < max_pipeline` check, which
 *     then short-circuits, so every begin() hangs (E2E R1-4 / R2-8 caught it). Transactions
 *     therefore run on a second, small pool with `max_pipeline: 1`. That is safe in transaction
 *     mode: Supavisor pins ONE backend from BEGIN to COMMIT, so messages inside a transaction
 *     can't be split across backends, and a reserved connection only takes the next BEGIN after
 *     the previous COMMIT's ReadyForQuery.
 *   - session mode (port 5432): a connection is one backend, so both settings are merely harmless.
 */
import postgres from 'postgres';

type Sql = postgres.Sql;

export interface PoolOptionsInput {
	local: boolean;
}

export function poolOptions({ local }: PoolOptionsInput) {
	return {
		prepare: false,
		max_pipeline: 0,
		// 4 + 2 (transactions) connections per server instance: enough parallelism for /api/home's
		// Promise.all without pipelining, and modest in session mode, where each one holds a backend.
		max: 4,
		idle_timeout: 20,
		connect_timeout: 10,
		ssl: local ? (false as const) : ('require' as const),
		connection: { application_name: 'rotor-hub' }
	};
}

/**
 * Pool for transactions only (see above): one-at-a-time is impossible there, and unnecessary.
 * Two connections, so a token refresh (it holds its transaction during the call to Spotify)
 * never makes a daily-pick rotate wait. No transaction opens another one.
 */
export function txPoolOptions(input: PoolOptionsInput) {
	return { ...poolOptions(input), max_pipeline: 1, max: 2, connection: { application_name: 'rotor-hub-tx' } };
}

/**
 * The hub's DB client: autocommit queries on a never-pipelining pool, `begin()` delegated to the
 * transaction pool. Same Sql type, so callers don't change. `end()` closes both.
 */
export function createHubPool(url: string): Sql {
	const local = isLocalDatabaseUrl(url);
	const pool = postgres(url, poolOptions({ local }));
	const tx = postgres(url, txPoolOptions({ local }));
	const endPool = pool.end.bind(pool);
	Object.assign(pool, {
		begin: tx.begin.bind(tx),
		end: async (opts?: { timeout?: number }) => {
			await Promise.all([endPool(opts), tx.end(opts)]);
		}
	});
	return pool;
}

/** Local/throwaway databases (dev, E2E) connect without TLS. */
export function isLocalDatabaseUrl(url: string): boolean {
	return /@(localhost|127\.0\.0\.1)[:/]|host=\/|sslmode=disable/.test(url);
}

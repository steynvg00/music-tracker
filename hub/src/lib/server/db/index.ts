import postgres from 'postgres';
import { config } from '$lib/server/env';
import { createHubPool } from './options';
import { timedSql } from '$lib/server/timing';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or a transaction: both are tagged-template query functions. */
export type Queryable = Sql | Tx;

let pool: Sql | null = null;

/**
 * Supabase Supavisor pooler, transaction (6543) OR session (5432) mode. See ./options.ts:
 * autocommit queries run with `prepare: false` + `max_pipeline: 0` (one query in flight per
 * connection); transactions run on a second small pool (pipelining inside BEGIN…COMMIT is safe).
 * Connects as the table owner, which bypasses the deny-all RLS on every table
 * (04-architecture.md §3.5). The browser never talks to the DB.
 */
export function db(): Sql {
	if (pool) return pool;
	// v0.92: every query's time goes into the request's Server-Timing "db" entry.
	pool = timedSql(createHubPool(config().databaseUrl));
	return pool;
}

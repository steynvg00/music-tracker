# Migrations

## Naming convention

Migration files are named `NNNN_<name>.sql` (e.g. `0001_initial.sql`). Always zero-pad to four digits and increment sequentially.

## How to apply a migration

1. Open the [Supabase Dashboard](https://supabase.com) for this project.
2. Go to **SQL Editor → New query**.
3. Paste the full contents of the migration file and click **Run**.
4. The migration inserts a row into `migrations_applied` — verify it appears there after running.

Always run migrations in **numeric order**. Never skip a number.

## Tracking applied migrations

The `migrations_applied` table records which migrations have been applied to the production database. After applying a migration, confirm the row is present:

```sql
SELECT * FROM migrations_applied ORDER BY number;
```

## After applying

- Update the **"Migrations applied"** table in `CLAUDE.md` (user responsibility).
- Add the migration to the **SQL Snippets** database in Notion (user responsibility, after production run).

## Supabase free-tier note

Free-tier Supabase projects pause after ~1 week of inactivity. If the project is paused, restore it from the dashboard before running migrations.

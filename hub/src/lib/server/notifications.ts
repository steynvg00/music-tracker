/** Settings › Notifications (R9): per-type switches (notification_prefs, 0030) and device health. */
import type { Queryable } from '$lib/server/db';
import { deviceWarning, isNotificationKind, NOTIFICATION_KINDS, type NotificationPref, type PushDevice } from '$lib/shared/notifications';
import { BadInput } from '$lib/shared/custom';

function isMissingTable(e: unknown): boolean {
	return typeof e === 'object' && e !== null && (e as { code?: string }).code === '42P01';
}

/** Every type with its switch. No row → on. Without 0030 every type reads as on (`stored: false`). */
export async function notificationPrefs(sql: Queryable): Promise<{ prefs: NotificationPref[]; stored: boolean }> {
	let rows: { kind: string; enabled: boolean }[] = [];
	let stored = true;
	try {
		rows = await sql<{ kind: string; enabled: boolean }[]>`SELECT kind, enabled FROM notification_prefs`;
	} catch (e) {
		if (!isMissingTable(e)) throw e;
		stored = false;
	}
	const on = new Map(rows.map((r) => [r.kind, r.enabled]));
	return {
		stored,
		prefs: NOTIFICATION_KINDS.map((k) => ({ kind: k.kind, label: k.label, enabled: on.get(k.kind) ?? true, wasMail: k.was === 'mail' }))
	};
}

export async function setNotificationPref(sql: Queryable, kind: unknown, enabled: unknown): Promise<void> {
	if (!isNotificationKind(kind)) throw new BadInput('unknown notification type');
	if (typeof enabled !== 'boolean') throw new BadInput('enabled must be true or false');
	await sql`
		INSERT INTO notification_prefs (kind, enabled, updated_at) VALUES (${kind}, ${enabled}, now())
		ON CONFLICT (kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
}

/** Every subscribed device: last successful push, failures, and a warning (Data health). */
export async function pushDevices(sql: Queryable, now: Date = new Date()): Promise<PushDevice[]> {
	const rows = await sql<{ device_label: string | null; created_at: Date; last_success_at: Date | null; failures: number }[]>`
		SELECT device_label, created_at, last_success_at, failures FROM push_subscriptions ORDER BY created_at`;
	return rows.map((r, i) => {
		const d = {
			label: r.device_label || `Device ${i + 1}`,
			createdAt: new Date(r.created_at).toISOString(),
			lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
			failures: r.failures
		};
		return { ...d, warning: deviceWarning(d, now) };
	});
}

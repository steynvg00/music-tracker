/**
 * Notification types (R9). Every message the crons used to mail is a Web Push now; each type can
 * be switched off in Settings › Notifications and tested on its own. Mirrors lib/notify.KINDS
 * (same keys, same order; a vitest checks it).
 */
export const NOTIFICATION_KINDS = [
	{ kind: 'daily_pick', label: "Today's pick is ready", was: null },
	{ kind: 'weekly_digest', label: 'Weekly refresh digest', was: 'mail' },
	{ kind: 'monthly_digest', label: 'Monthly refresh digest', was: 'mail' },
	{ kind: 'custom_sweep', label: 'Custom playlists auto-deleted', was: 'mail' },
	{ kind: 'snapshot', label: 'New snapshot playlists', was: 'mail' },
	{ kind: 'milestone', label: 'Play milestones (50, 100 … 500 plays)', was: 'mail' },
	{ kind: 'special_badge', label: 'Special track badges', was: 'mail' },
	{ kind: 'badge_digest', label: 'Badge digest (per ingest run)', was: 'mail' },
	{ kind: 'artist_badge', label: 'Artist badges', was: 'mail' },
	{ kind: 'ingest_alert', label: 'Ingest freshness alert', was: 'mail' },
	{ kind: 'radar', label: 'Release radar source failing', was: null },
	{ kind: 'token', label: 'Spotify sign-in expiring', was: null },
	{ kind: 'wrapped', label: 'Rotor Wrapped is ready', was: null },
	{ kind: 'job', label: 'A job you started finished', was: null }
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]['kind'];

export function isNotificationKind(k: unknown): k is NotificationKind {
	return typeof k === 'string' && NOTIFICATION_KINDS.some((x) => x.kind === k);
}

export interface NotificationPref {
	kind: NotificationKind;
	label: string;
	enabled: boolean;
	/** This type was an e-mail until v0.89. */
	wasMail: boolean;
}

export interface PushDevice {
	label: string;
	createdAt: string;
	lastSuccessAt: string | null;
	failures: number;
	/** failing: last delivery attempts failed; silent: nothing received in 7 days. */
	warning: 'failing' | 'silent' | null;
}

export const SILENT_DAYS = 7;

/** Device warning (Data health, R9): failures first, then "nothing received in 7 days". */
export function deviceWarning(d: { createdAt: string; lastSuccessAt: string | null; failures: number }, now: Date = new Date()): PushDevice['warning'] {
	if (d.failures > 0) return 'failing';
	const since = Date.parse(d.lastSuccessAt ?? d.createdAt);
	return now.getTime() - since > SILENT_DAYS * 86_400_000 ? 'silent' : null;
}

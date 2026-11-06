/** Web Push subscriptions (R2). The hub stores them; Python (lib/web_push.py) sends. */
import type { Queryable } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';

export interface SubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
	deviceLabel: string | null;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function parseSubscription(b: Record<string, unknown>): SubscriptionInput {
	const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new BadInput('endpoint must be a URL');
	}
	if (url.protocol !== 'https:' || endpoint.length > 2000) throw new BadInput('endpoint must be an https URL');
	const keys = (b.keys ?? {}) as Record<string, unknown>;
	const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
	const auth = typeof keys.auth === 'string' ? keys.auth : '';
	if (!B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) throw new BadInput('keys.p256dh is invalid');
	if (!B64URL.test(auth) || auth.length < 16 || auth.length > 32) throw new BadInput('keys.auth is invalid');
	const label = typeof b.device_label === 'string' ? b.device_label.slice(0, 80) : null;
	return { endpoint, p256dh, auth, deviceLabel: label };
}

export async function saveSubscription(sql: Queryable, s: SubscriptionInput): Promise<void> {
	await sql`
		INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_label) VALUES (${s.endpoint}, ${s.p256dh}, ${s.auth}, ${s.deviceLabel})
		ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
			device_label = EXCLUDED.device_label, failures = 0`;
}

export async function deleteSubscription(sql: Queryable, endpoint: string): Promise<void> {
	await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

export async function subscriptionCount(sql: Queryable): Promise<number> {
	const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM push_subscriptions`;
	return r?.n ?? 0;
}

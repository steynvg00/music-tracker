/** Browser side of Web Push (R2). Python sends; the hub only stores subscriptions. */
import { apiPost } from '$lib/player/api-client';

export function pushSupported(): boolean {
	return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iOS only delivers Web Push to a Home Screen web app. */
export function needsInstall(): boolean {
	if (typeof window === 'undefined') return false;
	const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
	const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return ios && !standalone;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function deviceLabel(): string {
	const ua = navigator.userAgent;
	if (/iPhone/.test(ua)) return 'iPhone';
	if (/iPad/.test(ua)) return 'iPad';
	if (/Android/.test(ua)) return 'Android';
	if (/Mac/.test(ua)) return 'Mac';
	if (/Windows/.test(ua)) return 'Windows';
	return 'Browser';
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	if (!pushSupported()) return null;
	const reg = await navigator.serviceWorker.ready;
	return reg.pushManager.getSubscription();
}

/** Must run from a click (iOS asks for permission only inside a user gesture). */
export async function enablePush(publicKey: string): Promise<'enabled' | 'denied' | 'unsupported'> {
	if (!pushSupported()) return 'unsupported';
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return 'denied';
	const reg = await navigator.serviceWorker.ready;
	const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
	await apiPost('/api/push/subscribe', { ...sub.toJSON(), device_label: deviceLabel() });
	return 'enabled';
}

export async function disablePush(): Promise<void> {
	const sub = await currentSubscription();
	if (!sub) return;
	await apiPost('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
	await sub.unsubscribe();
}

/**
 * Next run of a 5-field cron expression (UTC), for "About this playlist › Next refresh".
 * Supports what the repo's workflows use: numbers, '*', lists ('1,15') and ranges ('1-5')
 * in minute, hour, day-of-month, month, day-of-week. Day-of-month and day-of-week follow
 * cron's OR rule when both are restricted.
 */

function parseField(field: string, min: number, max: number): Set<number> | null {
	if (field === '*') return null;
	const out = new Set<number>();
	for (const part of field.split(',')) {
		const m = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!m) throw new Error(`unsupported cron field: ${field}`);
		const a = Number(m[1]);
		const b = m[2] === undefined ? a : Number(m[2]);
		if (a < min || b > max || a > b) throw new Error(`cron field out of range: ${field}`);
		for (let v = a; v <= b; v++) out.add(v);
	}
	return out;
}

export function nextRun(expr: string, from: Date = new Date()): Date | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	let minute, hour, dom, month, dow;
	try {
		minute = parseField(fields[0]!, 0, 59);
		hour = parseField(fields[1]!, 0, 23);
		dom = parseField(fields[2]!, 1, 31);
		month = parseField(fields[3]!, 1, 12);
		dow = parseField(fields[4]!, 0, 7);
	} catch {
		return null;
	}
	if (dow?.has(7)) dow.add(0);
	const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
	for (let i = 0; i < 60 * 24 * 400; i++) {
		const dayOk = (() => {
			const d = dom ? dom.has(t.getUTCDate()) : true;
			const w = dow ? dow.has(t.getUTCDay()) : true;
			return dom && dow ? d || w : d && w;
		})();
		if (
			(!month || month.has(t.getUTCMonth() + 1)) &&
			dayOk &&
			(!hour || hour.has(t.getUTCHours())) &&
			(!minute || minute.has(t.getUTCMinutes()))
		) {
			return t;
		}
		t.setTime(t.getTime() + 60_000);
	}
	return null;
}

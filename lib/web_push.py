"""Web Push for the Rotor hub (v0.82, R2): daily pick ready, token expiring, job finished.

The hub stores each device's subscription (push_subscriptions, migration 0022); all
sending happens here, in GitHub Actions (hub-jobs.yml), with the VAPID private key from
the GitHub secret VAPID_PRIVATE_KEY. The hub only knows the public key.

Without VAPID_PRIVATE_KEY / VAPID_SUBJECT nothing is sent (returns 0): notifications
are optional. Subscriptions the push service reports as gone (404/410) are deleted.
"""

from __future__ import annotations

import json
import os
import sys

from pywebpush import WebPushException, webpush

TTL_S = 12 * 3600


def configured() -> bool:
    return bool(os.environ.get("VAPID_PRIVATE_KEY") and os.environ.get("VAPID_SUBJECT"))


def payload(kind: str, title: str, body: str, url: str, tag: str | None = None) -> str:
    return json.dumps({"kind": kind, "title": title, "body": body, "url": url, "tag": tag or kind})


def send(conn, *, kind: str, title: str, body: str, url: str = "/home",
         dedupe_key: str | None = None, tag: str | None = None, _webpush=webpush) -> int:
    """Send one notification to every subscribed device. Returns how many accepted it.

    With dedupe_key, a notification is sent at most once ever (push_log).
    """
    if not configured():
        print(f"[push] VAPID not configured; skipping '{kind}' notification.", flush=True)
        return 0
    cur = conn.cursor()
    if dedupe_key:
        cur.execute(
            "INSERT INTO push_log (dedupe_key, kind) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING dedupe_key",
            (dedupe_key, kind),
        )
        if cur.fetchone() is None:
            conn.commit()
            return 0
        conn.commit()

    cur.execute("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    subs = cur.fetchall()
    data = payload(kind, title, body, url, tag)
    delivered = 0
    for endpoint, p256dh, auth in subs:
        try:
            _webpush(
                subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                data=data,
                vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
                vapid_claims={"sub": os.environ["VAPID_SUBJECT"]},
                ttl=TTL_S,
                timeout=10,
            )
            delivered += 1
            cur.execute(
                "UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE endpoint = %s",
                (endpoint,),
            )
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                cur.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,))
                print(f"[push] subscription gone ({status}); removed.", flush=True)
            else:
                cur.execute(
                    "UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = %s", (endpoint,)
                )
                print(f"[push] WARNING: delivery failed ({status}): {e}", file=sys.stderr, flush=True)
        except Exception as e:  # network errors: count, keep going
            cur.execute("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = %s", (endpoint,))
            print(f"[push] WARNING: delivery failed: {e}", file=sys.stderr, flush=True)
    if dedupe_key:
        cur.execute("UPDATE push_log SET delivered = %s WHERE dedupe_key = %s", (delivered, dedupe_key))
    conn.commit()
    return delivered

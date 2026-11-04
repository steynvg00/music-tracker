"""Encrypted Spotify token store shared with the Rotor hub (table hub_oauth_tokens, migration 0019).

The hub (hub/src/lib/server/crypto.ts) writes the rows; the crons read the 'cron' row
through lib/spotify.py. Both sides use the same format so either can read what the
other wrote:

    blob = 0x01 || iv (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes)
    aad  = "rotor:<client>:<field>"      e.g. "rotor:cron:refresh_token"

The AAD binds a ciphertext to its row and column: a hub token pasted into the cron
row fails to decrypt instead of silently working.

TOKEN_ENC_KEY is 32 random bytes, base64 (standard or URL-safe alphabet). It lives in
Vercel env and GitHub Actions secrets, never in the repo.
"""

from __future__ import annotations

import base64
import binascii
import os
from dataclasses import dataclass
from datetime import datetime

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT_VERSION = 1
IV_BYTES = 12
TAG_BYTES = 16


class TokenStoreError(Exception):
    """The key or a stored blob is unusable (wrong key, tampered, bad format)."""


def parse_key(raw: str | None) -> bytes | None:
    """Decode TOKEN_ENC_KEY. Returns None when unset; raises when set but malformed."""
    if raw is None or not raw.strip():
        return None
    s = raw.strip()
    padded = s + "=" * (-len(s) % 4)
    try:
        if "-" in s or "_" in s:
            key = base64.urlsafe_b64decode(padded)
        else:
            key = base64.b64decode(padded, validate=True)
    except (binascii.Error, ValueError) as e:
        raise TokenStoreError(f"TOKEN_ENC_KEY is not valid base64: {e}") from None
    if len(key) != 32:
        raise TokenStoreError(f"TOKEN_ENC_KEY must decode to 32 bytes, got {len(key)}")
    return key


def key_from_env() -> bytes | None:
    return parse_key(os.environ.get("TOKEN_ENC_KEY"))


def aad_for(client: str, field: str) -> bytes:
    return f"rotor:{client}:{field}".encode()


def encrypt(plaintext: str, key: bytes, aad: bytes, iv: bytes | None = None) -> bytes:
    """Encrypt to the shared blob format. `iv` is only passed by tests (fixed vectors)."""
    iv = iv if iv is not None else os.urandom(IV_BYTES)
    if len(iv) != IV_BYTES:
        raise TokenStoreError("IV must be 12 bytes")
    return bytes([FORMAT_VERSION]) + iv + AESGCM(key).encrypt(iv, plaintext.encode(), aad)


def decrypt(blob: bytes | memoryview, key: bytes, aad: bytes) -> str:
    data = bytes(blob)
    if len(data) < 1 + IV_BYTES + TAG_BYTES or data[0] != FORMAT_VERSION:
        raise TokenStoreError("unknown token blob format")
    iv, body = data[1 : 1 + IV_BYTES], data[1 + IV_BYTES :]
    try:
        return AESGCM(key).decrypt(iv, body, aad).decode()
    except Exception:  # cryptography raises InvalidTag
        raise TokenStoreError("token blob failed authentication (wrong key or tampered)") from None


@dataclass(frozen=True)
class StoredToken:
    client: str
    account_id: str
    spotify_client_id: str
    refresh_token: str
    scopes: str
    authorized_at: datetime
    last_error: str | None


def load_token(conn, client: str, key: bytes) -> StoredToken | None:
    """Read and decrypt one row. None when the row doesn't exist."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT account_id, spotify_client_id, refresh_token_enc, scopes, authorized_at, last_error
        FROM hub_oauth_tokens
        WHERE client = %s AND provider = 'spotify'
        """,
        (client,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    account_id, spotify_client_id, blob, scopes, authorized_at, last_error = row
    return StoredToken(
        client=client,
        account_id=account_id,
        spotify_client_id=spotify_client_id,
        refresh_token=decrypt(blob, key, aad_for(client, "refresh_token")),
        scopes=scopes,
        authorized_at=authorized_at,
        last_error=last_error,
    )


def record_refresh(conn, client: str, key: bytes, rotated_refresh_token: str | None) -> None:
    """Mark a successful refresh. Stores a rotated refresh token; never moves authorized_at."""
    cur = conn.cursor()
    if rotated_refresh_token:
        cur.execute(
            """
            UPDATE hub_oauth_tokens
               SET refresh_token_enc = %s, last_refresh_at = now(),
                   last_error = NULL, last_error_at = NULL, updated_at = now()
             WHERE client = %s
            """,
            (encrypt(rotated_refresh_token, key, aad_for(client, "refresh_token")), client),
        )
    else:
        cur.execute(
            """
            UPDATE hub_oauth_tokens
               SET last_refresh_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()
             WHERE client = %s
            """,
            (client,),
        )
    conn.commit()


def record_error(conn, client: str, error: str) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE hub_oauth_tokens
           SET last_error = %s, last_error_at = now(), updated_at = now()
         WHERE client = %s
        """,
        (error[:500], client),
    )
    conn.commit()

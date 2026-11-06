"""Generate a VAPID key pair for Rotor's Web Push (v0.82, R2).

  uv run python scripts/generate_vapid_keys.py

Prints two values:
  VAPID_PUBLIC_KEY   → Vercel env (the browser needs it to subscribe; public)
  VAPID_PRIVATE_KEY  → GitHub Actions secret only (hub-jobs.yml signs pushes with it)
Never commit either; run it once and paste. Rotating the pair means every device
has to enable notifications again.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def main() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    private_raw = key.private_numbers().private_value.to_bytes(32, "big")
    public_raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    print(f"VAPID_PUBLIC_KEY={b64url(public_raw)}")
    print(f"VAPID_PRIVATE_KEY={b64url(private_raw)}")


if __name__ == "__main__":
    main()

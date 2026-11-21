"""Executed through SSH stdin/-c; never imports or modifies the pochti project."""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path


class ReadError(Exception):
    pass


def read_mail(request):
    action = request.get("action")
    if action not in {"probe", "messages", "addresses"}:
        raise ReadError("MAIL_REQUEST")
    config_path = Path(request.get("config", "/etc/tempmail/config.json"))
    if not config_path.is_absolute():
        raise ReadError("MAIL_CONFIG")
    with config_path.open(encoding="utf-8-sig") as source:
        database = Path(json.load(source)["database"])
    if not database.is_absolute():
        raise ReadError("MAIL_CONFIG")
    email = request.get("email", "")
    if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ReadError("MAIL_REQUEST")
    now = int(time.time())
    # mode=ro prevents opening a missing DB as a new empty store or writing rows.
    db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        db.execute("BEGIN")
        address = db.execute(
            "SELECT address, user_id, expires_at FROM addresses WHERE address = ?",
            (email.lower(),),
        ).fetchone()
        if address is None:
            raise ReadError("MAIL_NOT_FOUND")
        # Resolve ownership using the explicitly supplied mailbox, never another user.
        if action == "addresses":
            rows = db.execute(
                "SELECT address, expires_at FROM addresses WHERE user_id = ? AND expires_at > ? ORDER BY created_at, id",
                (address["user_id"], now),
            ).fetchall()
            return {"ok": True, "addresses": [dict(row) for row in rows]}
        if address["expires_at"] <= now:
            raise ReadError("MAIL_EXPIRED")
        result = {"ok": True, "mailbox": {"email": address["address"], "expiresAt": address["expires_at"], "now": now}}
        if action == "messages":
            since = request.get("since", 0)
            if not isinstance(since, (int, float)) or since < 0:
                raise ReadError("MAIL_REQUEST")
            # Only messages related to Apify for this exact mailbox are transferred.
            rows = db.execute(
                """SELECT m.id, m.sender, m.body, m.received_at
                     FROM messages m JOIN addresses a ON a.id = m.address_id
                    WHERE a.address = ? AND a.user_id = ? AND a.expires_at > ?
                      AND m.received_at >= ? AND instr(lower(m.sender), 'apify.com') > 0
                    ORDER BY m.received_at DESC, m.id DESC LIMIT 100""",
                (email.lower(), address["user_id"], now, max(0, int(since / 1000) - 60)),
            ).fetchall()
            result["messages"] = [dict(row) for row in rows]
        return result
    finally:
        db.close()


def main():
    try:
        result = read_mail(json.load(sys.stdin))
    except ReadError as error:
        result = {"ok": False, "error": str(error)}
    except Exception:
        result = {"ok": False, "error": "MAIL_REMOTE_READ"}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()

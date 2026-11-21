"""Resolve the existing operator for issuance without changing pochti state."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def main():
    try:
        request = json.load(sys.stdin)
        config = json.loads(Path(request.get("config", "/etc/tempmail/config.json")).read_text())
        db = sqlite3.connect(Path(config["database"]).as_uri() + "?mode=ro", uri=True)
        try:
            db.execute("PRAGMA query_only = ON")
            owners = set()
            for request_id in request.get("requestIds", [])[:100]:
                digest = hashlib.sha256(request_id.encode()).digest()
                row = db.execute("SELECT user_id FROM issuance_events WHERE request_id = ?", (digest,)).fetchone()
                if row and row[0] > 0:
                    owners.add(row[0])
            source = "known_issuance"
            if not owners:
                rows = db.execute("SELECT user_id FROM users WHERE user_id > 0").fetchall()
                if len(rows) == 1:
                    owners.add(rows[0][0])
                    source = "only_non_test_user"
            if len(owners) != 1:
                print(json.dumps({"ok": False, "error": "MAIL_OWNER_UNRESOLVED"}))
                return
            print(json.dumps({"ok": True, "ownerId": next(iter(owners)), "source": source}))
        finally:
            db.close()
    except Exception:
        print(json.dumps({"ok": False, "error": "MAIL_OWNER_UNRESOLVED"}))


if __name__ == "__main__":
    main()

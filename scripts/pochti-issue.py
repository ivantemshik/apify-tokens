"""Issue one new mailbox using the existing deployed pochti application."""
import json
import sqlite3
import sys
from pathlib import Path


def main():
    try:
        request = json.load(sys.stdin)
        anchor = request.get("email", "")
        domain = request["domain"]
        request_id = request["requestId"]
        if not isinstance(request_id, str) or not request_id.startswith("apify-") or len(request_id) > 120:
            raise ValueError()
        sys.path.insert(0, "/opt/tempmail/src")
        from temp_mail.__main__ import Config, smtp_ready
        config = Config.read(Path(request.get("config", "/etc/tempmail/config.json")))
        if domain not in config.suffixes or not smtp_ready():
            raise ValueError()
        with sqlite3.connect(Path(config.database).as_uri() + "?mode=ro", uri=True) as db:
            owner = db.execute("SELECT user_id FROM addresses WHERE address = ?", (anchor,)).fetchone()
            if owner is None and type(request.get("ownerId")) is int and request["ownerId"] > 0:
                owner = db.execute("SELECT user_id FROM users WHERE user_id = ?", (request["ownerId"],)).fetchone()
        if owner is None or owner[0] < 0:
            raise ValueError()
        store = config.store()
        result = store.issue_address(owner[0], domain, request_id)
        if result.status != "created" or result.address is None:
            print(json.dumps({"ok": False, "error": "MAIL_ISSUE_UNAVAILABLE"}))
            return
        print(json.dumps({"ok": True, "address": result.address["address"], "expiresAt": result.address["expires_at"]}))
    except Exception:
        print(json.dumps({"ok": False, "error": "MAIL_ISSUE_UNAVAILABLE"}))


if __name__ == "__main__":
    main()

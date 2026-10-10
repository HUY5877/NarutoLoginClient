"""Exercise the production enqueue Lua in an isolated Redis emulator.

Run with Python containing fakeredis[lua]: python tests/queue-restart.integration.py
No project configuration, credentials or live Redis keys are accessed.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import fakeredis
from redis.exceptions import ResponseError


SCRIPT = re.search(
    r"const enqueueScript = `([\s\S]*?)`;",
    (Path(__file__).resolve().parents[1] / "src/server/queue.ts").read_text(encoding="utf-8"),
).group(1)
PREFIX = "restart:tasks"
USER = str(uuid4())
OLD_ID = str(uuid4())
LOCK = f"{PREFIX}:users:{USER}:active"
NOW = "2026-10-10T00:02:30.000Z"
SESSION = {
    "id": OLD_ID, "userId": USER, "status": "qr_ready", "workerId": "worker-1",
    "createdAt": "2026-10-10T00:00:00.000Z", "expiresAt": "2026-10-10T00:02:00.000Z",
    "loginStartedAt": "2026-10-10T00:01:00.000Z", "loginExpiresAt": "2026-10-10T00:11:00.000Z",
    "tokenHash": "a" * 64, "simulation": True, "loginAuthorized": True,
}
RUN = {"taskId": OLD_ID, "workerId": "worker-1", "status": "failed", "errorCode": "login_finish_failed"}


def fixture(report):
    db = fakeredis.FakeRedis(decode_responses=True)
    db.set(LOCK, OLD_ID, ex=600)
    db.set(f"{PREFIX}:sessions:{OLD_ID}", json.dumps(SESSION), ex=600)
    if report is not None:
        db.set(f"{PREFIX}:runs:{OLD_ID}", report if isinstance(report, str) else json.dumps(report), ex=86400)
    db.xadd(f"{PREFIX}:logs:{OLD_ID}", {"json": "original execution history"})
    return db


def submit(db, task_id):
    session = {"id": task_id, "userId": USER, "status": "queued", "tokenHash": "b" * 64,
               "createdAt": NOW, "expiresAt": "2026-10-10T00:07:30.000Z", "simulation": True}
    keys = [PREFIX, f"{PREFIX}:sessions:{task_id}", LOCK, f"{PREFIX}:logs:{task_id}"]
    return db.eval(SCRIPT, len(keys), *keys, json.dumps(session), "300000",
                   json.dumps({"id": task_id}), NOW, json.dumps({"message": "submitted"}))


cases = [
    (RUN, 1), ({**RUN, "status": "interrupted"}, 1), ({**RUN, "status": "expired"}, 1),
    (None, -1), ("{", -1), ("null", -1), ({**RUN, "workerId": "old-worker"}, -1),
    ({**RUN, "taskId": str(uuid4())}, -1), ({**RUN, "workerId": None}, -1), ({**RUN, "status": ["failed"]}, -1),
    *[({**RUN, "status": status}, -1) for status in ["waiting_scan", "finishing_login", "running_daily", "completed"]],
]
for report, expected in cases:
    db = fixture(report)
    before = db.get(f"{PREFIX}:sessions:{OLD_ID}")
    new_id = str(uuid4())
    assert submit(db, new_id) == expected, report
    assert db.get(LOCK) == (new_id if expected == 1 else OLD_ID)
    assert db.llen(PREFIX) == (1 if expected == 1 else 0)
    assert db.get(f"{PREFIX}:sessions:{OLD_ID}") == before
    assert db.xlen(f"{PREFIX}:logs:{OLD_ID}") == 1
    assert db.get(f"{PREFIX}:runs:{OLD_ID}") == (None if report is None else report if isinstance(report, str) else json.dumps(report))

# All callers saw the same failure, but only one may replace the old lock.
db = fixture(RUN)
ids = [str(uuid4()) for _ in range(8)]
with ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(lambda value: submit(db, value), ids))
assert results.count(1) == 1 and results.count(-1) == 7, results
winner = ids[results.index(1)]
assert db.get(LOCK) == winner and db.llen(PREFIX) == 1
assert submit(db, winner) == 0  # Lost response: replay must not enqueue again.
assert db.llen(PREFIX) == 1

# A late replay of the old outbox cannot reset the new account lock.
old_args = [json.dumps(SESSION), "300000", "{}", NOW, "{}"]
assert db.eval(SCRIPT, 4, PREFIX, f"{PREFIX}:sessions:{OLD_ID}", LOCK,
               f"{PREFIX}:logs:{OLD_ID}", *old_args) == 0
assert db.get(LOCK) == winner and db.llen(PREFIX) == 1

# A malformed queue must leave the failed task's lock intact for safe retry.
db = fixture(RUN)
db.set(PREFIX, "wrong-type")
new_id = str(uuid4())
try:
    submit(db, new_id)
    raise AssertionError("corrupt queue was accepted")
except ResponseError:
    pass
assert db.get(LOCK) == OLD_ID and not db.exists(f"{PREFIX}:sessions:{new_id}")
print(f"PASS: {len(cases)} lease/worker scenarios, concurrent restart, idempotent replay and queue failure")

"""Drive the real research parser, proof assembler and receipts with local fixtures."""

import json
import sys
from pathlib import Path


def deny_external_effects(event, _args):
    if event.startswith(("socket.", "os.exec", "os.posix_spawn", "os.spawn")) or event in {
        "subprocess.Popen", "os.system", "os.fork", "os.forkpty"
    }:
        raise RuntimeError("The offline research fixture forbids networking and process launches")


sys.addaudithook(deny_external_effects)
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / ".agents/skills/deep-research/scripts"))

# The Unix worker and collector are unchanged. Supply their two platform I/O
# operations inside this isolated, offline fixture process on Windows only.
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes
    import errno
    import msvcrt
    import os
    from types import ModuleType

    fcntl = ModuleType("fcntl")
    fcntl.LOCK_EX, fcntl.LOCK_NB, fcntl.LOCK_UN = 2, 4, 8

    def flock(fd, operation):
        if operation == (fcntl.LOCK_EX | fcntl.LOCK_NB):
            mode = msvcrt.LK_NBLCK
        elif operation == fcntl.LOCK_UN:
            mode = msvcrt.LK_UNLCK
        else:
            raise ValueError("Unexpected offline fixture lock operation")
        position = os.lseek(fd, 0, os.SEEK_CUR)
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, mode, 1)
        except OSError as error:
            if mode == msvcrt.LK_NBLCK and error.errno in (errno.EACCES, errno.EAGAIN):
                raise BlockingIOError(errno.EAGAIN, "Offline fixture worker lock is held") from error
            raise
        finally:
            os.lseek(fd, position, os.SEEK_SET)

    fcntl.flock = flock
    sys.modules["fcntl"] = fcntl

    move_file = ctypes.WinDLL("kernel32.dll", use_last_error=True).MoveFileExW
    move_file.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
    move_file.restype = wintypes.BOOL
    replace_existing, write_through = 0x1, 0x8

    def write_windows_artifact(path, data):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_name(path.name + ".tmp")
        with staged.open("wb") as stream:
            stream.write(data.encode("utf-8") if isinstance(data, str) else data)
            stream.flush()
            os.fsync(stream.fileno())
        if not move_file(str(staged), str(path), replace_existing | write_through):
            raise ctypes.WinError(ctypes.get_last_error())

    import research_worker
    research_worker.atomic = write_windows_artifact

from research_review import digest
from research_cli import MAX_PACKET, collect, rpc
from research_state import Store
from research_worker import Worker


FIXTURE_RETRIEVED_AT = "2026-11-10T00:00:00Z"
LEASE_CONDITION = "According to the lease specification, a restarted worker can recover queue entries only while their lease is valid."
SOURCES = {
    "S001": {
        "url": "https://fixture.invalid/lease/spec",
        "title": "Invented lease queue specification",
        "text": "A restarted worker can recover lease queue entries only while their lease is valid.",
        "fetchedAt": FIXTURE_RETRIEVED_AT,
    },
    "S002": {
        "url": "https://fixture.invalid/journal/spec",
        "title": "Invented journal queue specification",
        "text": "The journal queue can replay committed entries after restart if the journal is intact.",
        "fetchedAt": FIXTURE_RETRIEVED_AT,
    },
    "S003": {
        "url": "https://fixture.invalid/lease/staging-note",
        "title": "Invented staging note",
        "text": "In staging, a restarted worker recovered lease queue entries after their leases had expired.",
    },
}
CLAIMS = [
    ("C1", "A restarted worker can always recover lease queue entries.", "S001"),
    ("C2", "The journal queue can replay committed entries after restart if the journal is intact.", "S002"),
    ("C3", "An invented staging note reports recovery of expired lease queue entries after restart.", "S003"),
]


def initial_report(offers):
    selectors = {
        row["source_id"]: {key: row[key] for key in ("source_id", "text_sha256", "start", "end")}
        for row in offers
    }
    return {
        "title": "Lease queue and journal queue restart behavior",
        "complete": True,
        "claims": [
            {"id": unit, "kind": "fact", "text": text, "evidence": [selectors[source]]}
            for unit, text, source in CLAIMS
        ],
        "summary": ["C1", "C2"],
        "comparisons": [{
            "text": "The lease specification limits recovery to valid leases. The journal specification limits replay to committed entries in an intact journal.",
            "claim_ids": ["C1", "C2"],
        }],
        "recommendations": [{
            "text": "Test recovery near lease expiry and after an interrupted journal write before choosing a queue.",
            "claim_ids": ["C1", "C2"],
        }],
        "contradictions": [{
            "text": "The staging note describes recovery of expired entries, in tension with the lease specification. The cause remains unresolved.",
            "claim_ids": ["C1", "C3"],
        }],
        "unanswered": ["Would the two queues behave the same after power loss rather than process restart?"],
    }


class ScriptedModel:
    model_id = "offline-research-mission-fixture"

    def __init__(self, stage):
        self.stage = stage
        self.calls = 0

    def complete(self, messages, _timeout):
        self.calls += 1
        if self.calls != 1 or self.stage == "finalize":
            raise RuntimeError("Unexpected simulated model call")
        context = json.loads(messages[-1]["content"])
        report = initial_report(context["citation_passages"])
        if self.stage == "initial":
            action = {"action": "finish", "report": report}
        else:
            plan = context["targeted_repair"]["plan"]
            hashes = {row["unit"]: row["beforeSha256"] for row in plan["units"]}
            action = {
                "action": "repair",
                "base_candidate_hash": plan["baseCandidateHash"],
                "plan_sha256": digest(plan),
                "replacements": [],
                "checked_units": [],
                "cannot_repair": ["claims:C1"],
            }
            if self.stage == "correct":
                action.update(
                    replacements=[{
                        "unit": "claims:C1", "before_sha256": hashes["claims:C1"],
                        "value": {**report["claims"][0], "text": LEASE_CONDITION},
                    }],
                    checked_units=[
                        {"unit": unit, "before_sha256": hashes[unit]}
                        for unit in ("summary:0", "comparisons:0", "recommendations:0", "contradictions:0")
                    ],
                    cannot_repair=[],
                )
        return {"content": json.dumps(action)}


def deny_retrieval(*_args):
    raise RuntimeError("The offline research fixture forbids external retrieval")


def drive(root, stage, job_id):
    expected = {
        "initial": "awaiting_semantic_review", "correct": "awaiting_semantic_review",
        "decline": "partial", "finalize": "completed",
    }[stage]
    store = Store(root / "backend")
    job = store.get(job_id)
    if job["manifest"]["mode"] != "fixture" or [row["id"] for row in store.list_jobs() if row["status"] in ("queued", "running")] != [job_id]:
        raise RuntimeError("Expected exactly one runnable offline fixture job")
    if stage == "initial":
        if store.claim_next()["id"] != job_id:
            raise RuntimeError("Unexpected research fixture job")
        store.checkpoint(job_id, {
            "step": 0, "phase": "draft", "next": "model", "history": [], "sources": SOURCES,
            "known_urls": [], "draft": None, "errors": [], "limited": False,
        })
        # Record the scripted discovery response through the real operation ledger.
        operation = store.reserve(job_id, "search", {"query": "invented queue specifications"})
        store.complete_operation(operation["id"], {"status": "ok", "results": []})
    if stage == "finalize":
        store.accepted_packet(job)
    model = ScriptedModel(stage)
    Worker(store, model, deny_retrieval, deny_retrieval, mode="fixture").drain()
    finished = store.get(job_id)
    if finished["status"] != expected or model.calls != (0 if stage == "finalize" else 1):
        raise RuntimeError(f"Fixture {stage} expected {expected}, got {finished['status']}: {finished.get('reason')}")
    return {"status": finished["status"], "reason": finished.get("reason")}


def main(output, action, *args):
    root = Path(output)
    if action in ("rpc", "collect"):
        raw = sys.stdin.buffer.read(MAX_PACKET + 1)
        if len(raw) > MAX_PACKET:
            raise ValueError("Offline fixture request exceeds its packet bound")
        request = json.loads(raw)
        if action == "collect":
            if request["job"]["manifest"]["mode"] != "fixture":
                raise ValueError("The offline fixture can only collect a fixture result")
            result = collect(request, root / "coordinator" / "research-results")
        else:
            command = request["command"]
            allowed = {"prepare_manifest", "submit", "status", "proposal_export", "review_reserve", "review_submit", "export"}
            if command not in allowed or (command in ("prepare_manifest", "submit") and request["manifest"]["mode"] != "fixture"):
                raise ValueError("Unexpected offline fixture RPC")
            result = rpc(Store(root / "backend"), request)
    else:
        result = drive(root, action, *args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:])

# Research missions

A mission groups a saved research task's question, claim ledger, source passages and exact review state. The coordinator still owns task status and approval. The mission view describes what the available evidence establishes.

## Offline demonstration

Run this from the source checkout with Node 24 and Python 3. The output path must be new and its parent must be a private, caller-owned temporary directory.

```sh
demo_root="$(mktemp -d)"
node scripts/mosaic-research-mission.mjs demo --output "$demo_root/mission"
```

Set `FRONTIER_TEST_PYTHON` to an existing Python interpreter if needed. The demo uses invented source documents and simulated independent reviewer responses. The Node coordinator, durable SQLite records, Python research protocol and targeted assembly run locally in disposable state. The demo forbids provider, retrieval and network access. It records the original candidate that needs revision, a fresh candidate awaiting review, the final accepted candidate and a separate partial result for an issue outside the targeted contract. Read `transcript.json` alongside the Markdown and JSON exports for the candidate identities and restart evidence.

On Windows, the source demo can validate its output directory and prepare its disposable draft. The protected execution gate still holds goal activation, so the full demo stops there. The Windows offline fixture job verifies the Python artifact path independently. It uses the invented sources and a simulated reviewer to write, hash and collect a repaired report. An authenticated recipe preview against a saved draft returns the parked diagnostic and creates zero tasks or provider requests.

## Read an existing task

Use the same authenticated coordinator connection as the harness CLI. The read commands require a running coordinator with the mission tools registered.

```sh
node scripts/mosaic-research-mission.mjs inspect --root "$state_root" --task "$task_id"
node scripts/mosaic-research-mission.mjs export --root "$state_root" --task "$task_id" --format markdown
```

The equivalent tools are `research_mission_inspect` and `research_mission_export`. Export accepts `json` or `markdown`. Both accept an optional `candidateHash` (CLI `--candidate`) for a current or retained, locally verified negative review on this task. An archived candidate keeps its negative verdict after replacement. The artifact catalog can open the original via its saved ID. The first read of a saved artifact can register its ID in the existing artifact catalog. Later reads reuse the record and verify the bytes used by the view. The caller supplies no report path, review decision or evidence bytes.

The default page contains up to 10 entries across claims, summary, comparisons, recommendations, contradictions, unanswered questions and sources in that order. The maximum is 20 entries. The JSON page has a 256 KiB byte ceiling and may return fewer entries. Continue with `pagination.nextOffset` (CLI `--offset`) until it is null. Select the same candidate hash while paging bound candidates. Use the saved artifacts for the original bytes and full evidence when a display bound is reached.

Each canonical claim ID keeps its text and qualification. Source selections use the saved text hash and zero-based, end-exclusive Unicode character offsets. Summary and synthesis units point back to claims by ID. Source retrieval dates remain unknown when the catalog has no recorded date. A retrieval date does not provide the publication date. `mechanically_linked` means the quote matches a saved source. `reviewed_supported` requires exact independent review with coverage. A finding can make a mechanically linked unit `disputed`. Missing and malformed evidence stays `unverified`, with diagnostics and original artifacts where available.

An acknowledged review awaiting collection appears as `awaiting_finalization`. Reviewed support appears after successful collection. For supported reviewed results, acceptance uses the coordinator's exact goal/task authority, acknowledged reviewer ticket, full coverage, remote receipt, report/source hashes and targeted assembly proof where applicable. Research completed under an older protocol or the deterministic native path can appear as partial in this view because it lacks that independent review. The original task status remains visible as `sourceStatus`.

## Prepare and correct

`research_mission_prepare` saves a data-only draft using a goal ID, exact goal hash, idempotency key and brief. The brief requires `question`, `scope`, `outputShape` and a calendar `asOf` date in `YYYY-MM-DD` form. The text bounds are 2,000 characters for question and scope and 1,000 for output shape. A matching question in the same goal version may display the brief separately as requested metadata. Its as-of date describes the request. The canonical report does not record a candidate as-of date. Each view keeps the task identity and its approved source scope, permissions, limits and deadlines.

An authorized research task enters the existing goal approval and task submission path in a research-capable environment. The existing `research_review` tool reserves review and submits a verdict against the exact candidate and rubric hashes. A targeted revision uses the saved findings and changes only authorized units. Its replacement needs a full new independent review. If a required change needs a new source or exceeds the repair contract, the task can end partial and retain the rejected original.

The installed coding release keeps research parked. The core mission tools can prepare metadata and inspect available evidence. The beta tool catalog keeps the research namespace hidden. Research execution and correction require the existing research route. Live readiness requires a bound pre-final acceptance receipt and a separate independent live assessment for the exact final report and source artifacts, plus the applicable release provenance and activation gates. Fixture results establish local behavior with simulated review, and do not satisfy those gates. See [review lifecycle](research-review/IMPLEMENTATION.md) and [release authority](research-review/LOCAL_READINESS_AUTHORITY.md).

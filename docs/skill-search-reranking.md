# Opt-in skill-search reranking contract

Status: implemented, **disabled by default**. Global configuration loading,
bounded Jev networking via `@typesafe-ai/sdk` 0.6.0, validation, deadlines, and
session-memory caching implement this contract. The keyword ranking algorithm
remains unchanged and supplies the default and every failure fallback.

## Scope and configuration

Only `skill_search` may invoke the reranker. Do not change automatic prompt
transforms, memory filtering, documentation injection, skill execution, or
`index.ts` prompt behavior. Preserve lazy file loading and explicit `/skill:name`:
the reranker never reads or executes a skill and does not intercept that command.

The repository already uses `config.toml` with snake_case TOML fields for Bootstrap
configuration (`src/bootstrap-protocol.ts`). Add an optional
`[skill_search.reranking]` table to the **global Bootstrap config only**, at
`<globalDirectory>/config.toml`. Use the global directory already resolved by
Bootstrap, not a new hard-coded Pi home. The extension's current fallback is
`~/.config/pi/agent/extensions/pi-bootstrap`; a supplied agent directory overrides
it. This is extension configuration, not Pi `settings.json` or `models.json`.

Project config cannot opt in or override reranking settings. This deliberate
exception to Bootstrap's global/project protocol inheritance prevents a checkout
from silently enabling paid transmission using the user's credential. The existing
root `enabled` controls Bootstrap rules, not consent to reranking; only the new
nested `enabled = true` grants that consent. Existing rule tables remain required
where the current protocol parser requires them. Do not rewrite installed defaults
or add opt-in settings automatically.

Example to append to a valid global config (then start a fresh session/reload):

```toml
[skill_search.reranking]
enabled = true
model = "jev-latest" # Optional; pin a version for reproducibility.
timeout_ms = 1000
cache_max_entries = 128
cache_ttl_ms = 300000
max_candidates = 32
max_query_bytes = 2048
max_name_bytes = 256
max_description_bytes = 512
max_payload_bytes = 32768
min_probability = 0.55
min_margin = 0.10
```

| TOML key | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `false` | Boolean; only literal `true` opts in |
| `experimental_fit` | `false` | Boolean; adds independent candidate applicability in the same request; still requires `enabled` |
| `min_fit_probability` | `0.75` | Finite number in (0.5, 1]; uncalibrated symmetric fit/negative confidence gate |
| `model` | `"jev-latest"` | Nonblank Jev model ID, at most 256 UTF-8 bytes |
| `timeout_ms` | `1000` | Integer 1–10000 |
| `cache_max_entries` | `128` | Integer 0–1024; 0 disables caching |
| `cache_ttl_ms` | `300000` | Integer 0–3600000; 0 disables caching |
| `max_candidates` | `32` | Integer 1–64, independent of result `limit` |
| `max_query_bytes` | `2048` | Integer 1–8192 |
| `max_name_bytes` | `256` | Integer 1–256 |
| `max_description_bytes` | `512` | Integer 0–2048 |
| `max_payload_bytes` | `32768` | Integer 256–65536, including serialized JSON overhead |
| `min_probability` | `0.55` | Finite number in [0, 1] |
| `min_margin` | `0.10` | Finite number in [0, 1] |

TOML snake_case maps directly to camelCase in `SkillRerankingConfig`. Bounds are
hard maxima, not suggestions. Reject unknown reranking keys and invalid values;
do not coerce strings or clamp invalid settings. Disable reranking for that config
and use keyword search with a sanitized diagnostic. Do not let a reranking config
error break keyword search; existing unrelated protocol errors retain their behavior.
Read config at session start/reload; changes take effect on a fresh session/reload.

Read `TYPESAFE_API_KEY` from the process environment only when opted in. An absent
or whitespace-only key, missing table/file, disabled setting, or
invalid reranking config means normal keyword search and **no provider calls**.
Do not infer a model from Pi's chat model, use Pi login/auth storage, write keys
into TOML, return credentials in tool results, or put keys in logs/cache keys.
Keep the SDK/client lazy: registration, resource discovery, prompt hooks, disabled
searches, and exact-name searches must not create a provider connection. A remote
unsupported-model/auth error is a provider failure, not evidence of no match.

## Candidate selection and privacy boundary

1. Apply the existing query and `limit` validation. Keep the current trim/lowercase
   normalization and Unicode tokenization. Whitespace/punctuation-only queries
   remain tool errors; `limit` remains an integer 1–20, default 5.
2. Snapshot `skillCatalog`: exclude `disableModelInvocation`, keep the first
   duplicate name, and retain its local metadata for later result reconstruction.
   An empty catalog returns the existing empty result without a provider call.
3. If a catalog name equals the normalized query case-insensitively, bypass
   reranking and return the **unchanged keyword-search result**, including its
   ordering, `limit`, and `total`. This preserves existing exact-name behavior;
   it does not introduce a new ranking algorithm or affect `/skill:name`.
4. Compute the unchanged keyword baseline (positive scores only, descending score,
   ties by the existing `name.localeCompare`). Save it for every fallback.
5. For opted-in semantic candidates, start with the entire eligible catalog in
   unchanged keyword score/name order, including zero-score entries. Locally rank
   name/description metadata against the small curated synonym-concept vocabulary
   in `src/bootstrap-skills-retrieval.ts`, scoring alternate concept terms only
   (literal query tokens already have the lexical stream). Alternate lexical and
   concept-ranked streams, deduplicating names; start with concept matches when
   all lexical scores are zero. Then take at most `max_candidates`, independent of result `limit`.
   This reserves slots for supported synonym-only targets even in late catalog
   positions or when lexical matches fill the cap, without additional API calls.
   The outbound query/metadata are not expanded. This is deterministic retrieval
   enrichment, not general semantic understanding: unsupported vocabulary,
   non-English paraphrases, ambiguous concepts, or many competing concept matches
   can still miss the target. Small caps (especially 1 with positive lexical hits)
   and payload tail-dropping further limit recall. No quality improvement is
   claimed beyond the focused synthetic acceptance cases; cookbook examples are
   inspiration, not measured evidence. A skill absent from the actual transmitted
   shortlist cannot be selected.
6. Build fresh allowlisted objects containing only `id`, `name`, and `description`.
   IDs are `c0`, `c1`, … in shortlist order, valid only for this request/snapshot.
   Keep the ID-to-local-metadata map private. Skip candidates with names over
   `max_name_bytes` (do not truncate names); truncate descriptions at UTF-8 code
   point boundaries to `max_description_bytes`. Empty descriptions are allowed.
7. The outbound data payload is exactly `SkillRerankingRequest`: normalized query
   plus those candidates. If the query exceeds `max_query_bytes`, use the baseline
   without sending a truncated query. Enforce `max_payload_bytes` on the UTF-8
   encoding of `JSON.stringify(request)`, including escaping and delimiters; drop
   candidates from the tail until it fits. If none fit, use baseline, no call.
   Assign IDs after dropping/skipping so they remain contiguous.

Never transmit conversation history, system prompts, full `SKILL.md` bodies,
file contents/excerpts, `filePath`, `baseDir`, source paths, cwd, or local provenance.
Do not spread `SkillMetadata` into a request. The adapter may add only a fixed,
application-owned classification instruction/schema plus the configured model and
authentication required by the SDK; no Pi prompt or session context is an input.
Descriptions and the query can themselves contain sensitive text or path strings;
opt-in allows transmitting this bounded user-authored metadata, not a promise of
content redaction. Do not auto-fetch supporting files or URLs found in metadata.

## Adapter, validation, and decisions

`src/bootstrap-skills-reranking.ts` is a type-only seam. The SDK adapter receives
only the bounded request, explicit model ID, and caller-owned `AbortSignal`.
Credentials stay in the adapter's private construction state. Its return type is
`unknown` deliberately: TypeScript types do not validate provider data.

Normalize the SDK answer into `SkillRerankingDistribution` before applying it:

```json
{"probabilities":[{"id":"c0","probability":0.7},{"id":"c1","probability":0.1},{"id":null,"probability":0.2}]}
```

Require exactly one entry per submitted ID and one explicit `null` no-match
alternative. Reject unknown IDs, duplicate IDs, missing entries, empty/partial
answers, wrong types, NaN/infinite/negative probabilities, values above 1, and a
sum not within 0.000001 of 1. Normalize the accepted near-one sum to 1 before
gating. Never use provider-supplied paths, names, descriptions, executable text,
or IDs from another request. Construct public matches only from the captured
local map, and return fresh metadata objects as today. Bound the provider response
before parsing (64 KiB); oversized responses are failures. The SDK adapter must
supply a complete answer distribution (including no-match); if its API cannot,
report failure, rather than inventing probabilities from prose/confidence labels.

Decision rules:

- Rank alternatives by descending probability. Tied candidates keep shortlist
  order (keyword score then name). On a tie involving no-match, put no-match
  first for deterministic conservative behavior.
- Let `p1` be the largest probability and `p2` the second largest (including
  no-match). Accept a decision only if `p1 >= min_probability` and
  `p1 - p2 >= min_margin`. These tunable **distribution-based signals are not
  correctness guarantees**, calibrated accuracy, or a claim the task is safe.
- If the accepted top alternative is no-match, return `{ matches: [], total: 0 }`
  and the existing no-matching-skills text. This is an intentional semantic empty
  result, even if the keyword baseline was nonempty.
- This is explicit ranked **search**, not automatic single-skill suggestion.
  `min_probability` and `min_margin` gate only the top decision; defaults remain
  `0.55` and `0.10`. Do not lower them merely to allow multiple results.
- If the accepted top alternative is a candidate, include candidate alternatives
  with probability **strictly greater than no-match**, ordered as above and sliced
  to `limit`. Exclude ties with no-match and zero-support candidates. `total`
  counts qualifying candidates before slicing, not the catalog or shortlist size;
  the requested limit never changes inclusion or the top-decision gate.
  For example, `[0.60, 0.25, 0.10, no_match: 0.05]` returns three candidates at
  defaults (or the first one with `limit=1`, still `total=3`).
- Inclusion is a relative ranking policy, **not an independent applicability/fit
  check**. Even a small positive probability can qualify when no-match is lower;
  a confident winner does not certify the remaining results. Conversely, a
  useful secondary skill may be excluded when no-match outranks it. Independent
  per-candidate fit checks are available only under the additional experimental
  opt-in below; measured quality evaluation remains separate work. Mocked
  distributions establish policy mechanics, not relevance quality.
- A low-probability or ambiguous distribution is `uncertain`, not an explicit
  no-match. Use the unchanged keyword baseline. Likewise, timeout, unavailable
  provider/config/credentials, malformed response/IDs, SDK errors, unsupported
  models, auth/rate-limit/network failures all use that baseline. A baseline may
  itself be empty; failure must never be interpreted as a semantic no-match.
- Retain the public `{ content, details: { matches, total } }` shape, local
  `filePath`/`baseDir`, and read/relative-path guidance. Keep internal
  `SkillRerankingDecision`/sanitized failure reasons separate; do not expose raw
  responses, prompts, or credentials through results or diagnostics.

### Experimental independent applicability

Optional global `experimental_fit = true` adds one `noul` question per submitted
candidate to the **same** Choice request. It is off by default, including for
existing reranking users. No second request, retries, skill bodies or session
context are added. Metadata occurs once in state; questions refer to local IDs.
The fixed rubric judges whether each skill serves the query independently of
other options, not whether the query requests execution: planning, review and
explanation skills may all apply. This mode uses the legacy metadata-in-state
Choice shape, regardless of the adapter's offline formulation selection.

Require a complete bounded fit array (`{id, probability}` per candidate) alongside
the complete Choice distribution. SDK answers must contain exactly `selection`
and all `fit_cN` answers of type `noul` with finite probabilities in [0, 1]. Missing,
extra, duplicate, wrong-type or out-of-range fit data fail closed to keyword
fallback; no inferred fit from Choice mass, prose, reported choice or confidence.
Fit probabilities are independent and **must not** sum to one.

With `t = min_fit_probability` (default **0.75**, an uncalibrated experimental
policy value, not a cookbook-derived or measured threshold):

- Each fit >= t is independently applicable; each fit <= 1-t is confidently
  inapplicable; values between those gates are uncertain.
- All confidently inapplicable yields intentional no-match, even if relative
  Choice confidently prefers the best bad option or is ambiguous.
- Otherwise retain existing Choice top confidence/margin gates and explicit
  accepted no_match. A confident no_match remains an intentional empty result.
- After an accepted candidate winner, return **all independently applicable**
  candidates in Choice order, irrespective of whether the winner itself fits or
  whether another applicable result falls below no_match. Do not gate on maximum
  fit of some other option. Ties retain shortlist order. Exclude uncertain fits;
  if no positive fit remains, use uncertain keyword fallback, not abstention.
- `total` is the fitted count before `limit`; cache decisions remain independent
  of limit. Invalid/provider/timeout/uncertain outcomes are never cached; validated
  all-low no-match may be cached. Effective fit settings participate in cache keys
  and snapshot invalidation.

The logical metadata `max_payload_bytes` cap is unchanged. Fit mode permits a
separate fixed **24576-byte** schema/rubric/model envelope (versus 4096 for
Choice-only), checked both before SDK setup and on actual serialized transport.
Thus the full JSON body is at most `max_payload_bytes + 24576` bytes (57344 at
defaults, absolute maximum 90112); headers/authentication are separate. The
response cap remains 65536 bytes. Question count is bounded at 65 (64 fits plus
Choice); metadata is not duplicated to buy this overhead. More judgments can cost
more time/tokens; no cost, efficacy or latency benefit is claimed. The cookbook is
inspiration only; offline fake-HTTP tests are not calibration or measured evidence.
Focused acceptance: `npx tsx --test test/bootstrap-skills-fit.test.ts`.

## Resource lifetime and fallback guarantees

The caller owns an end-to-end deadline of `timeout_ms`, including SDK lazy setup,
request, and response processing. On expiry, abort and return the saved baseline
without waiting indefinitely for an uncooperative adapter. Disable SDK retries:
one search causes at most one provider request. Propagate tool cancellation to
the adapter; cancellation terminates the tool rather than launching a fallback
network call. Concurrent tool searches must use immutable snapshots and independent
signals. Discard stale responses after catalog/session/config changes; do not cache
or return obsolete paths. Annotate the opted-in tool `openWorldHint: true`
because it can send data externally; disabled keyword-only behavior stays local.

Cache only validated, gated successful decisions (including explicit no-match),
never failures or uncertain results. Cache in session memory only, with LRU eviction
at `cache_max_entries` and absolute expiry `cache_ttl_ms` measured from insertion
using a monotonic clock; hits do not extend expiry. No disk cache or raw provider
response retention. Bound each entry by the request bounds plus at most 64 IDs.
Cache keys cover contract version, model, normalized query, all effective settings,
and the ordered transmitted metadata/ID mapping. Clear on any local catalog
snapshot change (including paths), credential change, config change, `session_start`
(including resume/fork/reload), and `session_shutdown`; abort outstanding work at
these boundaries. Reconstruct cache-hit results from the current local catalog,
never from persisted paths. No shared cross-session credential or cache state.

## Internal evaluation observation

Optional dependency-injected callbacks support the repository benchmark without
changing the public tool result or outbound request. Tool observations contain
only indexes in the eligible sorted catalog, bounded keyword-result indexes,
shortlist kind, decision/reason enums and runtime-observed cache state. The
pre-rerank shortlist is observed even on cache hits; keyword fallback results are
kept separate, never unioned into it. SDK observations contain only attempt events
and validated nonnegative integer token counts (or `null` when unavailable), not
raw responses, query/metadata text, credentials, prompts or paths. No observers
are installed by normal extension registration, and throwing observers are
ignored. The benchmark additionally guards actual transport attempts by its
explicit authorized request ceiling. See [rollout evaluation](skill-search-rollout.md).

## Verification handoff

The implementation must test the config defaults/invalid settings and global-only
consent; zero provider calls while disabled/misconfigured/missing credentials;
exact-name and empty-catalog bypass; bounded Unicode/escaped JSON payloads without
paths/bodies/history; synonym shortlist expansion and excluded/duplicate skills;
validated distributions/IDs, ties, gating, explicit no-match versus every failure;
timeout/cancellation/stale work; cache expiry/eviction/invalidation; unchanged
keyword fallback, result paths/baseDir, and lazy explicit skill loading.

Before recommending adoption, compare keyword and opted-in modes on repository
fixtures for selection accuracy, no-match accuracy, latency, and cost. Threshold
and model choices require those measurements; cookbook examples are inspiration,
not a benchmark or adoption recommendation. The baseline evaluation worker owns
that harness; this contract neither defines fixtures nor changes baseline ranking.

References: [Jev skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion),
`src/bootstrap-skills.ts`, `src/bootstrap-protocol.ts`, `src/bootstrap-paths.ts`,
and Pi's installed `docs/extensions.md`, `docs/skills.md`, `docs/configuration.md`,
`docs/settings.md`, `docs/packages.md`, and `examples/extensions/hello.ts`.

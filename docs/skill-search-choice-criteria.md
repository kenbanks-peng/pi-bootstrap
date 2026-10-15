# Offline Choice-criteria evaluation

`src/bootstrap-skills-jev.ts` exports `buildJevChoiceRequest(request, model,
formulation)` for offline request-shape comparisons. It imports no SDK and makes
no network request. Formulations:

- `legacy` (default): query/candidates in state, null option criteria.
- `explicit-criteria`: query only in state; each request-local `c0`, `c1`, …
  option has structured `{ name, description }` evidence. `no_match` explicitly
  means none of the offered skills serves the requested task, rather than
  selecting a merely related skill. Fixed instructions identify metadata and
  the query as untrusted data, not instructions.

Metadata is included **once** in either formulation. Names are not option IDs,
so even a skill named `no_match` does not collide with the no-match option.
Only query, candidate ID/name/description, fixed application-owned rubric/schema,
and the explicit model are included. Extra candidate/request fields are dropped.
No skill bodies, excerpts, paths, provenance, history or Pi prompts are read or
added. Metadata/query text itself is not redacted; it can contain sensitive text.
A prompt-injection disclaimer is not a demonstrated model-security guarantee.

## Comparing without an API call

```ts
import { buildJevChoiceRequest } from "../src/bootstrap-skills-jev.ts";

const request = {
  query: "modify an existing slide deck",
  candidates: [
    { id: "c0", name: "slide-editor", description: "Edit existing slides." },
    { id: "c1", name: "slide-author", description: "Create new slide decks." },
  ],
};
const legacy = buildJevChoiceRequest(request, "offline-test-model", "legacy");
const explicit = buildJevChoiceRequest(request, "offline-test-model", "explicit-criteria");
// Compare JSON shapes/UTF-8 sizes locally; do not send private fixtures.
```

For fake-HTTP adapter checks, the optional fourth `createJevAdapter` argument
selects the formulation: `createJevAdapter(key, fakeFetch, observe,
"explicit-criteria")`. Calling its `rerank` method invokes the SDK and supplied
fetch; use fake fetch for offline work. Omitting fake fetch would perform a paid
request. This task did not make paid requests. Production construction remains
legacy; this Choice-only experiment introduces no formulation config switch,
enablement change or default promotion.
Any future live comparison needs separate consent and separately identified
formulation artifacts/caches. Pure request-shape tests establish no accuracy,
latency, token-cost or efficacy advantage.

## Bounds and unchanged decisions

The bounds and decisions below describe Choice-only mode, without experimental fit.

The existing runtime still bounds `JSON.stringify(SkillRerankingRequest)` by
`max_payload_bytes`, including escaping and delimiters. The metadata budget is
not doubled by moving it into criteria. The adapter additionally rejects logical
requests above the supported 65536-byte ceiling, candidate counts outside 1–64,
noncontiguous IDs, and model IDs outside 256 UTF-8 bytes. Runtime query/name/
description caps and tail dropping are unchanged.

The complete JSON SDK body has a separate fixed envelope allowance of **4096
UTF-8 bytes above the allowlisted logical request size**. This covers instructions,
explicit no-match rubric, question/schema delimiters, option-map overhead (up to
64 candidates), and the configured model (including JSON escaping). It is not a
second metadata allowance. Both the pure builder and the actual SDK transport
check this bound before HTTP is attempted; a changed SDK wire shape that exceeds
it fails closed. Thus the maximum supported JSON body is 69632 bytes; the default
32768-byte logical cap permits at most 36864 bytes including envelope. Headers
and authentication are outside the JSON cap. The 65536-byte response cap remains
independent and unchanged.

Only the provider's probability distribution is returned. Existing runtime
completeness/ID/range/sum validation, probability/margin gates, keyword fallback,
no-match handling, cancellation and cache lifetime policy remain unchanged.
The client and per-call retry counts remain zero; imports/client creation remain
lazy. There are no runtime/config/retrieval or Pi API changes.

Focused offline acceptance: `npx tsx --test test/bootstrap-skills-jev-criteria.test.ts`.
The tests cover both real-SDK/fake-HTTP shapes, allowlisting, ID mapping,
injection-like metadata, explicit no-match, UTF-8/escaping/envelope bounds,
unchanged decisions for matching/no-match/uncertain/invalid distributions,
zero retries, pre-abort, and oversized responses.

The [TypeSafe skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion)
is inspiration for option-level evidence only, not measured evidence for this
Choice-only experiment. Its bodies/history, second pass and applicability questions
are not adopted by this experiment. Independent applicability is now available
separately through the additional opt-in
[`experimental_fit` mode](skill-search-reranking.md#experimental-independent-applicability),
with its own documented single-request questions, decision policy and envelope bound.

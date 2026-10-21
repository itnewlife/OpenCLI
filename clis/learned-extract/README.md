# Learned extraction

This opt-in OpenCLI plugin learns a constrained rule once, validates it against independently checked page snapshots, and reuses it on fresh snapshots. The executor reads HTML and JSON-LD as data. It never evaluates generated JavaScript, runs page scripts, clicks, submits forms, or requests URLs found in a page.

The implementation is independent of Firecrawl source code. It reuses the general idea of validated reusable extraction rules, under OpenCLI's Apache-2.0 license.

## Version 0.1.2

Rules can explicitly declare variable text regions in addition to strict structural regions. For example, `"template":{"selectors":["[data-hook=reviewTitle]"],"textRegions":[{"selector":"[data-hook=reviewRichContentContainer]","within":"[data-hook=review]"}]}` validates the title structure and allows the complete body field to contain different numbers of paragraphs. Each text container and its owner must be unique, every declared content region must stay inside the same owner, its ancestor path is hashed, and all declared content regions must remain disjoint. Only bounded, safe text-formatting tags are accepted. A text region supports only a string text read of the complete declared container; nested selectors, attribute/number reads and JSON-LD are rejected there. Missing, duplicate, unsafe, moved or empty content still fails validation. At most eight structural and text regions combined are allowed; at least one structural region remains required.

Existing rules without text regions retain their previous hash and strict behavior. Adopting text regions requires checked re-learning; old cache files are never silently relaxed. The packaged plugin activates the corrected `amazon discussion <ASIN-or-URL>` through OpenCLI's normal plugin precedence and also exposes `learned-extract amazon-reviews <ASIN-or-URL>` using the exact same implementation. The global package files are untouched; uninstalling or rolling back the plugin restores the prior built-in command. Both commands support modern and legacy review markup, preserve body paragraph separators, record per-review identity and variant provenance, omit reviewer names, and report missing/conflicting fields explicitly. Use `--source product` to explicitly read reviews embedded on the product page, or the default `--source reviews` to start at the review list. Login and captcha stop that command without changing source. Commands return only currently rendered review samples; they do not paginate or claim complete coverage.

## Version 0.1.1

Editable content is excluded for empty, case-insensitive true and plaintext-only `contenteditable` values, including an editable document root. Template identity includes parent-child relationships as well as tag order and attribute names. Learning and repair bind to the cache revision read before generation; a concurrent writer causes the stale proposal to be rejected rather than silently promoted. Capture initializes a blank page lease before navigation to avoid duplicate first navigation on older Browser Bridge extensions.

Rules may optionally define `template.selectors` to validate stable content regions while excluding unrelated recent-history or recommendation modules. Each selector must identify exactly one distinct, non-overlapping region; DOM sources and JSON-LD scripts must remain inside the declared regions. Without this option the whole document is checked.

The template hash changed in 0.1.1. Existing 0.1.0 rules will report a template mismatch; re-learn with checked samples or explicitly repair with the same validated URL scope. Old cache entries and the previous plugin directory can be retained for rollback.

## Build and install

```sh
npm ci --ignore-scripts
npm run build
node scripts/package-learned-extract.mjs
node scripts/install-learned-extract.mjs
opencli learned-extract --help -f json
```

The packaged plugin includes its own extraction implementation and supports OpenCLI 2.0.x. It does not replace the global CLI, restart the daemon, change browser profiles, or modify other adapters. Local plugin installation uses OpenCLI's normal symlink and dependency installation mechanism. The install script first copies the package to a new durable version directory under `~/.local/share/opencli/learned-extract/`, then installs from there; rebuilding `dist` does not remove the installed copy. An existing plugin is never silently replaced.

## Capture and learn

Capture authorized pages using the existing Browser Bridge and its selected Chrome profile:

```sh
opencli learned-extract capture https://shop.example/products/a --output a.json
opencli learned-extract capture https://shop.example/products/b --output b.json
```

Snapshots remove forms, editable fields, event handlers, executable scripts and credential-like attributes while retaining semantic DOM attributes and JSON-LD. This is data minimization, not a guarantee that every secret is removed: page text and structured data can still contain personal or confidential information. Capture only authorized content. Snapshots are written with mode 0600, never overwrite an existing path, and are not uploaded unless a model endpoint is explicitly supplied.

Create `schema.json`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "price"],
  "properties": {
    "name": {"type": "string"},
    "price": {"type": ["number", "null"]}
  }
}
```

The first version supports flat scalar fields: string, number, integer and boolean, optionally nullable; description, enum, minimum and maximum. Unsupported schema keywords are rejected. A required nullable field still needs observed evidence; missing values remain null and invalidate the result. Optional absent fields remain null with `partial` status.

Create `samples.json` with manually checked values. Snapshot paths are relative to this manifest:

```json
[
  {"snapshot":"a.json","expected":{"name":"Brush A","price":12.5}},
  {"snapshot":"b.json","expected":{"name":"Brush B","price":15}}
]
```

At least two distinct snapshots of the same DOM structure are required. Every schema field must have an expected value or explicit null. Checked expected values are not sent to the model. Sample validation establishes extraction behavior on these examples, not the truth of every future page.

An agent or a developer can propose `rule.json`:

```json
{
  "version": 1,
  "scope": {"origin":"https://shop.example","pathPrefix":"/products"},
  "fields": {
    "name": {"source":"dom","selector":"h1","read":"text"},
    "price": {"source":"dom","selector":"[itemprop='price']","read":"attribute","attribute":"content"}
  }
}
```

For pages with changing recommendations, a rule may add `"template":{"selectors":[".product_main",".product_information"]}`. Choose stable regions that contain every field source and JSON-LD script used by the rule. These selectors are validated against every checked sample and fresh page; missing, duplicate, overlapping or changed regions invalidate the result. Content outside the declared regions does not affect the template hash. The default rule above validates the whole page.

Each DOM source must match exactly one element. Attribute reads are allowlisted. A JSON-LD source is `{"source":"jsonld","path":"offers.price"}`. It examines each JSON-LD object (including @graph entries); multiple matching values are ambiguous. No literals, code, expressions, defaults or regex operations are accepted. Numeric sources must be pure numbers; `$12.50`, `1,200` and `12 kg` are rejected rather than silently changing currency or units. Learn separate source fields for unit/currency/variant as needed.

```sh
opencli learned-extract learn product \
  --schema schema.json --context account-one:US:en \
  --snapshot a.json --samples samples.json --rule rule.json
```

Rules are cached only after all checked values, the current page, URL scope and page structure pass validation. Cache entries contain rule and version metadata, not captured HTML, checked values, context names or provider credentials. `--context` is a required non-secret account/view/locale identifier; its hash contributes to cache identity alongside name, schema and origin. It is not verified authentication, so callers must use distinct context values for distinct accounts/views. Default cache: `~/.opencli/extraction-rules`; override with `--cache-dir`.

## Explicit model-assisted learning

Instead of `--rule`, supply an exact model and full Chat Completions endpoint. No endpoint or model is silently selected:

```sh
opencli learned-extract learn product \
  --schema schema.json --context account-one:US:en \
  --snapshot a.json --samples samples.json \
  --endpoint http://127.0.0.1:1234/v1/chat/completions --model YOUR_LOCAL_MODEL
```

For an authenticated provider, set `OPENCLI_EXTRACT_API_KEY` in your protected environment. Never put a key in a rule, snapshot, URL or command argument. Remote endpoints require HTTPS; loopback HTTP is allowed. Only the explicitly selected endpoint receives sample HTML. Redirects and automatic retries are disabled. The transport uses JSON mode, checks completion/refusal/truncation and strictly validates the returned rule locally. JSON mode itself does not guarantee schema compliance; see [OpenAI's JSON-mode documentation](https://developers.openai.com/api/docs/guides/structured-outputs#json-mode). OpenAI-compatible third-party endpoints may differ and must support the documented request/response subset.

## Run and repair

Capture a fresh page, then run offline with no model request:

```sh
opencli learned-extract run product \
  --schema schema.json --context account-one:US:en --snapshot current.json
```

Results include typed values, raw field evidence, locator, match count, observation timestamp, content/template hashes, cache version and explicit issues. Check `status` (`verified`, `partial`, `invalid`) and `issues`, not just the outer CLI `ok`. Here `verified` means local extraction constraints passed; it does not assert source authority, exhaustive coverage, server freshness, account identity, or commercial correctness. Cached extraction rules are reused, not old page values. The observation time describes the snapshot, not necessarily the origin server's data age.

DOM structure changes fail closed even if selectors still match. Template identity hashes parent-child relationships, tag order and attribute names, not text values, but real page layout variation can cause extra invalidations. Use separate rule names for separate page templates. Scope is enforced by origin and URL path segments. A login page, error page or missing field can invalidate a run; no request to repair is made automatically.

Explicit repair requires two checked snapshots of the new template and either an imported rule or configured model. It attempts one proposal, validates it, then writes a new revision while keeping the previous JSON version. Failed proposals leave the validated cache unchanged:

```sh
opencli learned-extract run product \
  --schema schema.json --context account-one:US:en --snapshot changed.json \
  --repair true --samples changed-samples.json --rule changed-rule.json
```

Cache writes use per-key locks, atomic replacement and private files; corrupt files and symlinks are rejected. A crashed writer can leave a `.lock`; inspect it and confirm no writer is active before removing that specific lock. The first version retains one previous entry for manual inspection/restoration; no unattended rollback or business-system write occurs.

## Verification

```sh
npm run typecheck
npx vitest run --project unit src/extraction
npm run build
npx vitest run --project adapter clis/learned-extract/extract.test.js
```

Tests cover missing/zero distinction, strict types, ambiguity, scope, template changes, model envelope/timeout, cache corruption/locking, independently checked learning and failed-repair retention. Browser capture is exercised against an isolated DOM fixture; website-specific accuracy still requires authorized real-source acceptance.

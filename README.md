# Okta IGA Backup — README

A tiny Node.js utility that snapshots **Okta Identity Governance (IGA)** configuration and per-resource data using an **API token (SSWS)**. It discovers **applications and/or groups**, then pulls IGA objects that matter for governance reviews (campaigns, reviews, entitlement bundles, labels, collections, risk rules, delegates) and per resource **entitlements, entitlement values, grants, and resource owners**.

---

## Contents

- [What it collects](#what-it-collects)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration (env vars)](#configuration-env-vars)
- [Quick start](#quick-start)
- [Output layout](#output-layout)
- [Controlling scope](#controlling-scope)
- [Performance & rate limits](#performance--rate-limits)
- [Troubleshooting](#troubleshooting)
- [Notes on auth (SSWS vs OAuth)](#notes-on-auth-ssws-vs-oauth)
- [Safety & housekeeping](#safety--housekeeping)

---

## What it collects

### Org-wide IGA (GET-able endpoints)
- `/governance/api/v1/campaigns` → `campaigns.json`
- `/governance/api/v1/reviews` → `reviews.json`
- `/governance/api/v1/entitlement-bundles` → `entitlementBundles.json`
- `/governance/api/v1/labels` → `labels.json`
- `/governance/api/v1/collections` → `collections.json`
- `/governance/api/v1/risk-rules` → `riskRules.json`
- `/governance/api/v1/delegates` → `delegates.json`

### Per-resource (for each discovered application and/or group)
- `/governance/api/v1/entitlements?filter=resource eq "TYPE:ID"` → `entitlements.json`
- `/governance/api/v1/entitlements/values?filter=resource eq "TYPE:ID"` → `entitlement_values.json`
- `/governance/api/v1/grants?filter=resource eq "TYPE:ID"` → `grants.json`
- `/governance/api/v1/resource-owners?filter=resource eq "TYPE:ID"` → `resource_owners.json`

> Discovery sources:  
> - Applications: `/api/v1/apps`  
> - Groups: `/api/v1/groups`

---

## Prerequisites

- **Node.js 18+**
- An **Okta API token (SSWS)** with read access to:
  - Okta Core (to list apps & groups)
  - Okta IGA (to read IGA endpoints shown above)

> Admin console: *Security → API → Tokens* to create SSWS tokens.

---

## Install

```bash
# In the project directory
npm i axios mkdirp p-limit
```

The script is a single file: `iga_backup.js`.

---

## Configuration (env vars)

Set these before running:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OKTA_DOMAIN` | ✅ | *(none)* | Your Okta base URL, e.g. `https://acme.okta.com` |
| `OKTA_API_TOKEN` | ✅ | *(none)* | SSWS token value |
| `OUT_DIR` |  | `./out/iga` | Output folder |
| `CONCURRENCY` |  | `4` | Parallel requests (keep modest) |
| `PAGE_LIMIT` |  | *(unset)* | If set to a number, adds `?limit=` to supported endpoints; unset to omit |
| `IGA_MAX_RESOURCES` |  | `0` | Cap number of apps/groups discovered per type (0 = all) |
| `IGA_RES_TYPES` |  | `applications,groups` | Which resource types to include (`applications`, `groups`, or both comma-sep) |
| `IGA_SLEEP_MS_BETWEEN_CALLS` |  | `25` | Small delay before **every** request to smooth bursts |
| `IGA_RATE_LOW_WATERMARK` |  | `3` | If remaining tokens ≤ this, proactively pause until reset |
| `IGA_MAX_RETRIES` |  | `6` | Max retries per request on 429 |
| `IGA_RETRY_JITTER_MS` |  | `250` | Extra jitter added to any backoff |

---

## Quick start

```bash
export OKTA_DOMAIN="https://your-org.okta.com"
export OKTA_API_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# optional tuning
export CONCURRENCY=4
export IGA_RES_TYPES="applications,groups"    # or "applications" or "groups"
export IGA_MAX_RESOURCES=0                    # 0 = all
export PAGE_LIMIT=                            # leave empty to omit limit param

node iga_backup.js
```

---

## Output layout

```
out/iga/
  ├─ json/
  │   ├─ campaigns.json
  │   ├─ reviews.json
  │   ├─ entitlementBundles.json
  │   ├─ labels.json
  │   ├─ collections.json
  │   ├─ riskRules.json
  │   ├─ delegates.json
  │   └─ per-resource/
  │       ├─ APPLICATION-00ab.../
  │       │   ├─ entitlements.json
  │       │   ├─ entitlement_values.json
  │       │   ├─ grants.json
  │       │   └─ resource_owners.json
  │       └─ GROUP-00cd.../
  │           └─ ...
  └─ manifest.json
```

---

## Controlling scope

- **Only applications**:
  ```bash
  export IGA_RES_TYPES=applications
  ```
- **Only groups**:
  ```bash
  export IGA_RES_TYPES=groups
  ```
- **Limit size for testing** (first N of each type):
  ```bash
  export IGA_MAX_RESOURCES=25
  ```
- **Drop `?limit=`** entirely:
  ```bash
  export PAGE_LIMIT=
  ```

---

## Performance & rate limits

The client has **adaptive throttling**:
- Delay before each call (`IGA_SLEEP_MS_BETWEEN_CALLS`)
- Proactive pause when remaining ≤ `IGA_RATE_LOW_WATERMARK`
- Retries on `429` with backoff & jitter

Tips:
- Lower `CONCURRENCY` if still hitting limits
- Increase `IGA_SLEEP_MS_BETWEEN_CALLS` to 75–150 ms
- Keep `PAGE_LIMIT` unset if endpoints reject it

---

## Troubleshooting

- `400 filter condition invalid` → some resources may not be IGA-managed. Script logs and continues.  
- `405` → endpoint not GET-able (skip).  
- `401/403` → token lacks IGA access; may require OAuth.  
- Hanging → usually rate-limit waits; reduce concurrency or add sleep.

---

## Notes on auth (SSWS vs OAuth)

This tool uses **SSWS**. Some orgs may enforce **OAuth** for IGA endpoints; in that case, update auth flow.

---

## Safety & housekeeping

- Read-only (GET only). No writes to Okta.  
- Stores JSON locally under `OUT_DIR`. Secure your output.  
- Scrub sensitive IDs/names before sharing.

---

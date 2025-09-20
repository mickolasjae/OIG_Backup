// file: iga_backup.js
// Node 18+

const fs = require("fs");
const path = require("path");
const mkdirp = require("mkdirp");
const axios = require("axios");
const pLimit = require("p-limit").default;

/**
 * ===== ENV / CONFIG =====
 * Required:
 *   export OKTA_DOMAIN="https://acme.okta.com"
 *   export OKTA_API_TOKEN="xxxx"
 * Optional:
 *   export OUT_DIR="./out/iga"
 *   export CONCURRENCY="4"                // parallel jobs; keep modest for Okta
 *   export PAGE_LIMIT=""                  // unset/blank => no limit param
 *   export IGA_MAX_RESOURCES="0"          // 0 = all; N = first N per resource type
 *   export IGA_RES_TYPES="applications,groups"
 *   export IGA_SLEEP_MS_BETWEEN_CALLS="25"  // small delay before every request
 *   export IGA_RATE_LOW_WATERMARK="3"       // when remaining <= this -> proactive pause
 *   export IGA_MAX_RETRIES="6"              // 429/backoff retries per request
 *   export IGA_RETRY_JITTER_MS="250"        // extra jitter added to waits
 */
const OKTA_DOMAIN = process.env.OKTA_DOMAIN || "https://example.okta.com";
const OKTA_API_TOKEN = process.env.OKTA_API_TOKEN;

const OUT_DIR = process.env.OUT_DIR || "./out/iga";
const CONCURRENCY = Number(process.env.CONCURRENCY || "4");
const PAGE_LIMIT = process.env.PAGE_LIMIT ? Number(process.env.PAGE_LIMIT) : null;
const IGA_MAX_RESOURCES = Number(process.env.IGA_MAX_RESOURCES || "0");
const IGA_RES_TYPES = (process.env.IGA_RES_TYPES || "applications,groups")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const IGA_SLEEP_MS_BETWEEN_CALLS = Number(process.env.IGA_SLEEP_MS_BETWEEN_CALLS || "25");
const IGA_RATE_LOW_WATERMARK = Number(process.env.IGA_RATE_LOW_WATERMARK || "3");
const IGA_MAX_RETRIES = Number(process.env.IGA_MAX_RETRIES || "6");
const IGA_RETRY_JITTER_MS = Number(process.env.IGA_RETRY_JITTER_MS || "250");

if (!OKTA_API_TOKEN) {
  console.error("Missing env OKTA_API_TOKEN");
  process.exit(1);
}

/* ===== Helpers ===== */

function writer(dir, file, obj) {
  mkdirp.sync(dir);
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2));
}

function parseLinkHeader(link) {
  if (!link) return {};
  const parts = link.split(",");
  const out = {};
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ===== Smart Axios client with adaptive rate limiting =====
 * - Global pause shared by all requests.
 * - Honors Retry-After and X-Rate-Limit-Reset.
 * - Proactively pauses when remaining tokens low.
 */
function clientFactory() {
  const client = axios.create({
    baseURL: OKTA_DOMAIN,
    headers: {
      Authorization: `SSWS ${OKTA_API_TOKEN}`,
      "User-Agent": "oig-backup/ssws node",
    },
    timeout: 60000,
    validateStatus: () => true, // we'll handle status centrally
  });

  let globalPauseUntil = 0; // epoch ms
  let inFlight = 0;

  client.interceptors.request.use(async (config) => {
    // Small spacing between calls to avoid bursts
    if (IGA_SLEEP_MS_BETWEEN_CALLS > 0) {
      await sleep(IGA_SLEEP_MS_BETWEEN_CALLS);
    }
    // Respect global pause
    const now = Date.now();
    if (globalPauseUntil > now) {
      await sleep(globalPauseUntil - now);
    }
    config.metadata = { retryCount: (config.metadata?.retryCount || 0) };
    inFlight++;
    return config;
  });

  client.interceptors.response.use(
    async (res) => {
      inFlight = Math.max(0, inFlight - 1);

      // Proactive throttle if remaining is low
      const remaining = Number(res.headers["x-rate-limit-remaining"] || res.headers["X-Rate-Limit-Remaining"] || "");
      const resetSec = Number(res.headers["x-rate-limit-reset"] || res.headers["X-Rate-Limit-Reset"] || "");
      if (!isNaN(remaining) && remaining <= IGA_RATE_LOW_WATERMARK && !isNaN(resetSec)) {
        const resetMs = resetSec * 1000;
        const now = Date.now();
        if (resetMs > now) {
          // Set a short global pause until reset to let tokens replenish
          globalPauseUntil = Math.max(globalPauseUntil, resetMs + IGA_RETRY_JITTER_MS);
        }
      }

      // Bubble up non-2xx once we’ve done our headers logic (for proactive pause)
      if (res.status >= 400) {
        return Promise.reject({ response: res, config: res.config });
      }
      return res;
    },
    async (error) => {
      inFlight = Math.max(0, inFlight - 1);
      const res = error?.response;
      const cfg = error?.config || {};
      const attempt = (cfg.metadata?.retryCount || 0) + 1;

      // Only handle HTTP errors with a response (network/timeout bubble up)
      if (!res) return Promise.reject(error);

      // If 429, schedule retry
      if (res.status === 429 && attempt <= IGA_MAX_RETRIES) {
        const retryAfterH = res.headers["retry-after"];
        const resetH = res.headers["x-rate-limit-reset"] || res.headers["X-Rate-Limit-Reset"];
        let waitMs = 2000; // default backoff
        if (retryAfterH) {
          const ra = Number(retryAfterH);
          if (!isNaN(ra)) waitMs = ra * 1000;
        } else if (resetH) {
          const resetMs = Number(resetH) * 1000;
          const now = Date.now();
          if (!isNaN(resetMs) && resetMs > now) waitMs = resetMs - now;
        }
        waitMs += IGA_RETRY_JITTER_MS;

        // Set global pause so everyone backs off together
        globalPauseUntil = Math.max(globalPauseUntil, Date.now() + waitMs);

        // Retry same request
        await sleep(waitMs);
        cfg.metadata = cfg.metadata || {};
        cfg.metadata.retryCount = attempt;
        return client.request(cfg);
      }

      // If we got here, either not 429 or retries exhausted
      return Promise.reject(error);
    }
  );

  return client;
}

/* ===== Paging wrapper ===== */
async function getAllPages(client, url, params = {}) {
  const results = [];
  let nextAfter;

  for (;;) {
    const qp = { ...params };
    if (PAGE_LIMIT) qp.limit = PAGE_LIMIT;
    if (nextAfter) qp.after = nextAfter;

    const res = await client.get(url, { params: qp });
    if (res.status >= 400) {
      throw new Error(`GET ${url} failed ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const body = res.data;
    const page = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
      ? body.data
      : body?.items ?? [];
    results.push(...page);

    const links = parseLinkHeader(res.headers.link || res.headers["Link"]);
    if (links.next) {
      const u = new URL(links.next);
      nextAfter = u.searchParams.get("after");
    } else {
      break;
    }
  }

  return results;
}

/* ===== Discovery (not written to disk) ===== */
async function discoverApplications(client) {
  const apps = await getAllPages(client, "/api/v1/apps", { expand: "metadata" }).catch(() => []);
  const trimmed = IGA_MAX_RESOURCES > 0 ? apps.slice(0, IGA_MAX_RESOURCES) : apps;
  console.log(`• discovered applications: ${trimmed.length}`);
  return trimmed
    .map((a) => a?.id)
    .filter(Boolean)
    .map((id) => ({ type: "APPLICATION", id }));
}

async function discoverGroups(client) {
  const groups = await getAllPages(client, "/api/v1/groups").catch(() => []);
  const trimmed = IGA_MAX_RESOURCES > 0 ? groups.slice(0, IGA_MAX_RESOURCES) : groups;
  console.log(`• discovered groups: ${trimmed.length}`);
  return trimmed
    .map((g) => g?.id)
    .filter(Boolean)
    .map((id) => ({ type: "GROUP", id }));
}

/* ===== IGA helpers ===== */
function buildResourceFilter(resource) {
  return `resource eq "${resource.type}:${resource.id}"`;
}

async function listEntitlements(client, resource) {
  return getAllPages(client, "/governance/api/v1/entitlements", {
    filter: buildResourceFilter(resource),
  });
}

async function listEntitlementValues(client, resource) {
  return getAllPages(client, "/governance/api/v1/entitlements/values", {
    filter: buildResourceFilter(resource),
  });
}

async function listGrants(client, resource) {
  return getAllPages(client, "/governance/api/v1/grants", {
    filter: buildResourceFilter(resource),
  });
}

async function listResourceOwners(client, resource) {
  return getAllPages(client, "/governance/api/v1/resource-owners", {
    filter: buildResourceFilter(resource),
  });
}

// Org-wide IGA (GET-able)
const STATIC_IGA_ENDPOINTS = [
  { key: "campaigns", path: "/governance/api/v1/campaigns" },
  { key: "reviews", path: "/governance/api/v1/reviews" },
  { key: "entitlementBundles", path: "/governance/api/v1/entitlement-bundles" },
  { key: "labels", path: "/governance/api/v1/labels" },
  { key: "collections", path: "/governance/api/v1/collections" },
  { key: "riskRules", path: "/governance/api/v1/risk-rules" },
  { key: "delegates", path: "/governance/api/v1/delegates" },
];

/* ===== Main ===== */
async function main() {
  const started = new Date().toISOString();
  const outBase = path.resolve(OUT_DIR);
  mkdirp.sync(outBase);
  const client = clientFactory();
  const limit = pLimit(CONCURRENCY);

  const manifest = {
    started,
    oktaDomain: OKTA_DOMAIN,
    auth: "SSWS",
    pageLimit: PAGE_LIMIT,
    entities: {},
  };

  // 1) Static org-wide IGA
  await Promise.all(
    STATIC_IGA_ENDPOINTS.map(({ key, path: igaPath }) =>
      limit(async () => {
        try {
          const data = await getAllPages(client, igaPath);
          writer(path.join(outBase, "json"), `${key}.json`, data);
          manifest.entities[key] = { count: data.length, error: null };
          console.log(`✓ ${key}  ${data.length}`);
        } catch (e) {
          manifest.entities[key] = { count: 0, error: e.message };
          console.warn(`✗ ${key}  error: ${e.message}`);
        }
      })
    )
  );

  // 2) Discover resources (apps/groups) — not written to disk
  const resources = [];
  if (IGA_RES_TYPES.includes("applications")) {
    resources.push(...(await discoverApplications(client)));
  }
  if (IGA_RES_TYPES.includes("groups")) {
    resources.push(...(await discoverGroups(client)));
  }

  // 3) Per-resource IGA data only
  const perResourceDir = path.join(outBase, "json", "per-resource");
  mkdirp.sync(perResourceDir);

  let entCount = 0,
    entValCount = 0,
    grantCount = 0,
    ownerCount = 0;

  await Promise.all(
    resources.map((r) =>
      limit(async () => {
        const slug = `${r.type}-${r.id}`;
        const base = path.join(perResourceDir, slug);
        mkdirp.sync(base);

        try {
          const ents = await listEntitlements(client, r);
          entCount += ents.length;
          writer(base, `entitlements.json`, ents);
        } catch (e) {
          console.warn(`✗ entitlements [${r.type}:${r.id}]  error: ${e.message}`);
        }

        try {
          const vals = await listEntitlementValues(client, r);
          entValCount += vals.length;
          writer(base, `entitlement_values.json`, vals);
        } catch (e) {
          console.warn(`✗ entitlementValues [${r.type}:${r.id}]  error: ${e.message}`);
        }

        try {
          const grants = await listGrants(client, r);
          grantCount += grants.length;
          writer(base, `grants.json`, grants);
        } catch (e) {
          console.warn(`✗ grants [${r.type}:${r.id}]  error: ${e.message}`);
        }

        try {
          const owners = await listResourceOwners(client, r);
          ownerCount += owners.length;
          writer(base, `resource_owners.json`, owners);
        } catch (e) {
          console.warn(`✗ resourceOwners [${r.type}:${r.id}]  error: ${e.message}`);
        }
      })
    )
  );

  // 4) Manifest
  manifest.entities.entitlements_total = entCount;
  manifest.entities.entitlementValues_total = entValCount;
  manifest.entities.grants_total = grantCount;
  manifest.entities.resourceOwners_total = ownerCount;

  manifest.finished = new Date().toISOString();
  writer(outBase, "manifest.json", manifest);
  console.log("Done. Manifest at", path.join(outBase, "manifest.json"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

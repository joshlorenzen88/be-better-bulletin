#!/usr/bin/env node
// scripts/fetch-deals.mjs
//
// Daily Deal Desk collection pipeline for Be Better Bulletin. Runs standalone
// (no Claude chat session involved) from GitHub Actions — see
// .github/workflows/daily-fetch.yml. Writes deals.json, which the "Daily Deal
// Desk" panel in index.html fetches at runtime (same pattern as stories.json
// and community-spotlight.json).
//
// Collects today's offers from four retailers using only permitted public
// data and documented APIs:
//   - Best Buy: the official Products API (api.bestbuy.com) when the
//     BESTBUY_API_KEY repo secret is set.
//   - Woot: the official developer API (developer.woot.com/feed) when the
//     WOOT_API_KEY repo secret is set.
//   - Home Depot & Lowe's (and Best Buy/Woot when no key is configured):
//     attempts to read schema.org Product JSON-LD off the retailer's public
//     daily-deals page, identifying itself honestly as a bot (same
//     "compatible; BotName; +URL" convention as fetch-stories.mjs).
//
// Home Depot and Lowe's both commonly block automated requests. This script
// does NOT try to get around that — no browser User-Agent spoofing, no IP
// rotation, no CAPTCHA solving. When a retailer blocks or doesn't expose
// readable product data, the honest result is a "limited"/"unavailable"
// status with a direct link, not a workaround. No deals are ever fabricated.
//
// Usage:
//   node scripts/fetch-deals.mjs            # normal run, writes deals.json
//   DRY_RUN=1 node scripts/fetch-deals.mjs  # fetch + log, don't write
//
// Requires Node 18+ (uses global fetch and AbortSignal.timeout). No npm
// dependencies.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "deals.json");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function log(...args) {
  console.log("[fetch-deals]", ...args);
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; BeBetterBulletinDealBot/1.0; +https://bebetterbulletin.com) Node.js";

const sources = [
  { id: "hd", name: "The Home Depot", url: "https://www.homedepot.com/daily-deals", color: "#c95116", label: "Daily Deals", description: "Tools, home improvement & seasonal finds" },
  { id: "lowes", name: "Lowe’s", url: "https://www.lowes.com/l/savings/daily-deals", color: "#174887", label: "Daily Deals", description: "Tools, appliances & outdoor living" },
  { id: "bestbuy", name: "Best Buy", url: "https://www.bestbuy.com/site/top-deals/deal-of-the-day/pcmcat248000050016.c?id=pcmcat248000050016", color: "#64551c", label: "Deal of the Day", description: "Electronics, computers & home tech" },
  { id: "woot", name: "Woot!", url: "https://www.woot.com/", color: "#537239", label: "Daily offers", description: "Rotating deals across home & electronics" },
];

function safeUrl(value, base) {
  try {
    const u = new URL(value, base);
    return u.protocol === "https:" && u.hostname === new URL(base).hostname ? u.href : null;
  } catch {
    return null;
  }
}

function readImage(value) {
  const first = Array.isArray(value) ? value[0] : value;
  const candidate = typeof first === "object" ? first?.url : first;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// Recursively walks parsed JSON-LD looking for schema.org Product nodes with
// a usable name/url/price. This is the only "scraping" this script does: it
// reads structured data the retailer itself published on the page, exactly
// as a search engine would — it does not parse rendered DOM, inject a
// browser, or guess at prices from unstructured text.
function extract(html, source, now) {
  const results = [];
  function walk(v, depth = 0) {
    if (!v || typeof v !== "object" || depth > 30) return;
    const types = Array.isArray(v["@type"]) ? v["@type"] : [v["@type"]];
    if (types.includes("Product")) {
      const offer = Array.isArray(v.offers) ? v.offers[0] : v.offers;
      const price = Number(offer?.price);
      const url = safeUrl(v.url || offer?.url, source.url);
      const end = offer?.priceValidUntil ? Date.parse(offer.priceValidUntil) : NaN;
      if (v.name && url && Number.isFinite(price) && price > 0 && (!Number.isFinite(end) || end > now)) {
        results.push({
          id: source.id + "-" + url,
          name: String(v.name).slice(0, 250),
          description: "Listed on the retailer’s daily deal page",
          price,
          original: null,
          image: readImage(v.image),
          url,
          category: "Other",
          icon: "tag",
          retailer: source.id,
          checkedAt: new Date(now).toISOString(),
          expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
          method: "Live page",
          validUntil: new Date(now + 6 * 3600000).toISOString(),
        });
      }
    }
    for (const child of Object.values(v)) if (typeof child === "object") walk(child, depth + 1);
  }
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(match[1]));
    } catch {}
  }
  return [...new Map(results.map((p) => [p.url, p])).values()].slice(0, 150);
}

async function collectFromPage(source, now) {
  let deals = [];
  let status = "unavailable";
  let message = "Could not reach the retailer. Open its daily page below.";
  try {
    const res = await fetch(source.url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      deals = extract(html, source, now);
      status = deals.length ? "live" : "limited";
      message = deals.length
        ? "Products collected from the daily deal page."
        : "Product listings are not exposed in readable data. Browse the retailer directly.";
    } else {
      message = "Retailer declined automatic access (HTTP " + res.status + "). Browse its daily page directly.";
    }
  } catch {}
  return { ...source, status, message, deals, attemptedAt: new Date(now).toISOString() };
}

// Best Buy's official Products API (developer.bestbuy.com) — requires a free
// developer account and an API key set as the BESTBUY_API_KEY repo secret.
// Falls back to the page-read attempt above on any failure or empty result.
async function collectBestBuy(source, now, apiKey) {
  try {
    const url =
      "https://api.bestbuy.com/v1/products(onSale=true)?apiKey=" +
      encodeURIComponent(apiKey) +
      "&format=json&show=sku,name,salePrice,regularPrice,image,largeImage,url&pageSize=50&sort=salePrice.asc";
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data?.products) ? data.products : [];
      const deals = items
        .filter((p) => p?.sku && p.name && p.url && Number.isFinite(p.salePrice) && p.salePrice > 0 && Number.isFinite(p.regularPrice) && p.regularPrice > p.salePrice)
        .map((p) => ({
          id: "bestbuy-" + p.sku,
          name: String(p.name).slice(0, 250),
          description: "Listed on Best Buy’s Products API",
          price: p.salePrice,
          original: p.regularPrice,
          image: readImage(p.largeImage || p.image),
          url: safeUrl(p.url, source.url) || p.url,
          category: "Other",
          icon: "tag",
          retailer: "bestbuy",
          checkedAt: new Date(now).toISOString(),
          expiresAt: null,
          method: "Best Buy Products API",
        }))
        .slice(0, 100);
      if (deals.length) {
        return { ...source, status: "live", message: "Products collected from Best Buy’s official Products API.", deals, attemptedAt: new Date(now).toISOString() };
      }
    }
  } catch {}
  return collectFromPage(source, now);
}

// Woot's official developer API (developer.woot.com) — requires a free API
// key (requested via Woot's forums) set as the WOOT_API_KEY repo secret.
// Falls back to the page-read attempt above on any failure or empty result.
async function collectWoot(source, now, apiKey) {
  try {
    const res = await fetch("https://developer.woot.com/feed/Featured", {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data) ? data : Array.isArray(data?.Items) ? data.Items : [];
      const deals = items
        .filter((it) => it && !it.IsSoldOut && it.OfferId && it.Title && it.Url && it.Photo && Number.isFinite(it.SalePrice?.Minimum) && it.SalePrice.Minimum > 0 && (!it.EndDate || Date.parse(it.EndDate) > now))
        .map((it) => {
          const price = it.SalePrice.Minimum;
          const listMin = Number.isFinite(it.ListPrice?.Minimum) ? it.ListPrice.Minimum : null;
          return {
            id: "woot-" + it.OfferId,
            name: String(it.Title).slice(0, 250),
            description: it.Subtitle ? String(it.Subtitle).slice(0, 250) : "Listed on Woot’s official feed",
            price,
            original: listMin && listMin > price ? listMin : null,
            image: readImage(it.Photo),
            url: safeUrl(it.Url, source.url) || it.Url,
            category: "Other",
            icon: "tag",
            retailer: "woot",
            checkedAt: new Date(now).toISOString(),
            expiresAt: it.EndDate ? new Date(Date.parse(it.EndDate)).toISOString() : null,
            method: "Woot API",
          };
        })
        .slice(0, 100);
      if (deals.length) {
        return { ...source, status: "live", message: "Products collected from Woot’s official developer API.", deals, attemptedAt: new Date(now).toISOString() };
      }
    }
  } catch {}
  return collectFromPage(source, now);
}

async function collect(source, env, now) {
  if (source.id === "bestbuy" && env.BESTBUY_API_KEY) return collectBestBuy(source, now, env.BESTBUY_API_KEY);
  if (source.id === "woot" && env.WOOT_API_KEY) return collectWoot(source, now, env.WOOT_API_KEY);
  return collectFromPage(source, now);
}

async function main() {
  const now = Date.now();
  const env = {
    BESTBUY_API_KEY: process.env.BESTBUY_API_KEY || "",
    WOOT_API_KEY: process.env.WOOT_API_KEY || "",
  };
  const retailers = await Promise.all(sources.map((s) => collect(s, env, now)));
  for (const r of retailers) log(r.id, "->", r.status, "(" + r.deals.length + " deals)", "-", r.message);

  const output = { retailers, checkedAt: new Date(now).toISOString() };

  if (DRY_RUN) {
    log("DRY_RUN set — not writing deals.json");
    return;
  }
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  log("Wrote", OUT_PATH);
}

main().catch((err) => {
  console.error("[fetch-deals] fatal:", err);
  process.exitCode = 1;
});

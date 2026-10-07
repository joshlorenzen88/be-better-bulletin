#!/usr/bin/env node
// scripts/check-deals.mjs
//
// Smoke test for fetch-deals.mjs's collection logic, run against mocked
// fetch responses (no network). Covers: JSON-LD product extraction, expired
// offers, unsafe (non-https/cross-origin) URLs, a blocked retailer, and both
// the success and fallback paths for the Best Buy and Woot official APIs.
//
// This imports the module's internals by re-reading and eval'ing them in an
// isolated scope rather than requiring fetch-deals.mjs to export internals
// it otherwise has no reason to export (it's a script, not a library) —
// same approach daily-deals/scripts/check.mjs uses against worker/index.js,
// just adapted since this module has no default export to import directly.
//
// Usage: node scripts/check-deals.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "fetch-deals.mjs");
let src = readFileSync(SRC_PATH, "utf8");

// Strip the top-level main()/main().catch() invocation so importing this
// module for testing doesn't also try to write deals.json over the network.
src = src.replace(/\nmain\(\)\.catch[\s\S]*$/, "\nexport { sources, extract, collectFromPage, collectBestBuy, collectWoot, collect };\n");

const tmpPath = path.join(__dirname, "._fetch-deals.testbuild.mjs");
writeFileSync(tmpPath, src, "utf8");

const originalFetch = globalThis.fetch;
let mod;
try {
  mod = await import("file://" + tmpPath + "?t=" + Date.now());
} finally {
  unlinkSync(tmpPath);
}
const { sources, extract, collectFromPage, collectBestBuy, collectWoot, collect } = mod;

const lowesSource = sources.find((s) => s.id === "lowes");
const bestbuySource = sources.find((s) => s.id === "bestbuy");
const wootSource = sources.find((s) => s.id === "woot");

// ---- extract(): product JSON-LD, expiry, unsafe URL ----
const html =
  '<script type="application/ld+json">' +
  JSON.stringify({
    "@type": "ItemList",
    itemListElement: [
      { "@type": "Product", name: "Test drill", url: "https://www.lowes.com/pd/test", offers: { price: "49.00", priceValidUntil: "2099-01-01" } },
      { "@type": "Product", name: "Expired", url: "https://www.lowes.com/pd/old", offers: { price: "29", priceValidUntil: "2020-01-01" } },
      { "@type": "Product", name: "Unsafe", url: "javascript:alert(1)", offers: { price: "10" } },
    ],
  }) +
  "</script>";
const now = Date.now();
const extracted = extract(html, lowesSource, now);
assert.equal(extracted.length, 1);
assert.equal(extracted[0].price, 49);
console.log("ok: product extraction, expiry filtering, unsafe URL rejection");

// ---- collectFromPage(): blocked retailer -> honest "unavailable" ----
globalThis.fetch = async () => new Response("Blocked", { status: 403 });
let result = await collectFromPage(lowesSource, now);
assert.equal(result.status, "unavailable");
assert.equal(result.deals.length, 0);
console.log("ok: blocked retailer reports unavailable, no fabricated deals");

// ---- collectFromPage(): live page -> extracted deals ----
globalThis.fetch = async () => new Response(html, { status: 200 });
result = await collectFromPage(lowesSource, now);
assert.equal(result.status, "live");
assert.equal(result.deals.length, 1);
console.log("ok: live page scrape extracts deals");

// ---- collectBestBuy(): success ----
globalThis.fetch = async (url) => {
  if (String(url).includes("api.bestbuy.com")) {
    return new Response(
      JSON.stringify({
        products: [
          { sku: 123, name: "Test Laptop", salePrice: 499.99, regularPrice: 699.99, largeImage: "https://img.bbystatic.com/test.jpg", url: "https://www.bestbuy.com/site/test/123.p" },
          { sku: 456, name: "No discount", salePrice: 50, regularPrice: 50, url: "https://www.bestbuy.com/site/test/456.p" },
        ],
      }),
      { status: 200 },
    );
  }
  return new Response("Blocked", { status: 403 });
};
result = await collectBestBuy(bestbuySource, now, "testkey");
assert.equal(result.status, "live");
assert.equal(result.deals.length, 1);
assert.equal(result.deals[0].price, 499.99);
assert.equal(result.deals[0].original, 699.99);
assert.equal(result.deals[0].method, "Best Buy Products API");
console.log("ok: Best Buy API success path");

// ---- collectBestBuy(): API fails -> falls back to page read ----
globalThis.fetch = async (url) => (String(url).includes("api.bestbuy.com") ? new Response("rate limited", { status: 429 }) : new Response("Blocked", { status: 403 }));
result = await collectBestBuy(bestbuySource, now, "testkey");
assert.equal(result.status, "unavailable");
assert.equal(result.deals.length, 0);
console.log("ok: Best Buy API failure falls back to page-read attempt");

// ---- collectWoot(): success ----
globalThis.fetch = async (url) => {
  if (String(url).includes("developer.woot.com")) {
    return new Response(
      JSON.stringify([
        { OfferId: "abc", Title: "Test Gadget", Url: "https://www.woot.com/offers/abc", Photo: "https://cdn.woot.com/test.jpg", SalePrice: { Minimum: 29.99 }, ListPrice: { Minimum: 59.99 }, IsSoldOut: false, EndDate: "2099-01-01T00:00:00Z" },
        { OfferId: "sold", Title: "Sold out", Url: "https://www.woot.com/offers/sold", Photo: "https://cdn.woot.com/sold.jpg", SalePrice: { Minimum: 10 }, IsSoldOut: true },
      ]),
      { status: 200 },
    );
  }
  return new Response("Blocked", { status: 403 });
};
result = await collectWoot(wootSource, now, "testkey");
assert.equal(result.status, "live");
assert.equal(result.deals.length, 1);
assert.equal(result.deals[0].price, 29.99);
assert.equal(result.deals[0].original, 59.99);
console.log("ok: Woot API success path, sold-out items excluded");

// ---- collectWoot(): API throws -> falls back to page read ----
globalThis.fetch = async (url) => {
  if (String(url).includes("developer.woot.com")) throw new Error("network down");
  return new Response("Blocked", { status: 403 });
};
result = await collectWoot(wootSource, now, "testkey");
assert.equal(result.status, "unavailable");
assert.equal(result.deals.length, 0);
console.log("ok: Woot API exception falls back to page-read attempt");

// ---- collect(): dispatches by retailer id and env keys ----
globalThis.fetch = async (url) => (String(url).includes("api.bestbuy.com") ? new Response("Blocked", { status: 500 }) : new Response("Blocked", { status: 403 }));
result = await collect(bestbuySource, { BESTBUY_API_KEY: "" }, now);
assert.equal(result.status, "unavailable"); // no key -> goes straight to page read, which is blocked
console.log("ok: collect() skips Best Buy API with no key configured");

globalThis.fetch = originalFetch;
console.log("\nAll Daily Deal Desk collection checks passed.");

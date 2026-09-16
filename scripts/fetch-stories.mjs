#!/usr/bin/env node
// scripts/fetch-stories.mjs
//
// Daily curation pipeline for Be Better Bulletin. Runs standalone (no Claude
// chat session involved) from GitHub Actions — see .github/workflows/daily-fetch.yml.
//
//   1. Fetches a handful of good-news RSS feeds over plain HTTP.
//   2. Parses items, and unrolls weekly "link roundup" posts into their
//      individual linked stories.
//   3. Filters out horoscopes, history trivia, opinion/how-to pieces,
//      obituaries, and anything partisan/divisive.
//   4. Categorizes each story into exactly one of the 7 fixed categories and
//      writes a one-sentence factual summary — using the Anthropic API when
//      ANTHROPIC_API_KEY is set (best quality), and falling back to a pure
//      keyword heuristic otherwise (and on any API error), so this script
//      never *requires* the API to run.
//   5. Dedupes against data/stories-db.json by URL, appends new stories,
//      prunes to ~150, and regenerates stories.json (top 80 by publishedAt).
//
// Usage:
//   node scripts/fetch-stories.mjs            # normal run, writes files
//   DRY_RUN=1 node scripts/fetch-stories.mjs   # fetch + log, don't write
//
// Requires Node 18+ (uses global fetch). No npm dependencies.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "stories-db.json");
const FEED_PATH = path.join(ROOT, "stories.json");

const DB_CAP = 150;
const FEED_TOP = 80;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

// Fixed category set — do not add, remove, or rename.
const CATEGORIES = ["environment", "science", "community", "animals", "technology", "society", "culture"];

// Add more feeds here as you find good sources. Each is plain RSS/Atom.
const FEEDS = [
  { url: "https://www.goodnewsnetwork.org/feed/", source: "Good News Network" },
  { url: "https://www.positive.news/feed/", source: "Positive News" },
  { url: "https://reasonstobecheerful.world/feed/", source: "Reasons to be Cheerful" },
];

const USER_AGENT =
  "Mozilla/5.0 (compatible; BeBetterBulletinBot/1.0; +https://github.com/) Node.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
// Cheap/fast model for a bulk classify-and-summarize task. If Anthropic
// renames or retires this model id, either set ANTHROPIC_MODEL in the
// workflow env, or the script just falls back to heuristics automatically —
// see docs.claude.com/en/docs/about-claude/models for current ids.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const ANTHROPIC_BATCH_SIZE = 12;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[fetch-stories]", ...args);
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function saveJson(filePath, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (DRY_RUN) {
    log(`(dry run) would write ${filePath} (${data.length} items)`);
    return;
  }
  await writeFile(filePath, text, "utf8");
  log(`wrote ${filePath} (${data.length} items)`);
}

const ENTITY_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (ENTITY_MAP[name] !== undefined ? ENTITY_MAP[name] : m));
}

function stripCdata(str) {
  if (!str) return "";
  const m = str.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : str;
}

function htmlToText(html) {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function slugify(str, maxLen = 60) {
  const base = decodeEntities(str)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return base || "story";
}

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // strip common tracking params
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "mc_cid", "mc_eid"].forEach(
      (p) => u.searchParams.delete(p)
    );
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return (url || "").trim().toLowerCase();
  }
}

function toIsoDate(pubDate) {
  const d = pubDate ? new Date(pubDate) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function firstSentence(text, maxLen = 220) {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^.{1,300}?[.!?](?:\s|$)/);
  let s = m ? m[0].trim() : clean.slice(0, maxLen);
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trim() + "…";
  return s;
}

// ---------------------------------------------------------------------------
// RSS parsing (regex-based; no dependency). Handles standard RSS 2.0 feeds,
// which is what all of the configured sources use.
// ---------------------------------------------------------------------------

function extractTag(block, tag) {
  // Matches <tag>...</tag> or <tag attr="...">...</tag>, non-greedy, and
  // also self-closed/namespaced variants like <content:encoded>.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? stripCdata(m[1]).trim() : "";
}

function extractLink(block) {
  // <link>https://...</link> (RSS) — some feeds wrap it in CDATA, some use
  // atom-style <link href="..."/>.
  const simple = extractTag(block, "link");
  if (simple) return decodeEntities(simple.trim());
  const atom = block.match(/<link[^>]*\shref=["']([^"']+)["']/i);
  return atom ? decodeEntities(atom[1]) : "";
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeEntities(htmlToText(extractTag(block, "title")));
    const link = extractLink(block);
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date") || extractTag(block, "published");
    const description = extractTag(block, "description");
    const contentEncoded = extractTag(block, "content:encoded");
    const guid = extractTag(block, "guid");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      pubDate,
      descriptionHtml: description,
      contentHtml: contentEncoded || description,
      guid: guid || link,
    });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      redirect: "follow",
    });
    if (!res.ok) {
      log(`WARN: ${feed.source} returned HTTP ${res.status}, skipping`);
      return [];
    }
    const xml = await res.text();
    const items = parseRssItems(xml).map((it) => ({ ...it, source: feed.source }));
    log(`fetched ${items.length} items from ${feed.source}`);
    return items;
  } catch (err) {
    log(`WARN: failed to fetch ${feed.source} (${feed.url}): ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Roundup detection + unrolling. Weekly link-roundup posts get skipped as a
// story in their own right; instead we pull the real articles they link to.
// ---------------------------------------------------------------------------

const ROUNDUP_TITLE_RE = /(good news (this week|of the week|roundup|digest|wrap[- ]?up)|weekly (good news|roundup|digest)|link roundup|news roundup|this week'?s good news)/i;

function isRoundupPost(item) {
  return ROUNDUP_TITLE_RE.test(item.title);
}

// Domains/paths that are never real outbound stories inside a roundup post.
const ROUNDUP_LINK_SKIP_RE = /(facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|pinterest\.com|mailto:|\/tag\/|\/category\/|\/author\/|\/about\/|\/subscribe|\/newsletter|#)/i;

function extractRoundupLinks(item) {
  const html = item.contentHtml || item.descriptionHtml || "";
  const links = [];
  const seen = new Set();
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = decodeEntities(m[1]);
    const text = htmlToText(m[2]);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (ROUNDUP_LINK_SKIP_RE.test(href)) continue;
    if (text.length < 20) continue; // too short to be a real headline
    const key = canonicalUrl(href);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ title: text, link: href });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Exclusion filters
// ---------------------------------------------------------------------------

const EXCLUDE_PATTERNS = [
  { name: "horoscope", re: /horoscope|zodiac sign|astrology reading/i },
  { name: "history-trivia", re: /good news (in|from) history|on this day in history|this day in history/i },
  { name: "opinion", re: /^(opinion|op-ed)[:\s]/i },
  { name: "how-to", re: /^how to\b|^\d+ (tips|ways|hacks) (to|for)\b/i },
  { name: "obituary", re: /\bobituary\b|dies at \d+|passes away at|\bin memoriam\b|has died at (the age of )?\d+/i },
];

// Deliberately broad and imperfect — this is a heuristic safety net, not a
// political classifier. Broadly non-controversial government/international
// stories (peace deals, public-health milestones, conservation records,
// humanitarian rescues) are NOT excluded by this list.
const DIVISIVE_KEYWORDS = [
  "republican party", "democratic party", "\\bgop\\b", "abortion", "pro-choice", "pro-life",
  "gun control", "gun rights", "second amendment", "border wall", "immigration crackdown",
  "impeach", "election fraud", "culture war", "critical race theory", "transgender ban",
  "trans rights bill", "book ban", "woke\\b", "maga\\b", "far-right", "far-left",
  "white nationalis", "antifa", "capitol riot", "supreme court overturn",
];
const DIVISIVE_RE = new RegExp(DIVISIVE_KEYWORDS.join("|"), "i");

function exclusionReason(title, text) {
  const hay = `${title} ${text}`;
  for (const { name, re } of EXCLUDE_PATTERNS) {
    if (re.test(hay)) return name;
  }
  if (DIVISIVE_RE.test(hay)) return "partisan/divisive";
  return null;
}

// ---------------------------------------------------------------------------
// Heuristic categorizer + summarizer (no API key required)
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS = {
  animals: [
    "dog", "cat", "puppy", "kitten", "elephant", "whale", "dolphin", "turtle", "bird", "eagle",
    "wildlife rescue", "otter", "panda", "tiger", "lion", "bear", "wolf", "rabbit", "horse",
    "koala", "penguin", "parrot", "kakapo", "endangered species",
  ],
  environment: [
    "climate", "renewable", "solar power", "wind power", "conservation", "recycl", "pollution",
    "emissions", "biodiversity", "reforestation", "wetland", "coral reef", "plastic waste",
    "sustainab", "clean energy", "carbon", "deforestation", "rewilding", "habitat",
  ],
  science: [
    "study", "research", "scientists", "nasa", "space telescope", "spacecraft", "medicine",
    "vaccine", "cancer", "disease", "cure", "treatment", "clinical trial", "discovery",
    "physics", "biology", "who validates", "world health organization", "health",
  ],
  technology: [
    "startup", "app", "robot", "artificial intelligence", "\\bai\\b", "invention", "engineer",
    "device", "innovation", "software", "3d print", "battery", "self-driving",
  ],
  community: [
    "neighbors", "volunteer", "charity", "donat", "kindness", "fundraiser", "community",
    "teacher", "students", "local hero", "homeless", "good samaritan", "rescue effort",
    "food bank", "shelter",
  ],
  culture: [
    "museum", "archaeolog", "artifact", "ancient", "art exhibit", "film", "music festival",
    "book", "novel", "historic discovery", "sculpture", "painting", "viking",
  ],
  society: [
    "peace deal", "treaty", "election", "policy", "law", "city council", "infrastructure",
    "railway", "public health", "human rights", "government", "united nations", "ceasefire",
    "reconcil",
  ],
};
// Priority order when multiple categories score equally.
const CATEGORY_PRIORITY = ["animals", "environment", "science", "technology", "community", "culture", "society"];

function classifyHeuristic(title, text) {
  const hay = `${title} ${text}`.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const cat of CATEGORY_PRIORITY) {
    const words = CATEGORY_KEYWORDS[cat];
    let score = 0;
    for (const w of words) {
      const re = new RegExp(w, "i");
      if (re.test(hay)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best || "society";
}

function summarizeHeuristic(title, text) {
  const base = text && text.length > 40 ? text : title;
  return firstSentence(base);
}

// ---------------------------------------------------------------------------
// Anthropic API classify+summarize+filter (used when ANTHROPIC_API_KEY is
// set; falls back to heuristics per-item on any failure).
// ---------------------------------------------------------------------------

async function classifyWithApiBatch(batch) {
  const prompt = [
    "You are curating a good-news digest called Be Better Bulletin.",
    "For each numbered story below, decide:",
    "1. include: true only if this is a genuine good-news story (rescues, recoveries, scientific/medical progress, community kindness, conservation wins, tech helping people, positive social developments, broadly non-controversial government/international wins like peace deals, public-health milestones, conservation records, humanitarian rescues). Set include:false for horoscopes, history trivia, opinion/how-to pieces, obituaries, link-roundup posts, or anything partisan/divisive (party politics, hot-button culture-war framing, contested legislation).",
    `2. category: exactly one of: ${CATEGORIES.join(", ")}.`,
    "3. summary: one factual sentence (no more than ~200 characters), written plainly, no hype.",
    "",
    "Respond with ONLY a JSON array, one object per story in the same order, like:",
    '[{"i":1,"include":true,"category":"animals","summary":"..."}, ...]',
    "",
    "Stories:",
    ...batch.map((s, idx) => `${idx + 1}. Title: ${s.title}\nText: ${firstSentence(s.text, 400)}`),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Anthropic API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Anthropic API response did not contain a JSON array");
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed;
}

/**
 * Classifies+summarizes+filters a list of {title, text} candidates.
 * Returns a parallel array of {include, category, summary}.
 * Uses the Anthropic API in batches when ANTHROPIC_API_KEY is set; falls
 * back to the heuristic path per-item whenever the API is unavailable,
 * unset, or errors (so this never blocks the pipeline).
 */
async function classifyCandidates(candidates) {
  const results = new Array(candidates.length);
  const heuristicFallback = (idx) => {
    const c = candidates[idx];
    results[idx] = {
      include: true,
      category: classifyHeuristic(c.title, c.text),
      summary: summarizeHeuristic(c.title, c.text),
    };
  };

  if (!ANTHROPIC_API_KEY) {
    log("No ANTHROPIC_API_KEY set — using heuristic classification for all stories.");
    candidates.forEach((_, idx) => heuristicFallback(idx));
    return results;
  }

  log(`ANTHROPIC_API_KEY set — using Anthropic API (model ${ANTHROPIC_MODEL}) for classification.`);
  for (let start = 0; start < candidates.length; start += ANTHROPIC_BATCH_SIZE) {
    const batch = candidates.slice(start, start + ANTHROPIC_BATCH_SIZE);
    try {
      const parsed = await classifyWithApiBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const idx = start + j;
        const row = parsed.find((p) => p.i === j + 1) || parsed[j];
        if (
          row &&
          typeof row.include === "boolean" &&
          CATEGORIES.includes(row.category) &&
          typeof row.summary === "string" &&
          row.summary.trim()
        ) {
          results[idx] = { include: row.include, category: row.category, summary: row.summary.trim() };
        } else {
          log(`WARN: malformed API row for "${batch[j].title}", falling back to heuristic`);
          heuristicFallback(idx);
        }
      }
    } catch (err) {
      log(`WARN: Anthropic API batch failed (${err.message}), falling back to heuristic for this batch`);
      batch.forEach((_, j) => heuristicFallback(start + j));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  log(
    ANTHROPIC_API_KEY
      ? `ANTHROPIC_API_KEY detected — will use the Anthropic API (model ${ANTHROPIC_MODEL}) for any new stories this run.`
      : "No ANTHROPIC_API_KEY set — will use heuristic classification for any new stories this run."
  );

  const db = await loadJson(DB_PATH, []);
  const existingUrls = new Set(db.map((s) => canonicalUrl(s.url)));
  const existingIds = new Set(db.map((s) => s.id));

  const rawItemLists = await Promise.all(FEEDS.map(fetchFeed));
  const rawItems = rawItemLists.flat();

  // Unroll roundup posts into their linked stories; keep everything else as-is.
  const candidates = [];
  for (const item of rawItems) {
    if (isRoundupPost(item)) {
      const links = extractRoundupLinks(item);
      log(`unrolling roundup post "${item.title}" -> ${links.length} linked stories`);
      for (const l of links) {
        candidates.push({
          title: l.title,
          link: l.link,
          pubDate: item.pubDate,
          text: l.title,
          source: item.source,
        });
      }
      continue;
    }
    candidates.push({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      text: htmlToText(item.descriptionHtml || item.contentHtml),
      source: item.source,
    });
  }

  // Drop excluded + already-known-by-url candidates before spending API calls.
  const filtered = [];
  for (const c of candidates) {
    const key = canonicalUrl(c.link);
    if (existingUrls.has(key)) continue;
    const reason = exclusionReason(c.title, c.text);
    if (reason) {
      log(`excluding "${c.title}" (${reason})`);
      continue;
    }
    filtered.push(c);
  }

  // Dedupe candidates against each other (same story can appear in >1 feed,
  // or be linked from multiple roundups) before classification.
  const seenInRun = new Set();
  const deduped = [];
  for (const c of filtered) {
    const key = canonicalUrl(c.link);
    if (seenInRun.has(key)) continue;
    seenInRun.add(key);
    deduped.push(c);
  }

  log(`${deduped.length} new candidate stories after filtering + dedupe`);

  if (deduped.length === 0) {
    log("Nothing new to add.");
    await finalizeAndWrite(db);
    return;
  }

  const classifications = await classifyCandidates(deduped);

  const newStories = [];
  const now = new Date().toISOString();
  for (let i = 0; i < deduped.length; i++) {
    const c = deduped[i];
    const cls = classifications[i];
    if (!cls || cls.include === false) {
      log(`excluding "${c.title}" (classifier said skip)`);
      continue;
    }
    let id = slugify(c.title);
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${slugify(c.title, 55)}-${suffix}`;
      suffix += 1;
    }
    existingIds.add(id);
    newStories.push({
      id,
      title: decodeEntities(c.title).trim(),
      url: c.link,
      source: c.source,
      category: CATEGORIES.includes(cls.category) ? cls.category : "society",
      summary: cls.summary,
      publishedAt: toIsoDate(c.pubDate),
      addedAt: now,
    });
  }

  log(`${newStories.length} new stories added this run`);

  const merged = [...db, ...newStories];
  await finalizeAndWrite(merged);
}

async function finalizeAndWrite(allStories) {
  // De-dupe defensively (in case data/stories-db.json ever had dupes) and
  // sort newest-first by publishedAt.
  const byUrl = new Map();
  for (const s of allStories) {
    byUrl.set(canonicalUrl(s.url), s);
  }
  const sorted = [...byUrl.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

  const db = sorted.slice(0, DB_CAP);
  const feed = sorted.slice(0, FEED_TOP);

  await saveJson(DB_PATH, db);
  await saveJson(FEED_PATH, feed);
}

// Only auto-run when executed directly (`node scripts/fetch-stories.mjs`),
// not when imported by a test harness.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[fetch-stories] FATAL:", err);
    process.exitCode = 1;
  });
}

export {
  main,
  parseRssItems,
  isRoundupPost,
  extractRoundupLinks,
  exclusionReason,
  classifyHeuristic,
  summarizeHeuristic,
  canonicalUrl,
  slugify,
  htmlToText,
};

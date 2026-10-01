// Publishes today's featured reader story.
//
// Run it with:
//   node scripts/set-spotlight.mjs
//
// It asks you three simple questions (name, city/state, story), shows you
// a preview, and — once you confirm — writes community-spotlight.json at
// the root of the project. That file is what the live site reads to show
// the "Reader Story of the Day" panel.
//
// Before overwriting it, it also saves whatever was previously featured
// into data/spotlight-archive.json, so past stories aren't lost — that's
// what powers the "Past Stories" list on the site.
//
// You do not need to edit any JSON by hand. Just answer the prompts.

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "community-spotlight.json");
const ARCHIVE_PATH = join(__dirname, "..", "data", "spotlight-archive.json");

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function sameStory(a, b) {
  return a && b && a.name === b.name && a.location === b.location && a.story === b.story && a.date === b.date;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

// A single, permanent line listener feeding a queue. This matters if you
// paste a multi-line story: all of it can arrive at once, faster than the
// script asks for it, and a naive "ask one question at a time" approach
// can silently lose lines that arrive before it's ready to read them.
// Queuing every line as it comes in guarantees nothing gets dropped.
const lineQueue = [];
const waiters = [];
rl.on("line", (line) => {
  if (waiters.length > 0) waiters.shift()(line);
  else lineQueue.push(line);
});

function nextLine() {
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
  return new Promise((resolve) => waiters.push(resolve));
}

async function ask(promptText) {
  process.stdout.write(promptText);
  return (await nextLine()).trim();
}

// Reads multiple lines of input, ending when the person presses Enter on
// an empty line. Returns everything they typed joined into one paragraph.
async function askMultiline(promptText) {
  console.log(promptText);
  console.log("(Type or paste the story. When you're done, press Enter on a blank line.)");
  const lines = [];
  while (true) {
    const line = (await nextLine()).trim();
    if (line === "") break;
    lines.push(line);
  }
  return lines.join(" ").trim();
}

async function main() {
  console.log("");
  console.log("=== Be Better Bulletin — publish a Reader Story ===");
  console.log("This will replace whatever story is currently featured on the site.");
  console.log("");

  let name = "";
  while (!name) {
    name = await ask("Reader's name (e.g. Jane D.): ");
    if (!name) console.log("Please enter a name.");
  }

  let location = "";
  while (!location) {
    location = await ask("City, State (e.g. Norman, OK): ");
    if (!location) console.log("Please enter a city/state.");
  }

  let story = "";
  while (!story) {
    story = await askMultiline("Their story:");
    if (!story) console.log("Please enter a story.");
  }

  const record = {
    name,
    location,
    story,
    date: new Date().toISOString().slice(0, 10),
  };

  console.log("");
  console.log("=== Preview ===");
  console.log("Name:     " + record.name);
  console.log("Location: " + record.location);
  console.log("Story:    " + record.story);
  console.log("");

  const confirm = (await ask("Publish this? (y/n): ")).toLowerCase();

  if (confirm !== "y" && confirm !== "yes") {
    console.log("Cancelled — nothing was written.");
    rl.close();
    process.exit(0);
    return;
  }

  // Archive whatever was previously featured before it gets overwritten,
  // so it isn't lost — that's the whole point of the "Past Stories" list.
  const previous = loadJson(OUTPUT_PATH, null);
  const archive = loadJson(ARCHIVE_PATH, []);
  if (previous && previous.story && !archive.some((entry) => sameStory(entry, previous))) {
    archive.unshift(previous);
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(record, null, 2) + "\n", "utf8");
  writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + "\n", "utf8");
  console.log("");
  console.log("Done! Wrote community-spotlight.json" + (archive.length ? " and updated the archive (" + archive.length + " past " + (archive.length === 1 ? "story" : "stories") + ")." : "."));
  console.log("Next: commit and push these files so the live site picks it up:");
  console.log("");
  console.log("  git add community-spotlight.json data/spotlight-archive.json");
  console.log('  git commit -m "Feature today\'s reader story"');
  console.log("  git push");
  console.log("");

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Something went wrong:", err.message);
  rl.close();
  process.exit(1);
});

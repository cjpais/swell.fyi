// The written part of each spot file (spots/*.md), rendered on its spot page. The front matter is
// checked and turned into src/data/spots.json by scripts/spots.ts; here only the prose is used.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const spots = defineCollection({
  loader: glob({ pattern: ["*.md", "!README.md"], base: "./spots" }),
});

export const collections = { spots };

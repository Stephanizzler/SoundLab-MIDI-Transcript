// Packs dist/ into one HTML page for publishing as a claude.ai artifact.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const html = readFileSync("dist/index.html", "utf8");
const assets = readdirSync("dist/assets");
const css = readFileSync(`dist/assets/${assets.find((f) => f.endsWith(".css"))}`, "utf8");
const js = readFileSync(`dist/assets/${assets.find((f) => f.endsWith(".js"))}`, "utf8").replace(/<\/script/gi, "<\\/script");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/g, "")
  .replace(/<link rel="stylesheet"[^>]*>|<script[^>]*><\/script>/g, "")
  .replace("<title>", '<meta name="claude:viewport-fit-sides" content="cover">\n<title>');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[^>]*src=[^>]*><\/script>/g, "");
writeFileSync(process.argv[2] ?? "dist/artifact.html", `${head.trim()}\n<style>${css}</style>\n${body.trim()}\n<script type="module">${js}</script>\n`);

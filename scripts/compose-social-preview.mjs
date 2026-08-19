import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import process from "node:process";
import sharp from "sharp";

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error("usage: node scripts/compose-social-preview.mjs <generated-background> <target.png>");
}

const source = resolve(sourceArgument);
const target = resolve(targetArgument);
const logo = await sharp(await readFile(resolve("assets/software-agent-logo.svg")))
  .resize(122, 122)
  .png()
  .toBuffer();

const labels = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640">
    <style>
      .overline { font: 700 34px "DejaVu Sans", Arial, sans-serif; letter-spacing: 8px; fill: #73F3E2; }
      .title { font: 800 92px "DejaVu Sans", Arial, sans-serif; letter-spacing: -3px; fill: #F8FAFC; }
      .tagline { font: 600 20px "DejaVu Sans", Arial, sans-serif; letter-spacing: 2px; fill: #B9C8DD; }
    </style>
    <text x="72" y="268" class="overline">SOFTWARE</text>
    <text x="68" y="366" class="title">AGENT</text>
    <text x="74" y="414" class="tagline">VISIBLE MULTI-AGENT DEVELOPMENT</text>
  </svg>
`);

await sharp(source)
  .resize({width: 1280, height: 640, fit: "cover", position: "centre"})
  .composite([
    {input: logo, left: 70, top: 74},
    {input: labels, left: 0, top: 0},
  ])
  .png({compressionLevel: 9, palette: true, quality: 94, effort: 10})
  .toFile(target);

process.stdout.write(`Composed ${target}\n`);

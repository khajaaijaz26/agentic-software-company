import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await sharp(resolve(root, "assets/software-agent-logo.svg"))
  .resize(1024, 1024)
  .png({compressionLevel: 9, palette: true})
  .toFile(resolve(root, "assets/software-agent-logo.png"));

process.stdout.write("Rendered assets/software-agent-logo.png from assets/software-agent-logo.svg\n");

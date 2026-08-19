# Software Agent visual asset provenance

Generated and composed on 2026-08-19 for this repository. No provider logos,
third-party screenshots, copyrighted characters, endorsements, or source
artwork were supplied or copied. The assets are intended to be distributed
with the repository under its Apache-2.0 license.

## Logo

- Files: `assets/software-agent-logo.svg` and its rendered PNG derivative.
- Source: original SVG authored in-repository by OpenAI Codex.
- Purpose: a terminal prompt routes work to three coordinated agent nodes and a
  verified result.
- Edit: `scripts/render-logo.mjs` renders the 1024x1024 PNG with Sharp.
- SHA-256 (SVG): `de7858376575ed9b2e108ebf2667f3f58fd26826f1024ec5d77dc36cbc2e4b74`
- SHA-256 (PNG): `206afdaf3ff7d360b7f059c051a59f56152e89c2004de87d509d9dce9163d66c`

## Terminal mark

- Form: `❯_ ●─●─● ✓ SOFTWARE AGENT` with `>_ o-o-o [OK] SOFTWARE AGENT`
  as the ASCII fallback.
- Source: code-native translation of this repository's original vector logo;
  the prompt, three agent nodes, and verified check retain the same meaning.
- Rendering: React/Ink text segments use the established cyan, violet, and
  mint palette, adapt at narrow widths, and remain readable without color or
  Unicode.
- No raster image, escape-sequence art, or third-party terminal logo is
  embedded in the CLI.

## README hero

- File: `docs/images/software-agent-hero.png` (1536x1024).
- Source: original raster generated with OpenAI's image-generation tool.
- Edit: lossless dimensions retained; PNG palette/compression optimized with
  Sharp to meet the repository size budget.
- Final SHA-256: `bc2f79951f8b50992f0dc417fb2a6653aa65a58fc00966864b275e7e048bccf5`
- Exact prompt:

> Create an original, premium 3:2 landscape hero illustration for an open-source developer terminal product named Software Agent. Show a dark local-first terminal workspace as an abstract command center, viewed straight-on with subtle depth: three distinct luminous AI workstreams operating side by side inside clean terminal-like panels, one cyan planning/orchestration stream, one blue software-engineering stream with abstract code blocks and file nodes, and one violet review/QA stream with test signals and a verified check. Connect them with restrained flowing event lines into a central local controller and a small human approval checkpoint. Visual mood: precise, trustworthy, calm, modern developer tooling; deep navy background, cyan/blue/violet gradients, mint verification accent, soft volumetric glow, high contrast, polished editorial 3D/2D hybrid illustration. Composition should leave some breathable negative space, remain legible at README width, and contain absolutely no words, letters, numbers, logos, brand marks, copied UI, people, robots, watermarks, or fake screenshots. Do not imitate any existing vendor interface. Target composition 1536x1024.

## Social preview

- File: `docs/images/software-agent-social-preview.png` (1280x640).
- Source: original raster background generated with OpenAI's image-generation
  tool.
- Edit: center-cropped to 2:1, then the original Software Agent SVG logo and
  exact vector-rendered title/tagline were composed with
  `scripts/compose-social-preview.mjs`. PNG palette/compression was optimized
  with Sharp.
- Final SHA-256: `924595f068b2a2a672676df603343bb8fd29bfd081c0d4311bf6528b919ad849`
- Exact prompt:

> Create an original ultra-wide 2:1 social-preview background illustration for a trustworthy open-source terminal developer platform. No text will be generated; reserve the left 42 percent as clean deep-navy negative space for a title added later in code. On the right, show three elegant luminous agent workstreams as abstract terminal panels and connected nodes, colored cyan, electric blue, and violet, converging through a compact local controller chip toward a mint verified check signal. Include subtle event trails, code-like geometric blocks, and restrained depth; premium modern developer-tool editorial art, dark navy, crisp, calm, highly polished, high contrast. Absolutely no words, letters, numbers, provider logos, brand marks, copied interface, people, robots, watermarks, or fake screenshots. Keep important art safely inside the center-right so it survives a 1280x640 crop.

## Workflow diagram

- File: `docs/images/software-agent-workflow.svg`.
- Source: original code-native SVG authored in-repository by OpenAI Codex from
  the implemented controller, agent, approval, tool, and event model.
- Purpose: explain the governed prompt-to-verified-result flow without
  presenting concept art as a runtime screenshot.
- SHA-256: `f540aed7570644cd672e6aceb8e12ea986b7ed676fdc3a7309ec6029d8de622b`

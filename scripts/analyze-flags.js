'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const countries = require('country-list');

const SVG_DIR = path.join(__dirname, '..', 'country-flags', 'svg');
const OUTPUT = path.join(__dirname, '..', 'docs', 'flags-data.json');

// Quantize an RGB triplet into a bucket key using the given tolerance.
// We floor each channel to the nearest multiple of `tolerance`, producing a
// coarse key that merges near-identical shades into a single bucket.
function quantizeKey(r, g, b, tolerance = 20) {
  const qr = Math.floor(r / tolerance) * tolerance;
  const qg = Math.floor(g / tolerance) * tolerance;
  const qb = Math.floor(b / tolerance) * tolerance;
  return (qr << 16) | (qg << 8) | qb;
}

// Convert an integer key (produced by quantizeKey) back to a hex color string.
function keyToHex(key) {
  const r = (key >> 16) & 0xff;
  const g = (key >> 8) & 0xff;
  const b = key & 0xff;
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0').toUpperCase()).join('');
}

async function analyzeFlag(svgPath) {
  // Rasterize the SVG to a raw RGBA pixel buffer at a fixed resolution.
  // 200×133 gives enough resolution for color sampling without being slow.
  const { data, info } = await sharp(svgPath, { limitInputPixels: false })
    .resize(200, 133, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map(); // quantized key → { totalR, totalG, totalB, count }
  let opaque = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    // Skip fully-transparent pixels (e.g. PNG transparency artifacts).
    if (a < 10) continue;
    opaque++;

    const key = quantizeKey(r, g, b, 20);
    if (!buckets.has(key)) {
      buckets.set(key, { totalR: 0, totalG: 0, totalB: 0, count: 0 });
    }
    const bucket = buckets.get(key);
    // Accumulate exact values so we can compute the true average hex per bucket.
    bucket.totalR += r;
    bucket.totalG += g;
    bucket.totalB += b;
    bucket.count++;
  }

  if (opaque === 0) return null;

  // Build color list, discarding colors below 1% surface area.
  const colors = [];
  for (const [, bucket] of buckets) {
    const ratio = bucket.count / opaque;
    if (ratio < 0.01) continue;

    // Use the bucket's average color as the representative hex.
    const avgR = Math.round(bucket.totalR / bucket.count);
    const avgG = Math.round(bucket.totalG / bucket.count);
    const avgB = Math.round(bucket.totalB / bucket.count);
    const hex = '#' + [avgR, avgG, avgB]
      .map(c => c.toString(16).padStart(2, '0').toUpperCase())
      .join('');

    colors.push({ hex, ratio: parseFloat(ratio.toFixed(4)) });
  }

  // Sort largest slice first for a consistent pie chart layout.
  colors.sort((a, b) => b.ratio - a.ratio);

  // Normalise ratios so they sum to exactly 1.0 after thresholding.
  const total = colors.reduce((s, c) => s + c.ratio, 0);
  for (const c of colors) {
    c.ratio = parseFloat((c.ratio / total).toFixed(4));
  }

  return colors;
}

async function main() {
  const files = fs.readdirSync(SVG_DIR).filter(f => f.endsWith('.svg'));
  const results = [];
  let processed = 0;

  for (const file of files) {
    const code = file.replace('.svg', '').toLowerCase();
    const name = countries.getName(code.toUpperCase());

    // Skip non-sovereign or unrecognised codes.
    if (!name) {
      // Silently skip; uncomment next line for verbose output.
      // console.warn(`  skip ${code}: no country name`);
      continue;
    }

    const svgPath = path.join(SVG_DIR, file);
    try {
      const colors = await analyzeFlag(svgPath);
      if (!colors || colors.length === 0) {
        console.warn(`  warn ${code}: no colors extracted`);
        continue;
      }
      results.push({ code, name, colors });
    } catch (err) {
      console.warn(`  warn ${code}: ${err.message}`);
    }

    processed++;
    if (processed % 25 === 0) {
      console.log(`Processed ${processed}/${files.length} flags…`);
    }
  }

  console.log(`Done. ${results.length} flags written to ${OUTPUT}`);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

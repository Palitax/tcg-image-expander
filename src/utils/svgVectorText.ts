import * as opentype from "opentype.js";
import { FONT_BOLD_BASE64, FONT_REGULAR_BASE64 } from "./streamFonts";
import { CardMetadata } from "./tcgDatabase";

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = Buffer.from(base64, "base64");
  const ab = new ArrayBuffer(binaryString.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < binaryString.length; ++i) {
    view[i] = binaryString[i];
  }
  return ab;
}

let cachedBoldFont: opentype.Font | null = null;
let cachedRegularFont: opentype.Font | null = null;

function getBoldFont(): opentype.Font {
  if (!cachedBoldFont) {
    const ab = base64ToArrayBuffer(FONT_BOLD_BASE64);
    cachedBoldFont = opentype.parse(ab);
  }
  return cachedBoldFont;
}

function getRegularFont(): opentype.Font {
  if (!cachedRegularFont) {
    const ab = base64ToArrayBuffer(FONT_REGULAR_BASE64);
    cachedRegularFont = opentype.parse(ab);
  }
  return cachedRegularFont;
}

function getTextWidth(font: opentype.Font, text: string, fontSize: number): number {
  const glyphs = font.stringToGlyphs(text);
  let width = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    if (glyph.advanceWidth) {
      width += glyph.advanceWidth * (fontSize / font.unitsPerEm);
    }
  }
  return width;
}

function renderTextToSvgPath(
  font: opentype.Font,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  align: "left" | "center" | "right" = "left",
  fill = "#ffffff"
): string {
  if (!text) return "";
  let startX = x;
  if (align === "center") {
    const w = getTextWidth(font, text, fontSize);
    startX = x - w / 2;
  } else if (align === "right") {
    const w = getTextWidth(font, text, fontSize);
    startX = x - w;
  }
  const path = font.getPath(text, startX, y, fontSize);
  return `<path d="${path.toPathData(2)}" fill="${fill}" />`;
}

/**
 * Generates pure vector SVG Stream Preview overlay (Zero OS font dependency, zero tofu boxes)
 */
export function buildStreamPreviewVectorSvg(
  metadata: CardMetadata,
  width = 1024,
  height = 1024
): Buffer {
  const boldFont = getBoldFont();
  const regularFont = getRegularFont();

  const line1 = [metadata.cardName, metadata.cardNumber, metadata.setCode].filter(Boolean).join(" - ");
  const line2 = metadata.setName || "";
  const line3 = metadata.slogan || "MANACARDS – Unpack the magic";

  // Dynamic font sizing for long card titles
  let line1FontSize = 40;
  if (line1.length > 28) line1FontSize = 34;
  if (line1.length > 38) line1FontSize = 28;
  if (line1.length > 48) line1FontSize = 24;

  let line2FontSize = 32;
  if (line2.length > 25) line2FontSize = 28;
  if (line2.length > 35) line2FontSize = 24;

  // Convert all text to pure vector SVG path shapes
  const badgePath = renderTextToSvgPath(boldFont, "STREAM PREVIEW", 42, 54, 23, "left", "#ffffff");
  const line1Path = renderTextToSvgPath(boldFont, line1, 512, 864, line1FontSize, "center", "#ffffff");
  const line2Path = renderTextToSvgPath(boldFont, line2, 512, 908, line2FontSize, "center", "#ffffff");
  const line3Path = renderTextToSvgPath(regularFont, line3, 512, 954, 22, "center", "#ffffff");

  const svgContent = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Stream Preview Accent Glow Gradient -->
    <linearGradient id="lineGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f472b6" stop-opacity="0.95" />
      <stop offset="50%" stop-color="#c084fc" stop-opacity="0.85" />
      <stop offset="100%" stop-color="#f472b6" stop-opacity="0.95" />
    </linearGradient>

    <!-- Bottom Vignette for text contrast -->
    <linearGradient id="bottomVignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0" />
      <stop offset="25%" stop-color="#000000" stop-opacity="0.45" />
      <stop offset="65%" stop-color="#000000" stop-opacity="0.88" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.98" />
    </linearGradient>

    <!-- Top Vignette for STREAM PREVIEW badge -->
    <linearGradient id="topVignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.75" />
      <stop offset="60%" stop-color="#000000" stop-opacity="0.30" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </linearGradient>

    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Top Vignette -->
  <rect x="0" y="0" width="${width}" height="120" fill="url(#topVignette)" />

  <!-- Bottom Dark Vignette for Text Contrast -->
  <rect x="0" y="650" width="${width}" height="374" fill="url(#bottomVignette)" />

  <!-- Top Left Badge (Pure Vector Path) -->
  ${badgePath}

  <!-- Framing Neon Lines -->
  <!-- Top & Right framing path -->
  <path d="M 265 46 L 950 46 Q 982 46 982 78 L 982 916 Q 982 948 950 948 L 780 948" fill="none" stroke="url(#lineGlow)" stroke-width="2" filter="url(#glow)" />
  
  <!-- Left & Bottom framing path -->
  <path d="M 42 78 L 42 916 Q 42 948 74 948 L 244 948" fill="none" stroke="url(#lineGlow)" stroke-width="2" filter="url(#glow)" />

  <!-- Outer side accent brackets -->
  <path d="M 26 120 L 26 880 Q 26 915 52 915 L 70 915" fill="none" stroke="url(#lineGlow)" stroke-width="1.4" opacity="0.55" />
  <path d="M 998 120 L 998 880 Q 998 915 972 915 L 954 915" fill="none" stroke="url(#lineGlow)" stroke-width="1.4" opacity="0.55" />

  <!-- Line 1: Card Name - Number - Set Code (Pure Vector Path) -->
  ${line1Path}

  <!-- Line 2: Set Name (Pure Vector Path) -->
  ${line2Path}

  <!-- Line 3: Bottom Slogan flanked with accent lines (Pure Vector Path) -->
  <line x1="80" y1="948" x2="234" y2="948" stroke="url(#lineGlow)" stroke-width="1.6" />
  ${line3Path}
  <line x1="790" y1="948" x2="944" y2="948" stroke="url(#lineGlow)" stroke-width="1.6" />
</svg>`;

  return Buffer.from(svgContent);
}

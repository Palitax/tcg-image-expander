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

  const cleanField = (val?: string): string => {
    if (!val) return "";
    const trimmed = val.trim();
    if (/^(n\/?a|na|none|null|undefined|-|\?)$/i.test(trimmed)) return "";
    return trimmed;
  };

  const line1Parts: string[] = [];
  const cName = cleanField(metadata.cardName);
  const cNum = cleanField(metadata.cardNumber);
  const cSet = cleanField(metadata.setCode);

  if (cName) line1Parts.push(cName);
  if (cNum) line1Parts.push(cNum);
  if (cSet && cSet !== "TCG") line1Parts.push(cSet);

  const line1 = line1Parts.join(" - ");

  // Set-Name wird auf dem Stream-Overlay nicht mehr angezeigt
  const line3 = cleanField(metadata.slogan) || "MANACARDS – Unpack the magic";

  // Dynamic font sizing for long card titles
  let line1FontSize = 40;
  if (line1.length > 28) line1FontSize = 34;
  if (line1.length > 38) line1FontSize = 28;
  if (line1.length > 48) line1FontSize = 24;

  // Calculate dynamic spacing for Line 3 slogan and flanking lines
  const line3Width = getTextWidth(regularFont, line3, 22);
  const leftLineEnd = Math.max(75, Math.round(512 - line3Width / 2 - 40));
  const rightLineStart = Math.min(949, Math.round(512 + line3Width / 2 + 40));

  // Top Left STREAM PREVIEW badge with clean line spacing (never cut into the text)
  const badgeText = "STREAM PREVIEW";
  const badgeFontSize = 23;
  const badgeWidth = getTextWidth(boldFont, badgeText, badgeFontSize);
  const badgePath = renderTextToSvgPath(boldFont, badgeText, 42, 54, badgeFontSize, "left", "#ffffff");
  const topLineStart = Math.max(285, Math.round(42 + badgeWidth + 22));

  // Convert all text to pure vector SVG path shapes (matching reference typography & vertical rhythm)
  const line1Y = 918;
  const line1Path = renderTextToSvgPath(boldFont, line1, 512, line1Y, line1FontSize, "center", "#ffffff");
  const line3Path = renderTextToSvgPath(regularFont, line3, 512, 980, 22, "center", "#ffffff");

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
      <feGaussianBlur stdDeviation="1.5" result="blur" />
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
  <path d="M ${topLineStart} 46 L 950 46 Q 982 46 982 78 L 982 922 Q 982 971 933 971 L ${rightLineStart} 971" fill="none" stroke="url(#lineGlow)" stroke-width="2" stroke-linecap="round" filter="url(#glow)" />
  
  <!-- Left & Bottom framing path -->
  <path d="M 42 78 L 42 922 Q 42 971 91 971 L ${leftLineEnd} 971" fill="none" stroke="url(#lineGlow)" stroke-width="2" stroke-linecap="round" filter="url(#glow)" />

  <!-- Outer Corner Accent Lines (Bottom Left & Bottom Right) -->
  <path d="M 26 740 L 26 946 Q 26 954 32 960 L 60 985" fill="none" stroke="url(#lineGlow)" stroke-width="2" stroke-linecap="round" filter="url(#glow)" opacity="0.9" />
  <path d="M 998 740 L 998 946 Q 998 954 992 960 L 964 985" fill="none" stroke="url(#lineGlow)" stroke-width="2" stroke-linecap="round" filter="url(#glow)" opacity="0.9" />

  <!-- Line 1: Card Name - Number - Set Code (Pure Vector Path) -->
  ${line1Path}

  <!-- Line 3: Bottom Slogan (Pure Vector Path) -->
  ${line3Path}
</svg>`;

  return Buffer.from(svgContent);
}

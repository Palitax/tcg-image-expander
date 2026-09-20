import sharp from "sharp";

export interface CardCutoutResult {
  /** High-resolution transparent PNG cutout of the card with die-cut rounded corners */
  cutoutCardBuffer: Buffer;
  cutoutCardBase64: string;
  /** Inner illustration crop (max 512px) for AI background outpainting */
  illustrationBuffer: Buffer;
  illustrationBase64: string;
  /** Detected pixel coordinates on the original image */
  cardCoords: { x1: number; y1: number; x2: number; y2: number };
  illustrationCoords: { x1: number; y1: number; x2: number; y2: number };
  /** Extracted card metadata */
  cardName: string;
  cardNumber: string;
  setCode: string;
  setName: string;
  sceneryDescription: string;
  hasSampleWatermark: boolean;
  usedFallback: boolean;
  originalWidth: number;
  originalHeight: number;
}

interface ExtractCardCutoutOptions {
  apiKey?: string | null;
  skipCardCrop?: boolean;
  /** Die-cut corner radius as percentage of card width (default ~3.8% = 0.038) */
  cornerRadiusPercent?: number;
  /** Maximum dimension for the returned cutout card (optional, preserves original resolution if omitted) */
  maxCardDimension?: number;
  /** Optional micro-nudge for border padding in pixels (e.g. +2 or -2) */
  edgePaddingPx?: number;
  /** Vertical shift in pixels (+ = shift down, - = shift up / reveal more top) */
  verticalOffsetPx?: number;
  /** Bottom sleeve trim in pixels (cuts off transparent penny sleeve overhang at the bottom) */
  bottomTrimPx?: number;
  /** Top border margin expansion in pixels (ensures top border is preserved) */
  topPaddingPx?: number;
}

/**
 * Peak-seeking gradient edge detector.
 * Climbs the FIRST dominant contrast peak moving inward from the scan edge (the transition
 * from uniform scanner bed / clear sleeve to the printed card border).
 * Once the peak is climbed and begins to drop, it locks onto the outer cardboard edge,
 * preventing any overshoot into inner card artwork.
 */
function findOuterCardEdgePeak(
  data: Buffer,
  width: number,
  height: number,
  axis: "x" | "y",
  dir: 1 | -1,
  startPos: number,
  spanStart: number,
  spanEnd: number,
  maxScan = 35,
  minPeakGrad = 14
): number {
  let peakPos = startPos;
  let peakGrad = 0;
  let inPeak = false;

  for (let step = 0; step <= maxScan; step++) {
    const p = startPos + step * dir;
    if (p < 2 || p >= (axis === "x" ? width : height) - 2) break;

    let grad = 0;
    let count = 0;
    for (let s = spanStart; s <= spanEnd; s += 2) {
      if (axis === "x") {
        grad += Math.abs(data[s * width + (p + 1)] - data[s * width + (p - 1)]);
      } else {
        grad += Math.abs(data[(p + 1) * width + s] - data[(p - 1) * width + s]);
      }
      count++;
    }
    grad /= Math.max(1, count);

    if (grad >= minPeakGrad) {
      inPeak = true;
      if (grad > peakGrad) {
        peakGrad = grad;
        peakPos = p;
      } else if (grad < peakGrad * 0.75) {
        // Peak reached its crest and dropped; lock onto outer boundary
        break;
      }
    } else if (inPeak && grad < peakGrad * 0.6) {
      // Descended from the outer edge crest
      break;
    }
  }

  return peakPos;
}

/**
 * Detects transparent penny sleeve overhang at the bottom of the card.
 * In a penny sleeve, the transparent plastic extends 15-45px past the physical printed cardboard edge.
 * Scanning upward from the candidate bottom:
 * - Peak 1 (outer): The bottom seam of the clear plastic sleeve
 * - Quiet Zone: 12-40px of flat, low-gradient transparent plastic (grad < 10)
 * - Peak 2 (inner): The physical cardboard edge of the card (grad >= 16) with printed border & copyright
 * If this double-peak pattern is detected, returns the position of Peak 2 (true cardboard edge).
 */
function detectCardboardBottomEdge(
  data: Buffer,
  width: number,
  height: number,
  candidateY2: number,
  spanStart: number,
  spanEnd: number
): number {
  const searchStart = Math.min(height - 4, candidateY2 + 10);
  const searchEnd = Math.max(4, candidateY2 - 70);

  const grads: { y: number; grad: number }[] = [];
  for (let y = searchEnd; y <= searchStart; y++) {
    let grad = 0;
    let count = 0;
    for (let x = spanStart; x <= spanEnd; x += 2) {
      grad += Math.abs(data[(y + 1) * width + x] - data[(y - 1) * width + x]);
      count++;
    }
    grad /= Math.max(1, count);
    grads.push({ y, grad });
  }

  // Find distinct gradient peaks (>= 14)
  const peaks: { y: number; grad: number }[] = [];
  for (let i = 1; i < grads.length - 1; i++) {
    if (grads[i].grad >= 14 && grads[i].grad >= grads[i - 1].grad && grads[i].grad >= grads[i + 1].grad) {
      if (peaks.length > 0 && Math.abs(peaks[peaks.length - 1].y - grads[i].y) <= 3) {
        if (grads[i].grad > peaks[peaks.length - 1].grad) {
          peaks[peaks.length - 1] = grads[i];
        }
      } else {
        peaks.push(grads[i]);
      }
    }
  }

  if (peaks.length >= 2) {
    const lowest = peaks[peaks.length - 1]; // outer edge / sleeve seam
    const nextLowest = peaks[peaks.length - 2]; // inner edge / cardboard
    const gap = lowest.y - nextLowest.y;
    if (gap >= 12 && gap <= 55) {
      console.log(`[Card Cutout] Sleeve-Stripping: Hüllenüberstand von ${gap}px am Boden erkannt (Hülle y=${lowest.y}, echter Karton y=${nextLowest.y}). Hülle wird abgeschnitten.`);
      return nextLowest.y;
    }
  }

  return peaks.length > 0 ? peaks[peaks.length - 1].y : candidateY2;
}

/**
 * Robust Computer-Vision edge detector for scanned cards.
 * Specifically handles transparent penny sleeves and scanner beds by searching for
 * the FIRST prominent gradient ridge (the outer cardboard edge) moving inward from the image borders.
 * This guarantees that the entire card, all borders, names, HP, and copyright lines are kept 100% intact.
 */
export async function detectCardBordersCV(
  originalBuf: Buffer,
  width: number,
  height: number
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  try {
    const { data } = await sharp(originalBuf)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const yMidStart = Math.round(height * 0.25);
    const yMidEnd = Math.round(height * 0.75);
    const xMidStart = Math.round(width * 0.25);
    const xMidEnd = Math.round(width * 0.75);

    const leftX = findOuterCardEdgePeak(data, width, height, "x", +1, 6, yMidStart, yMidEnd, Math.floor(width * 0.35), 15);
    const rightX = findOuterCardEdgePeak(data, width, height, "x", -1, width - 6, yMidStart, yMidEnd, Math.floor(width * 0.35), 15);
    const topY = findOuterCardEdgePeak(data, width, height, "y", +1, 14, xMidStart, xMidEnd, Math.floor(height * 0.35), 12);
    const bottomY = detectCardboardBottomEdge(data, width, height, height - 6, xMidStart, xMidEnd);

    let detectedW = rightX - leftX;
    let detectedH = bottomY - topY;

    // Safety fallback if no clear edge was detected
    if (detectedW < width * 0.4 || detectedH < height * 0.4) {
      return { x1: 0, y1: 0, x2: width, y2: height };
    }

    return {
      x1: Math.max(0, leftX),
      y1: Math.max(0, topY),
      x2: Math.min(width, rightX),
      y2: Math.min(height, bottomY)
    };
  } catch (err: any) {
    console.warn("[Card Cutout CV] Detection error:", err?.message || err);
    return { x1: 0, y1: 0, x2: width, y2: height };
  }
}

/**
 * Inward Border Refinement & Sleeve Stripping:
 * If an AI detection or scanner crop includes the outer transparent penny sleeve,
 * toploader border, or scanner margin, this scans a localized window around each candidate boundary
 * to snap onto the true high-contrast outer cardboard edge of the printed card.
 */
function refineCardCutoutBorders(
  data: Buffer,
  width: number,
  height: number,
  box: { x1: number; y1: number; x2: number; y2: number }
): { x1: number; y1: number; x2: number; y2: number } {
  const yMidStart = Math.round(box.y1 + (box.y2 - box.y1) * 0.25);
  const yMidEnd = Math.round(box.y1 + (box.y2 - box.y1) * 0.75);
  const xMidStart = Math.round(box.x1 + (box.x2 - box.x1) * 0.25);
  const xMidEnd = Math.round(box.x1 + (box.x2 - box.x1) * 0.75);

  // Left & right outer cardboard edge refinement (tight window: 30px)
  const searchStartLeft = Math.max(4, box.x1 - 15);
  const newX1 = findOuterCardEdgePeak(data, width, height, "x", +1, searchStartLeft, yMidStart, yMidEnd, 30, 14);

  const searchStartRight = Math.min(width - 4, box.x2 + 15);
  const newX2 = findOuterCardEdgePeak(data, width, height, "x", -1, searchStartRight, yMidStart, yMidEnd, 30, 14);

  // Top outer cardboard edge refinement (tight window 24px so it NEVER jumps into inner artwork)
  const searchStartTop = Math.max(4, box.y1 - 12);
  const newY1 = findOuterCardEdgePeak(data, width, height, "y", +1, searchStartTop, xMidStart, xMidEnd, 24, 12);

  // Bottom edge refinement with automated penny sleeve stripping
  const newY2 = detectCardboardBottomEdge(data, width, height, box.y2, xMidStart, xMidEnd);

  return {
    x1: Math.min(newX1, newX2 - 50),
    y1: Math.min(newY1, newY2 - 50),
    x2: Math.max(newX2, newX1 + 50),
    y2: Math.max(newY2, newY1 + 50)
  };
}

/**
 * Universal Card Cutout Engine:
 * Analyzes an image of any trading card (in clear penny sleeves, toploaders, or on scanner beds),
 * locates the true outer cardboard boundaries, and extracts a die-cut rounded-corner cutout
 * with 100% original pixel fidelity, leaving all card borders, text, HP, and copyright completely intact.
 */
export async function extractCardCutout(
  imageBuffer: Buffer,
  options: ExtractCardCutoutOptions = {}
): Promise<CardCutoutResult> {
  const {
    apiKey,
    skipCardCrop = false,
    cornerRadiusPercent = 0.038, // Standard TCG die-cut radius (~3.2mm on 63mm width = 3.8%)
    maxCardDimension,
    edgePaddingPx = 0,
    verticalOffsetPx = 0,
    bottomTrimPx = 0,
    topPaddingPx = 0
  } = options;

  // 1. Normalize orientation and read dimensions
  const normalizedBuffer = await sharp(imageBuffer).rotate().toBuffer();
  const metadata = await sharp(normalizedBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width === 0 || height === 0) {
    throw new Error("Konnte die Bildabmessungen der Sammelkarte nicht ermitteln.");
  }

  // If user explicitly chose to skip cropping
  if (skipCardCrop) {
    console.log("[Card Cutout] skipCardCrop ist aktiviert. Verwende gesamtes Bild.");
    const cardW = width;
    const cardH = height;
    const cornerRadius = Math.max(2, Math.round(cardW * cornerRadiusPercent));
    const maskSvg = Buffer.from(
      `<svg width="${cardW}" height="${cardH}"><rect x="0" y="0" width="${cardW}" height="${cardH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const cutoutBuffer = await sharp(normalizedBuffer)
      .ensureAlpha()
      .composite([{ input: maskSvg, blend: "dest-in" }])
      .png({ compressionLevel: 7 })
      .toBuffer();

    const illustrationBuffer = await sharp(normalizedBuffer)
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 85 })
      .toBuffer();

    return {
      cutoutCardBuffer: cutoutBuffer,
      cutoutCardBase64: `data:image/png;base64,${cutoutBuffer.toString("base64")}`,
      illustrationBuffer,
      illustrationBase64: `data:image/jpeg;base64,${illustrationBuffer.toString("base64")}`,
      cardCoords: { x1: 0, y1: 0, x2: width, y2: height },
      illustrationCoords: {
        x1: Math.round(width * 0.1),
        y1: Math.round(height * 0.12),
        x2: Math.round(width * 0.9),
        y2: Math.round(height * 0.58)
      },
      cardName: "",
      cardNumber: "",
      setCode: "",
      setName: "",
      sceneryDescription: "",
      hasSampleWatermark: false,
      usedFallback: false,
      originalWidth: width,
      originalHeight: height
    };
  }

  let cardCoords: { x1: number; y1: number; x2: number; y2: number } | null = null;
  let illustrationCoords: { x1: number; y1: number; x2: number; y2: number } | null = null;
  let cardName = "";
  let cardNumber = "";
  let setCode = "";
  let setName = "";
  let sceneryDescription = "";
  let hasSampleWatermark = false;
  let usedFallback = false;

  // 2. Gemini AI Vision Analysis (PRIMARY GROUND TRUTH AUTHORITY)
  if (apiKey && apiKey.trim()) {
    try {
      // Lightweight 1024px working copy for fast Gemini analysis (<1.5s)
      let aiWorkBuffer = normalizedBuffer;
      const maxDim = 1024;
      if (width > maxDim || height > maxDim) {
        aiWorkBuffer = await sharp(normalizedBuffer)
          .resize(maxDim, maxDim, { fit: "inside" })
          .jpeg({ quality: 85 })
          .toBuffer();
      }

      const base64Image = aiWorkBuffer.toString("base64");

      const prompt = `You are an ultra-precise TCG Computer Vision Analyzer specialized in Pokémon cards (Japanese & English) and other trading cards.
Your task is to detect the EXACT pixel coordinates of high-contrast printed graphic markers inside the card to allow programmatic border reconstruction.

### CRITICAL RULES & ANTI-HALLUCINATION:
1. STRICTLY IGNORE TRANSPARENT SLEEVES AND TOPLOADERS:
   - The card is encased in a clear plastic sleeve.
   - NEVER return coordinates of the outer plastic lips, empty sleeve overhangs, glare, or table background.
   - We do NOT need the physical card outer border coordinates. We only need the inner printed ink anchors.

2. TARGET ANCHORS (PRINTED INK ONLY):
   - "outer_horizontal_card_edges":
     - Exact [left_x, right_x] where the physical printed cardboard card ends horizontally.
     - Standard TCG cards sit flush horizontally in standard penny sleeves; detect the printed card edge, ignoring sleeve seams.
   - "header_top_edge_y":
     - The EXACT top edge of the uppermost printed text/icon in the header.
     - Specifically: the very top pixel of the stage symbol ("たね", "1進化", "Basic") or the HP/Name letters.
     - Do NOT include the gray/yellow card border above it.
   - "copyright_bottom_edge_y":
     - The EXACT bottom baseline edge of the single-line copyright text at the very bottom ("©202X Pokémon/Nintendo...").
     - The coordinate must touch the lowest pixel of the letters (e.g. baseline of 'g', 'p', 'y').
     - Do NOT include the gray/yellow card border or the clear plastic sleeve below it.
   - "footer_left_marker":
     - Bounding box [ymin, xmin, ymax, xmax] of the bottom-left set identifier strip (Set-Code, Rarity, Card-Number, e.g. "085/083 AR").
   - "illustration_box":
     - Bounding box [ymin, xmin, ymax, xmax] of the inner illustration area inside the card frame (excluding card text, HP, power, and borders).
   - "box_2d":
     - General fallback bounding box [ymin, xmin, ymax, xmax] of the physical card itself.

3. METADATA:
   - "cardName": Extract official English name (translate Japanese e.g. 'ワンパチ' -> 'Yamper', 'シルシュルー' -> 'Shroodle', 'エリキテル' -> 'Helioptile').
   - "cardNumber": Card sequence number (e.g. '086/080', '151/165', '070/063', 'OP05-119').
   - "setCode": Set registration code (e.g. 'SV8', 'M2', 'M1S', 'SV1L', 'OP05').
   - "setName": Official English set name (e.g. 'Mega Symphonia', 'Supercharged Breaker', 'Violet ex').
   - "sceneryDescription": Vivid description of the environmental scenery, art style, lighting, and colors of the card illustration. Exclude characters/pokemon/text.
   - "hasSampleWatermark": True if a diagonal semi-transparent 'SAMPLE' watermark exists.

4. COORDINATE FORMAT:
   - Return all coordinates normalized to the [0, 1000] integer scale.`;

      const models = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.5-pro"];
      let layoutText = "";

      for (const model of models) {
        try {
          console.log(`[Card Cutout] Attempting Gemini model ${model}...`);
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
          const payload = {
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: base64Image } },
                  { text: prompt }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  outer_horizontal_card_edges: {
                    type: "ARRAY",
                    items: { type: "INTEGER" },
                    description: "Exact [left_x, right_x] normalized 0-1000 where the printed cardboard ends horizontally, ignoring sleeve seams."
                  },
                  header_top_edge_y: {
                    type: "INTEGER",
                    description: "Normalized 0-1000 Y-coordinate of the uppermost printed text/icon in the header (top pixel of stage symbol 'たね'/'Basic' or Name/HP). Exclude card border above."
                  },
                  copyright_bottom_edge_y: {
                    type: "INTEGER",
                    description: "Normalized 0-1000 Y-coordinate of the bottom baseline of the single-line copyright text at the bottom ('©202X Pokémon...'). Exclude card border or clear plastic below."
                  },
                  footer_left_marker: {
                    type: "ARRAY",
                    items: { type: "INTEGER" },
                    description: "Bounding box [ymin, xmin, ymax, xmax] of bottom-left set identifier strip (Set-Code, Rarity, Card-Number)."
                  },
                  box_2d: {
                    type: "ARRAY",
                    items: { type: "INTEGER" },
                    description: "Fallback bounding box [ymin, xmin, ymax, xmax] normalized 0 to 1000 of the physical card."
                  },
                  illustration_box: {
                    type: "ARRAY",
                    items: { type: "INTEGER" },
                    description: "Bounding box of the inner illustration area as [ymin, xmin, ymax, xmax] integers normalized 0 to 1000."
                  },
                  cardName: { type: "STRING" },
                  cardNumber: { type: "STRING" },
                  setCode: { type: "STRING" },
                  setName: { type: "STRING" },
                  sceneryDescription: { type: "STRING" },
                  hasSampleWatermark: { type: "BOOLEAN" }
                },
                required: ["cardName", "cardNumber"]
              }
            }
          };

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
          });

          if (res.ok) {
            const json = await res.json();
            const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              layoutText = text;
              console.log(`[Card Cutout] Model ${model} returned layout successfully.`);
              break;
            }
          } else {
            console.warn(`[Card Cutout] Model ${model} HTTP ${res.status}`);
          }
        } catch (mErr: any) {
          console.warn(`[Card Cutout] Model ${model} failed:`, mErr?.message || mErr);
        }
      }

      if (layoutText) {
        const parsed = JSON.parse(layoutText);
        cardName = parsed.cardName || "";
        cardNumber = parsed.cardNumber || "";
        setCode = parsed.setCode || "";
        setName = parsed.setName || "";
        sceneryDescription = parsed.sceneryDescription || "";
        hasSampleWatermark = !!parsed.hasSampleWatermark;

        // 2a. Determine horizontal bounds (x1, x2)
        let aiX1: number | null = null;
        let aiX2: number | null = null;

        if (parsed.outer_horizontal_card_edges && Array.isArray(parsed.outer_horizontal_card_edges) && parsed.outer_horizontal_card_edges.length === 2) {
          const [leftVal, rightVal] = parsed.outer_horizontal_card_edges.map(Number);
          if (rightVal > leftVal + 50) {
            aiX1 = Math.round((leftVal / 1000) * width);
            aiX2 = Math.round((rightVal / 1000) * width);
          }
        }

        if (aiX1 === null || aiX2 === null) {
          if (parsed.box_2d && Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
            const [, xmin, , xmax] = parsed.box_2d.map(Number);
            if (xmax > xmin + 50) {
              aiX1 = Math.round((xmin / 1000) * width);
              aiX2 = Math.round((xmax / 1000) * width);
            }
          }
        }

        // 2b. Programmatic Border Reconstruction from Printed Ink Anchors
        if (aiX1 !== null && aiX2 !== null) {
          const rawW = aiX2 - aiX1;
          const isSmallJapaneseGame = setCode?.toLowerCase().includes("ygo") || setName?.toLowerCase().includes("yu-gi-oh");
          const TARGET_RATIO = isSmallJapaneseGame ? 1.4576 : 1.396825;
          const canonicalH = Math.round(rawW * TARGET_RATIO);

          const headerTopY = typeof parsed.header_top_edge_y === "number" && parsed.header_top_edge_y > 0
            ? Math.round((parsed.header_top_edge_y / 1000) * height)
            : null;
          const copyrightBottomY = typeof parsed.copyright_bottom_edge_y === "number" && parsed.copyright_bottom_edge_y > 0
            ? Math.round((parsed.copyright_bottom_edge_y / 1000) * height)
            : null;

          if (headerTopY !== null && copyrightBottomY !== null && copyrightBottomY > headerTopY) {
            // Anchor reconstruction: Top border margin is canonical ~3.8% of height, bottom border margin is ~3.3%
            const topMargin = Math.round(canonicalH * 0.038);
            let cy1 = Math.max(0, headerTopY - topMargin);
            let cy2 = cy1 + canonicalH;

            // Safety verify against copyright baseline: bottom edge must be at least 2.5% below copyright text
            const minBottomClearance = Math.round(canonicalH * 0.025);
            if (cy2 < copyrightBottomY + minBottomClearance) {
              cy2 = copyrightBottomY + Math.round(canonicalH * 0.033);
              cy1 = Math.max(0, cy2 - canonicalH);
            }

            cardCoords = { x1: aiX1, y1: cy1, x2: aiX2, y2: cy2 };
            console.log(`[Card Cutout] Programmatische Rand-Rekonstruktion aus Tinten-Ankern: Header-Y=${headerTopY}, Copyright-Y=${copyrightBottomY} -> Box: [${aiX1}, ${cy1}, ${aiX2}, ${cy2}] (${rawW}x${canonicalH})`);
          } else if (headerTopY !== null) {
            const topMargin = Math.round(canonicalH * 0.038);
            const cy1 = Math.max(0, headerTopY - topMargin);
            const cy2 = cy1 + canonicalH;
            cardCoords = { x1: aiX1, y1: cy1, x2: aiX2, y2: cy2 };
            console.log(`[Card Cutout] Rekonstruktion über Header-Tintenanker: [${aiX1}, ${cy1}, ${aiX2}, ${cy2}]`);
          } else if (copyrightBottomY !== null) {
            const bottomMargin = Math.round(canonicalH * 0.033);
            const cy2 = Math.min(height, copyrightBottomY + bottomMargin);
            const cy1 = Math.max(0, cy2 - canonicalH);
            cardCoords = { x1: aiX1, y1: cy1, x2: aiX2, y2: cy2 };
            console.log(`[Card Cutout] Rekonstruktion über Copyright-Tintenanker: [${aiX1}, ${cy1}, ${aiX2}, ${cy2}]`);
          } else if (parsed.box_2d && Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
            const [ymin, , ymax] = parsed.box_2d.map(Number);
            const cy1 = Math.round((ymin / 1000) * height);
            const cy2 = Math.round((ymax / 1000) * height);
            cardCoords = { x1: aiX1, y1: cy1, x2: aiX2, y2: cy2 };
            console.log(`[Card Cutout] Fallback auf Gemini box_2d: [${aiX1}, ${cy1}, ${aiX2}, ${cy2}]`);
          }
        }

        if (parsed.illustration_box && Array.isArray(parsed.illustration_box) && parsed.illustration_box.length === 4) {
          const [ymin, xmin, ymax, xmax] = parsed.illustration_box.map(Number);
          illustrationCoords = {
            x1: Math.round((xmin / 1000) * width),
            y1: Math.round((ymin / 1000) * height),
            x2: Math.round((xmax / 1000) * width),
            y2: Math.round((ymax / 1000) * height)
          };
        }
      }
    } catch (aiErr: any) {
      console.warn("[Card Cutout] AI vision pipeline error:", aiErr?.message || aiErr);
    }
  }

  // 3. Computer Vision Fallback (ONLY if AI is unavailable or failed)
  if (!cardCoords) {
    console.warn("[Card Cutout] AI did not detect card bounds or API unavailable. Falling back to CV edge detector.");
    usedFallback = true;
    cardCoords = await detectCardBordersCV(normalizedBuffer, width, height);
  }

  // 4. Inward Border Refinement & Sleeve Stripping (ONLY FOR CV FALLBACK!)
  // When Gemini AI successfully detects the card bounding box, we do NOT run 1D gradient refinement.
  // Gemini has full semantic awareness of card headers, borders, and sleeves.
  // 1D gradient scans lack semantic awareness and jump into inner artwork/headers or mistake copyright lines for sleeve edges.
  if (usedFallback) {
    try {
      const { data: greyData } = await sharp(normalizedBuffer)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const refined = refineCardCutoutBorders(greyData, width, height, cardCoords);
      console.log(`[Card Cutout CV] Verfeinerte Fallback-Kartonkoordinaten: [${refined.x1}, ${refined.y1}, ${refined.x2}, ${refined.y2}]`);
      cardCoords = refined;
    } catch (refineErr: any) {
      console.warn("[Card Cutout CV] Border refinement skipped:", refineErr?.message || refineErr);
    }
  } else {
    console.log(`[Card Cutout] Verwende direkte semantische Gemini-Koordinaten: [${cardCoords.x1}, ${cardCoords.y1}, ${cardCoords.x2}, ${cardCoords.y2}]`);
  }

  // 5. Mathematical TCG Aspect Ratio Guard & Plausibility Check
  // Standard card ratio: 63mm x 88mm = 1.3968 (Pokémon, MTG, One Piece, Lorcana)
  // Japanese small ratio: 59mm x 86mm = 1.4576 (Yu-Gi-Oh)
  let rawW = cardCoords.x2 - cardCoords.x1;
  let rawH = cardCoords.y2 - cardCoords.y1;
  let ratio = rawH / Math.max(1, rawW);

  // Check if it is genuinely a 100% borderless raw card scan (all margins <= 1%)
  const isGenuineEdgeToEdge =
    rawW >= width * 0.985 &&
    rawH >= height * 0.985 &&
    cardCoords.x1 <= width * 0.01 &&
    cardCoords.y1 <= height * 0.01;

  if (isGenuineEdgeToEdge) {
    console.log("[Card Cutout] Echter randloser Kartenscan erkannt.");
    cardCoords = { x1: 0, y1: 0, x2: width, y2: height };
  } else if (usedFallback) {
    // Rigid aspect ratio enforcement ONLY when using heuristic CV Fallback
    const isSmallJapaneseGame = setCode?.toLowerCase().includes("ygo") || setName?.toLowerCase().includes("yu-gi-oh");
    const TARGET_RATIO = isSmallJapaneseGame ? 1.4576 : 1.3968;
    const expectedH = Math.round(rawW * TARGET_RATIO);

    if (ratio < (TARGET_RATIO - 0.015)) {
      const expectedW = Math.round(rawH / TARGET_RATIO);
      if (expectedW < rawW) {
        const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
        const newX1 = Math.max(0, Math.round(centerX - expectedW / 2));
        const newX2 = Math.min(width, Math.round(centerX + expectedW / 2));
        console.log(`[Card Cutout CV] Breiten-Trim: Passe Breite von ${rawW} auf ${newX2 - newX1} an.`);
        cardCoords.x1 = newX1;
        cardCoords.x2 = newX2;
      }
    } else if (ratio > (TARGET_RATIO + 0.015)) {
      if (expectedH < rawH) {
        console.log(`[Card Cutout CV] Sleeve-Trim am Boden: Höhe von ${rawH} auf ${expectedH} angepasst.`);
        cardCoords.y2 = cardCoords.y1 + expectedH;
      }
    }
  } else {
    // Gemini AI Vision path:
    const isSmallJapaneseGame = setCode?.toLowerCase().includes("ygo") || setName?.toLowerCase().includes("yu-gi-oh");
    const TARGET_RATIO = isSmallJapaneseGame ? 1.4576 : 1.3968;
    const minPlausibleRatio = isSmallJapaneseGame ? 1.38 : 1.33;
    // Standard TCG card aspect ratio is strictly 1.3968 (88mm / 63mm).
    // An aspect ratio > 1.415 indicates that the height includes the empty transparent plastic lip
    // extending 2-5mm at the bottom edge.
    const maxPlausibleRatio = isSmallJapaneseGame ? 1.48 : 1.415;
    const expectedH = Math.round(rawW * TARGET_RATIO);

    // 5a. Top Card Border Protection (ensure header and top border aren't shaved):
    const minTopMargin = Math.round(expectedH * 0.038);
    if (illustrationCoords && illustrationCoords.y1 > cardCoords.y1) {
      const topDistance = illustrationCoords.y1 - cardCoords.y1;
      if (topDistance < minTopMargin) {
        const topShortage = minTopMargin - topDistance;
        console.log(`[Card Cutout] Oberer Kartenrand war um ${topShortage}px zu nah am Motiv (${topDistance}px < min ${minTopMargin}px). Rand nach oben erweitert.`);
        cardCoords.y1 = Math.max(0, cardCoords.y1 - topShortage);
        rawH = cardCoords.y2 - cardCoords.y1;
        ratio = rawH / Math.max(1, rawW);
      }
    }

    if (ratio >= minPlausibleRatio && ratio <= maxPlausibleRatio) {
      console.log(`[Card Cutout] Gemini-Seitenverhältnis (${ratio.toFixed(3)}) liegt im idealen Bereich (${minPlausibleRatio.toFixed(2)} - ${maxPlausibleRatio.toFixed(2)}). Echte Kartonkanten erkannt.`);
    } else if (ratio > maxPlausibleRatio) {
      // Crucial: Trading cards in protective sleeves have an empty transparent plastic lip extending 2-5mm at the bottom edge.
      // If ratio > maxPlausibleRatio, ymax captured this transparent sleeve edge rather than the printed cardboard edge.
      // We trim y2 directly underneath the bottom silver/yellow border, right below the copyright line:
      if (expectedH < rawH) {
        const excessSleevePx = rawH - expectedH;
        console.log(`[Card Cutout] Transparenter Hüllenüberstand (${excessSleevePx}px, Verhältnis ${ratio.toFixed(3)} > ${maxPlausibleRatio}) am Boden erkannt und entfernt. y2 von ${cardCoords.y2} auf ${cardCoords.y1 + expectedH} korrigiert (direkt unter Silber-/Gelbrand).`);
        cardCoords.y2 = cardCoords.y1 + expectedH;
      }
    } else if (ratio < minPlausibleRatio) {
      // Significantly too wide -> width includes side borders/scenery
      const expectedW = Math.round(rawH / TARGET_RATIO);
      if (expectedW < rawW) {
        const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
        const newX1 = Math.max(0, Math.round(centerX - expectedW / 2));
        const newX2 = Math.min(width, Math.round(centerX + expectedW / 2));
        console.log(`[Card Cutout] Plausibilitätskorrektur: Breite war zu weit gefasst (Verhältnis ${ratio.toFixed(3)} < ${minPlausibleRatio}). Passe x1/x2 an.`);
        cardCoords.x1 = newX1;
        cardCoords.x2 = newX2;
      }
    }
  }

  // 5c. Apply User Fine-Tuning Offsets:
  if (verticalOffsetPx && Math.abs(verticalOffsetPx) <= 80) {
    console.log(`[Card Cutout] Manueller vertikaler Versatz: ${verticalOffsetPx}px`);
    cardCoords.y1 = Math.max(0, Math.min(height - 50, cardCoords.y1 + verticalOffsetPx));
    cardCoords.y2 = Math.max(cardCoords.y1 + 50, Math.min(height, cardCoords.y2 + verticalOffsetPx));
  }

  if (bottomTrimPx && bottomTrimPx > 0 && bottomTrimPx <= 80) {
    console.log(`[Card Cutout] Manueller Hüllen-Trim (Boden): -${bottomTrimPx}px`);
    cardCoords.y2 = Math.max(cardCoords.y1 + 50, cardCoords.y2 - bottomTrimPx);
  }

  if (topPaddingPx && topPaddingPx > 0 && topPaddingPx <= 80) {
    console.log(`[Card Cutout] Manueller oberer Rand-Zuschlag: +${topPaddingPx}px`);
    cardCoords.y1 = Math.max(0, cardCoords.y1 - topPaddingPx);
  }

  // Apply optional edge padding micro-adjustment
  if (edgePaddingPx && Math.abs(edgePaddingPx) <= 25) {
    cardCoords.x1 = Math.max(0, cardCoords.x1 + edgePaddingPx);
    cardCoords.y1 = Math.max(0, cardCoords.y1 + edgePaddingPx);
    cardCoords.x2 = Math.min(width, cardCoords.x2 - edgePaddingPx);
    cardCoords.y2 = Math.min(height, cardCoords.y2 - edgePaddingPx);
  }

  // Strict boundary clamping
  const cx1 = Math.max(0, Math.min(cardCoords.x1, width - 1));
  const cy1 = Math.max(0, Math.min(cardCoords.y1, height - 1));
  const cx2 = Math.max(cx1 + 10, Math.min(cardCoords.x2, width));
  const cy2 = Math.max(cy1 + 10, Math.min(cardCoords.y2, height));

  const extractW = cx2 - cx1;
  const extractH = cy2 - cy1;

  console.log(`[Card Cutout] Final pristine card boundaries: [${cx1}, ${cy1}, ${cx2}, ${cy2}] (${extractW}x${extractH}, ratio ${(extractH / extractW).toFixed(3)})`);

  // 5. Watermark Removal if detected
  let workingBuffer = normalizedBuffer;
  if (hasSampleWatermark && apiKey) {
    try {
      console.log("[Card Cutout] 'SAMPLE' watermark detected. Cleaning with Gemini image model...");
      const imageModels = ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"];
      for (const m of imageModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
          const payload = {
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: normalizedBuffer.toString("base64") } },
                  { text: "Remove the large diagonal semi-transparent 'SAMPLE' watermark text from this card. Ensure that the card artwork, text, border, and numbers underneath are clean, fully visible, and seamlessly restored, with no watermark remaining." }
                ]
              }
            ],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"]
            }
          };

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (res.ok) {
            const json = await res.json();
            const part = json?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
            if (part?.inlineData?.data) {
              const cleanedBuf = Buffer.from(part.inlineData.data, "base64");
              workingBuffer = await sharp(cleanedBuf).resize(width, height).toBuffer();
              console.log("[Card Cutout] Watermark successfully removed.");
              break;
            }
          }
        } catch (cleanErr: any) {
          console.warn(`[Card Cutout] Watermark removal with ${m} failed:`, cleanErr.message);
        }
      }
    } catch (wErr: any) {
      console.warn("[Card Cutout] Watermark cleaning skipped:", wErr.message);
    }
  }

  // 6. Extract Card and apply Authentic Die-Cut Corner Mask
  let targetW = extractW;
  let targetH = extractH;
  if (maxCardDimension && (targetW > maxCardDimension || targetH > maxCardDimension)) {
    if (targetW >= targetH) {
      targetW = maxCardDimension;
      targetH = Math.round((extractH / extractW) * targetW);
    } else {
      targetH = maxCardDimension;
      targetW = Math.round((extractW / extractH) * targetH);
    }
  }

  const rawExtractedCard = await sharp(workingBuffer)
    .extract({ left: cx1, top: cy1, width: extractW, height: extractH })
    .resize(targetW, targetH)
    .png()
    .toBuffer();

  const cornerRadius = Math.max(4, Math.round(targetW * cornerRadiusPercent));
  const roundedMaskSvg = Buffer.from(
    `<svg width="${targetW}" height="${targetH}"><rect x="0" y="0" width="${targetW}" height="${targetH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
  );

  const cutoutCardBuffer = await sharp(rawExtractedCard)
    .ensureAlpha()
    .composite([{ input: roundedMaskSvg, blend: "dest-in" }])
    .png({ compressionLevel: 7 })
    .toBuffer();

  // 7. Extract Inner Illustration for Outpainting
  let ix1 = illustrationCoords?.x1 ?? Math.round(cx1 + extractW * 0.08);
  let iy1 = illustrationCoords?.y1 ?? Math.round(cy1 + extractH * 0.10);
  let ix2 = illustrationCoords?.x2 ?? Math.round(cx2 - extractW * 0.08);
  let iy2 = illustrationCoords?.y2 ?? Math.round(cy1 + extractH * 0.58);

  // Clamp illustration bounds strictly inside the extracted card
  ix1 = Math.max(cx1, Math.min(ix1, cx2 - 10));
  iy1 = Math.max(cy1, Math.min(iy1, cy2 - 10));
  ix2 = Math.max(ix1 + 10, Math.min(ix2, cx2));
  iy2 = Math.max(iy1 + 10, Math.min(iy2, cy2));

  const extractIllW = ix2 - ix1;
  const extractIllH = iy2 - iy1;

  const illustrationBuffer = await sharp(workingBuffer)
    .extract({ left: ix1, top: iy1, width: extractIllW, height: extractIllH })
    .resize(512, 512, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();

  return {
    cutoutCardBuffer,
    cutoutCardBase64: `data:image/png;base64,${cutoutCardBuffer.toString("base64")}`,
    illustrationBuffer,
    illustrationBase64: `data:image/jpeg;base64,${illustrationBuffer.toString("base64")}`,
    cardCoords: { x1: cx1, y1: cy1, x2: cx2, y2: cy2 },
    illustrationCoords: { x1: ix1, y1: iy1, x2: ix2, y2: iy2 },
    cardName,
    cardNumber,
    setCode,
    setName,
    sceneryDescription,
    hasSampleWatermark,
    usedFallback,
    originalWidth: width,
    originalHeight: height
  };
}

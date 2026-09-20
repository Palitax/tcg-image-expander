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
  /** Die-cut corner radius as percentage of card width (default ~3.5% = 0.035) */
  cornerRadiusPercent?: number;
  /** Maximum dimension for the returned cutout card (optional, preserves original resolution if omitted) */
  maxCardDimension?: number;
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

    const yMidStart = Math.round(height * 0.20);
    const yMidEnd = Math.round(height * 0.80);
    const ySpan = Math.max(1, yMidEnd - yMidStart);

    // 1. Scan Left: search inward from x=6. Find FIRST prominent peak (outer card edge)
    // Faint sleeve glare is < 12. Real cardboard outer edge is > 20.
    let leftX = 0;
    for (let x = 8; x < Math.floor(width * 0.45); x++) {
      let grad = 0;
      for (let y = yMidStart; y < yMidEnd; y++) {
        grad += Math.abs(data[y * width + (x + 1)] - data[y * width + (x - 1)]);
      }
      grad /= ySpan;
      if (grad > 20) {
        let peakX = x;
        let maxG = grad;
        for (let dx = 1; dx <= 4; dx++) {
          let g = 0;
          for (let y = yMidStart; y < yMidEnd; y++) {
            g += Math.abs(data[y * width + (x + dx + 1)] - data[y * width + (x + dx - 1)]);
          }
          g /= ySpan;
          if (g > maxG) {
            maxG = g;
            peakX = x + dx;
          }
        }
        leftX = peakX;
        break;
      }
    }

    // 2. Scan Right: search inward from width - 8. Find FIRST prominent peak
    let rightX = width;
    for (let x = width - 8; x > Math.floor(width * 0.55); x--) {
      let grad = 0;
      for (let y = yMidStart; y < yMidEnd; y++) {
        grad += Math.abs(data[y * width + (x + 1)] - data[y * width + (x - 1)]);
      }
      grad /= ySpan;
      if (grad > 20) {
        let peakX = x;
        let maxG = grad;
        for (let dx = 1; dx <= 4; dx++) {
          let g = 0;
          for (let y = yMidStart; y < yMidEnd; y++) {
            g += Math.abs(data[y * width + (x - dx + 1)] - data[y * width + (x - dx - 1)]);
          }
          g /= ySpan;
          if (g > maxG) {
            maxG = g;
            peakX = x - dx;
          }
        }
        rightX = peakX;
        break;
      }
    }

    // 3. Scan Bottom: search inward from height - 8. Find FIRST prominent peak
    const xMidStart = Math.round(width * 0.20);
    const xMidEnd = Math.round(width * 0.80);
    const xSpan = Math.max(1, xMidEnd - xMidStart);

    let bottomY = height;
    for (let y = height - 8; y > Math.floor(height * 0.50); y--) {
      let grad = 0;
      for (let x = xMidStart; x < xMidEnd; x++) {
        grad += Math.abs(data[(y + 1) * width + x] - data[(y - 1) * width + x]);
      }
      grad /= ySpan;
      if (grad > 20) {
        let peakY = y;
        let maxG = grad;
        for (let dy = 1; dy <= 4; dy++) {
          let g = 0;
          for (let x = xMidStart; x < xMidEnd; x++) {
            g += Math.abs(data[(y - dy + 1) * width + x] - data[(y - dy - 1) * width + x]);
          }
          g /= ySpan;
          if (g > maxG) {
            maxG = g;
            peakY = y - dy;
          }
        }
        bottomY = peakY;
        break;
      }
    }

    // 4. Scan Top: search inward starting at y=18 (skip top plastic flap). Find FIRST prominent peak
    let topY = 0;
    for (let y = 18; y < Math.floor(height * 0.45); y++) {
      let grad = 0;
      for (let x = xMidStart; x < xMidEnd; x++) {
        grad += Math.abs(data[(y + 1) * width + x] - data[(y - 1) * width + x]);
      }
      grad /= xSpan;
      if (grad > 18) {
        let peakY = y;
        let maxG = grad;
        for (let dy = 1; dy <= 4; dy++) {
          let g = 0;
          for (let x = xMidStart; x < xMidEnd; x++) {
            g += Math.abs(data[(y + dy + 1) * width + x] - data[(y + dy - 1) * width + x]);
          }
          g /= xSpan;
          if (g > maxG) {
            maxG = g;
            peakY = y + dy;
          }
        }
        topY = peakY;
        break;
      }
    }

    let detectedW = rightX - leftX;
    let detectedH = bottomY - topY;

    // Safety fallback if no clear edge was detected
    if (detectedW < width * 0.4 || detectedH < height * 0.4) {
      leftX = 0;
      topY = 0;
      rightX = width;
      bottomY = height;
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
 * toploader border, or scanner margin, this scans inward (up to 45px) from each candidate boundary
 * to locate the true high-contrast outer cardboard edge of the printed card.
 * If the candidate boundary is already on the card edge, it locks onto it.
 */
function refineCardCutoutBorders(
  data: Buffer,
  width: number,
  height: number,
  box: { x1: number; y1: number; x2: number; y2: number }
): { x1: number; y1: number; x2: number; y2: number } {
  function scanInward(
    axis: "x" | "y",
    dir: 1 | -1,
    startPos: number,
    spanStart: number,
    spanEnd: number,
    maxInward = 45,
    threshold = 14
  ): number {
    let bestPos = startPos;
    for (let step = 0; step <= maxInward; step++) {
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

      if (grad >= threshold) {
        bestPos = p;
        let maxG = grad;
        for (let dp = 1; dp <= 3; dp++) {
          const np = p + dp * dir;
          if (np < 2 || np >= (axis === "x" ? width : height) - 2) break;
          let g = 0;
          for (let s = spanStart; s <= spanEnd; s += 2) {
            if (axis === "x") {
              g += Math.abs(data[s * width + (np + 1)] - data[s * width + (np - 1)]);
            } else {
              g += Math.abs(data[(np + 1) * width + s] - data[(np - 1) * width + s]);
            }
          }
          g /= Math.max(1, count);
          if (g > maxG) {
            maxG = g;
            bestPos = np;
          }
        }
        break;
      }
    }
    return bestPos;
  }

  const yMidStart = Math.round(box.y1 + (box.y2 - box.y1) * 0.25);
  const yMidEnd = Math.round(box.y1 + (box.y2 - box.y1) * 0.75);
  const xMidStart = Math.round(box.x1 + (box.x2 - box.x1) * 0.25);
  const xMidEnd = Math.round(box.x1 + (box.x2 - box.x1) * 0.75);

  const newX1 = scanInward("x", +1, box.x1, yMidStart, yMidEnd, 45, 14);
  const newX2 = scanInward("x", -1, box.x2, yMidStart, yMidEnd, 45, 14);
  const newY1 = scanInward("y", +1, box.y1, xMidStart, xMidEnd, 45, 14);
  const newY2 = scanInward("y", -1, box.y2, xMidStart, xMidEnd, 45, 14);

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
    maxCardDimension
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

      const prompt = `You are an expert computer vision model specializing in Trading Card Game (TCG) scanning and segmentation (Pokémon, One Piece, Magic: The Gathering, Yu-Gi-Oh, Lorcana).
The uploaded image is a scan or photograph containing a trading card.

CRITICAL INSTRUCTIONS FOR LOCATING THE CARD:
1. The card is often placed inside a transparent penny sleeve, top loader, card saver, or on a scanner glass bed with light margins, reflections, or plastic flaps.
2. YOU MUST LOCATE THE EXACT BOUNDING BOX of the ENTIRE PHYSICAL PRINTED CARDBOARD CARD ITSELF.
3. EXCLUDE AND STRIP AWAY:
   - Any clear transparent penny sleeve plastic overhangs, seams, or flaps extending outside the card
   - Any top loader frames or magnetic case edges
   - Scanner bed white/grey glass borders, outer background scenery, or shadows
   - Any glare lines on the plastic sleeve outside the printed card borders
4. The bounding box ("box_2d") MUST wrap the ENTIRE physical cardboard card from outer border to outer border (including top name/HP bar and bottom copyright / set code line)!
5. "illustration_box": Locate the inner artwork illustration area inside the card frame (excluding card text, HP, power, and borders).
6. "cardName": Extract official English name (translate Japanese e.g. 'ワンパチ' -> 'Yamper', 'シルシュルー' -> 'Shroodle').
7. "cardNumber": Card sequence number (e.g. '086/080', '151/165', 'OP05-119').
8. "setCode": Set registration code (e.g. 'SV8', 'M2', 'SV1L', 'OP05').
9. "setName": Official English set name (e.g. 'Supercharged Breaker', 'Violet ex').
10. "sceneryDescription": Vivid description of the environmental scenery, art style, lighting, and colors of the card illustration. Exclude any characters, pokemon, humans, text, or card borders.
11. "hasSampleWatermark": True if a diagonal semi-transparent 'SAMPLE' watermark exists.`;

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
                  box_2d: {
                    type: "ARRAY",
                    items: { type: "INTEGER" },
                    description: "Bounding box of the physical trading card as [ymin, xmin, ymax, xmax] integers normalized 0 to 1000."
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
                required: ["box_2d", "cardName", "cardNumber"]
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

        if (parsed.box_2d && Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
          const [ymin, xmin, ymax, xmax] = parsed.box_2d.map(Number);
          const aiX1 = Math.round((xmin / 1000) * width);
          const aiY1 = Math.round((ymin / 1000) * height);
          const aiX2 = Math.round((xmax / 1000) * width);
          const aiY2 = Math.round((ymax / 1000) * height);

          if (aiX2 > aiX1 + 50 && aiY2 > aiY1 + 50) {
            cardCoords = { x1: aiX1, y1: aiY1, x2: aiX2, y2: aiY2 };
            const detectedW = aiX2 - aiX1;
            const detectedH = aiY2 - aiY1;
            console.log(`[Card Cutout] Gemini Vision successfully detected card: [${aiX1}, ${aiY1}, ${aiX2}, ${aiY2}] (${detectedW}x${detectedH}, ratio ${(detectedH / detectedW).toFixed(3)})`);
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

  // 4. Inward Border Refinement & Sleeve Stripping
  try {
    const { data: greyData } = await sharp(normalizedBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const refined = refineCardCutoutBorders(greyData, width, height, cardCoords);
    console.log(`[Card Cutout] Sleeve-stripped cardboard coordinates: [${refined.x1}, ${refined.y1}, ${refined.x2}, ${refined.y2}]`);
    cardCoords = refined;
  } catch (refineErr: any) {
    console.warn("[Card Cutout] Border refinement skipped:", refineErr?.message || refineErr);
  }

  // 5. Mathematical TCG Aspect Ratio Guard
  // Physical TCG standards: 63mm x 88mm = ratio 1.3968 (Western / Japanese Standard)
  // 59mm x 86mm = ratio 1.4576 (Japanese Small / Yu-Gi-Oh)
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
    console.log("[Card Cutout] Genuine edge-to-edge card scan detected.");
    cardCoords = { x1: 0, y1: 0, x2: width, y2: height };
  } else {
    // If card is too short in height (ratio < 1.36), protect copyright & set text
    if (ratio < 1.36) {
      const expectedH = Math.round(rawW * 1.397);
      let newY2 = Math.min(height, cardCoords.y1 + expectedH);
      let newY1 = cardCoords.y1;
      if (newY2 - newY1 < expectedH) {
        newY1 = Math.max(0, newY2 - expectedH);
      }
      console.log(`[Card Cutout] Aspect ratio guard: adjusted height from ${rawH} to ${newY2 - newY1} (ratio 1.397) to protect copyright.`);
      cardCoords.y1 = newY1;
      cardCoords.y2 = newY2;
    } else if (ratio > 1.47) {
      // If card is too narrow in width (ratio > 1.47), expand symmetrically from center to protect HP & borders
      const expectedW = Math.round(rawH / 1.397);
      const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
      const newX1 = Math.max(0, Math.round(centerX - expectedW / 2));
      const newX2 = Math.min(width, Math.round(centerX + expectedW / 2));
      console.log(`[Card Cutout] Aspect ratio guard: adjusted width from ${rawW} to ${newX2 - newX1} (ratio 1.397) to protect HP & borders.`);
      cardCoords.x1 = newX1;
      cardCoords.x2 = newX2;
    }
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

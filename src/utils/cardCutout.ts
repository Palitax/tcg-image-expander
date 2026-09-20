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
 * Robust Computer-Vision fallback for edge detection on scanned cards.
 * Specifically handles transparent penny sleeves and scanner beds by searching for
 * significant gradient ridges (card borders) and enforcing TCG physical aspect ratios.
 */
async function detectCardBordersCV(
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
    const ySpan = Math.max(1, yMidEnd - yMidStart);

    // 1. Scan Left: search inward from x=6 to 30% of width
    let leftX = 0;
    for (let x = 6; x < Math.floor(width * 0.3); x++) {
      let grad = 0;
      for (let y = yMidStart; y < yMidEnd; y++) {
        grad += Math.abs(data[y * width + (x + 1)] - data[y * width + (x - 1)]);
      }
      grad /= ySpan;
      // Sleeve reflection ridges are faint (<15); cardboard borders spike (>20)
      if (grad > 20) {
        let bestPeak = grad;
        let peakX = x;
        for (let lookahead = 1; lookahead <= 6; lookahead++) {
          const curX = x + lookahead;
          if (curX >= width - 2) break;
          let curGrad = 0;
          for (let y = yMidStart; y < yMidEnd; y++) {
            curGrad += Math.abs(data[y * width + (curX + 1)] - data[y * width + (curX - 1)]);
          }
          curGrad /= ySpan;
          if (curGrad > bestPeak) {
            bestPeak = curGrad;
            peakX = curX;
          }
        }
        leftX = peakX;
        break;
      }
    }

    // 2. Scan Right: search inward from right edge
    let rightX = width;
    for (let x = width - 7; x > Math.floor(width * 0.7); x--) {
      let grad = 0;
      for (let y = yMidStart; y < yMidEnd; y++) {
        grad += Math.abs(data[y * width + (x + 1)] - data[y * width + (x - 1)]);
      }
      grad /= ySpan;
      if (grad > 20) {
        let bestPeak = grad;
        let peakX = x;
        for (let lookahead = 1; lookahead <= 6; lookahead++) {
          const curX = x - lookahead;
          if (curX <= 1) break;
          let curGrad = 0;
          for (let y = yMidStart; y < yMidEnd; y++) {
            curGrad += Math.abs(data[y * width + (curX + 1)] - data[y * width + (curX - 1)]);
          }
          curGrad /= ySpan;
          if (curGrad > bestPeak) {
            bestPeak = curGrad;
            peakX = curX;
          }
        }
        rightX = peakX;
        break;
      }
    }

    // 3. Scan Bottom: search inward from bottom edge
    const xMidStart = Math.round(width * 0.25);
    const xMidEnd = Math.round(width * 0.75);
    const xSpan = Math.max(1, xMidEnd - xMidStart);

    let bottomY = height;
    for (let y = height - 7; y > Math.floor(height * 0.75); y--) {
      let grad = 0;
      for (let x = xMidStart; x < xMidEnd; x++) {
        grad += Math.abs(data[(y + 1) * width + x] - data[(y - 1) * width + x]);
      }
      grad /= xSpan;
      if (grad > 18) {
        let bestPeak = grad;
        let peakY = y;
        for (let lookahead = 1; lookahead <= 6; lookahead++) {
          const curY = y - lookahead;
          if (curY <= 1) break;
          let curGrad = 0;
          for (let x = xMidStart; x < xMidEnd; x++) {
            curGrad += Math.abs(data[(curY + 1) * width + x] - data[(curY - 1) * width + x]);
          }
          curGrad /= ySpan;
          if (curGrad > bestPeak) {
            bestPeak = curGrad;
            peakY = curY;
          }
        }
        bottomY = peakY;
        break;
      }
    }

    // Determine top based on card width and physical TCG aspect ratio (~1.40 - 1.45)
    let cardW = rightX - leftX;
    if (cardW < width * 0.4) {
      // Fallback if width too small
      leftX = 0;
      rightX = width;
      cardW = width;
    }

    const expectedH = Math.round(cardW * 1.415);
    let topY = Math.max(0, bottomY - expectedH);

    // Fine-tune top edge around expected topY
    let bestTopY = topY;
    let maxTopGrad = 0;
    for (let y = Math.max(4, topY - 18); y <= Math.min(height - 2, topY + 18); y++) {
      let grad = 0;
      for (let x = xMidStart; x < xMidEnd; x++) {
        grad += Math.abs(data[(y + 1) * width + x] - data[(y - 1) * width + x]);
      }
      grad /= xSpan;
      if (grad > maxTopGrad && grad > 14) {
        maxTopGrad = grad;
        bestTopY = y;
      }
    }
    topY = bestTopY;

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
 * Universal Card Cutout Engine:
 * Analyzes an image of any trading card (even in clear penny sleeves, toploaders, or on scanner beds),
 * identifies the exact physical cardboard boundaries, and extracts a die-cut rounded-corner cutout
 * along with the inner illustration area for outpainting.
 */
export async function extractCardCutout(
  imageBuffer: Buffer,
  options: ExtractCardCutoutOptions = {}
): Promise<CardCutoutResult> {
  const {
    apiKey,
    skipCardCrop = false,
    cornerRadiusPercent = 0.035,
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

  // 2. Gemini AI Vision Detection (if apiKey available)
  if (apiKey && apiKey.trim()) {
    try {
      // Create a lightweight 1024px working copy for Gemini Vision to ensure fast, sub-2s responses
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
2. YOU MUST LOCATE THE EXACT BOUNDING BOX of the PHYSICAL PRINTED CARDBOARD CARD ITSELF.
3. EXCLUDE AND STRIP AWAY:
   - Any clear transparent penny sleeve plastic overhangs, seams, or flaps extending outside the card
   - Any top loader frames or magnetic case edges
   - Scanner bed white/grey glass borders, outer background scenery, or shadows
   - Any glare lines on the plastic sleeve outside the printed card borders
4. The bounding box ("box_2d") MUST wrap the entire printed card from outer border to outer border (including top name bar and bottom copyright / set code line)!
5. "illustration_box": Locate the inner artwork illustration area inside the card frame (excluding card text, HP, power, and borders).
6. "cardName": Extract official English name (translate Japanese e.g. 'ワンパチ' -> 'Yamper').
7. "cardNumber": Card sequence number (e.g. '086/080', '151/165', 'OP05-119').
8. "setCode": Set registration code (e.g. 'SV8', 'M2', 'SV2a', 'OP05').
9. "setName": Official English set name (e.g. 'Supercharged Breaker', 'Battle Partners').
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
          cardCoords = {
            x1: Math.round((xmin / 1000) * width),
            y1: Math.round((ymin / 1000) * height),
            x2: Math.round((xmax / 1000) * width),
            y2: Math.round((ymax / 1000) * height)
          };
          console.log(`[Card Cutout] AI box_2d [${ymin}, ${xmin}, ${ymax}, ${xmax}] -> exact pixels:`, cardCoords);
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

  // 3. Fallback to Robust CV edge detector if AI did not return coordinates
  if (!cardCoords) {
    console.warn("[Card Cutout] Using robust CV edge detector fallback.");
    usedFallback = true;
    cardCoords = await detectCardBordersCV(normalizedBuffer, width, height);
  }

  // 4. Validate and sanitize coordinates
  let rawW = cardCoords.x2 - cardCoords.x1;
  let rawH = cardCoords.y2 - cardCoords.y1;

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
    // Physical aspect ratio validation: TCG cards are ~1.397 to 1.458 (height/width)
    let adjX1 = cardCoords.x1;
    let adjY1 = cardCoords.y1;
    let adjX2 = cardCoords.x2;
    let adjY2 = cardCoords.y2;

    if (rawH < rawW * 1.38) {
      const expectedH = Math.round(rawW * 1.415);
      adjY2 = Math.min(height, adjY1 + expectedH);
      if (adjY2 - adjY1 < expectedH) {
        adjY1 = Math.max(0, adjY2 - expectedH);
      }
      console.log(`[Card Cutout] Adjusted height from ${rawH} to ${adjY2 - adjY1} (ratio 1.415) to prevent copyright clipping.`);
    }

    cardCoords = {
      x1: Math.max(0, adjX1),
      y1: Math.max(0, adjY1),
      x2: Math.min(width, adjX2),
      y2: Math.min(height, adjY2)
    };
  }

  // Strict boundary clamping
  const cx1 = Math.max(0, Math.min(cardCoords.x1, width - 1));
  const cy1 = Math.max(0, Math.min(cardCoords.y1, height - 1));
  const cx2 = Math.max(cx1 + 10, Math.min(cardCoords.x2, width));
  const cy2 = Math.max(cy1 + 10, Math.min(cardCoords.y2, height));

  const extractW = cx2 - cx1;
  const extractH = cy2 - cy1;

  console.log(`[Card Cutout] Final card extraction: [${cx1}, ${cy1}, ${cx2}, ${cy2}] (${extractW}x${extractH})`);

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
  let ix1 = illustrationCoords?.x1 ?? Math.round(cx1 + extractW * 0.1);
  let iy1 = illustrationCoords?.y1 ?? Math.round(cy1 + extractH * 0.12);
  let ix2 = illustrationCoords?.x2 ?? Math.round(cx1 + extractW * 0.9);
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

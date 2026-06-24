import { NextResponse } from "next/server";
import sharp from "sharp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { originalImage, backgroundImage } = await request.json();

    if (!originalImage || !backgroundImage) {
      return NextResponse.json({ error: "Missing originalImage or backgroundImage base64 data." }, { status: 400 });
    }

    // Extract raw base64 data
    const originalBase64 = originalImage.includes(",") ? originalImage.split(",")[1] : originalImage;
    const backgroundBase64 = backgroundImage.includes(",") ? backgroundImage.split(",")[1] : backgroundImage;

    const originalImageBuffer = Buffer.from(originalBase64, "base64");
    const backgroundBuffer = Buffer.from(backgroundBase64, "base64");

    // Get original image metadata
    const originalMetadata = await sharp(originalImageBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Failed to read original image dimensions." }, { status: 400 });
    }

    // Get background image metadata
    const bgMetadata = await sharp(backgroundBuffer).metadata();
    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;

    const shadowPadding = 45;

    // Scale original card to fit beautifully with margins
    const maxScaleFactor = 0.75; // Card takes up at most 75% of background dimensions
    let maxCardWidth = Math.round(bgWidth * maxScaleFactor) - shadowPadding * 2;
    let maxCardHeight = Math.round(bgHeight * maxScaleFactor) - shadowPadding * 2;

    // Ensure we don't end up with negative dimensions
    maxCardWidth = Math.max(100, maxCardWidth);
    maxCardHeight = Math.max(100, maxCardHeight);

    const cardRatio = width / height;
    let targetCardHeight = maxCardHeight;
    let targetCardWidth = Math.round(targetCardHeight * cardRatio);

    if (targetCardWidth > maxCardWidth) {
      targetCardWidth = maxCardWidth;
      targetCardHeight = Math.round(targetCardWidth / cardRatio);
    }

    let shadowWidth = targetCardWidth + shadowPadding * 2;
    let shadowHeight = targetCardHeight + shadowPadding * 2;

    // Hard constraint safety check: if shadow width/height is larger than background, scale down further
    if (shadowWidth > bgWidth || shadowHeight > bgHeight) {
      const scaleW = bgWidth / shadowWidth;
      const scaleH = bgHeight / shadowHeight;
      const scale = Math.min(scaleW, scaleH) * 0.95; // 5% extra safety margin

      targetCardWidth = Math.max(50, Math.round(targetCardWidth * scale));
      targetCardHeight = Math.max(50, Math.round(targetCardHeight * scale));
      shadowWidth = targetCardWidth + shadowPadding * 2;
      shadowHeight = targetCardHeight + shadowPadding * 2;
    }

    const resizedCard = await sharp(originalImageBuffer)
      .resize(targetCardWidth, targetCardHeight)
      .png() // Force to PNG format
      .toBuffer();

    const innerShadowInput = await sharp({
      create: {
        width: targetCardWidth,
        height: targetCardHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.5 } // soft dark shadow
      }
    })
    .png() // Must output as PNG to be a valid input format in composite
    .toBuffer();

    const cardShadow = await sharp({
      create: {
        width: shadowWidth,
        height: shadowHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([
      {
        input: innerShadowInput,
        top: shadowPadding,
        left: shadowPadding
      }
    ])
    .blur(22) // Gaussian blur for soft shadow
    .png() // Must output as PNG to be a valid input format in the next step
    .toBuffer();

    // Overlay resized card over the shadow
    const cardWithShadow = await sharp(cardShadow)
      .composite([
        {
          input: resizedCard,
          top: shadowPadding,
          left: shadowPadding
        }
      ])
      .png() // Must output as PNG
      .toBuffer();

    // Overlay card + shadow in center of the background
    const finalTop = Math.round((bgHeight - shadowHeight) / 2);
    const finalLeft = Math.round((bgWidth - shadowWidth) / 2);

    const finalResultBuffer = await sharp(backgroundBuffer)
      .composite([
        {
          input: cardWithShadow,
          top: finalTop,
          left: finalLeft
        }
      ])
      .png()
      .toBuffer();

    const finalBase64 = finalResultBuffer.toString("base64");

    return NextResponse.json({
      resultImageUrl: `data:image/png;base64,${finalBase64}`
    });

  } catch (error: any) {
    console.error("Error in Merge API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during merge." }, { status: 500 });
  }
}

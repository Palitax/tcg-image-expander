import { NextResponse } from "next/server";
import sharp from "sharp";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { cardImage, backgroundImage } = await request.json();

    if (!cardImage) {
      return NextResponse.json(
        { error: "Missing cardImage base64 data." },
        { status: 400 }
      );
    }

    let cardBuffer: Buffer;
    if (cardImage.startsWith("http://") || cardImage.startsWith("https://")) {
      const res = await fetch(cardImage);
      if (!res.ok) {
        return NextResponse.json(
          { error: `Failed to fetch cardImage from storage: ${res.statusText}` },
          { status: 500 }
        );
      }
      cardBuffer = Buffer.from(await res.arrayBuffer());
    } else {
      const cardBase64 = cardImage.includes(",") ? cardImage.split(",")[1] : cardImage;
      cardBuffer = Buffer.from(cardBase64, "base64");
    }

    let backgroundBuffer: Buffer;
    if (backgroundImage) {
      if (backgroundImage.startsWith("http://") || backgroundImage.startsWith("https://")) {
        const res = await fetch(backgroundImage);
        if (!res.ok) {
          return NextResponse.json(
            { error: `Failed to fetch backgroundImage from storage: ${res.statusText}` },
            { status: 500 }
          );
        }
        backgroundBuffer = Buffer.from(await res.arrayBuffer());
      } else {
        const backgroundBase64 = backgroundImage.includes(",") ? backgroundImage.split(",")[1] : backgroundImage;
        backgroundBuffer = Buffer.from(backgroundBase64, "base64");
      }

      // Apply a light blur (5px) to distinguish the foreground case/card from the background
      backgroundBuffer = await sharp(backgroundBuffer)
        .blur(5)
        .toBuffer();
    } else {
      // Generate a blurred background from the card itself (ambient background)
      backgroundBuffer = await sharp(cardBuffer)
        .resize(1024, 1024, { fit: "cover" })
        .blur(40)
        .png()
        .toBuffer();
    }

    // Load transparent case template from public directory
    const casePath = path.join(process.cwd(), "public", "card-case-transparent.png");
    if (!fs.existsSync(casePath)) {
      return NextResponse.json(
        { error: "Transparent case asset not found on the server. Please run the generation script first." },
        { status: 500 }
      );
    }
    const caseTemplateBuffer = fs.readFileSync(casePath);

    // Get background dimensions
    const bgMetadata = await sharp(backgroundBuffer).metadata();
    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;

    // Original dimensions of card-case-transparent.png
    const origCaseWidth = 681;
    const origCaseHeight = 1024;

    // Scale case to fit beautifully in the background (max 80% of background height/width to leave room for shadow)
    const paddingMultiplier = 0.80;
    const maxCaseWidth = Math.round(bgWidth * paddingMultiplier);
    const maxCaseHeight = Math.round(bgHeight * paddingMultiplier);

    const scale = Math.min(maxCaseWidth / origCaseWidth, maxCaseHeight / origCaseHeight);

    const targetCaseWidth = Math.max(100, Math.round(origCaseWidth * scale));
    const targetCaseHeight = Math.max(150, Math.round(origCaseHeight * scale));

    // Calculate scaled slot bounds (original slot: Left=144, Top=231, Width=411, Height=579)
    const targetSlotLeft = Math.round(144 * scale);
    const targetSlotTop = Math.round(231 * scale);
    const targetSlotWidth = Math.round(411 * scale);
    const targetSlotHeight = Math.round(579 * scale);

    // Resize case and card
    const resizedCase = await sharp(caseTemplateBuffer)
      .resize(targetCaseWidth, targetCaseHeight)
      .png()
      .toBuffer();

    const resizedCard = await sharp(cardBuffer)
      .resize(targetSlotWidth, targetSlotHeight, { fit: "fill" })
      .png()
      .toBuffer();

    // Composite card inside case
    // Create transparent overlay canvas
    const caseWithCardBuffer = await sharp({
      create: {
        width: targetCaseWidth,
        height: targetCaseHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([
      {
        input: resizedCard,
        top: targetSlotTop,
        left: targetSlotLeft
      },
      {
        input: resizedCase,
        top: 0,
        left: 0
      }
    ])
    .png()
    .toBuffer();

    // Create shadow mask with rounded corners to match the case geometry (approx 4.5% corner radius)
    const caseCornerRadius = Math.round(targetCaseWidth * 0.045);
    const shadowPadding = 20; // small padding for tight shadow
    const shadowSvg = Buffer.from(
      `<svg width="${targetCaseWidth}" height="${targetCaseHeight}"><rect x="0" y="0" width="${targetCaseWidth}" height="${targetCaseHeight}" rx="${caseCornerRadius}" ry="${caseCornerRadius}" fill="black" fill-opacity="0.35"/></svg>`
    );

    const shadowWidth = targetCaseWidth + shadowPadding * 2;
    const shadowHeight = targetCaseHeight + shadowPadding * 2;

    const caseShadow = await sharp({
      create: {
        width: shadowWidth,
        height: shadowHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([
      {
        input: shadowSvg,
        top: shadowPadding + 3, // slight offset down
        left: shadowPadding + 3  // slight offset right
      }
    ])
    .blur(8) // Tight, small blur (reduced by 50%+ for crisp shadow)
    .png()
    .toBuffer();

    // Composite the case+card on top of the shadow
    const caseWithShadow = await sharp(caseShadow)
      .composite([
        {
          input: caseWithCardBuffer,
          top: shadowPadding,
          left: shadowPadding
        }
      ])
      .png()
      .toBuffer();

    // Center the final composite with shadow on the outpainted background
    const finalTop = Math.round((bgHeight - shadowHeight) / 2);
    const finalLeft = Math.round((bgWidth - shadowWidth) / 2);

    const finalResultBuffer = await sharp(backgroundBuffer)
      .composite([
        {
          input: caseWithShadow,
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

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error in Case compositing API:", error);
    return NextResponse.json(
      { error: message || "Internal server error during case rendering." },
      { status: 500 }
    );
  }
}

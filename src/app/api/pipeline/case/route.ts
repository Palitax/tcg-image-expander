import { NextResponse } from "next/server";
import sharp from "sharp";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { cardImage, backgroundImage, aspectRatio } = await request.json();

    if (!cardImage || !backgroundImage) {
      return NextResponse.json(
        { error: "Missing cardImage or backgroundImage base64 data." },
        { status: 400 }
      );
    }

    // Extract raw base64 data
    const cardBase64 = cardImage.includes(",") ? cardImage.split(",")[1] : cardImage;
    const backgroundBase64 = backgroundImage.includes(",") ? backgroundImage.split(",")[1] : backgroundImage;

    const cardBuffer = Buffer.from(cardBase64, "base64");
    const backgroundBuffer = Buffer.from(backgroundBase64, "base64");

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

    // Scale case to fit beautifully in the background (max 85% of background height/width)
    const paddingMultiplier = 0.85;
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

    // Create drop shadow for the case (case has rounded corners, radius ~ 4.5% of width)
    const caseCornerRadius = Math.round(targetCaseWidth * 0.045);
    const shadowPadding = Math.round(35 * scale); // Responsive shadow padding
    const shadowWidth = targetCaseWidth + shadowPadding * 2;
    const shadowHeight = targetCaseHeight + shadowPadding * 2;

    const caseShadowSvg = Buffer.from(
      `<svg width="${targetCaseWidth}" height="${targetCaseHeight}"><rect x="0" y="0" width="${targetCaseWidth}" height="${targetCaseHeight}" rx="${caseCornerRadius}" ry="${caseCornerRadius}" fill="black" fill-opacity="0.35"/></svg>`
    );

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
        input: caseShadowSvg,
        top: shadowPadding,
        left: shadowPadding
      }
    ])
    .blur(Math.max(5, Math.round(18 * scale))) // Responsive blur radius
    .png()
    .toBuffer();

    // Composite case with card onto shadow
    const caseWithShadowBuffer = await sharp(caseShadow)
      .composite([
        {
          input: caseWithCardBuffer,
          top: shadowPadding,
          left: shadowPadding
        }
      ])
      .png()
      .toBuffer();

    // Center the final composite on the outpainted background
    const finalTop = Math.round((bgHeight - shadowHeight) / 2);
    const finalLeft = Math.round((bgWidth - shadowWidth) / 2);

    const finalResultBuffer = await sharp(backgroundBuffer)
      .composite([
        {
          input: caseWithShadowBuffer,
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
    console.error("Error in Case compositing API:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error during case rendering." },
      { status: 500 }
    );
  }
}

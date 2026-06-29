import { NextResponse } from "next/server";
import sharp from "sharp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { displayCutout, backgroundImage } = await request.json();

    if (!displayCutout || !backgroundImage) {
      return NextResponse.json(
        { error: "Missing displayCutout or backgroundImage base64 data." },
        { status: 400 }
      );
    }

    // Extract raw base64 data
    const cutoutBase64 = displayCutout.includes(",") ? displayCutout.split(",")[1] : displayCutout;
    const backgroundBase64 = backgroundImage.includes(",") ? backgroundImage.split(",")[1] : backgroundImage;

    const cutoutBuffer = Buffer.from(cutoutBase64, "base64");
    const backgroundBuffer = Buffer.from(backgroundBase64, "base64");

    // Get dimensions of display cutout
    const cutoutMetadata = await sharp(cutoutBuffer).metadata();
    const cutoutWidth = cutoutMetadata.width || 0;
    const cutoutHeight = cutoutMetadata.height || 0;

    if (cutoutWidth === 0 || cutoutHeight === 0) {
      return NextResponse.json({ error: "Failed to read display cutout dimensions." }, { status: 400 });
    }

    // Get background image metadata
    const bgMetadata = await sharp(backgroundBuffer).metadata();
    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;

    const shadowPadding = 40;

    // Scale display cutout to fit beautifully on the background (max 70% of dimensions)
    const maxScaleFactor = 0.70;
    let maxCutoutWidth = Math.round(bgWidth * maxScaleFactor) - shadowPadding * 2;
    let maxCutoutHeight = Math.round(bgHeight * maxScaleFactor) - shadowPadding * 2;

    // Ensure dimensions are positive
    maxCutoutWidth = Math.max(100, maxCutoutWidth);
    maxCutoutHeight = Math.max(100, maxCutoutHeight);

    const cutoutRatio = cutoutWidth / cutoutHeight;
    let targetWidth = maxCutoutWidth;
    let targetHeight = Math.round(targetWidth / cutoutRatio);

    if (targetHeight > maxCutoutHeight) {
      targetHeight = maxCutoutHeight;
      targetWidth = Math.round(targetHeight * cutoutRatio);
    }

    // Resize the transparent cutout
    const resizedCutout = await sharp(cutoutBuffer)
      .resize(targetWidth, targetHeight)
      .png()
      .toBuffer();

    // Create shadow mask / silhouette by overlaying semi-transparent black over the cutout's alpha channel
    const shadowOpacityBuffer = await sharp({
      create: {
        width: targetWidth,
        height: targetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.35 } // soft dark shadow
      }
    })
    .composite([{
      input: resizedCutout,
      blend: "dest-in"
    }])
    .png()
    .toBuffer();

    // Pad the shadow so it has room to blur without clipping at the edges
    const paddedWidth = targetWidth + shadowPadding * 2;
    const paddedHeight = targetHeight + shadowPadding * 2;

    const shadowBlurBuffer = await sharp({
      create: {
        width: paddedWidth,
        height: paddedHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([{
      input: shadowOpacityBuffer,
      top: shadowPadding,
      left: shadowPadding
    }])
    .blur(25) // Gaussian blur for soft shadow
    .png()
    .toBuffer();

    // Offset the shadow slightly down to create a realistic 3D floating effect
    const shadowOffsetX = 0;
    const shadowOffsetY = 15; // Move shadow down relative to cutout

    const displayWithShadow = await sharp({
      create: {
        width: paddedWidth,
        height: paddedHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([
      {
        input: shadowBlurBuffer,
        top: shadowOffsetY,
        left: shadowOffsetX
      },
      {
        input: resizedCutout,
        top: shadowPadding,
        left: shadowPadding
      }
    ])
    .png()
    .toBuffer();

    // Overlay final display box + shadow centered on the background
    const finalTop = Math.round((bgHeight - paddedHeight) / 2);
    const finalLeft = Math.round((bgWidth - paddedWidth) / 2);

    const finalResultBuffer = await sharp(backgroundBuffer)
      .composite([{
        input: displayWithShadow,
        top: finalTop,
        left: finalLeft
      }])
      .png()
      .toBuffer();

    const finalBase64 = finalResultBuffer.toString("base64");

    return NextResponse.json({
      resultImageUrl: `data:image/png;base64,${finalBase64}`
    });

  } catch (error: any) {
    console.error("Error in Display Merge API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during display merge." }, { status: 500 });
  }
}

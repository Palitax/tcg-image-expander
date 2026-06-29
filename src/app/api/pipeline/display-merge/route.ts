import { NextResponse } from "next/server";
import sharp from "sharp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { 
      displayCutout, 
      backgroundImage,
      watermarkImage,
      watermarkPosition = "bottom-center",
      watermarkOpacity = 0.33,
      watermarkScale = 0.15
    } = await request.json();

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

    // Process optional watermark overlay
    let watermarkOverlay: any = null;
    if (watermarkImage) {
      try {
        const watermarkBase64 = watermarkImage.includes(",") ? watermarkImage.split(",")[1] : watermarkImage;
        const watermarkBuffer = Buffer.from(watermarkBase64, "base64");
        
        // Get watermark metadata
        const watermarkMeta = await sharp(watermarkBuffer).metadata();
        const wmWidth = watermarkMeta.width || 0;
        const wmHeight = watermarkMeta.height || 0;

        if (wmWidth > 0 && wmHeight > 0) {
          const wmRatio = wmWidth / wmHeight;
          const targetWmWidth = Math.round(bgWidth * watermarkScale);
          const targetWmHeight = Math.round(targetWmWidth / wmRatio);

          // Resize watermark
          let resizedWm = await sharp(watermarkBuffer)
            .resize(targetWmWidth, targetWmHeight)
            .png()
            .toBuffer();

          // Apply opacity: composite with solid color of specified alpha using blend "dest-in"
          const opacityAlpha = Math.round(watermarkOpacity * 255);
          resizedWm = await sharp(resizedWm)
            .ensureAlpha()
            .composite([{
              input: Buffer.from([0, 0, 0, opacityAlpha]),
              raw: { width: 1, height: 1, channels: 4 },
              tile: true,
              blend: "dest-in"
            }])
            .png()
            .toBuffer();

          // Calculate coordinates based on watermarkPosition
          let wmLeft = Math.round((bgWidth - targetWmWidth) / 2);
          let wmTop = bgHeight - targetWmHeight - Math.round(bgHeight * 0.05); // default bottom-center

          if (watermarkPosition === "bottom-right") {
            wmLeft = bgWidth - targetWmWidth - Math.round(bgWidth * 0.05);
            wmTop = bgHeight - targetWmHeight - Math.round(bgHeight * 0.05);
          } else if (watermarkPosition === "bottom-left") {
            wmLeft = Math.round(bgWidth * 0.05);
            wmTop = bgHeight - targetWmHeight - Math.round(bgHeight * 0.05);
          } else if (watermarkPosition === "top-left") {
            wmLeft = Math.round(bgWidth * 0.05);
            wmTop = Math.round(bgHeight * 0.05);
          } else if (watermarkPosition === "top-right") {
            wmLeft = bgWidth - targetWmWidth - Math.round(bgWidth * 0.05);
            wmTop = Math.round(bgHeight * 0.05);
          } else if (watermarkPosition === "center") {
            wmLeft = Math.round((bgWidth - targetWmWidth) / 2);
            wmTop = Math.round((bgHeight - targetWmHeight) / 2);
          }

          watermarkOverlay = {
            input: resizedWm,
            left: wmLeft,
            top: wmTop
          };
        }
      } catch (wmError: any) {
        console.warn("[Display Merge API] Watermark overlay failed:", wmError.message);
      }
    }

    // Overlay final display box + shadow centered on the background
    const finalTop = Math.round((bgHeight - paddedHeight) / 2);
    const finalLeft = Math.round((bgWidth - paddedWidth) / 2);

    const compositeArray: any[] = [{
      input: displayWithShadow,
      top: finalTop,
      left: finalLeft
    }];

    if (watermarkOverlay) {
      compositeArray.push(watermarkOverlay);
    }

    const finalResultBuffer = await sharp(backgroundBuffer)
      .composite(compositeArray)
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

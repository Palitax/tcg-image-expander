import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const diagnostics: Record<string, any> = {
    nodeVersion: process.version,
    arch: process.arch,
    platform: process.platform,
    cwd: process.cwd(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_REGION: process.env.VERCEL_REGION,
    }
  };

  try {
    const sharp = require("sharp");
    diagnostics.sharpLoaded = true;
    diagnostics.sharpVersion = sharp.versions;
    
    const testBuf = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
    }).png().toBuffer();
    diagnostics.sharpTestSuccess = testBuf.length > 0;
  } catch (sharpError: any) {
    diagnostics.sharpLoaded = false;
    diagnostics.sharpError = sharpError?.message || String(sharpError);
    diagnostics.sharpStack = sharpError?.stack;
  }

  return NextResponse.json(diagnostics);
}

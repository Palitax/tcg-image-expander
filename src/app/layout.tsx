import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TCG Art Studio | Premium Card Expander & Product Showcase",
  description: "Transform your trading card game illustrations into seamless, immersive portrait or square art assets. Perfect for web shops and collections. Powered by Gemini 3.5 Flash and Imagen 3.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-[#030303] text-zinc-150 font-sans selection:bg-purple-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}

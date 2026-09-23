/**
 * Schnelle Berechnung eines kryptographischen SHA-256 Fingerabdrucks (Hash)
 * einer Datei im Browser mittels der nativen Web Crypto API.
 */
export async function calculateFileHash(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (err) {
    console.warn("Fehler bei SHA-256 Hash-Berechnung, nutze Fallback-Signatur:", err);
    // Fallback: Signatur aus Name, Größe und Änderungsdatum
    return `fallback_${file.name.replace(/\s+/g, "_")}_${file.size}_${file.lastModified}`;
  }
}

/**
 * Erzeugt einen schnellen Identifikationsschlüssel (Name + Dateigröße)
 */
export function getFileFallbackKey(file: File): string {
  return `${file.name.trim()}_${file.size}`;
}

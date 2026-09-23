import { CropBox } from "@/components/CardCropVisor";

export interface StreamCardSide {
  id: string;
  file: File;
  previewUrl: string;
  cropBox: CropBox | null;
  isVisorCustomized?: boolean;
  status: "pending" | "processing" | "completed" | "failed";
  progressMsg?: string;
  resultImageUrl?: string;
  cutoutImageUrl?: string;
  backgroundImageUrl?: string;
  error?: string;
  isSaved?: boolean;
  fileHash?: string;
  fallbackKey?: string;
  metadata?: {
    cardName: string;
    cardNumber: string;
    setCode: string;
    setName: string;
    slogan?: string;
  };
}

export interface StreamBatchCard {
  id: string;
  cardNumberIndex: number; // 1, 2, ...
  cardName: string;        // z. B. "Karte 01" oder "Glurak"
  front: StreamCardSide;
  back?: StreamCardSide | null;
  isSaved?: boolean;
}

/**
 * Normalisiert Dateinamen für den Vergleich und entfernt typische Bildendungen.
 */
export function getBaseFileName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "").trim();
}

/**
 * Bereinigt einen Dateinamen zu einem sicheren Dateinamen für Downloads.
 */
export function sanitizeCardFileName(name: string, fallback = "Karte"): string {
  if (!name || !name.trim()) return fallback;
  return name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

export type DuplexScanOrder = "alternating" | "stack";

interface FileClassification {
  file: File;
  baseName: string;
  side: "front" | "back" | "unknown";
  coreKey: string;
}

const FRONT_PATTERNS = [
  /([_\-\s]|^)front([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vorderseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vorne([_\-\s]|\d|$)/i,
  /([_\-\s]|^)recto([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vs([_\-\s]|\d|$)/i,
  /[_\-\s](f|a)$/i
];

const BACK_PATTERNS = [
  /([_\-\s]|^)back([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rueckseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rückseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)hinten([_\-\s]|\d|$)/i,
  /([_\-\s]|^)verso([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rs([_\-\s]|\d|$)/i,
  /[_\-\s]b$/i
];

/**
 * Erkennt, ob ein Dateiname explizit als Vorderseite oder Rückseite gekennzeichnet ist,
 * und extrahiert den gemeinsamen Kern (coreKey).
 */
function classifyFile(file: File): FileClassification {
  const base = getBaseFileName(file.name);

  // 1. Prüfe auf Vorderseite-Muster
  for (const pattern of FRONT_PATTERNS) {
    if (pattern.test(base)) {
      const core = base.replace(pattern, " ").replace(/\s+/g, " ").trim();
      return { file, baseName: base, side: "front", coreKey: core.toLowerCase() || base.toLowerCase() };
    }
  }

  // 2. Prüfe auf Rückseite-Muster
  for (const pattern of BACK_PATTERNS) {
    if (pattern.test(base)) {
      const core = base.replace(pattern, " ").replace(/\s+/g, " ").trim();
      return { file, baseName: base, side: "back", coreKey: core.toLowerCase() || base.toLowerCase() };
    }
  }

  // 3. Unbekannt / keine expliziten Marker
  return { file, baseName: base, side: "unknown", coreKey: base.toLowerCase() };
}

/**
 * Natürliche Sortierung (z.B. img1, img2, img10 in richtiger numerischer Reihenfolge).
 */
function naturalSortFiles(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
}

/**
 * Erstellt eine Standard-StreamCardSide für eine Datei.
 */
function createCardSide(file: File): StreamCardSide {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
    file,
    previewUrl: URL.createObjectURL(file),
    cropBox: null,
    isVisorCustomized: false,
    status: "pending",
    isSaved: false
  };
}

/**
 * Erzeugt eine formatiert lesbare Kartennummer (z. B. "01", "02", ...).
 */
function formatCardIndex(idx: number): string {
  return idx < 10 ? `0${idx}` : `${idx}`;
}

/**
 * Analysiert Dateinamen beim Massen-Upload und gruppiert sie automatisch in Vorder- und Rückseiten.
 * 
 * @param acceptedFiles Liste der hochgeladenen Bilddateien
 * @param autoGroupDuplex Ob sequentiell nummerierte Scans als Duplex-Paare interpretiert werden sollen
 * @param duplexScanOrder "alternating" (1=VS, 2=RS, 3=VS...) oder "stack" (1..N=VS, N+1..2N=RS)
 * @returns Geordnete Liste von StreamBatchCard Objekten
 */
export function analyzeAndPairCardImages(
  acceptedFiles: File[],
  autoGroupDuplex = true,
  duplexScanOrder: DuplexScanOrder = "alternating"
): StreamBatchCard[] {
  if (!acceptedFiles || acceptedFiles.length === 0) return [];

  const sortedFiles = naturalSortFiles(acceptedFiles);
  const classifications = sortedFiles.map(classifyFile);

  const hasExplicitSides = classifications.some(c => c.side !== "unknown");

  const cards: StreamBatchCard[] = [];

  if (hasExplicitSides) {
    // -------------------------------------------------------------
    // STRATEGIE A: Explizite Suffix-/Präfix-Marker (z.B. _front / _back)
    // -------------------------------------------------------------
    const fronts = classifications.filter(c => c.side === "front");
    const backs = classifications.filter(c => c.side === "back");
    const unknowns = classifications.filter(c => c.side === "unknown");

    const usedBackIndexes = new Set<number>();
    let cardCount = 0;

    // Für jede erkannte Vorderseite suchen wir die passende Rückseite mit gleichem coreKey
    for (const f of fronts) {
      cardCount++;
      let matchBackIdx = backs.findIndex(
        (b, i) => !usedBackIndexes.has(i) && b.coreKey === f.coreKey
      );

      // Fallback: Falls Anzahl Vorderseiten === Rückseiten und coreKey nicht exakt übereinstimmt,
      // ordne die Rückseite am gleichen Listenindex zu
      if (matchBackIdx === -1 && fronts.length === backs.length) {
        const potentialIdx = cardCount - 1;
        if (!usedBackIndexes.has(potentialIdx) && backs[potentialIdx]) {
          matchBackIdx = potentialIdx;
        }
      }

      let matchedBack: FileClassification | undefined;
      if (matchBackIdx !== -1) {
        usedBackIndexes.add(matchBackIdx);
        matchedBack = backs[matchBackIdx];
      }

      const rawCardName = f.coreKey
        ? f.coreKey.charAt(0).toUpperCase() + f.coreKey.slice(1)
        : `Karte ${formatCardIndex(cardCount)}`;

      cards.push({
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
        cardNumberIndex: cardCount,
        cardName: rawCardName,
        front: createCardSide(f.file),
        back: matchedBack ? createCardSide(matchedBack.file) : null,
        isSaved: false
      });
    }

    // Übrig gebliebene Rückseiten ohne zugehörige Vorderseite
    backs.forEach((b, i) => {
      if (!usedBackIndexes.has(i)) {
        cardCount++;
        cards.push({
          id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
          cardNumberIndex: cardCount,
          cardName: `Rückseite ${formatCardIndex(cardCount)}`,
          front: createCardSide(b.file), // als primäre Seite
          back: null,
          isSaved: false
        });
      }
    });

    // Unbekannte Dateien: Falls Duplex aktiv, paarweise bündeln
    if (autoGroupDuplex && unknowns.length >= 2) {
      if (duplexScanOrder === "stack") {
        const half = Math.ceil(unknowns.length / 2);
        for (let i = 0; i < half; i++) {
          cardCount++;
          const frontFile = unknowns[i].file;
          const backFile = (half + i < unknowns.length) ? unknowns[half + i].file : null;
          const name = unknowns[i].baseName || `Karte ${formatCardIndex(cardCount)}`;
          cards.push({
            id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
            cardNumberIndex: cardCount,
            cardName: name,
            front: createCardSide(frontFile),
            back: backFile ? createCardSide(backFile) : null,
            isSaved: false
          });
        }
      } else {
        for (let i = 0; i < unknowns.length; i += 2) {
          cardCount++;
          const frontFile = unknowns[i].file;
          const backFile = (i + 1 < unknowns.length) ? unknowns[i + 1].file : null;
          const name = unknowns[i].baseName || `Karte ${formatCardIndex(cardCount)}`;
          cards.push({
            id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
            cardNumberIndex: cardCount,
            cardName: name,
            front: createCardSide(frontFile),
            back: backFile ? createCardSide(backFile) : null,
            isSaved: false
          });
        }
      }
    } else {
      unknowns.forEach((u) => {
        cardCount++;
        cards.push({
          id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
          cardNumberIndex: cardCount,
          cardName: u.baseName || `Karte ${formatCardIndex(cardCount)}`,
          front: createCardSide(u.file),
          back: null,
          isSaved: false
        });
      });
    }

    return cards;
  }

  // -------------------------------------------------------------
  // STRATEGIE B: Duplex-Scanner Reihenfolge (z.B. Epson DS-530 ADF oder Flatbed-Stapel)
  // Bei aktivierter Duplex-Gruppierung werden jeweils Paare gebildet
  // -------------------------------------------------------------
  if (autoGroupDuplex && sortedFiles.length >= 2) {
    let cardCount = 0;
    const n = sortedFiles.length;

    if (duplexScanOrder === "stack") {
      // Stapelweise: Erst alle Vorderseiten (1..N), dann alle Rückseiten (N+1..2N)
      const half = Math.ceil(n / 2);
      for (let i = 0; i < half; i++) {
        cardCount++;
        const frontFile = sortedFiles[i];
        const backFile = (half + i < n) ? sortedFiles[half + i] : null;

        const frontBase = getBaseFileName(frontFile.name);
        const name = frontBase || `Karte ${formatCardIndex(cardCount)}`;

        cards.push({
          id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
          cardNumberIndex: cardCount,
          cardName: name,
          front: createCardSide(frontFile),
          back: backFile ? createCardSide(backFile) : null,
          isSaved: false
        });
      }
      return cards;
    } else {
      // Alternierend: 1=VS, 2=RS, 3=VS, 4=RS...
      for (let i = 0; i < n; i += 2) {
        cardCount++;
        const frontFile = sortedFiles[i];
        const backFile = (i + 1 < n) ? sortedFiles[i + 1] : null;

        const frontBase = getBaseFileName(frontFile.name);
        const name = frontBase || `Karte ${formatCardIndex(cardCount)}`;

        cards.push({
          id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
          cardNumberIndex: cardCount,
          cardName: name,
          front: createCardSide(frontFile),
          back: backFile ? createCardSide(backFile) : null,
          isSaved: false
        });
      }
      return cards;
    }
  }

  // -------------------------------------------------------------
  // STRATEGIE C: Einzelkarten (Ungleiche Anzahl oder keine Duplex-Gruppierung)
  // -------------------------------------------------------------
  return sortedFiles.map((file, idx) => {
    const cardNum = idx + 1;
    const base = getBaseFileName(file.name);
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
      cardNumberIndex: cardNum,
      cardName: base || `Karte ${formatCardIndex(cardNum)}`,
      front: createCardSide(file),
      back: null,
      isSaved: false
    };
  });
}

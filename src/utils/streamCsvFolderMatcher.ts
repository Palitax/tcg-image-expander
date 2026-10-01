import { StreamBatchCard, StreamCardSide, getBaseFileName } from "./streamBatchPairing";
import { findClientCalibration } from "./clientCalibration";

export interface ParsedCsvCard {
  rowIndex: number;
  cardName: string;
  cardNumber?: string;
  setCode?: string;
  setName?: string;
  frontFileName?: string;
  backFileName?: string;
  rawRow: Record<string, string>;
}

export interface MatchedCardItem {
  id: string;
  csvCard: ParsedCsvCard;
  frontFile: File | null;
  backFile: File | null;
  matchStatus: "exact_pair" | "front_only" | "back_only" | "missing";
  frontPreviewUrl?: string;
  backPreviewUrl?: string;
  notes?: string;
}

export interface StreamFolderMatchResult {
  totalCsvCards: number;
  matchedCards: MatchedCardItem[];
  pairedCount: number;
  frontOnlyCount: number;
  missingCards: ParsedCsvCard[];
  totalFolderImages: number;
  matchedFolderImagesCount: number;
  ignoredFolderImagesCount: number;
}

const FRONT_PATTERNS = [
  /([_\-\s]|^)front([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vorderseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vorne([_\-\s]|\d|$)/i,
  /([_\-\s]|^)recto([_\-\s]|\d|$)/i,
  /([_\-\s]|^)vs([_\-\s]|\d|$)/i,
  /[_\-\s](f|a|1)$/i
];

const BACK_PATTERNS = [
  /([_\-\s]|^)back([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rueckseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rückseite([_\-\s]|\d|$)/i,
  /([_\-\s]|^)hinten([_\-\s]|\d|$)/i,
  /([_\-\s]|^)verso([_\-\s]|\d|$)/i,
  /([_\-\s]|^)rs([_\-\s]|\d|$)/i,
  /[_\-\s](b|2)$/i
];

/**
 * Normalisiert einen Suchschlüssel für einen unempfindlichen, fehlertoleranten Vergleich:
 * Entfernt Sonderzeichen, wandelt Umlaute um, normalisiert Leerzeichen und entfernt führende Nullen.
 */
export function normalizeSearchKey(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\b0+(\d+)\b/g, "$1") // führende Nullen bei Zahlen entfernen (z. B. "004" -> "4")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parst eine CSV-Datei und extrahiert die enthaltenen TCG-Karten (ideal für Whatnot- und Bestandslisten).
 */
export async function parseStreamCardCsv(file: File): Promise<ParsedCsvCard[]> {
  let text = await file.text();
  // Strip UTF-8 BOM if present
  text = text.replace(/^\uFEFF/, "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Trennzeichen anhand der ersten Zeile erkennen
  const headerLine = lines[0];
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const pipeCount = (headerLine.match(/\|/g) || []).length;

  let separator = ",";
  let maxCount = commaCount;
  if (semiCount > maxCount) { separator = ";"; maxCount = semiCount; }
  if (tabCount > maxCount) { separator = "\t"; maxCount = tabCount; }
  if (pipeCount > maxCount) { separator = "|"; maxCount = pipeCount; }

  // Zeilen in Spalten parsen unter Berücksichtigung von Anführungszeichen
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
      } else if (char === separator && !inQuotes) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const rawRows = lines.map(parseLine);
  if (rawRows.length === 0) return [];

  const cleanHeader = (s: string) => s.toLowerCase().replace(/[\uFEFF"'\s\-_#]/g, "");
  const headers = rawRows[0].map(cleanHeader);

  // Spalten-Indizes erkennen
  const nameHeaders = [
    "name", "cardname", "kartenname", "title", "titel", "listingtitle", 
    "item", "itemname", "product", "productname", "card", "karte", 
    "bezeichnung", "artikel", "sku"
  ];
  const numberHeaders = [
    "number", "cardnumber", "kartennummer", "nr", "kartennr", "setnumber", "num"
  ];
  const setHeaders = [
    "set", "setname", "setcode", "edition", "serie", "series"
  ];
  const frontHeaders = [
    "frontfile", "frontimage", "front", "vorderseite", "vs", "frontfilename"
  ];
  const backHeaders = [
    "backfile", "backimage", "back", "rueckseite", "rückseite", "rs", "backfilename"
  ];
  const genericFileHeaders = [
    "file", "filename", "datei", "dateiname", "image", "bild"
  ];

  let nameCol = -1;
  let numCol = -1;
  let setCol = -1;
  let frontCol = -1;
  let backCol = -1;
  let genericFileCol = -1;

  headers.forEach((h, idx) => {
    if (nameHeaders.includes(h) && nameCol === -1) nameCol = idx;
    if (numberHeaders.includes(h) && numCol === -1) numCol = idx;
    if (setHeaders.includes(h) && setCol === -1) setCol = idx;
    if (frontHeaders.includes(h) && frontCol === -1) frontCol = idx;
    if (backHeaders.includes(h) && backCol === -1) backCol = idx;
    if (genericFileHeaders.includes(h) && genericFileCol === -1) genericFileCol = idx;
  });

  const parsedCards: ParsedCsvCard[] = [];
  const startRow = (nameCol !== -1 || numCol !== -1 || setCol !== -1 || frontCol !== -1) ? 1 : 0;

  for (let r = startRow; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (row.length === 0 || row.every(c => !c)) continue;

    const rawMap: Record<string, string> = {};
    row.forEach((val, i) => {
      const headerKey = rawRows[0][i] || `spalte_${i + 1}`;
      rawMap[headerKey] = val;
    });

    let cardName = "";
    if (nameCol !== -1 && row[nameCol]) {
      cardName = row[nameCol];
    } else if (genericFileCol !== -1 && row[genericFileCol]) {
      cardName = row[genericFileCol].replace(/\.[^/.]+$/, "");
    } else {
      // Erste nicht-leere Spalte als Kartenname
      cardName = row.find(c => c.trim().length > 0) || `Karte ${r}`;
    }

    // Anführungszeichen bereinigen
    cardName = cardName.replace(/^["']|["']$/g, "").trim();
    if (!cardName) continue;

    const cardNumber = numCol !== -1 && row[numCol] ? row[numCol].replace(/^["']|["']$/g, "").trim() : undefined;
    const setName = setCol !== -1 && row[setCol] ? row[setCol].replace(/^["']|["']$/g, "").trim() : undefined;
    const frontFileName = frontCol !== -1 && row[frontCol] ? row[frontCol].replace(/^["']|["']$/g, "").trim() : undefined;
    const backFileName = backCol !== -1 && row[backCol] ? row[backCol].replace(/^["']|["']$/g, "").trim() : undefined;

    parsedCards.push({
      rowIndex: r,
      cardName,
      cardNumber,
      setName,
      frontFileName,
      backFileName,
      rawRow: rawMap
    });
  }

  return parsedCards;
}

interface ClassifiedFolderFile {
  file: File;
  fileName: string;
  baseName: string;
  parentDirName: string;
  side: "front" | "back" | "unknown";
  coreKey: string;
  normCoreKey: string;
  normBaseName: string;
  normParentDir: string;
}

/**
 * Klassifiziert eine Bilddatei aus dem ausgewählten Ordner.
 */
function classifyFolderFile(file: File): ClassifiedFolderFile {
  const base = getBaseFileName(file.name);
  const relativePath = (file as any).webkitRelativePath || file.name;
  const pathParts = relativePath.split(/[/\\]/);
  const parentDir = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";

  // 1. Prüfe auf Vorderseiten-Muster
  for (const pattern of FRONT_PATTERNS) {
    if (pattern.test(base)) {
      const core = base.replace(pattern, " ").replace(/\s+/g, " ").trim();
      return {
        file,
        fileName: file.name,
        baseName: base,
        parentDirName: parentDir,
        side: "front",
        coreKey: core || base,
        normCoreKey: normalizeSearchKey(core || base),
        normBaseName: normalizeSearchKey(base),
        normParentDir: normalizeSearchKey(parentDir)
      };
    }
  }

  // 2. Prüfe auf Rückseiten-Muster
  for (const pattern of BACK_PATTERNS) {
    if (pattern.test(base)) {
      const core = base.replace(pattern, " ").replace(/\s+/g, " ").trim();
      return {
        file,
        fileName: file.name,
        baseName: base,
        parentDirName: parentDir,
        side: "back",
        coreKey: core || base,
        normCoreKey: normalizeSearchKey(core || base),
        normBaseName: normalizeSearchKey(base),
        normParentDir: normalizeSearchKey(parentDir)
      };
    }
  }

  return {
    file,
    fileName: file.name,
    baseName: base,
    parentDirName: parentDir,
    side: "unknown",
    coreKey: base,
    normCoreKey: normalizeSearchKey(base),
    normBaseName: normalizeSearchKey(base),
    normParentDir: normalizeSearchKey(parentDir)
  };
}

/**
 * Gleicht die Karten aus der CSV-Datei mit den Bilddateien im ausgewählten Ordner ab.
 * Identifiziert Vorder- und Rückseiten exakt und schließt alle nicht genannten Dateien aus.
 */
export function matchCsvCardsWithFolderFiles(
  csvCards: ParsedCsvCard[],
  folderFiles: File[]
): StreamFolderMatchResult {
  // Nur Bilddateien berücksichtigen
  const imageExtensions = /\.(jpe?g|png|webp|bmp|tiff)$/i;
  const imageFiles = folderFiles.filter(f => imageExtensions.test(f.name));

  const classifiedFiles = imageFiles.map(classifyFolderFile);
  const usedFileNames = new Set<string>();

  const matchedCards: MatchedCardItem[] = [];
  const missingCards: ParsedCsvCard[] = [];

  for (const csvCard of csvCards) {
    const normCardName = normalizeSearchKey(csvCard.cardName);
    const normCardNum = csvCard.cardNumber ? normalizeSearchKey(csvCard.cardNumber) : "";

    let matchedFront: ClassifiedFolderFile | null = null;
    let matchedBack: ClassifiedFolderFile | null = null;

    // 1. STRATEGIE: Explizite Dateinamen aus der CSV (falls vorhanden)
    if (csvCard.frontFileName) {
      const targetFront = csvCard.frontFileName.toLowerCase();
      matchedFront = classifiedFiles.find(
        f => !usedFileNames.has(f.fileName) && f.fileName.toLowerCase() === targetFront
      ) || null;
    }
    if (csvCard.backFileName) {
      const targetBack = csvCard.backFileName.toLowerCase();
      matchedBack = classifiedFiles.find(
        f => !usedFileNames.has(f.fileName) && f.fileName.toLowerCase() === targetBack
      ) || null;
    }

    // 2. STRATEGIE: Unterordner-Match (Ordner/Glurak/front.jpg & Ordner/Glurak/back.jpg)
    if (!matchedFront) {
      const folderMatches = classifiedFiles.filter(
        f => !usedFileNames.has(f.fileName) && f.normParentDir && f.normParentDir === normCardName
      );
      if (folderMatches.length > 0) {
        matchedFront = folderMatches.find(f => f.side === "front") || folderMatches[0] || null;
        matchedBack = folderMatches.find(f => f.side === "back" && f !== matchedFront) || (folderMatches.length > 1 ? folderMatches[1] : null);
      }
    }

    // 3. STRATEGIE: Exakter / Normalisierter CoreKey-Match
    if (!matchedFront) {
      // Suche Vorderseite
      matchedFront = classifiedFiles.find(f => 
        !usedFileNames.has(f.fileName) && 
        f.side === "front" && 
        (f.normCoreKey === normCardName || f.normBaseName === normCardName)
      ) || null;

      // Falls keine explizite Vorderseite, suche unbekannte Datei mit gleichem Namen
      if (!matchedFront) {
        matchedFront = classifiedFiles.find(f => 
          !usedFileNames.has(f.fileName) && 
          f.side === "unknown" && 
          (f.normCoreKey === normCardName || f.normBaseName === normCardName)
        ) || null;
      }
    }

    // Suche passende Rückseite, falls noch nicht gefunden
    if (matchedFront && !matchedBack) {
      // 3a. Passende Rückseite mit gleichem CoreKey
      matchedBack = classifiedFiles.find(f => 
        !usedFileNames.has(f.fileName) && 
        f.side === "back" && 
        (f.normCoreKey === matchedFront!.normCoreKey || f.normCoreKey === normCardName)
      ) || null;
    }

    // 4. STRATEGIE: Fehlertoleranter Token-Abgleich (z. B. "Glurak 4/102" in "04_Glurak_front.jpg")
    if (!matchedFront && normCardName.length >= 3) {
      const cardTokens = normCardName.split(" ").filter(t => t.length > 1);
      
      const potentialFronts = classifiedFiles.filter(f => {
        if (usedFileNames.has(f.fileName) || f.side === "back") return false;
        // Alle Token der Karte im Dateinamen enthalten?
        const matchesAllTokens = cardTokens.length > 0 && cardTokens.every(token => 
          f.normCoreKey.includes(token) || f.normBaseName.includes(token)
        );
        // Falls Kartennummer vorhanden, muss diese zwingend auch im Dateinamen vorkommen
        const matchesNum = !normCardNum || f.normCoreKey.includes(normCardNum) || f.normBaseName.includes(normCardNum);
        return matchesAllTokens && matchesNum;
      });

      if (potentialFronts.length > 0) {
        // Bevorzuge explizite Vorderseiten
        matchedFront = potentialFronts.find(f => f.side === "front") || potentialFronts[0];

        // Finde korrespondierende Rückseite
        matchedBack = classifiedFiles.find(f => 
          !usedFileNames.has(f.fileName) && 
          f.side === "back" && 
          (f.normCoreKey === matchedFront!.normCoreKey || cardTokens.every(t => f.normCoreKey.includes(t)))
        ) || null;
      }
    }

    // Ergebnis für diese CSV-Karte eintragen
    if (matchedFront) {
      usedFileNames.add(matchedFront.fileName);
      if (matchedBack) {
        usedFileNames.add(matchedBack.fileName);
      }

      matchedCards.push({
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
        csvCard,
        frontFile: matchedFront.file,
        backFile: matchedBack ? matchedBack.file : null,
        matchStatus: matchedBack ? "exact_pair" : "front_only",
        frontPreviewUrl: URL.createObjectURL(matchedFront.file),
        backPreviewUrl: matchedBack ? URL.createObjectURL(matchedBack.file) : undefined
      });
    } else {
      missingCards.push(csvCard);
      matchedCards.push({
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
        csvCard,
        frontFile: null,
        backFile: null,
        matchStatus: "missing",
        notes: "Kein passendes Scan-Bild im Ordner gefunden"
      });
    }
  }

  const pairedCount = matchedCards.filter(m => m.matchStatus === "exact_pair").length;
  const frontOnlyCount = matchedCards.filter(m => m.matchStatus === "front_only").length;
  const matchedFolderImagesCount = usedFileNames.size;
  const ignoredFolderImagesCount = imageFiles.length - matchedFolderImagesCount;

  return {
    totalCsvCards: csvCards.length,
    matchedCards,
    pairedCount,
    frontOnlyCount,
    missingCards,
    totalFolderImages: imageFiles.length,
    matchedFolderImagesCount,
    ignoredFolderImagesCount
  };
}

/**
 * Erstellt eine StreamCardSide für eine Datei mit sofortigem Abgleich existierender Stanzvisier-Kalibrierungen.
 */
function createMatchedCardSide(
  file: File, 
  metadata: { cardName: string; cardNumber: string; setCode: string; setName: string; slogan?: string }
): StreamCardSide {
  const cal = findClientCalibration(file);
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
    file,
    previewUrl: URL.createObjectURL(file),
    cropBox: cal ? cal.cropBox : null,
    isVisorCustomized: Boolean(cal),
    fileHash: cal?.fileHash,
    status: "pending",
    isSaved: false,
    metadata
  };
}

/**
 * Konvertiert die erfolgreich abgeglichenen Treffer in StreamBatchCard-Objekte für die Stapelverarbeitung.
 */
export function convertMatchedCardsToStreamBatch(matches: MatchedCardItem[]): StreamBatchCard[] {
  const validMatches = matches.filter(m => m.frontFile !== null);

  return validMatches.map((item, idx) => {
    const cardNum = idx + 1;
    const meta = {
      cardName: item.csvCard.cardName,
      cardNumber: item.csvCard.cardNumber || "",
      setCode: item.csvCard.setCode || "",
      setName: item.csvCard.setName || "",
      slogan: "MANACARDS – Unpack the magic"
    };

    return {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
      cardNumberIndex: cardNum,
      cardName: item.csvCard.cardName,
      front: createMatchedCardSide(item.frontFile!, meta),
      back: item.backFile ? createMatchedCardSide(item.backFile, meta) : null,
      isSaved: false
    };
  });
}

/**
 * Erzeugt eine Muster-CSV-Datei für den Stream-Studio Ordnerabgleich zum Herunterladen.
 */
export function downloadStreamCardSampleCsv(): void {
  const csvContent = 
`Kartenname,Kartennummer,Set,Vorderseite,Rückseite
Glurak,4/102,Base Set,Glurak_front.jpg,Glurak_back.jpg
Bisasam,44/102,Base Set,Bisasam_front.jpg,Bisasam_back.jpg
Turtok,2/102,Base Set,Turtok_front.jpg,Turtok_back.jpg
Pikachu,025/165,151,Pikachu_VS.png,Pikachu_RS.png
Gengar VMAX,157/264,Fusion Strike,Gengar_front.webp,Gengar_back.webp`;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "muster_stream_kartenliste.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

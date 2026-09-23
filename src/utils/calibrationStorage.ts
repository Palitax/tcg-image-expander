import fs from "fs/promises";
import path from "path";

export interface CardCalibrationRecord {
  id: string;
  fileHash: string;
  fallbackKey: string;
  fileName?: string;
  fileSize?: number;
  cropBox: {
    x: number;
    y: number;
    width: number;
    height: number;
    imageWidth?: number;
    imageHeight?: number;
  };
  isUserManual: boolean;
  metadata?: {
    cardName?: string;
    cardNumber?: string;
    setCode?: string;
    setName?: string;
    slogan?: string;
  };
  cardSide?: "front" | "back";
  updatedAt: number;
}

const DATA_DIR = path.join(process.cwd(), "data");
const CALIBRATIONS_FILE = path.join(DATA_DIR, "card_calibrations.json");

/**
 * Lädt alle gespeicherten Kalibrierungs-Einträge aus der JSON-Datei.
 */
export async function loadCalibrations(): Promise<Record<string, CardCalibrationRecord>> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const content = await fs.readFile(CALIBRATIONS_FILE, "utf-8");
    return JSON.parse(content);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    console.error("Fehler beim Laden von card_calibrations.json:", err);
    return {};
  }
}

/**
 * Schreibt alle Kalibrierungen atomar in die JSON-Datei.
 */
async function writeCalibrations(data: Record<string, CardCalibrationRecord>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${CALIBRATIONS_FILE}.tmp.${Date.now()}`;
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempFile, CALIBRATIONS_FILE);
}

/**
 * Speichert oder aktualisiert eine einzelne Visier-Kalibrierung.
 */
export async function saveCalibration(record: CardCalibrationRecord): Promise<void> {
  const all = await loadCalibrations();
  
  // Primärer Key: fileHash
  if (record.fileHash) {
    all[record.fileHash] = record;
  }
  // Sekundärer Key: fallbackKey (fileName_fileSize) für schnellen Lookup
  if (record.fallbackKey) {
    all[record.fallbackKey] = record;
  }

  await writeCalibrations(all);
}

/**
 * Speichert mehrere Kalibrierungen auf einmal.
 */
export async function saveCalibrationsBatch(records: CardCalibrationRecord[]): Promise<void> {
  const all = await loadCalibrations();
  for (const record of records) {
    if (record.fileHash) all[record.fileHash] = record;
    if (record.fallbackKey) all[record.fallbackKey] = record;
  }
  await writeCalibrations(all);
}

/**
 * Gleicht eine Liste hochgeladener Karten mit den gespeicherten Kalibrierungen ab.
 * Sucht zuerst nach fileHash, dann nach fallbackKey (Name + Größe).
 */
export async function matchCalibrations(
  queryList: Array<{ hash?: string; fallbackKey?: string; fileName?: string; fileSize?: number }>
): Promise<Record<string, CardCalibrationRecord>> {
  const all = await loadCalibrations();
  const matched: Record<string, CardCalibrationRecord> = {};

  for (const item of queryList) {
    let found: CardCalibrationRecord | undefined = undefined;

    if (item.hash && all[item.hash]) {
      found = all[item.hash];
    } else if (item.fallbackKey && all[item.fallbackKey]) {
      found = all[item.fallbackKey];
    } else if (item.fileName && item.fileSize !== undefined) {
      const fbKey = `${item.fileName.trim()}_${item.fileSize}`;
      if (all[fbKey]) {
        found = all[fbKey];
      }
    }

    if (found) {
      const responseKey = item.hash || item.fallbackKey || `${item.fileName}_${item.fileSize}`;
      matched[responseKey] = found;
    }
  }

  return matched;
}

/**
 * Exportiert alle eindeutigen Kalibrierungs-Einträge als Array für Backups.
 */
export async function exportAllCalibrations(): Promise<CardCalibrationRecord[]> {
  const all = await loadCalibrations();
  const uniqueMap = new Map<string, CardCalibrationRecord>();

  for (const record of Object.values(all)) {
    const key = record.fileHash || record.fallbackKey || record.id;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, record);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Importiert eine Liste von Kalibrierungen und führt sie zusammen.
 */
export async function importCalibrationsList(records: CardCalibrationRecord[]): Promise<number> {
  if (!Array.isArray(records) || records.length === 0) return 0;
  await saveCalibrationsBatch(records);
  return records.length;
}

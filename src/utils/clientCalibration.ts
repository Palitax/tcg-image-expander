import { CardCalibrationRecord } from "./calibrationStorage";
import { getFileFallbackKey } from "./fileHash";

const LOCAL_STORAGE_KEY = "tcg_card_calibrations_v1";

/**
 * Holt alle lokal im Browser gespeicherten Kalibrierungen.
 */
export function getLocalCalibrationsMap(): Record<string, CardCalibrationRecord> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Fehler beim Lesen der lokalen Kalibrierungen:", err);
    return {};
  }
}

/**
 * Schreibt alle Kalibrierungen synchron in den localStorage.
 */
export function saveLocalCalibrationsMap(map: Record<string, CardCalibrationRecord>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn("Fehler beim Speichern der lokalen Kalibrierungen:", err);
  }
}

/**
 * Speichert oder aktualisiert eine einzelne Kalibrierung im localStorage.
 * Indiziert nach fileHash, fallbackKey, fileName und baseName für maximal robuste Trefferquote.
 */
export function saveClientCalibration(record: CardCalibrationRecord): void {
  const map = getLocalCalibrationsMap();

  if (record.fileHash) map[record.fileHash] = record;
  if (record.fallbackKey) map[record.fallbackKey] = record;
  if (record.fileName) {
    map[record.fileName.trim()] = record;
    if (record.fileSize !== undefined) {
      map[`${record.fileName.trim()}_${record.fileSize}`] = record;
    }
    const base = record.fileName.replace(/\.[^/.]+$/, "").trim();
    if (base) map[base] = record;
  }

  saveLocalCalibrationsMap(map);
}

/**
 * Speichert mehrere Kalibrierungen auf einmal im localStorage.
 */
export function saveClientCalibrationsBatch(records: CardCalibrationRecord[]): void {
  const map = getLocalCalibrationsMap();
  for (const record of records) {
    if (record.fileHash) map[record.fileHash] = record;
    if (record.fallbackKey) map[record.fallbackKey] = record;
    if (record.fileName) {
      map[record.fileName.trim()] = record;
      if (record.fileSize !== undefined) {
        map[`${record.fileName.trim()}_${record.fileSize}`] = record;
      }
      const base = record.fileName.replace(/\.[^/.]+$/, "").trim();
      if (base) map[base] = record;
    }
  }
  saveLocalCalibrationsMap(map);
}

/**
 * Sucht synchron im Browser nach einer gespeicherten Kalibrierung für eine Datei.
 */
export function findClientCalibration(
  file: File,
  fileHash?: string
): CardCalibrationRecord | null {
  const map = getLocalCalibrationsMap();

  if (fileHash && map[fileHash]) return map[fileHash];

  const fbKey = getFileFallbackKey(file);
  if (map[fbKey]) return map[fbKey];

  const nameWithSize = `${file.name.trim()}_${file.size}`;
  if (map[nameWithSize]) return map[nameWithSize];

  if (map[file.name.trim()]) return map[file.name.trim()];

  const base = file.name.replace(/\.[^/.]+$/, "").trim();
  if (map[base]) return map[base];

  return null;
}

/**
 * Synchronisiert Server-Kalibrierungen mit dem lokalen Cache.
 */
export function syncServerCalibrationsToClient(serverRecords: CardCalibrationRecord[]): void {
  if (!Array.isArray(serverRecords) || serverRecords.length === 0) return;
  saveClientCalibrationsBatch(serverRecords);
}

const DB_NAME = "TcgImageExpanderDB";
const STORE_NAME = "artworks";
const DB_VERSION = 1;

export interface SavedArtwork {
  id: string;
  name: string;
  imageUrl: string;
  originalCardUrl?: string;
  backgroundUrl?: string;
  cardOnlyUrl?: string;
  aspectRatio: string;
  timestamp: number;
  isCase?: boolean;
  isDisplay?: boolean;
}

export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("IndexedDB is not available in Server-Side Rendering (SSR) environments."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });
}

export async function getSavedArtworks(): Promise<SavedArtwork[]> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result as SavedArtwork[];
        // Sort by timestamp descending (newest first)
        results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error("Failed to get saved artworks from IndexedDB:", error);
    return [];
  }
}

export async function saveArtwork(artwork: SavedArtwork): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(artwork);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function deleteArtwork(id: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function migrateFromLocalStorage(): Promise<SavedArtwork[]> {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem("tcg_art_library");
  if (!stored) return [];

  try {
    const artworks = JSON.parse(stored) as SavedArtwork[];
    if (Array.isArray(artworks) && artworks.length > 0) {
      for (const artwork of artworks) {
        if (artwork.id && artwork.imageUrl) {
          await saveArtwork(artwork);
        }
      }
    }
    localStorage.removeItem("tcg_art_library");
    console.log(`Successfully migrated ${artworks.length} items from localStorage to IndexedDB.`);
    return getSavedArtworks();
  } catch (e) {
    console.error("Failed to migrate localStorage to IndexedDB:", e);
    return [];
  }
}

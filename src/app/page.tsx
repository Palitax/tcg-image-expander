"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import JSZip from "jszip";
import { 
  Upload, 
  Sparkles, 
  Image as ImageIcon, 
  RefreshCw, 
  Download, 
  Layers, 
  Maximize2, 
  AlertCircle,
  CheckCircle2,
  Clock,
  Info,
  Bookmark,
  Search,
  Trash2,
  Pencil,
  X,
  ChevronDown,
  Package,
  Activity,
  Check
} from "lucide-react";
import { 
  getSavedArtworks, 
  saveArtwork, 
  deleteArtwork, 
  migrateFromLocalStorage,
  type SavedArtwork
} from "@/utils/db";
import { supabase } from "@/utils/supabaseClient";

const isLocalMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

interface DbArtwork {
  id: string;
  space_id: string;
  name: string;
  image_url: string;
  original_card_url: string | null;
  background_url: string | null;
  aspect_ratio: string;
  timestamp: string | number;
}

interface ProgressStep {
  id: string;
  label: string;
  description: string;
  status: "idle" | "running" | "success" | "error";
}

const INITIAL_STEPS: ProgressStep[] = [
  { id: "LAYOUT", label: "Layout-Analyse", description: "Gemini erkennt Begrenzungsrahmen der inneren Karte", status: "idle" },
  { id: "CROP", label: "Kunstwerk-Extraktion", description: "Sharp schneidet das Bild mithilfe von Koordinaten aus", status: "idle" },
  { id: "OUTPAINT", label: "Hintergrund-Erweiterung", description: "Imagen 3 erweitert den Hintergrund im gewünschten Seitenverhältnis", status: "idle" },
  { id: "MERGE", label: "Karten-Compositing", description: "Karte mit elegantem weichem Schatten und Finish überlagern", status: "idle" }
];

const DISPLAY_STEPS: ProgressStep[] = [
  { id: "LAYOUT", label: "Display-Erkennung", description: "Gemini verfolgt die Begrenzung des Display-Rahmens", status: "idle" },
  { id: "CROP", label: "Ausschnitt & Zuschnitt", description: "Sharp extrahiert und schneidet den transparenten Ausschnitt zu", status: "idle" },
  { id: "OUTPAINT", label: "Hintergrund-Generierung", description: "Imagen 3 generiert eine passende thematische Szene", status: "idle" },
  { id: "MERGE", label: "3D-Komposition", description: "Komposition des Ausschnitts mit weichem Schattenwurf auf den Hintergrund", status: "idle" }
];

const BOOSTER_STEPS: ProgressStep[] = [
  { id: "LAYOUT", label: "Booster-Erkennung", description: "Gemini verfolgt die Begrenzung der Booster-Folie", status: "idle" },
  { id: "CROP", label: "Ausschnitt & Zuschnitt", description: "Sharp extrahiert und schneidet den transparenten Ausschnitt zu", status: "idle" },
  { id: "OUTPAINT", label: "Hintergrund-Generierung", description: "Imagen 3 generiert eine passende thematische Szene", status: "idle" },
  { id: "MERGE", label: "3D-Komposition", description: "Komposition des Ausschnitts mit weichem Schattenwurf auf den Hintergrund", status: "idle" }
];

// Helper to convert file to Base64 data URL
const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
};

// Client-side fetch retry helper to prevent Vercel timeouts and network resets
const fetchWithRetry = async (
  url: string, 
  options: RequestInit, 
  retries = 2, 
  delay = 1500, 
  onRetry?: (msg: string) => void
): Promise<Response> => {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw e;
    }
    if (retries > 0) {
      const msg = `Retrying connection in ${(delay / 1000).toFixed(0)}s... (${retries} left)`;
      if (onRetry) onRetry(msg);
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5, onRetry);
    }
    throw e;
  }
};

// Helper to safely parse JSON from response or extract plain text/statusText on failure
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseResponseData = async (response: Response, defaultErrorMsg: string): Promise<any> => {
  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new Error("Invalid response format received from server.");
    }
  }

  // Handle error status
  let errorMessage = defaultErrorMsg;
  try {
    const errorData = await response.json();
    errorMessage = errorData.error || errorMessage;
  } catch {
    try {
      const text = await response.text();
      errorMessage = text || response.statusText || errorMessage;
    } catch {
      errorMessage = response.statusText || errorMessage;
    }
  }
  throw new Error(errorMessage);
};

const getErrorMessage = (err: unknown): string => {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
};

const fetchBlob = async (url: string, fallbackUrl?: string): Promise<{ blob: Blob; mimeType: string }> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const blob = await response.blob();
    return { blob, mimeType: blob.type };
  } catch (error) {
    console.error("Failed to fetch image blob:", error, "URL:", url);
    if (fallbackUrl) {
      console.log("Retrying fetch with fallback URL:", fallbackUrl);
      return fetchBlob(fallbackUrl);
    }
    throw error;
  }
};

const convertBlobToPng = async (blob: Blob): Promise<Blob> => {
  if (blob.type === "image/png") return blob;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get 2d context for PNG conversion"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Failed to generate PNG blob"));
        }
      }, "image/png");
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image for PNG conversion"));
    };
    img.src = url;
  });
};

const getAdjustedFilename = (filename: string, mimeType: string): string => {
  let ext = "";
  if (mimeType === "image/webp") ext = "webp";
  else if (mimeType === "image/png") ext = "png";
  else if (mimeType === "image/jpeg" || mimeType === "image/jpg") ext = "jpg";
  
  if (ext) {
    return filename.replace(/\.[^/.]+$/, "") + "." + ext;
  }
  return filename;
};

const fetchAndProcessImage = async (
  url: string,
  filename: string,
  fallbackUrl?: string
): Promise<{ blob: Blob; mimeType: string }> => {
  let blob: Blob;
  let mimeType: string;

  if (url.startsWith("data:")) {
    const response = await fetch(url);
    blob = await response.blob();
    mimeType = blob.type;
  } else {
    const fetched = await fetchBlob(url, fallbackUrl);
    blob = fetched.blob;
    mimeType = fetched.mimeType;
  }

  // If the user requested a .png file but we got webp (or another format), convert it to png.
  if (filename.toLowerCase().endsWith(".png") && mimeType !== "image/png") {
    try {
      const pngBlob = await convertBlobToPng(blob);
      return { blob: pngBlob, mimeType: "image/png" };
    } catch (err) {
      console.error("Failed to convert image to PNG on client side:", err);
    }
  }

  return { blob, mimeType };
};

const triggerDownload = async (url: string, filename: string, fallbackUrl?: string): Promise<void> => {
  try {
    if (url.startsWith("data:")) {
      const mimeMatch = url.match(/^data:([^;]+);/);
      const isPngRequested = filename.toLowerCase().endsWith(".png");
      const isSourcePng = mimeMatch && mimeMatch[1] === "image/png";

      // If we don't need PNG conversion, use direct data URI download for speed
      if (!isPngRequested || isSourcePng) {
        let adjustedFilename = filename;
        if (mimeMatch) {
          adjustedFilename = getAdjustedFilename(filename, mimeMatch[1]);
        }
        const link = document.createElement("a");
        link.href = url;
        link.download = adjustedFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }
    }

    const { blob, mimeType } = await fetchAndProcessImage(url, filename, fallbackUrl);
    const adjustedFilename = getAdjustedFilename(filename, mimeType);
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = adjustedFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up local reference after download triggers
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.error("Failed to download file:", error);
    // Fallback: open in new window if download block cannot be bypassed
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

const triggerZipDownload = async (
  files: { url: string; filename: string; fallbackUrl?: string }[],
  zipFilename: string
): Promise<void> => {
  try {
    const zip = new JSZip();
    
    // Fetch all files in parallel
    const fetchPromises = files.map(async (file) => {
      const { blob, mimeType } = await fetchAndProcessImage(file.url, file.filename, file.fallbackUrl);
      const adjustedFilename = getAdjustedFilename(file.filename, mimeType);
      zip.file(adjustedFilename, blob);
    });

    await Promise.all(fetchPromises);

    // Generate zip
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const objectUrl = URL.createObjectURL(zipBlob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = zipFilename.endsWith(".zip") ? zipFilename : `${zipFilename}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.error("Failed to generate and download zip:", error);
    // Fallback: download files individually
    alert("Failed to create zip file. Downloading files individually instead.");
    for (const file of files) {
      await triggerDownload(file.url, file.filename, file.fallbackUrl);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

// SavedArtwork interface is imported from @/utils/db

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [steps, setSteps] = useState<ProgressStep[]>(INITIAL_STEPS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultImageUrl, setResultImageUrl] = useState<string | null>(null);
  const [usedAmbientFallback, setUsedAmbientFallback] = useState<boolean>(false);
  const [ambientFallbackReason, setAmbientFallbackReason] = useState<string>("");
  const [usedCropFallback, setUsedCropFallback] = useState<boolean>(false);
  const [trimmedCard, setTrimmedCard] = useState<string | null>(null);
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | null>(null);
  const [bgMode, setBgMode] = useState<"backdrop" | "outpaint">("outpaint");
  const [shouldCropCard, setShouldCropCard] = useState<boolean>(true);

  const [activeTab, setActiveTab] = useState<"generate" | "case" | "library">("generate");
  const [activeStudioSubTab, setActiveStudioSubTab] = useState<"card" | "display" | "booster">("card");
  const [savedArtworks, setSavedArtworks] = useState<SavedArtwork[]>([]);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveTarget, setSaveTarget] = useState<"generate" | "case" | "upload" | "display" | "booster">("generate");
  const [newArtworkName, setNewArtworkName] = useState<string>("");
  const [libraryUploadDataUrl, setLibraryUploadDataUrl] = useState<string | null>(null);
  const [libraryUploadAspectRatio, setLibraryUploadAspectRatio] = useState<string>("3:4");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [libraryCategory, setLibraryCategory] = useState<"all" | "cards" | "displays" | "boosters">("all");
  const [libraryCardSubCategory, setLibraryCardSubCategory] = useState<"all" | "case" | "noCase">("all");

  // Card renaming states
  const [isRenameModalOpen, setIsRenameModalOpen] = useState<boolean>(false);
  const [renamingArtwork, setRenamingArtwork] = useState<SavedArtwork | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [identifyingArtworkId, setIdentifyingArtworkId] = useState<string | null>(null);

  // Space authentication states
  const [currentSpace, setCurrentSpace] = useState<{ id: string; name: string } | null>(null);
  const [loginSpaceName, setLoginSpaceName] = useState<string>("");
  const [loginPasscode, setLoginPasscode] = useState<string>("");
  const [isKeepLoggedIn, setIsKeepLoggedIn] = useState<boolean>(true);
  const [loginStep, setLoginStep] = useState<"name" | "code" | "create">("name");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoginLoading, setIsLoginLoading] = useState<boolean>(false);
  const [isSpaceSyncing, setIsSpaceSyncing] = useState<boolean>(false);

  // Case Maker states
  const [selectedArtworkId, setSelectedArtworkId] = useState<string | null>(null);
  const [caseCardImage, setCaseCardImage] = useState<string | null>(null);
  const [caseBgImage, setCaseBgImage] = useState<string | null>(null);
  const [caseResultUrl, setCaseResultUrl] = useState<string | null>(null);
  const [isCaseProcessing, setIsCaseProcessing] = useState<boolean>(false);
  const [caseErrorMessage, setCaseErrorMessage] = useState<string | null>(null);

  // Case components for split download
  const [caseWithCardUrl, setCaseWithCardUrl] = useState<string | null>(null);
  const [caseBgResultUrl, setCaseBgResultUrl] = useState<string | null>(null);
  const [isCaseOverlayLoaded, setIsCaseOverlayLoaded] = useState<boolean>(false);

  // Dropdown states for downloads
  const [isGenDownloadOpen, setIsGenDownloadOpen] = useState<boolean>(false);
  const [isCaseDownloadOpen, setIsCaseDownloadOpen] = useState<boolean>(false);
  const [openLibraryDownloadId, setOpenLibraryDownloadId] = useState<string | null>(null);

  // Lightbox larger view state
  const [lightboxImage, setLightboxImage] = useState<{ url: string; title: string } | null>(null);

  // Display Studio states
  const [displayFile, setDisplayFile] = useState<File | null>(null);
  const [displayPreviewUrl, setDisplayPreviewUrl] = useState<string | null>(null);
  const [displayResultUrl, setDisplayResultUrl] = useState<string | null>(null);
  const [displayCutoutUrl, setDisplayCutoutUrl] = useState<string | null>(null);
  const [displayBgUrl, setDisplayBgUrl] = useState<string | null>(null);
  const [isDisplayProcessing, setIsDisplayProcessing] = useState<boolean>(false);
  const [displayErrorMessage, setDisplayErrorMessage] = useState<string | null>(null);
  const [displayAspectRatio, setDisplayAspectRatio] = useState<string>("3:4");
  const [displayBgMode, setDisplayBgMode] = useState<"outpaint" | "ambient" | "transparent">("transparent");
  const [displaySteps, setDisplaySteps] = useState<ProgressStep[]>(DISPLAY_STEPS);
  const [displayElapsedTime, setDisplayElapsedTime] = useState<number>(0);
  const [displayActiveStepMessage, setDisplayActiveStepMessage] = useState<string>("");
  const [isDisplayDownloadOpen, setIsDisplayDownloadOpen] = useState<boolean>(false);

  // Booster Studio states
  const [boosterFile, setBoosterFile] = useState<File | null>(null);
  const [boosterPreviewUrl, setBoosterPreviewUrl] = useState<string | null>(null);
  const [boosterResultUrl, setBoosterResultUrl] = useState<string | null>(null);
  const [boosterCutoutUrl, setBoosterCutoutUrl] = useState<string | null>(null);
  const [boosterBgUrl, setBoosterBgUrl] = useState<string | null>(null);
  const [isBoosterProcessing, setIsBoosterProcessing] = useState<boolean>(false);
  const [boosterErrorMessage, setBoosterErrorMessage] = useState<string | null>(null);
  const [boosterAspectRatio, setBoosterAspectRatio] = useState<string>("3:4");
  const [boosterBgMode, setBoosterBgMode] = useState<"outpaint" | "ambient" | "transparent">("transparent");
  const [boosterSteps, setBoosterSteps] = useState<ProgressStep[]>(BOOSTER_STEPS);
  const [boosterElapsedTime, setBoosterElapsedTime] = useState<number>(0);
  const [boosterActiveStepMessage, setBoosterActiveStepMessage] = useState<string>("");
  const [isBoosterDownloadOpen, setIsBoosterDownloadOpen] = useState<boolean>(false);

  // Watermark logo states
  const [watermarkFile, setWatermarkFile] = useState<File | null>(null);
  const [watermarkPreviewUrl, setWatermarkPreviewUrl] = useState<string | null>(null);
  const [watermarkOpacity, setWatermarkOpacity] = useState<number>(0.33); // default 33% opacity
  const [watermarkPosition, setWatermarkPosition] = useState<string>("bottom-center");
  const [watermarkScale, setWatermarkScale] = useState<number>(0.15); // default 15% width scale

  // Upload base64 image data URL to Supabase Storage
  const uploadBase64ToSupabase = async (base64Data: string, path: string): Promise<string> => {
    const matches = base64Data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.*)$/);
    if (!matches || matches.length !== 3) {
      throw new Error("Invalid base64 string format");
    }
    const mimeType = matches[1];
    const rawBase64 = matches[2];

    const binaryStr = window.atob(rawBase64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });

    const { error } = await supabase.storage
      .from("tcg-artworks")
      .upload(path, blob, {
        contentType: mimeType,
        upsert: true
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from("tcg-artworks")
      .getPublicUrl(path);

    return publicUrl;
  };

  // Handle ESC key to close lightbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightboxImage(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Load saved session on mount and load artworks
  useEffect(() => {
    const loadSessionAndArtworks = async () => {
      if (isLocalMode) {
        // Local mode: load from IndexedDB
        const legacyData = localStorage.getItem("tcg_art_library");
        if (legacyData) {
          try {
            const migrated = await migrateFromLocalStorage();
            setSavedArtworks(migrated);
            return;
          } catch (e) {
            console.error("Failed to migrate legacy localStorage artworks:", e);
          }
        }
        try {
          const artworks = await getSavedArtworks();
          setSavedArtworks(artworks);
        } catch (e) {
          console.error("Failed to load artworks from IndexedDB:", e);
        }
        return;
      }

      // Supabase mode: check session
      const savedSpace = localStorage.getItem("tcg_current_space");
      if (savedSpace) {
        try {
          const space = JSON.parse(savedSpace);
          setCurrentSpace(space);
          
          setIsSpaceSyncing(true);

          // If legacy data exists, migrate it to the current space in Supabase!
          const legacyData = localStorage.getItem("tcg_art_library");
          if (legacyData) {
            try {
              const artworks = JSON.parse(legacyData);
              for (const art of artworks) {
                let imageUrl = art.imageUrl;
                let originalCardUrl = art.originalCardUrl;
                let backgroundUrl = art.backgroundUrl;
                
                if (imageUrl.startsWith("data:image/")) {
                  imageUrl = await uploadBase64ToSupabase(imageUrl, `spaces/${space.id}/${art.id}/final.png`);
                }
                if (originalCardUrl && originalCardUrl.startsWith("data:image/")) {
                  originalCardUrl = await uploadBase64ToSupabase(originalCardUrl, `spaces/${space.id}/${art.id}/card.png`);
                }
                if (backgroundUrl && backgroundUrl.startsWith("data:image/")) {
                  backgroundUrl = await uploadBase64ToSupabase(backgroundUrl, `spaces/${space.id}/${art.id}/bg.png`);
                }
                
                await supabase.from("artworks").insert({
                  id: art.id,
                  space_id: space.id,
                  name: art.name,
                  image_url: imageUrl,
                  original_card_url: originalCardUrl || null,
                  background_url: backgroundUrl || null,
                  aspect_ratio: art.aspectRatio,
                  timestamp: art.timestamp
                });
              }
              localStorage.removeItem("tcg_art_library");
              console.log(`Successfully migrated ${artworks.length} items from localStorage to Supabase.`);
            } catch (migErr) {
              console.error("Failed to migrate legacy localStorage to Supabase:", migErr);
            }
          }
          
          // Fetch artworks
          const { data, error } = await supabase
            .from("artworks")
            .select("*")
            .eq("space_id", space.id)
            .order("timestamp", { ascending: false });

          if (error) throw error;

          const formatted: SavedArtwork[] = ((data as DbArtwork[]) || []).map((row) => {
            const dbOriginalCardUrl = row.original_card_url || undefined;
            let originalCardUrl = dbOriginalCardUrl;
            let cardOnlyUrl: string | undefined = undefined;
            let isDisplay = false;
            let isBooster = false;

            if (dbOriginalCardUrl && dbOriginalCardUrl.includes("?card_only=")) {
              const parts = dbOriginalCardUrl.split("?card_only=");
              originalCardUrl = parts[0];
              const queryPart = parts[1];
              if (queryPart.includes("&is_display=true")) {
                isDisplay = true;
                cardOnlyUrl = decodeURIComponent(queryPart.replace("&is_display=true", ""));
              } else if (queryPart.includes("&is_booster=true")) {
                isBooster = true;
                cardOnlyUrl = decodeURIComponent(queryPart.replace("&is_booster=true", ""));
              } else {
                cardOnlyUrl = decodeURIComponent(queryPart);
              }
            }

            const isCase = originalCardUrl ? (originalCardUrl.includes("case_with_card") || originalCardUrl.includes("/case_with_card")) : false;
            
            // Fallback for new artworks where card_only.png is in storage but not in url query (e.g. from previous steps)
            if (isCase && !cardOnlyUrl && originalCardUrl && Number(row.timestamp) > 1782300000000) {
              if (originalCardUrl.includes("case_with_card.png")) {
                cardOnlyUrl = originalCardUrl.replace("case_with_card.png", "card_only.png");
              }
            }

            return {
              id: row.id,
              name: row.name,
              imageUrl: row.image_url,
              originalCardUrl: originalCardUrl,
              backgroundUrl: row.background_url || undefined,
              cardOnlyUrl: cardOnlyUrl,
              aspectRatio: row.aspect_ratio,
              timestamp: Number(row.timestamp),
              isCase: isCase,
              isDisplay: isDisplay,
              isBooster: isBooster
            };
          });
          setSavedArtworks(formatted);
        } catch (e) {
          console.error("Failed to restore session or fetch artworks:", e);
          localStorage.removeItem("tcg_current_space");
        } finally {
          setIsSpaceSyncing(false);
        }
      }
    };

    loadSessionAndArtworks();
  }, []);

  const checkSpaceExists = async () => {
    if (!loginSpaceName.trim()) return;
    setLoginError(null);
    setIsLoginLoading(true);

    try {
      const { data, error } = await supabase
        .from("spaces")
        .select("id")
        .ilike("name", loginSpaceName.trim())
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setLoginStep("code");
      } else {
        setLoginStep("create");
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setLoginError(message || "Überprüfung der Bereichsverfügbarkeit fehlgeschlagen.");
    } finally {
      setIsLoginLoading(false);
    }
  };

  const handleSpaceLogin = async () => {
    if (!loginSpaceName.trim() || loginPasscode.length !== 4) return;
    setLoginError(null);
    setIsLoginLoading(true);

    try {
      const { data, error } = await supabase.rpc("verify_space", {
        space_name: loginSpaceName.trim(),
        space_passcode: loginPasscode
      });

      if (error) throw error;

      if (data && data.length > 0) {
        const loggedInSpace = { id: data[0].id, name: data[0].name };
        setCurrentSpace(loggedInSpace);
        
        if (isKeepLoggedIn) {
          localStorage.setItem("tcg_current_space", JSON.stringify(loggedInSpace));
        }

        setIsSpaceSyncing(true);

        // Fetch artworks
        const { data: arts, error: artsError } = await supabase
          .from("artworks")
          .select("*")
          .eq("space_id", loggedInSpace.id)
          .order("timestamp", { ascending: false });

        if (artsError) throw artsError;

        const formatted: SavedArtwork[] = ((arts as DbArtwork[]) || []).map((row) => {
          const dbOriginalCardUrl = row.original_card_url || undefined;
          let originalCardUrl = dbOriginalCardUrl;
          let cardOnlyUrl: string | undefined = undefined;
          let isDisplay = false;
          let isBooster = false;

          if (dbOriginalCardUrl && dbOriginalCardUrl.includes("?card_only=")) {
            const parts = dbOriginalCardUrl.split("?card_only=");
            originalCardUrl = parts[0];
            const queryPart = parts[1];
            if (queryPart.includes("&is_display=true")) {
              isDisplay = true;
              cardOnlyUrl = decodeURIComponent(queryPart.replace("&is_display=true", ""));
            } else if (queryPart.includes("&is_booster=true")) {
              isBooster = true;
              cardOnlyUrl = decodeURIComponent(queryPart.replace("&is_booster=true", ""));
            } else {
              cardOnlyUrl = decodeURIComponent(queryPart);
            }
          }

          const isCase = originalCardUrl ? (originalCardUrl.includes("case_with_card") || originalCardUrl.includes("/case_with_card")) : false;
          
          // Fallback for new artworks where card_only.png is in storage but not in url query
          if (isCase && !cardOnlyUrl && originalCardUrl && Number(row.timestamp) > 1782300000000) {
            if (originalCardUrl.includes("case_with_card.png")) {
              cardOnlyUrl = originalCardUrl.replace("case_with_card.png", "card_only.png");
            }
          }

          return {
            id: row.id,
            name: row.name,
            imageUrl: row.image_url,
            originalCardUrl: originalCardUrl,
            backgroundUrl: row.background_url || undefined,
            cardOnlyUrl: cardOnlyUrl,
            aspectRatio: row.aspect_ratio,
            timestamp: Number(row.timestamp),
            isCase: isCase,
            isDisplay: isDisplay,
            isBooster: isBooster
          };
        });
        setSavedArtworks(formatted);
        
        setLoginSpaceName("");
        setLoginPasscode("");
        setLoginStep("name");
      } else {
        setLoginError("Falscher 4-stelliger Passcode.");
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setLoginError(message || "Ein Fehler ist beim Anmelden aufgetreten.");
    } finally {
      setIsLoginLoading(false);
      setIsSpaceSyncing(false);
    }
  };

  const handleCreateSpace = async () => {
    if (!loginSpaceName.trim() || loginPasscode.length !== 4) return;
    setLoginError(null);
    setIsLoginLoading(true);

    try {
      const { data, error } = await supabase
        .from("spaces")
        .insert({
          name: loginSpaceName.trim(),
          passcode: loginPasscode
        })
        .select("id, name")
        .single();

      if (error) throw error;

      if (data) {
        setCurrentSpace(data);
        if (isKeepLoggedIn) {
          localStorage.setItem("tcg_current_space", JSON.stringify(data));
        }
        setSavedArtworks([]);
        
        setLoginSpaceName("");
        setLoginPasscode("");
        setLoginStep("name");
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setLoginError(message || "Bereich konnte nicht erstellt werden.");
    } finally {
      setIsLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setCurrentSpace(null);
    setSavedArtworks([]);
    localStorage.removeItem("tcg_current_space");
  };

  const handleRenameArtwork = async () => {
    if (!renamingArtwork || !renameValue.trim()) return;

    if (!isLocalMode && currentSpace) {
      setIsLoginLoading(true);
      try {
        const { data, error } = await supabase
          .from("artworks")
          .update({ name: renameValue.trim() })
          .eq("id", renamingArtwork.id)
          .select("id");

        if (error) throw error;
        if (!data || data.length === 0) {
          throw new Error("No rows were updated. Make sure you executed the UPDATE RLS policy in Supabase.");
        }
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to rename artwork in database: " + message);
        setIsLoginLoading(false);
        return;
      } finally {
        setIsLoginLoading(false);
      }
    } else {
      try {
        const updatedArt = { ...renamingArtwork, name: renameValue.trim() };
        await saveArtwork(updatedArt);
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to rename artwork locally: " + message);
        return;
      }
    }

    setSavedArtworks(prev =>
      prev.map(art => (art.id === renamingArtwork.id ? { ...art, name: renameValue.trim() } : art))
    );
    setIsRenameModalOpen(false);
    setRenamingArtwork(null);
  };

  const handleFindCardName = async (art: SavedArtwork) => {
    const targetUrl = art.originalCardUrl || art.cardOnlyUrl || art.imageUrl;
    if (!targetUrl) {
      alert("No image available to identify.");
      return;
    }

    setIdentifyingArtworkId(art.id);
    
    try {
      const response = await fetch("/api/pipeline/identify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ imageUrl: targetUrl }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to analyze card name.");
      }

      const data = await response.json();
      if (data.isFound && data.cardName) {
        let finalName = data.cardName.trim();
        if (data.cardNumber && data.cardNumber.trim()) {
          finalName += " " + data.cardNumber.trim();
        }

        if (!isLocalMode && currentSpace) {
          setIsLoginLoading(true);
          try {
            const { data: updateData, error } = await supabase
              .from("artworks")
              .update({ name: finalName })
              .eq("id", art.id)
              .select("id");

            if (error) throw error;
            if (!updateData || updateData.length === 0) {
              throw new Error("No rows were updated. Make sure you executed the UPDATE RLS policy in Supabase.");
            }
          } catch (err) {
            const message = getErrorMessage(err);
            alert("Failed to update card name in database: " + message);
            return;
          } finally {
            setIsLoginLoading(false);
          }
        } else {
          try {
            const updatedArt = { ...art, name: finalName };
            await saveArtwork(updatedArt);
          } catch (err) {
            const message = getErrorMessage(err);
            alert("Failed to update card name locally: " + message);
            return;
          }
        }

        setSavedArtworks(prev =>
          prev.map(item => (item.id === art.id ? { ...item, name: finalName } : item))
        );

        let msg = `Successfully identified card!\nName: ${data.cardName}`;
        if (data.cardNumber) msg += `\nNumber: ${data.cardNumber}`;
        if (data.detectedLanguage && data.detectedLanguage.toLowerCase() !== "english") {
          msg += `\nDetected Language: ${data.detectedLanguage} (Translated to English)`;
        }
        alert(msg);
      } else {
        alert("Could not identify the card name or number from the image.");
      }
    } catch (error: any) {
      console.error("Error identifying card name:", error);
      alert("Error identifying card: " + error.message);
    } finally {
      setIdentifyingArtworkId(null);
    }
  };

  const closeSaveModal = () => {
    if (isSaving) return;
    setIsSaveModalOpen(false);
    setNewArtworkName("");
    setLibraryUploadDataUrl(null);
    setIsSaving(false);
  };

  const handleSaveArtwork = async () => {
    const targetUrl = 
      saveTarget === "case" ? caseResultUrl : 
      saveTarget === "upload" ? libraryUploadDataUrl : 
      saveTarget === "display" ? displayResultUrl :
      saveTarget === "booster" ? boosterResultUrl :
      resultImageUrl;

    if (!targetUrl || !newArtworkName.trim()) return;

    const artId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();

    let imageUrl = targetUrl;
    let originalCardUrl = 
      saveTarget === "generate" ? (trimmedCard || undefined) : 
      saveTarget === "case" ? (caseWithCardUrl || caseCardImage || undefined) : 
      saveTarget === "display" ? (displayPreviewUrl || undefined) :
      saveTarget === "booster" ? (boosterPreviewUrl || undefined) :
      undefined;
    let backgroundUrl = 
      saveTarget === "generate" ? (backgroundImageUrl || undefined) : 
      saveTarget === "case" ? (caseBgResultUrl || caseBgImage || undefined) : 
      saveTarget === "display" ? (displayBgUrl || undefined) :
      saveTarget === "booster" ? (boosterBgUrl || undefined) :
      undefined;

    const timestamp = Date.now();
    setIsSaving(true);

    if (!isLocalMode && currentSpace) {
      setIsLoginLoading(true);
      try {
        if (imageUrl.startsWith("data:image/")) {
          imageUrl = await uploadBase64ToSupabase(imageUrl, `spaces/${currentSpace.id}/${artId}/final.png`);
        }
        if (saveTarget === "display" && displayFile) {
          const path = `spaces/${currentSpace.id}/${artId}/display_original.png`;
          const { error: uploadError } = await supabase.storage
            .from("tcg-artworks")
            .upload(path, displayFile, { contentType: displayFile.type, upsert: true });
          if (!uploadError) {
            const { data: { publicUrl } } = supabase.storage
              .from("tcg-artworks")
              .getPublicUrl(path);
            originalCardUrl = publicUrl;
          }
        } else if (saveTarget === "booster" && boosterFile) {
          const path = `spaces/${currentSpace.id}/${artId}/booster_original.png`;
          const { error: uploadError } = await supabase.storage
            .from("tcg-artworks")
            .upload(path, boosterFile, { contentType: boosterFile.type, upsert: true });
          if (!uploadError) {
            const { data: { publicUrl } } = supabase.storage
              .from("tcg-artworks")
              .getPublicUrl(path);
            originalCardUrl = publicUrl;
          }
        } else if (originalCardUrl && originalCardUrl.startsWith("data:image/")) {
          const filename = saveTarget === "case" ? "case_with_card.png" : "card.png";
          originalCardUrl = await uploadBase64ToSupabase(originalCardUrl, `spaces/${currentSpace.id}/${artId}/${filename}`);
        }
        if (backgroundUrl && backgroundUrl.startsWith("data:image/")) {
          backgroundUrl = await uploadBase64ToSupabase(backgroundUrl, `spaces/${currentSpace.id}/${artId}/bg.png`);
        }

        let cardOnlyUrl: string | undefined = undefined;
        if (saveTarget === "case" && caseCardImage) {
          if (caseCardImage.startsWith("data:image/")) {
            cardOnlyUrl = await uploadBase64ToSupabase(caseCardImage, `spaces/${currentSpace.id}/${artId}/card_only.png`);
          } else {
            try {
              const res = await fetch(caseCardImage);
              if (res.ok) {
                const blob = await res.blob();
                const path = `spaces/${currentSpace.id}/${artId}/card_only.png`;
                const { error: uploadError } = await supabase.storage
                  .from("tcg-artworks")
                  .upload(path, blob, { contentType: blob.type, upsert: true });
                if (!uploadError) {
                  const { data: { publicUrl } } = supabase.storage
                    .from("tcg-artworks")
                    .getPublicUrl(path);
                  cardOnlyUrl = publicUrl;
                }
              }
            } catch (e) {
              console.error("Failed to copy card image to card_only.png:", e);
              cardOnlyUrl = caseCardImage;
            }
          }
        } else if (saveTarget === "display" && displayCutoutUrl) {
          if (displayCutoutUrl.startsWith("data:image/")) {
            cardOnlyUrl = await uploadBase64ToSupabase(displayCutoutUrl, `spaces/${currentSpace.id}/${artId}/display_cutout.png`);
          }
        } else if (saveTarget === "booster" && boosterCutoutUrl) {
          if (boosterCutoutUrl.startsWith("data:image/")) {
            cardOnlyUrl = await uploadBase64ToSupabase(boosterCutoutUrl, `spaces/${currentSpace.id}/${artId}/booster_cutout.png`);
          }
        }

        if ((saveTarget === "case" || saveTarget === "display" || saveTarget === "booster") && originalCardUrl && cardOnlyUrl) {
          originalCardUrl = `${originalCardUrl}?card_only=${encodeURIComponent(cardOnlyUrl)}${
            saveTarget === "display" ? "&is_display=true" : 
            saveTarget === "booster" ? "&is_booster=true" : ""
          }`;
        }

        const { error } = await supabase
          .from("artworks")
          .insert({
            id: artId,
            space_id: currentSpace.id,
            name: newArtworkName.trim(),
            image_url: imageUrl,
            original_card_url: originalCardUrl || null,
            background_url: backgroundUrl || null,
            aspect_ratio: 
              saveTarget === "upload" ? libraryUploadAspectRatio : 
              saveTarget === "display" ? displayAspectRatio : 
              saveTarget === "booster" ? boosterAspectRatio :
              aspectRatio,
            timestamp: timestamp
          });

        if (error) throw error;
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to save artwork to database: " + message);
        setIsLoginLoading(false);
        setIsSaving(false);
        return;
      } finally {
        setIsLoginLoading(false);
      }
    } else {
      const localArtwork: SavedArtwork = {
        id: artId,
        name: newArtworkName.trim(),
        imageUrl: imageUrl,
        originalCardUrl: originalCardUrl,
        backgroundUrl: backgroundUrl,
        cardOnlyUrl: 
          saveTarget === "case" ? (caseCardImage || undefined) : 
          saveTarget === "display" ? (displayCutoutUrl || undefined) : 
          saveTarget === "booster" ? (boosterCutoutUrl || undefined) :
          undefined,
        aspectRatio: 
          saveTarget === "upload" ? libraryUploadAspectRatio : 
          saveTarget === "display" ? displayAspectRatio : 
          saveTarget === "booster" ? boosterAspectRatio :
          aspectRatio,
        timestamp: timestamp,
        isCase: saveTarget === "case",
        isDisplay: saveTarget === "display",
        isBooster: saveTarget === "booster"
      };

      try {
        await saveArtwork(localArtwork);
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to save artwork locally: " + message);
        setIsSaving(false);
        return;
      }
    }

    // Reconstruct cardOnlyUrl in memory for the updated state (either local or supabase-predicted)
    let finalCardOnlyUrl: string | undefined = undefined;
    let finalOriginalCardUrl = originalCardUrl;
    if (saveTarget === "case" || saveTarget === "display" || saveTarget === "booster") {
      if (!isLocalMode && currentSpace) {
        if (originalCardUrl && originalCardUrl.includes("?card_only=")) {
          const parts = originalCardUrl.split("?card_only=");
          finalOriginalCardUrl = parts[0];
          const queryPart = parts[1];
          if (queryPart.includes("&is_display=true")) {
            finalCardOnlyUrl = decodeURIComponent(queryPart.replace("&is_display=true", ""));
          } else if (queryPart.includes("&is_booster=true")) {
            finalCardOnlyUrl = decodeURIComponent(queryPart.replace("&is_booster=true", ""));
          } else {
            finalCardOnlyUrl = decodeURIComponent(queryPart);
          }
        } else if (originalCardUrl && originalCardUrl.includes("case_with_card.png")) {
          finalCardOnlyUrl = originalCardUrl.replace("case_with_card.png", "card_only.png");
        } else {
          finalCardOnlyUrl = 
            saveTarget === "case" ? (caseCardImage || undefined) : 
            saveTarget === "display" ? (displayCutoutUrl || undefined) :
            (boosterCutoutUrl || undefined);
        }
      } else {
        finalCardOnlyUrl = 
          saveTarget === "case" ? (caseCardImage || undefined) : 
          saveTarget === "display" ? (displayCutoutUrl || undefined) :
          (boosterCutoutUrl || undefined);
      }
    }

    const newArtworkRecord: SavedArtwork = {
      id: artId,
      name: newArtworkName.trim(),
      imageUrl: imageUrl,
      originalCardUrl: finalOriginalCardUrl,
      backgroundUrl: backgroundUrl,
      cardOnlyUrl: finalCardOnlyUrl,
      aspectRatio: 
        saveTarget === "upload" ? libraryUploadAspectRatio : 
        saveTarget === "display" ? displayAspectRatio : 
        saveTarget === "booster" ? boosterAspectRatio :
        aspectRatio,
      timestamp: timestamp,
      isCase: saveTarget === "case",
      isDisplay: saveTarget === "display",
      isBooster: saveTarget === "booster"
    };

    const updated = [newArtworkRecord, ...savedArtworks];
    setSavedArtworks(updated);
    setIsSaving(false);
    closeSaveModal();
  };

  const handleDeleteArtwork = async (id: string) => {
    const art = savedArtworks.find(a => a.id === id);
    const artName = art ? art.name : "this artwork";
    if (!confirm(`Are you sure you want to delete "${artName}"?`)) {
      return;
    }

    if (!isLocalMode && currentSpace) {
      try {
        const { data, error: dbError } = await supabase
          .from("artworks")
          .delete()
          .eq("id", id)
          .select("id");

        if (dbError) throw dbError;
        if (!data || data.length === 0) {
          throw new Error("No rows were deleted. Make sure you executed the DELETE RLS policy in Supabase.");
        }

        try {
          await supabase.storage
            .from("tcg-artworks")
            .remove([
              `spaces/${currentSpace.id}/${id}/final.png`,
              `spaces/${currentSpace.id}/${id}/card.png`,
              `spaces/${currentSpace.id}/${id}/bg.png`
            ]);
        } catch (storageErr) {
          console.warn("Storage cleanup failed:", storageErr);
        }

        const updated = savedArtworks.filter(art => art.id !== id);
        setSavedArtworks(updated);
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to delete artwork from database: " + message);
      }
    } else {
      try {
        await deleteArtwork(id);
        const updated = savedArtworks.filter(art => art.id !== id);
        setSavedArtworks(updated);
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to delete artwork locally: " + message);
      }
    }
  };

  const handleSelectArtworkForCase = (id: string) => {
    const art = savedArtworks.find(a => a.id === id);
    if (!art) return;
    
    setSelectedArtworkId(id);
    setCaseErrorMessage(null);
    
    // Check if this artwork is a saved Case showcase
    const isSavedCase = art.isCase || !!(art.originalCardUrl && (art.originalCardUrl.includes("case_with_card") || art.originalCardUrl.includes("/case_with_card")));
    
    if (isSavedCase) {
      setCaseResultUrl(art.imageUrl);
      setCaseWithCardUrl(art.originalCardUrl || null);
      setCaseBgResultUrl(art.backgroundUrl || null);
      setCaseCardImage(art.cardOnlyUrl || art.originalCardUrl || null);
      setCaseBgImage(art.backgroundUrl || null);
      setIsCaseOverlayLoaded(true);
    } else {
      setCaseResultUrl(null);
      setCaseWithCardUrl(null);
      setCaseBgResultUrl(null);
      setIsCaseOverlayLoaded(false);
      
      if (art.originalCardUrl && art.backgroundUrl) {
        setCaseCardImage(art.originalCardUrl);
        setCaseBgImage(art.backgroundUrl);
      } else {
        // Use the final composite / uploaded image as the card, and use an ambient background
        setCaseCardImage(art.imageUrl);
        setCaseBgImage("ambient");
      }
    }
  };

  const handleProcessCaseImage = async () => {
    if (!caseCardImage || !caseBgImage) return;
    setIsCaseProcessing(true);
    setCaseErrorMessage(null);
    setCaseResultUrl(null);
    setCaseWithCardUrl(null);
    setCaseBgResultUrl(null);

    try {
      const response = await fetch("/api/pipeline/case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardImage: caseCardImage,
          backgroundImage: caseBgImage === "ambient" ? null : caseBgImage,
          isCaseOverlay: isCaseOverlayLoaded
        })
      });

      const { 
        resultImageUrl, 
        caseWithCardUrl: newCaseWithCardUrl, 
        backgroundImageUrl: newCaseBgResultUrl 
      } = await parseResponseData(
        response,
        "Failed to generate case showcase."
      );
      setCaseResultUrl(resultImageUrl);
      setCaseWithCardUrl(newCaseWithCardUrl || null);
      setCaseBgResultUrl(newCaseBgResultUrl || null);
    } catch (err) {
      const message = getErrorMessage(err);
      console.error("Case generation error:", err);
      setCaseErrorMessage(message || "An unexpected error occurred during case rendering.");
    } finally {
      setIsCaseProcessing(false);
    }
  };
  
  // Timer & active messages
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [activeStepMessage, setActiveStepMessage] = useState<string>("");
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleCancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const abortDisplayControllerRef = useRef<AbortController | null>(null);

  const handleCancelDisplayProcessing = () => {
    if (abortDisplayControllerRef.current) {
      abortDisplayControllerRef.current.abort();
    }
  };

  const abortBoosterControllerRef = useRef<AbortController | null>(null);

  const handleCancelBoosterProcessing = () => {
    if (abortBoosterControllerRef.current) {
      abortBoosterControllerRef.current.abort();
    }
  };

  useEffect(() => {
    if (isProcessing) {
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedTime((Date.now() - startTime) / 1000);
      }, 100);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isProcessing]);

  const displayTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isDisplayProcessing) {
      const startTime = Date.now();
      displayTimerRef.current = setInterval(() => {
        setDisplayElapsedTime((Date.now() - startTime) / 1000);
      }, 100);
    } else {
      if (displayTimerRef.current) {
        clearInterval(displayTimerRef.current);
      }
    }
    return () => {
      if (displayTimerRef.current) {
        clearInterval(displayTimerRef.current);
      }
    };
  }, [isDisplayProcessing]);

  const boosterTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isBoosterProcessing) {
      const startTime = Date.now();
      boosterTimerRef.current = setInterval(() => {
        setBoosterElapsedTime((Date.now() - startTime) / 1000);
      }, 100);
    } else {
      if (boosterTimerRef.current) {
        clearInterval(boosterTimerRef.current);
      }
    }
    return () => {
      if (boosterTimerRef.current) {
        clearInterval(boosterTimerRef.current);
      }
    };
  }, [isBoosterProcessing]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      setFile(selectedFile);
      setPreviewUrl(URL.createObjectURL(selectedFile));
      setResultImageUrl(null);
      setErrorMessage(null);
      setUsedAmbientFallback(false);
      setUsedCropFallback(false);
      setTrimmedCard(null);
      setSteps(INITIAL_STEPS.map(s => ({ ...s, status: "idle" })));
      setElapsedTime(0);
      setActiveStepMessage("");
      setNewArtworkName("");
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png", ".webp"]
    },
    maxFiles: 1,
    disabled: isProcessing
  });

  const onDisplayDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      setDisplayFile(selectedFile);
      setDisplayPreviewUrl(URL.createObjectURL(selectedFile));
      setDisplayResultUrl(null);
      setDisplayCutoutUrl(null);
      setDisplayBgUrl(null);
      setDisplayErrorMessage(null);
      setDisplaySteps(DISPLAY_STEPS.map(s => ({ ...s, status: "idle" })));
      setDisplayElapsedTime(0);
      setDisplayActiveStepMessage("");
      setNewArtworkName("");
    }
  }, []);

  const {
    getRootProps: getDisplayRootProps,
    getInputProps: getDisplayInputProps,
    isDragActive: isDisplayDragActive
  } = useDropzone({
    onDrop: onDisplayDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png", ".webp"]
    },
    maxFiles: 1,
    disabled: isDisplayProcessing
  });

  const onBoosterDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      setBoosterFile(selectedFile);
      setBoosterPreviewUrl(URL.createObjectURL(selectedFile));
      setBoosterResultUrl(null);
      setBoosterCutoutUrl(null);
      setBoosterBgUrl(null);
      setBoosterErrorMessage(null);
      setBoosterSteps(BOOSTER_STEPS.map(s => ({ ...s, status: "idle" })));
      setBoosterElapsedTime(0);
      setBoosterActiveStepMessage("");
      setNewArtworkName("");
    }
  }, []);

  const {
    getRootProps: getBoosterRootProps,
    getInputProps: getBoosterInputProps,
    isDragActive: isBoosterDragActive
  } = useDropzone({
    onDrop: onBoosterDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png", ".webp"]
    },
    maxFiles: 1,
    disabled: isBoosterProcessing
  });

  const onLibraryDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      try {
        const dataUrl = await fileToDataUrl(selectedFile);
        
        let detectedRatio = "3:4";
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve) => {
          img.onload = () => {
            const ratio = img.width / img.height;
            let ratioStr = `${img.width}:${img.height}`;
            const rounded = Math.round(ratio * 100) / 100;
            if (Math.abs(rounded - 0.75) < 0.05) ratioStr = "3:4";
            else if (Math.abs(rounded - 1.0) < 0.05) ratioStr = "1:1";
            else if (Math.abs(rounded - 0.56) < 0.05) ratioStr = "9:16";
            else if (Math.abs(rounded - 1.78) < 0.05) ratioStr = "16:9";
            else {
              const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
              const divisor = gcd(img.width, img.height);
              ratioStr = `${img.width / divisor}:${img.height / divisor}`;
              if (ratioStr.length > 7) {
                ratioStr = rounded.toString();
              }
            }
            detectedRatio = ratioStr;
            resolve(true);
          };
          img.onerror = () => {
            resolve(false);
          };
        });

        setLibraryUploadDataUrl(dataUrl);
        setLibraryUploadAspectRatio(detectedRatio);
        setSaveTarget("upload");
        setNewArtworkName(selectedFile.name.replace(/\.[^/.]+$/, ""));
        setIsSaveModalOpen(true);
      } catch (err) {
        console.error("Failed to read dropped file:", err);
        alert("Failed to read image file.");
      }
    }
  }, []);

  const {
    getRootProps: getLibraryRootProps,
    getInputProps: getLibraryInputProps,
    isDragActive: isLibraryDragActive
  } = useDropzone({
    onDrop: onLibraryDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png", ".webp"]
    },
    maxFiles: 1,
    noClick: true
  });

  // Listen for paste event to allow pasting images directly from clipboard (Ctrl+V / Cmd+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const pastedFile = items[i].getAsFile();
          if (pastedFile) {
            e.preventDefault();
            if (activeTab === "generate") {
              if (activeStudioSubTab === "card") {
                if (!isProcessing) {
                  onDrop([pastedFile]);
                }
              } else if (activeStudioSubTab === "display") {
                if (!isDisplayProcessing) {
                  onDisplayDrop([pastedFile]);
                }
              } else if (activeStudioSubTab === "booster") {
                if (!isBoosterProcessing) {
                  onBoosterDrop([pastedFile]);
                }
              }
            } else if (activeTab === "library") {
              onLibraryDrop([pastedFile]);
            }
          }
          break;
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [activeTab, activeStudioSubTab, isProcessing, isDisplayProcessing, isBoosterProcessing, onDrop, onDisplayDrop, onBoosterDrop, onLibraryDrop]);

  const updateStepStatus = (stepId: string, status: "running" | "success" | "error") => {
    setSteps(prev => 
      prev.map(step => {
        if (step.id === stepId) {
          return { ...step, status };
        }
        if (status === "success" && prev.findIndex(s => s.id === stepId) > prev.findIndex(s => s.id === step.id)) {
          return { ...step, status: "success" };
        }
        return step;
      })
    );
  };

  const updateDisplayStepStatus = (stepId: string, status: "running" | "success" | "error") => {
    setDisplaySteps(prev => 
      prev.map(step => {
        if (step.id === stepId) {
          return { ...step, status };
        }
        if (status === "success" && prev.findIndex(s => s.id === stepId) > prev.findIndex(s => s.id === step.id)) {
          return { ...step, status: "success" };
        }
        return step;
      })
    );
  };

  const updateBoosterStepStatus = (stepId: string, status: "running" | "success" | "error") => {
    setBoosterSteps(prev => 
      prev.map(step => {
        if (step.id === stepId) {
          return { ...step, status };
        }
        if (status === "success" && prev.findIndex(s => s.id === stepId) > prev.findIndex(s => s.id === step.id)) {
          return { ...step, status: "success" };
        }
        return step;
      })
    );
  };

  const handleProcessImage = async () => {
    if (!file) return;
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    setIsProcessing(true);
    setErrorMessage(null);
    setResultImageUrl(null);
    setUsedAmbientFallback(false);
    setUsedCropFallback(false);
    setTrimmedCard(null);
    setElapsedTime(0);
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: "idle" })));

    try {
      // STEP 1 & 2: Bounding Box Detection & Crop
      updateStepStatus("LAYOUT", "running");
      setActiveStepMessage("Locating artwork bounding box...");
      
      const cropFormData = new FormData();
      cropFormData.append("cardImage", file);
      cropFormData.append("skipCardCrop", String(!shouldCropCard));

      const cropResponse = await fetch("/api/pipeline/crop", {
        method: "POST",
        body: cropFormData,
        signal
      });

      const { 
        croppedImage, 
        trimmedCard: cropTrimmedCard, 
        usedFallback: cropFallback,
        cardName,
        cardNumber
      } = await parseResponseData(
        cropResponse,
        "Failed to analyze and crop card artwork."
      );
      setUsedCropFallback(cropFallback || false);
      setTrimmedCard(cropTrimmedCard || null);
      updateStepStatus("LAYOUT", "success");
      updateStepStatus("CROP", "success");

      // Auto-populate card name and number detected by Gemini
      let detectedName = "";
      if (cardName && cardName.trim()) {
        detectedName += cardName.trim();
      }
      if (cardNumber && cardNumber.trim()) {
        if (detectedName) detectedName += " ";
        detectedName += cardNumber.trim();
      }
      if (detectedName) {
        setNewArtworkName(detectedName);
      }

      // STEP 3: Outpainting with style analysis & Imagen 3
      updateStepStatus("OUTPAINT", "running");
      setActiveStepMessage("Analyzing style with Gemini...");

      const outpaintResponse = await fetchWithRetry(
        "/api/pipeline/outpaint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ croppedImage, aspectRatio, mode: bgMode }),
          signal
        },
        2,
        1500,
        (msg) => setActiveStepMessage(msg)
      );

      const { backgroundImage, usedFallback, fallbackReason } = await parseResponseData(
        outpaintResponse,
        "Failed to outpaint and extend background."
      );
      setBackgroundImageUrl(backgroundImage);
      setUsedAmbientFallback(usedFallback || false);
      setAmbientFallbackReason(fallbackReason || "");
      updateStepStatus("OUTPAINT", "success");

      // STEP 4: Merge card + shadow over background
      updateStepStatus("MERGE", "running");
      setActiveStepMessage("Overlaying card with 3D drop shadow...");

      const mergeResponse = await fetch("/api/pipeline/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          originalImage: cropTrimmedCard || trimmedCard, 
          backgroundImage,
          isTrimmed: !!(cropTrimmedCard || trimmedCard)
        }),
        signal
      });

      const { resultImageUrl } = await parseResponseData(
        mergeResponse,
        "Failed to merge card and background."
      );
      updateStepStatus("MERGE", "success");
      setResultImageUrl(resultImageUrl);
      setActiveStepMessage("Completed!");

    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setErrorMessage("Die Bildgenerierung wurde abgebrochen.");
        setSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "error" } : s));
        return;
      }
      const message = getErrorMessage(error);
      console.error("Pipeline error:", error);
      setErrorMessage(message || "An unexpected error occurred during processing.");
      
      // Mark current running step as error
      setSteps(prev => {
        const runningIdx = prev.findIndex(s => s.status === "running" || s.status === "idle");
        if (runningIdx !== -1) {
          return prev.map((s, idx) => idx === runningIdx ? { ...s, status: "error" } : s);
        }
        return prev;
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProcessDisplayImage = async () => {
    if (!displayFile) return;
    setIsDisplayProcessing(true);
    setDisplayErrorMessage(null);
    setDisplayResultUrl(null);
    setDisplayCutoutUrl(null);
    setDisplayBgUrl(null);
    setDisplayElapsedTime(0);
    setDisplaySteps(DISPLAY_STEPS.map(s => ({ ...s, status: "idle" })));

    const controller = new AbortController();
    abortDisplayControllerRef.current = controller;
    const signal = controller.signal;

    try {
      console.log("[Display Studio] Starting Layout & Crop step...");
      // STEP 1 & 2: Bounding Box/Polygon Detection & Crop
      updateDisplayStepStatus("LAYOUT", "running");
      setDisplayActiveStepMessage("Locating display box boundary...");
      
      const cropFormData = new FormData();
      cropFormData.append("displayImage", displayFile);

      const cropResponse = await fetch("/api/pipeline/display-crop", {
        method: "POST",
        body: cropFormData,
        signal
      });

      const { 
        cutoutImage, 
        croppedImage, 
        displayName,
        displaySeries,
        coords,
        usedFallback
      } = await parseResponseData(
        cropResponse,
        "Failed to analyze and cutout display box."
      );
      
      console.log("[Display Studio] Layout & Crop success:", { displayName, displaySeries, usedFallback, coords });
      setDisplayCutoutUrl(cutoutImage || null);
      updateDisplayStepStatus("LAYOUT", "success");
      updateDisplayStepStatus("CROP", "success");

      // Auto-populate display name detected by Gemini
      let detectedName = "";
      if (displayName && displayName.trim()) {
        detectedName += displayName.trim();
      }
      if (displaySeries && displaySeries.trim()) {
        if (detectedName) detectedName += " - ";
        detectedName += displaySeries.trim();
      }
      if (detectedName) {
        setNewArtworkName(detectedName);
      }

      if (displayBgMode === "transparent") {
        console.log("[Display Studio] Transparent mode selected. Skipping background generation and merge steps.");
        setDisplayResultUrl(cutoutImage || null);
        
        // Mark remaining steps as success
        setDisplaySteps(prev => 
          prev.map(s => s.id === "OUTPAINT" || s.id === "MERGE" ? { ...s, status: "success" } : s)
        );
        setDisplayActiveStepMessage("Completed transparent cutout!");
        return;
      }

      console.log("[Display Studio] Starting Outpaint step with mode:", displayBgMode);
      // STEP 3: Outpainting with style analysis & Imagen 3
      updateDisplayStepStatus("OUTPAINT", "running");
      setDisplayActiveStepMessage("Analyzing display theme with Gemini...");

      const outpaintResponse = await fetchWithRetry(
        "/api/pipeline/outpaint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            croppedImage: cutoutImage, // Use the clean transparent cutout as style reference
            aspectRatio: displayAspectRatio, 
            mode: displayBgMode,
            isDisplay: true
          }),
          signal
        },
        2,
        1500,
        (msg) => setDisplayActiveStepMessage(msg)
      );

      const { backgroundImage } = await parseResponseData(
        outpaintResponse,
        "Failed to generate themed backdrop."
      );
      console.log("[Display Studio] Outpaint background generated successfully.");
      setDisplayBgUrl(backgroundImage || null);
      updateDisplayStepStatus("OUTPAINT", "success");

      console.log("[Display Studio] Starting Merge step...");
      // STEP 4: Merge display cutout + shadow over background
      updateDisplayStepStatus("MERGE", "running");
      setDisplayActiveStepMessage("Overlaying cutout with soft 3D drop shadow...");

      const mergeResponse = await fetch("/api/pipeline/display-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          displayCutout: cutoutImage, 
          backgroundImage,
          watermarkImage: watermarkPreviewUrl,
          watermarkPosition,
          watermarkOpacity,
          watermarkScale
        }),
        signal
      });

      const { resultImageUrl } = await parseResponseData(
        mergeResponse,
        "Failed to merge display cutout and background."
      );
      console.log("[Display Studio] Merge completed successfully.");
      updateDisplayStepStatus("MERGE", "success");
      setDisplayResultUrl(resultImageUrl || null);
      setDisplayActiveStepMessage("Completed!");

    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setDisplayErrorMessage("Die Bildgenerierung wurde abgebrochen.");
        setDisplaySteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "error" } : s));
        return;
      }
      const message = getErrorMessage(error);
      console.error("[Display Studio] Display pipeline error:", error);
      setDisplayErrorMessage(message || "An unexpected error occurred during processing.");
      
      // Mark current running step as error
      setDisplaySteps(prev => {
        const runningIdx = prev.findIndex(s => s.status === "running" || s.status === "idle");
        if (runningIdx !== -1) {
          return prev.map((s, idx) => idx === runningIdx ? { ...s, status: "error" } : s);
        }
        return prev;
      });
    } finally {
      setIsDisplayProcessing(false);
    }
  };

  const handleProcessBoosterImage = async () => {
    if (!boosterFile) return;
    setIsBoosterProcessing(true);
    setBoosterErrorMessage(null);
    setBoosterResultUrl(null);
    setBoosterCutoutUrl(null);
    setBoosterBgUrl(null);
    setBoosterElapsedTime(0);
    setBoosterSteps(BOOSTER_STEPS.map(s => ({ ...s, status: "idle" })));

    const controller = new AbortController();
    abortBoosterControllerRef.current = controller;
    const signal = controller.signal;

    try {
      console.log("[Booster Studio] Starting Layout & Crop step...");
      // STEP 1 & 2: Bounding Box/Polygon Detection & Crop
      updateBoosterStepStatus("LAYOUT", "running");
      setBoosterActiveStepMessage("Locating booster pack boundary...");
      
      const cropFormData = new FormData();
      cropFormData.append("boosterImage", boosterFile);

      const cropResponse = await fetch("/api/pipeline/booster-crop", {
        method: "POST",
        body: cropFormData,
        signal
      });

      const { 
        cutoutImage, 
        croppedImage, 
        displayName,
        displaySeries,
        coords,
        usedFallback
      } = await parseResponseData(
        cropResponse,
        "Failed to analyze and cutout booster pack."
      );
      
      console.log("[Booster Studio] Layout & Crop success:", { displayName, displaySeries, usedFallback, coords });
      setBoosterCutoutUrl(cutoutImage || null);
      updateBoosterStepStatus("LAYOUT", "success");
      updateBoosterStepStatus("CROP", "success");

      // Auto-populate booster name detected by Gemini
      let detectedName = "";
      if (displayName && displayName.trim()) {
        detectedName += displayName.trim();
      }
      if (displaySeries && displaySeries.trim()) {
        if (detectedName) detectedName += " - ";
        detectedName += displaySeries.trim();
      }
      if (detectedName) {
        setNewArtworkName(detectedName);
      }

      if (boosterBgMode === "transparent") {
        console.log("[Booster Studio] Transparent mode selected. Skipping background generation and merge steps.");
        setBoosterResultUrl(cutoutImage || null);
        
        // Mark remaining steps as success
        setBoosterSteps(prev => 
          prev.map(s => s.id === "OUTPAINT" || s.id === "MERGE" ? { ...s, status: "success" } : s)
        );
        setBoosterActiveStepMessage("Completed transparent cutout!");
        return;
      }

      console.log("[Booster Studio] Starting Outpaint step with mode:", boosterBgMode);
      // STEP 3: Outpainting with style analysis & Imagen 3
      updateBoosterStepStatus("OUTPAINT", "running");
      setBoosterActiveStepMessage("Analyzing booster theme with Gemini...");

      const outpaintResponse = await fetchWithRetry(
        "/api/pipeline/outpaint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            croppedImage: cutoutImage, // Use the clean transparent cutout as style reference
            aspectRatio: boosterAspectRatio, 
            mode: boosterBgMode,
            isDisplay: true
          }),
          signal
        },
        2,
        1500,
        (msg) => setBoosterActiveStepMessage(msg)
      );

      const { backgroundImage } = await parseResponseData(
        outpaintResponse,
        "Failed to generate themed backdrop."
      );
      console.log("[Booster Studio] Outpaint background generated successfully.");
      setBoosterBgUrl(backgroundImage || null);
      updateBoosterStepStatus("OUTPAINT", "success");

      console.log("[Booster Studio] Starting Merge step...");
      // STEP 4: Merge booster cutout + shadow over background
      updateBoosterStepStatus("MERGE", "running");
      setBoosterActiveStepMessage("Overlaying cutout with soft 3D drop shadow...");

      const mergeResponse = await fetch("/api/pipeline/display-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          displayCutout: cutoutImage, 
          backgroundImage,
          watermarkImage: watermarkPreviewUrl,
          watermarkPosition,
          watermarkOpacity,
          watermarkScale
        }),
        signal
      });

      const { resultImageUrl } = await parseResponseData(
        mergeResponse,
        "Failed to merge booster cutout and background."
      );
      console.log("[Booster Studio] Merge completed successfully.");
      updateBoosterStepStatus("MERGE", "success");
      setBoosterResultUrl(resultImageUrl || null);
      setBoosterActiveStepMessage("Completed!");

    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setBoosterErrorMessage("Die Bildgenerierung wurde abgebrochen.");
        setBoosterSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "error" } : s));
        return;
      }
      const message = getErrorMessage(error);
      console.error("[Booster Studio] Booster pipeline error:", error);
      setBoosterErrorMessage(message || "An unexpected error occurred during processing.");
      
      // Mark current running step as error
      setBoosterSteps(prev => {
        const runningIdx = prev.findIndex(s => s.status === "running" || s.status === "idle");
        if (runningIdx !== -1) {
          return prev.map((s, idx) => idx === runningIdx ? { ...s, status: "error" } : s);
        }
        return prev;
      });
    } finally {
      setIsBoosterProcessing(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setPreviewUrl(null);
    setResultImageUrl(null);
    setBackgroundImageUrl(null);
    setErrorMessage(null);
    setUsedAmbientFallback(false);
    setAmbientFallbackReason("");
    setUsedCropFallback(false);
    setTrimmedCard(null);
    setBgMode("outpaint");
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: "idle" })));
    setElapsedTime(0);
    setActiveStepMessage("");
    
    // Reset Case Maker states
    setSelectedArtworkId(null);
    setCaseCardImage(null);
    setCaseBgImage(null);
    setCaseResultUrl(null);
    setCaseWithCardUrl(null);
    setCaseBgResultUrl(null);
    setIsCaseOverlayLoaded(false);
    setCaseErrorMessage(null);

    // Reset Display Studio states
    setDisplayFile(null);
    setDisplayPreviewUrl(null);
    setDisplayResultUrl(null);
    setDisplayCutoutUrl(null);
    setDisplayBgUrl(null);
    setDisplayErrorMessage(null);
    setDisplaySteps(DISPLAY_STEPS.map(s => ({ ...s, status: "idle" })));
    setDisplayElapsedTime(0);
    setDisplayActiveStepMessage("");
    setIsDisplayDownloadOpen(false);

    // Reset Booster Studio states
    setBoosterFile(null);
    setBoosterPreviewUrl(null);
    setBoosterResultUrl(null);
    setBoosterCutoutUrl(null);
    setBoosterBgUrl(null);
    setBoosterErrorMessage(null);
    setBoosterSteps(BOOSTER_STEPS.map(s => ({ ...s, status: "idle" })));
    setBoosterElapsedTime(0);
    setBoosterActiveStepMessage("");
    setIsBoosterDownloadOpen(false);
  };

  const filteredArtworks = savedArtworks.filter(art => {
    const matchesSearch = art.name.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    if (libraryCategory === "displays") {
      return !!art.isDisplay;
    } else if (libraryCategory === "boosters") {
      return !!art.isBooster;
    } else if (libraryCategory === "cards") {
      const isCard = !art.isDisplay && !art.isBooster;
      if (!isCard) return false;
      if (libraryCardSubCategory === "case") {
        return !!art.isCase;
      } else if (libraryCardSubCategory === "noCase") {
        return !art.isCase;
      }
      return true;
    }
    return true; // "all"
  });

  return (
    <div className="flex-1 w-full min-h-screen flex flex-col relative overflow-hidden bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-950/20 via-zinc-950 to-black">
      {/* Visual background accents */}
      <div className="absolute top-0 right-1/4 w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/4 w-[400px] h-[400px] bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Space Login Overlay */}
      {!isLocalMode && !currentSpace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-md">
          <div className="relative w-full max-w-md bg-zinc-905 border border-zinc-800 rounded-3xl p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col items-center">
            {/* Logo/Icon */}
            <div className="w-16 h-16 rounded-2xl border border-purple-500/20 bg-purple-500/5 flex items-center justify-center mb-6">
              <Layers className="w-8 h-8 text-purple-400" />
            </div>

            <h2 className="text-2xl font-extrabold text-white mb-2 text-center">
              Willkommen beim New World Legacy Shop Asset Generator
            </h2>
            <p className="text-sm text-zinc-400 mb-6 text-center">
              {loginStep === "name" 
                ? "Gib einen Bereichsnamen ein, um auf deine Bibliothek zuzugreifen oder einen neuen geteilten Bereich zu erstellen."
                : loginStep === "code"
                ? `Gib den 4-stelligen Passcode für den Bereich "${loginSpaceName}" ein.`
                : `Der Bereich "${loginSpaceName}" existiert nicht. Erstelle ihn, indem du einen 4-stelligen Passcode festlegst.`}
            </p>

            {loginError && (
              <div className="w-full mb-4 px-4 py-2.5 rounded-xl border border-red-500/20 bg-red-500/5 text-red-400 text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            {loginStep === "name" && (
              <form 
                onSubmit={(e) => { e.preventDefault(); checkSpaceExists(); }}
                className="w-full flex flex-col gap-4"
              >
                <input
                  type="text"
                  placeholder="Bereichsname (z. B. pikachu-fans)"
                  value={loginSpaceName}
                  onChange={(e) => setLoginSpaceName(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
                  className="w-full px-4 py-3 rounded-xl bg-zinc-955 border border-zinc-800 text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm"
                  autoFocus
                  required
                />
                
                <label className="flex items-center gap-2 text-xs text-zinc-400 select-none cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    checked={isKeepLoggedIn}
                    onChange={(e) => setIsKeepLoggedIn(e.target.checked)}
                    className="rounded border-zinc-800 bg-zinc-955 text-purple-600 focus:ring-0 focus:ring-offset-0"
                  />
                  Auf diesem Gerät angemeldet bleiben
                </label>

                <button
                  type="submit"
                  disabled={isLoginLoading || !loginSpaceName.trim()}
                  className="w-full mt-2 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
                >
                  {isLoginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Weiter"}
                </button>
              </form>
            )}

            {(loginStep === "code" || loginStep === "create") && (
              <div className="w-full flex flex-col items-center">
                <div className="flex gap-2 mb-6">
                  <input
                    type="password"
                    pattern="[0-9]*"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="••••"
                    value={loginPasscode}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, "");
                      setLoginPasscode(val);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && loginPasscode.length === 4) {
                        if (loginStep === "code") handleSpaceLogin();
                        else handleCreateSpace();
                      }
                    }}
                    className="tracking-[0.5em] text-center text-2xl w-36 px-4 py-3 rounded-xl bg-zinc-955 border border-zinc-800 text-white placeholder-zinc-700 focus:border-purple-500 focus:outline-none transition-colors"
                    autoFocus
                    required
                  />
                </div>

                <div className="flex gap-3 w-full">
                  <button
                    type="button"
                    onClick={() => {
                      setLoginStep("name");
                      setLoginPasscode("");
                      setLoginError(null);
                    }}
                    className="flex-1 py-3 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-955 text-zinc-350 hover:text-white text-sm font-semibold transition-colors"
                  >
                    Zurück
                  </button>
                  <button
                    type="button"
                    onClick={loginStep === "code" ? handleSpaceLogin : handleCreateSpace}
                    disabled={isLoginLoading || loginPasscode.length !== 4}
                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
                  >
                    {isLoginLoading ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : loginStep === "code" ? (
                      "Bereich freischalten"
                    ) : (
                      "Bereich erstellen"
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main container */}
      <main className="flex-1 flex flex-col max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-10 relative z-10">
        
        {/* Header */}
        <header className="text-center mb-10 flex flex-col items-center">
          <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-purple-500/20 bg-purple-500/5 text-purple-400 text-xs font-semibold uppercase tracking-wider mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            all_out_luffy x New World Legacy
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-zinc-300 to-purple-400 bg-clip-text text-transparent pb-2 leading-tight">
            New World Legacy Shop Asset Generator
          </h1>
          <p className="mt-3 text-lg text-zinc-400 max-w-2xl">
            Erweitere Karten-Illustrationen zu immersiven Hintergründen. Präsentiere Karten in atemberaubenden Layouts, optimiert für Webshops und Social-Media-Sharing.
          </p>
        </header>

        {/* Tab selection bar */}
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-8 border-b border-zinc-800 pb-4">
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => setActiveTab("generate")}
              className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 ${
                activeTab === "generate"
                  ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.1)]"
                  : "border border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Sparkles className="w-4 h-4" />
              Studio
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("case")}
              className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 ${
                activeTab === "case"
                  ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.1)]"
                  : "border border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Layers className="w-4 h-4" />
              Case-Maker
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("library")}
              className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 ${
                activeTab === "library"
                  ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.1)]"
                  : "border border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Bookmark className="w-4 h-4" />
              Meine Bibliothek ({savedArtworks.length})
            </button>
          </div>

          {/* Space indicator / Logout */}
          {!isLocalMode && currentSpace && (
            <div className="flex items-center gap-3 px-4 py-2 rounded-xl border border-zinc-800 bg-zinc-900/20 text-xs font-semibold text-zinc-400">
              <Layers className="w-3.5 h-3.5 text-purple-400" />
              <span>Bereich: <strong className="text-zinc-200">{currentSpace.name}</strong></span>
              {isSpaceSyncing && <RefreshCw className="w-3 h-3 text-purple-400 animate-spin" />}
              <span className="w-px h-3.5 bg-zinc-800 mx-1" />
              <button
                type="button"
                onClick={handleLogout}
                className="text-purple-400 hover:text-purple-300 transition-colors flex items-center gap-1 cursor-pointer"
              >
                Abmelden
              </button>
            </div>
          )}
        </div>

        {activeTab === "generate" ? (
          <>
            {/* Sub-tabs switch */}
            <div className="flex justify-center mb-6">
              <div className="flex p-1 rounded-xl bg-zinc-950/60 border border-zinc-850 backdrop-blur-xl">
                <button
                  type="button"
                  onClick={() => setActiveStudioSubTab("card")}
                  className={`px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                    activeStudioSubTab === "card"
                      ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-md animate-in fade-in duration-200"
                      : "border border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Karten-Studio
                </button>
                <button
                  type="button"
                  onClick={() => setActiveStudioSubTab("display")}
                  className={`px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                    activeStudioSubTab === "display"
                      ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-md animate-in fade-in duration-200"
                      : "border border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Package className="w-3.5 h-3.5" />
                  Display-Studio
                </button>
                <button
                  type="button"
                  onClick={() => setActiveStudioSubTab("booster")}
                  className={`px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                    activeStudioSubTab === "booster"
                      ? "bg-purple-600/15 border border-purple-500/30 text-purple-400 shadow-md animate-in fade-in duration-200"
                      : "border border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Booster-Studio
                </button>
              </div>
            </div>

            {activeStudioSubTab === "card" ? (
              <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left panel - Controls & Source */}
          <section className="lg:col-span-7 flex flex-col gap-6">
            {/* Aspect Ratio & Control Card */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Layers className="w-5 h-5 text-purple-400" />
                1. Konfiguration
              </h2>
              
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-2">Ziel-Seitenverhältnis</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { value: "3:4", label: "Porträt 3:4", desc: "Klassische Präsentation" },
                      { value: "9:16", label: "Story 9:16", desc: "Vertikal Vollbild" },
                      { value: "1:1", label: "Quadrat 1:1", desc: "Raster/Instagram" },
                      { value: "16:9", label: "Querformat 16:9", desc: "Banner/Hintergrund" }
                    ].map((ratio) => (
                      <button
                        key={ratio.value}
                        type="button"
                        disabled={isProcessing}
                        onClick={() => setAspectRatio(ratio.value)}
                        className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                          aspectRatio === ratio.value
                            ? "border-purple-500 bg-purple-500/10 text-white shadow-[0_0_15px_rgba(168,85,247,0.15)]"
                            : "border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        } disabled:opacity-50 disabled:pointer-events-none`}
                      >
                        <span className="font-semibold text-sm">{ratio.label}</span>
                        <span className="text-[10px] text-zinc-500 mt-1">{ratio.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Upload Zone */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-purple-400" />
                2. Karte hochladen
              </h2>

              {!file ? (
                <div
                  {...getRootProps()}
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-all ${
                    isDragActive
                      ? "border-purple-500 bg-purple-500/5 text-purple-400"
                      : "border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-950/50"
                  }`}
                >
                  <input {...getInputProps()} />
                  <div className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4 text-purple-400 group-hover:scale-110 transition-transform">
                    <Upload className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-200 text-center">
                    Ziehe dein Kartenbild hierher oder klicke auf <span className="text-purple-400">Durchsuchen</span>
                  </p>
                  <p className="text-xs text-zinc-500 mt-2 text-center">
                    Unterstützt PNG, JPG, JPEG, WEBP (bis zu 10MB)
                  </p>
                </div>
              ) : (
                <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-955/50 p-4 flex flex-col items-center">
                  <div className="max-w-[280px] w-full aspect-[2.5/3.5] relative rounded-lg overflow-hidden shadow-xl border border-zinc-800/80 bg-zinc-900">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewUrl || ""}
                      alt="Uploaded card"
                      className="w-full h-full object-cover"
                    />
                  </div>

                  {/* Crop Option Toggle */}
                  <div className="w-full flex items-center justify-between mt-3 px-1">
                    <label className="text-xs font-medium text-zinc-300 select-none cursor-pointer flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={shouldCropCard}
                        onChange={(e) => setShouldCropCard(e.target.checked)}
                        disabled={isProcessing}
                        className="rounded border-zinc-800 bg-zinc-955 text-purple-600 focus:ring-0 focus:ring-offset-0 disabled:opacity-50"
                      />
                      Kanten automatisch zuschneiden (deaktivieren, wenn die Karte bereits sauber/randlos ist)
                    </label>
                  </div>
                  
                  <div className="w-full flex items-center justify-between mt-4 pt-4 border-t border-zinc-800/80">
                    <div className="truncate pr-4">
                      <p className="text-sm font-semibold text-zinc-200 truncate">{file.name}</p>
                      <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                    <div className="flex gap-2">
                      {resultImageUrl && (
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={handleProcessImage}
                          className="px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                          Erneut versuchen
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={handleReset}
                        className="px-3 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Entfernen
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Run Button */}
            {file && !resultImageUrl && !errorMessage && (
              <button
                type="button"
                disabled={isProcessing}
                onClick={handleProcessImage}
                className="w-full py-4 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-md flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(147,51,234,0.3)] hover:shadow-[0_0_30px_rgba(147,51,234,0.5)] transition-all disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 disabled:pointer-events-none"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    Verarbeite ({elapsedTime.toFixed(1)}s)...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    Karten-Illustration erweitern
                  </>
                )}
              </button>
            )}

            {/* Error Display */}
            {errorMessage && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-red-400 flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                  <div>
                    <h3 className="font-semibold text-white">Ausführung der Pipeline fehlgeschlagen</h3>
                    <p className="text-sm text-zinc-400 mt-1">{errorMessage}</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-3.5 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950/50 text-zinc-400 hover:text-zinc-200 text-xs font-semibold transition-colors"
                  >
                    Datei leeren
                  </button>
                  <button
                    type="button"
                    onClick={handleProcessImage}
                    className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                  >
                    Erneut versuchen
                  </button>
                </div>
              </div>
            )}

          </section>

          {/* Right panel - Pipeline status / Result Showcase */}
          <section className="lg:col-span-5 flex flex-col gap-6">
            
            {/* Pipeline Status Checklist */}
            {isProcessing || steps.some(s => s.status !== "idle") ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                    <RefreshCw className={`w-5 h-5 text-purple-400 ${isProcessing ? "animate-spin" : ""}`} />
                    Pipeline Status
                  </h2>
                  <div className="flex items-center gap-2">
                    {isProcessing && (
                      <button
                        type="button"
                        onClick={handleCancelProcessing}
                        className="px-2.5 py-1 rounded-lg border border-red-500/30 hover:border-red-500/50 bg-red-950/20 hover:bg-red-950/40 text-[10px] text-red-400 font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1"
                      >
                        <X className="w-3 h-3" />
                        Abbrechen
                      </button>
                    )}
                    <div className="text-xs text-zinc-400 flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-zinc-850 bg-zinc-950/60 font-mono">
                      <Clock className="w-3.5 h-3.5 text-zinc-500" />
                      {elapsedTime.toFixed(1)}s
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  {steps.map((step, idx) => {
                    const isRunning = step.status === "running";
                    const isSuccess = step.status === "success";
                    const isError = step.status === "error";

                    return (
                      <div 
                        key={step.id} 
                        className={`flex gap-4 p-3 rounded-xl border transition-all ${
                          isRunning 
                            ? "border-purple-500/40 bg-purple-500/5 shadow-[0_0_15px_rgba(168,85,247,0.05)]" 
                            : isSuccess 
                            ? "border-emerald-500/10 bg-emerald-500/5 opacity-80" 
                            : isError 
                            ? "border-red-500/20 bg-red-500/5"
                            : "border-zinc-800/40 bg-zinc-950/10 opacity-40"
                        }`}
                      >
                        <div className="flex flex-col items-center">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                            isSuccess 
                              ? "bg-emerald-500 text-black" 
                              : isError 
                              ? "bg-red-500 text-black"
                              : isRunning 
                              ? "bg-purple-500 text-white" 
                              : "bg-zinc-800 text-zinc-500"
                          }`}>
                            {isSuccess ? <CheckCircle2 className="w-4 h-4" /> : isError ? <AlertCircle className="w-4 h-4" /> : idx + 1}
                          </div>
                          {idx < steps.length - 1 && (
                            <div className={`w-[2px] flex-1 mt-2 -mb-5 ${
                              isSuccess ? "bg-emerald-500/30" : isRunning ? "bg-purple-500/20" : "bg-zinc-800"
                            }`} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className={`font-semibold text-sm ${isRunning ? "text-purple-400" : isSuccess ? "text-emerald-400" : "text-zinc-200"}`}>
                            {step.label}
                          </h3>
                          
                          {/* Live Sub-status messages */}
                          {isRunning && activeStepMessage ? (
                            <div className="flex items-center gap-1.5 mt-1.5 text-xs text-purple-300 font-medium animate-pulse bg-purple-950/20 border border-purple-900/30 px-2 py-1 rounded-md">
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
                              <span className="truncate">{activeStepMessage}</span>
                            </div>
                          ) : (
                            <p className="text-xs text-zinc-550 mt-0.5">{step.description}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Result Showcase Card */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex-1 flex flex-col">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Maximize2 className="w-5 h-5 text-purple-400" />
                Showcase Preview
              </h2>

              <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950/80 rounded-xl border border-zinc-850 p-4 relative min-h-[350px]">
                {resultImageUrl ? (
                  <div className="w-full flex flex-col items-center">
                    <div 
                      className="relative rounded-lg overflow-hidden border border-zinc-850 shadow-2xl w-full max-w-[340px] cursor-pointer group transition-all duration-300 hover:border-purple-500/60 hover:shadow-[0_0_30px_rgba(168,85,247,0.25)]"
                      style={{ aspectRatio: aspectRatio.replace(":", "/") }}
                      onClick={() => setLightboxImage({ url: resultImageUrl, title: file?.name ? file.name.replace(/\.[^/.]+$/, "") : "Expanded Card" })}
                      title="Größere Ansicht (Klicken)"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resultImageUrl}
                        alt="Final expanded trading card display"
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                      />
                      {/* Click to zoom overlay */}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300">
                        <div className="p-3 rounded-full bg-black/60 border border-zinc-850 text-white backdrop-blur-md scale-90 group-hover:scale-100 transition-all duration-300">
                          <Maximize2 className="w-5 h-5" />
                        </div>
                      </div>
                    </div>

                    {/* Fallback information badge */}
                    {(usedAmbientFallback || usedCropFallback) && (
                      <div className="mt-4 flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border border-purple-500/20 bg-purple-500/5 text-purple-300 text-xs font-medium max-w-[320px]">
                        {usedCropFallback && (
                          <div className="flex items-center gap-2">
                            <Info className="w-4 h-4 text-purple-400 shrink-0" />
                            <span>Default layout boundaries used.</span>
                          </div>
                        )}
                        {usedAmbientFallback && (
                          <div className="flex items-center gap-2">
                            <Info className="w-4 h-4 text-purple-400 shrink-0" />
                            <span>Ambient Blur fallback used.</span>
                          </div>
                        )}
                        {usedAmbientFallback && ambientFallbackReason && (
                          <span className="text-zinc-400 font-mono text-[10px] break-all mt-1 bg-black/40 p-1.5 rounded border border-zinc-800 max-h-[80px] overflow-y-auto w-full block">
                            {ambientFallbackReason}
                          </span>
                        )}
                      </div>
                    )}
                    
                    <div className="mt-6 flex flex-col gap-3 w-full max-w-[340px]">
                      <div className="flex flex-col sm:flex-row gap-3 w-full">
                        <div className="flex-1 relative">
                          <div className="flex rounded-xl bg-zinc-900 border border-zinc-700 divide-x divide-zinc-800 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.4)] overflow-hidden">
                            <button
                              type="button"
                              onClick={() => {
                                if (resultImageUrl) {
                                  triggerDownload(
                                    resultImageUrl,
                                    `TCG_${file?.name ? file.name.replace(/\.[^/.]+$/, "") : "expanded"}.png`
                                  );
                                }
                              }}
                              className="flex-1 px-4 py-3 hover:bg-zinc-800 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all"
                            >
                              <Download className="w-4 h-4" />
                              Herunterladen
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsGenDownloadOpen(!isGenDownloadOpen)}
                              className="px-3 hover:bg-zinc-800 text-white flex items-center justify-center transition-all"
                              aria-haspopup="true"
                              aria-expanded={isGenDownloadOpen}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </div>
                          
                          {isGenDownloadOpen && (
                            <>
                              <div 
                                className="fixed inset-0 z-20" 
                                onClick={() => setIsGenDownloadOpen(false)} 
                              />
                              <div className="absolute right-0 bottom-full mb-2 w-56 rounded-xl border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1.5 shadow-2xl z-30 flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsGenDownloadOpen(false);
                                    if (resultImageUrl) {
                                      triggerDownload(
                                        resultImageUrl,
                                        `TCG_${file?.name ? file.name.replace(/\.[^/.]+$/, "") : "expanded"}.png`
                                      );
                                    }
                                  }}
                                  className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors"
                                >
                                  <Layers className="w-4 h-4 text-purple-400" />
                                  <span>Zusammengefügte Karte (Einzelbild)</span>
                                </button>
                                {(trimmedCard || previewUrl) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsGenDownloadOpen(false);
                                      const nameBase = file?.name ? file.name.replace(/\.[^/.]+$/, "") : "expanded";
                                      const filesToDownload: { url: string; filename: string; fallbackUrl?: string }[] = [];
                                      if (backgroundImageUrl) {
                                        filesToDownload.push({
                                          url: backgroundImageUrl,
                                          filename: `TCG_${nameBase}_background.png`
                                        });
                                      }
                                      const cardUrl = trimmedCard || previewUrl;
                                      if (cardUrl) {
                                        filesToDownload.push({
                                          url: cardUrl,
                                          filename: `TCG_${nameBase}_card.png`
                                        });
                                      }
                                      
                                      if (filesToDownload.length > 1) {
                                        triggerZipDownload(filesToDownload, `TCG_${nameBase}_split_components.zip`);
                                      } else if (filesToDownload.length === 1) {
                                        triggerDownload(filesToDownload[0].url, filesToDownload[0].filename);
                                      }
                                    }}
                                    className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                  >
                                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                      <span className="text-[10px] font-bold text-indigo-400">ZIP</span>
                                    </div>
                                    <span>Komponenten trennen (Hintergrund + Karte)</span>
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSaveTarget("generate");
                            if (!newArtworkName) {
                              setNewArtworkName(file?.name ? file.name.replace(/\.[^/.]+$/, "") : "");
                            }
                            setIsSaveModalOpen(true);
                          }}
                          className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(147,51,234,0.2)]"
                        >
                          <Bookmark className="w-4 h-4" />
                          Speichern
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setCaseCardImage(trimmedCard);
                          setCaseBgImage(backgroundImageUrl);
                          setSelectedArtworkId(null);
                          setCaseResultUrl(null);
                          setCaseErrorMessage(null);
                          setActiveTab("case");
                        }}
                        className="w-full py-3 rounded-xl bg-purple-600/15 border border-purple-500/30 hover:bg-purple-600/25 text-purple-400 font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(168,85,247,0.05)]"
                      >
                        <Layers className="w-4 h-4" />
                        Case-Showcase erstellen
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                      <ImageIcon className="w-8 h-8 text-zinc-650" />
                    </div>
                    <p className="text-sm font-semibold text-zinc-400">Noch kein Showcase generiert</p>
                    <p className="text-xs text-zinc-650 mt-2 max-w-[240px]">
                      Lade deine Sammelkarte hoch und starte die Pipeline, um das fertige Produkt-Showcase zu sehen.
                    </p>
                  </div>
                )}
              </div>
            </div>

          </section>

        </div>
            ) : activeStudioSubTab === "display" ? (
              <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left panel - Controls & Source */}
            <section className="lg:col-span-7 flex flex-col gap-6">
              
              {/* Aspect Ratio & Control Card */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-purple-400" />
                  1. Konfiguration
                </h2>
                
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2">Ziel-Seitenverhältnis</label>
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { value: "3:4", label: "Porträt 3:4", desc: "Klassische Präsentation" },
                        { value: "9:16", label: "Story 9:16", desc: "Vertikal Vollbild" },
                        { value: "1:1", label: "Quadrat 1:1", desc: "Raster/Instagram" },
                        { value: "16:9", label: "Querformat 16:9", desc: "Banner/Hintergrund" }
                      ].map((ratio) => (
                        <button
                          key={ratio.value}
                          type="button"
                          onClick={() => setDisplayAspectRatio(ratio.value)}
                          className={`p-3 rounded-xl border text-left transition-all ${
                            displayAspectRatio === ratio.value
                              ? "bg-purple-600/10 border-purple-500 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.05)]"
                              : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                          }`}
                        >
                          <div className="font-semibold text-xs">{ratio.label}</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">{ratio.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2">Hintergrund-Generierungsmodus</label>
                    <div className="grid grid-cols-3 gap-3">
                      <button
                        type="button"
                        onClick={() => setDisplayBgMode("outpaint")}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          displayBgMode === "outpaint"
                            ? "bg-purple-600/10 border-purple-500 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.05)]"
                            : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        <div className="font-semibold text-xs">Thematischer Hintergrund</div>
                        <div className="text-[10px] text-zinc-550 mt-0.5">Gemini beschreibt den Kontext, Imagen 3 baut die Szene</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisplayBgMode("ambient")}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          displayBgMode === "ambient"
                            ? "bg-purple-600/10 border-purple-500 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.05)]"
                            : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        <div className="font-semibold text-xs">Ambient-Weichzeichner</div>
                        <div className="text-[10px] text-zinc-550 mt-0.5">Weiche, verschwommene Version der Displaybox-Farben</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisplayBgMode("transparent")}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          displayBgMode === "transparent"
                            ? "bg-purple-600/10 border-purple-500 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.05)]"
                            : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        <div className="font-semibold text-xs">Transparenter Ausschnitt</div>
                        <div className="text-[10px] text-zinc-550 mt-0.5">Hintergrund entfernen und transparente Displaybox ausgeben</div>
                      </button>
                    </div>
                  </div>

                  {/* Watermark Logo Section */}
                  <div className="border-t border-zinc-800 pt-4 mt-2">
                    <label className="block text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
                      <ImageIcon className="w-4 h-4 text-purple-400" />
                      Logo / Wasserzeichen überlagern (optional)
                    </label>
                    
                    {!watermarkPreviewUrl ? (
                      <div className="flex items-center justify-center border border-dashed border-zinc-800 rounded-xl p-4 bg-zinc-950/40 hover:bg-zinc-950/60 transition-all">
                        <label className="cursor-pointer text-center py-2 px-4 flex flex-col items-center">
                          <Upload className="w-5 h-5 text-zinc-500 mb-1" />
                          <span className="text-xs font-semibold text-zinc-400">Wasserzeichen-Bild hochladen</span>
                          <span className="text-[10px] text-zinc-650 mt-0.5">PNG / JPG (Transparenz empfohlen)</span>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                setWatermarkFile(f);
                                const reader = new FileReader();
                                reader.onload = () => setWatermarkPreviewUrl(reader.result as string);
                                reader.readAsDataURL(f);
                              }
                            }}
                            className="hidden"
                          />
                        </label>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 p-3 rounded-xl border border-zinc-850 bg-zinc-950/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={watermarkPreviewUrl}
                              alt="Wasserzeichen-Vorschau"
                              className="w-10 h-10 object-contain rounded bg-zinc-900 border border-zinc-800 p-1"
                            />
                            <div>
                              <div className="text-xs font-semibold text-zinc-300 truncate max-w-[150px]">
                                {watermarkFile ? watermarkFile.name : "Wasserzeichen-Logo"}
                              </div>
                              <div className="text-[10px] text-zinc-500">
                                Größe: {Math.round(watermarkScale * 100)}% | Deckkraft: {Math.round(watermarkOpacity * 100)}%
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setWatermarkFile(null);
                              setWatermarkPreviewUrl(null);
                            }}
                            className="text-xs font-semibold text-rose-455 hover:text-rose-450 transition-colors py-1 px-2 rounded hover:bg-rose-500/10 cursor-pointer"
                          >
                            Entfernen
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3 mt-1">
                          <div>
                            <label className="block text-[11px] font-semibold text-zinc-400 mb-1">Position</label>
                            <select
                              value={watermarkPosition}
                              onChange={(e) => setWatermarkPosition(e.target.value)}
                              className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-300 outline-none focus:border-purple-500"
                            >
                              <option value="bottom-center">Unten Mitte</option>
                              <option value="bottom-right">Unten Rechts</option>
                              <option value="bottom-left">Unten Links</option>
                              <option value="top-left">Oben Links</option>
                              <option value="top-right">Oben Rechts</option>
                              <option value="center">Zentriert</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-[11px] font-semibold text-zinc-400 mb-1">Größe</label>
                            <select
                              value={watermarkScale}
                              onChange={(e) => setWatermarkScale(Number(e.target.value))}
                              className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-300 outline-none focus:border-purple-500"
                            >
                              <option value="0.05">Sehr klein (5%)</option>
                              <option value="0.10">Klein (10%)</option>
                              <option value="0.15">Mittel (15%)</option>
                              <option value="0.25">Groß (25%)</option>
                              <option value="0.35">Sehr groß (35%)</option>
                            </select>
                          </div>
                        </div>

                        <div className="mt-1">
                          <div className="flex justify-between items-center text-[11px] font-semibold text-zinc-400 mb-1">
                            <span>Deckkraft (Wasserzeichen)</span>
                            <span className="text-zinc-200">{Math.round(watermarkOpacity * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0.05"
                            max="1.0"
                            step="0.05"
                            value={watermarkOpacity}
                            onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                            className="w-full accent-purple-500 bg-zinc-800 h-1 rounded-lg cursor-pointer appearance-none"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {displayFile && (
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={handleProcessDisplayImage}
                        disabled={isDisplayProcessing}
                        className="flex-1 py-3 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-purple-600/50 text-white font-bold text-sm transition-all shadow-[0_4px_20px_rgba(168,85,247,0.3)] hover:shadow-[0_4px_25px_rgba(168,85,247,0.45)] flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
                      >
                        {isDisplayProcessing ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span>Display wird verarbeitet...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4" />
                            <span>Zusammengefügtes Display generieren</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={handleReset}
                        disabled={isDisplayProcessing}
                        className="py-3 px-4 rounded-xl border border-zinc-855 hover:border-zinc-700 hover:bg-zinc-900 bg-transparent text-zinc-300 font-semibold text-sm transition-all cursor-pointer disabled:cursor-not-allowed"
                      >
                        Zurücksetzen
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Source Upload Card */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex-1 flex flex-col min-h-[350px]">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <ImageIcon className="w-5 h-5 text-purple-400" />
                  2. Displaybox-Bild hochladen
                </h2>
                
                {!displayPreviewUrl ? (
                  <div
                    {...getDisplayRootProps()}
                    className={`flex-1 border-2 border-dashed rounded-xl flex flex-col items-center justify-center p-8 text-center transition-all ${
                      isDisplayDragActive
                        ? "border-purple-500 bg-purple-600/5 shadow-[inset_0_0_20px_rgba(168,85,247,0.05)]"
                        : "border-zinc-800 hover:border-zinc-700 bg-zinc-950/40"
                    } ${isDisplayProcessing ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
                  >
                    <input {...getDisplayInputProps()} />
                    <div className="w-16 h-16 rounded-2xl bg-purple-600/10 border border-purple-500/20 text-purple-400 flex items-center justify-center mb-4 shadow-[0_8px_30px_rgba(0,0,0,0.3)]">
                      <Upload className="w-8 h-8" />
                    </div>
                    <p className="text-sm font-semibold text-zinc-200">
                      Ziehe dein Displaybox-Bild hierher
                    </p>
                    <p className="text-xs text-zinc-550 mt-1.5 max-w-sm">
                      Unterstützt PNG, JPEG, WEBP. Direkt aus der Zwischenablage einfügen (Strg+V / Cmd+V).
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 relative rounded-xl border border-zinc-850 bg-zinc-955/60 overflow-hidden flex items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={displayPreviewUrl}
                      alt="Source display"
                      className="max-h-[380px] w-auto object-contain rounded-lg shadow-2xl"
                    />
                    {!isDisplayProcessing && (
                      <button
                        onClick={handleReset}
                        className="absolute top-4 right-4 p-2 rounded-xl bg-black/60 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-black/80 transition-all cursor-pointer shadow-lg"
                        title="Bild entfernen"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Right panel - Result & Progress */}
            <section className="lg:col-span-5 flex flex-col gap-6 h-full">
              {/* Output Preview */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex flex-col flex-1 min-h-[500px]">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-purple-400" />
                    Vorschau der Ausgabe
                  </h2>
                  
                  {displayResultUrl && (
                    <div className="flex gap-2">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setIsDisplayDownloadOpen(!isDisplayDownloadOpen)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Herunterladen
                          <ChevronDown className="w-3 h-3" />
                        </button>
                        
                        {isDisplayDownloadOpen && (
                          <>
                            <div className="fixed inset-0 z-20" onClick={() => setIsDisplayDownloadOpen(false)} />
                            <div className="absolute right-0 mt-1 w-52 rounded-lg border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1 shadow-2xl z-30 flex flex-col gap-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
                              <button
                                type="button"
                                onClick={() => {
                                  setIsDisplayDownloadOpen(false);
                                  triggerDownload(displayResultUrl, `Display_${newArtworkName.replace(/\s+/g, "_") || "showcase"}.png`);
                                }}
                                className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors cursor-pointer"
                              >
                                <Layers className="w-3.5 h-3.5 text-purple-400" />
                                <span>Zusammengefügtes Showcase</span>
                              </button>
                              {displayCutoutUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsDisplayDownloadOpen(false);
                                    triggerDownload(displayCutoutUrl, `Display_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_cutout.png`);
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800 cursor-pointer"
                                >
                                  <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                                  <span>Nur Display-Ausschnitt</span>
                                </button>
                              )}
                              {displayBgUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsDisplayDownloadOpen(false);
                                    const filesToDownload = [
                                      { url: displayBgUrl, filename: `Display_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_background.png` },
                                      { url: displayCutoutUrl || displayResultUrl, filename: `Display_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_cutout.png` }
                                    ];
                                    triggerZipDownload(filesToDownload, `Display_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_split.zip`);
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800 cursor-pointer"
                                >
                                  <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                    <span className="text-[9px] font-bold text-indigo-400">ZIP</span>
                                  </div>
                                  <span>Hintergrund & Ausschnitt trennen</span>
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      
                      <button
                        type="button"
                        onClick={() => {
                          setSaveTarget("display");
                          setIsSaveModalOpen(true);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Bookmark className="w-3.5 h-3.5" />
                        Speichern
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex-1 border border-zinc-850 bg-zinc-950/80 rounded-xl relative overflow-hidden min-h-[420px] flex flex-col items-center justify-center p-6">
                  {displayResultUrl ? (
                    <div className="w-full flex flex-col items-center animate-in fade-in duration-300">
                      <div 
                        className="relative rounded-lg overflow-hidden w-full max-w-[440px] cursor-pointer group transition-all duration-300"
                        style={{ aspectRatio: displayAspectRatio.replace(":", "/") }}
                        onClick={() => setLightboxImage({ url: displayResultUrl, title: newArtworkName || "Merged Display Box" })}
                        title="Größere Ansicht (Klicken)"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={displayResultUrl}
                          alt="Result showcase"
                          className={`w-full h-full ${displayBgMode === "transparent" ? "object-contain" : "object-cover"} transition-transform duration-500 group-hover:scale-[1.02]`}
                        />
                        {/* Click to zoom overlay */}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300">
                          <div className="p-3 rounded-full bg-black/60 border border-zinc-855 text-white backdrop-blur-md scale-90 group-hover:scale-100 transition-all duration-300">
                            <Maximize2 className="w-5 h-5" />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center p-8 flex flex-col items-center max-w-sm">
                      <div className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-555 flex items-center justify-center mb-3">
                        <Sparkles className="w-5 h-5" />
                      </div>
                      <h3 className="font-semibold text-zinc-350 text-sm">Noch kein Display generiert</h3>
                      <p className="text-xs text-zinc-555 mt-1">
                        Konfiguriere Layout-Optionen, lade ein Bild einer Displaybox hoch und klicke auf Generieren.
                      </p>
                    </div>
                  )}

                  {isDisplayProcessing && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center">
                      <div className="relative w-16 h-16 flex items-center justify-center mb-6">
                        <div className="absolute inset-0 border-2 border-purple-500/20 rounded-full" />
                        <div className="absolute inset-0 border-2 border-t-purple-500 rounded-full animate-spin" />
                        <Sparkles className="w-6 h-6 text-purple-400 animate-pulse" />
                      </div>
                      <div className="font-bold text-white text-base mb-1">
                        Display-Showcase wird erstellt...
                      </div>
                      <div className="text-zinc-400 text-xs font-semibold mb-3 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-zinc-555" />
                        <span>Vergangene Zeit: <strong className="text-zinc-300">{displayElapsedTime.toFixed(1)}s</strong></span>
                      </div>
                      <div className="px-4 py-1.5 rounded-full border border-purple-500/20 bg-purple-600/10 text-[10px] text-purple-400 font-bold tracking-wider uppercase animate-pulse">
                        {displayActiveStepMessage}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Progress Steps Card */}
              {isDisplayProcessing || displayResultUrl || displayErrorMessage ? (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                  <h2 className="text-sm font-bold text-zinc-400 tracking-wider uppercase mb-4 flex items-center gap-2">
                    Verarbeitungsschritte
                  </h2>
                  <div className="flex flex-col gap-4">
                    {displaySteps.map((step) => {
                      const isIdle = step.status === "idle";
                      const isRunning = step.status === "running";
                      const isSuccess = step.status === "success";
                      const isError = step.status === "error";

                      return (
                        <div
                          key={step.id}
                          className={`flex items-start gap-3.5 p-3 rounded-xl border transition-all ${
                            isRunning
                              ? "bg-purple-600/5 border-purple-500/30 text-purple-400"
                              : isSuccess
                              ? "bg-emerald-600/5 border-emerald-500/20 text-emerald-400"
                              : isError
                              ? "bg-rose-600/5 border-rose-500/20 text-rose-400"
                              : "bg-zinc-950/20 border-zinc-850 text-zinc-400"
                          }`}
                        >
                          <div className="mt-0.5 shrink-0">
                            {isRunning ? (
                              <RefreshCw className="w-4 h-4 animate-spin text-purple-400" />
                            ) : isSuccess ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            ) : isError ? (
                              <AlertCircle className="w-4 h-4 text-rose-400" />
                            ) : (
                              <div className="w-4 h-4 rounded-full border border-zinc-700 bg-zinc-900" />
                            )}
                          </div>
                          <div>
                            <div className="font-semibold text-xs leading-none">
                              {step.label}
                            </div>
                            <p className="text-[10px] text-zinc-500 mt-1 leading-normal">
                              {step.description}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {displayErrorMessage && (
                    <div className="mt-4 p-3 rounded-xl border border-rose-500/20 bg-rose-600/10 text-xs font-semibold text-rose-400 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{displayErrorMessage}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          </div>
            ) : (
              <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start animate-in fade-in duration-300">
                {/* Left panel - Controls & Source */}
                <section className="lg:col-span-7 flex flex-col gap-6">
                  {/* Aspect Ratio & Control Card */}
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                    <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                      <Layers className="w-5 h-5 text-purple-400" />
                      1. Konfiguration
                    </h2>
                    
                    <div className="flex flex-col gap-4">
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-2">Hintergrund-Modus</label>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { value: "transparent", label: "Transparenter Ausschnitt", desc: "Nur der Booster" },
                            { value: "outpaint", label: "Umgebung erweitern", desc: "Thematische Erweiterung" },
                            { value: "ambient", label: "Weicher Schein", desc: "Einfacher farbiger Hintergrund" }
                          ].map((mode) => (
                            <button
                              key={mode.value}
                              type="button"
                              onClick={() => setBoosterBgMode(mode.value as any)}
                              disabled={isBoosterProcessing}
                              className={`p-3 rounded-xl border text-left transition-all ${
                                boosterBgMode === mode.value
                                  ? "border-purple-500 bg-purple-500/5 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.05)]"
                                  : "border-zinc-800 hover:border-zinc-700 bg-zinc-955/40 text-zinc-400 hover:text-zinc-200"
                              } ${isBoosterProcessing ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
                            >
                              <div className="text-xs font-bold">{mode.label}</div>
                              <div className="text-[10px] text-zinc-500 mt-1 leading-normal">{mode.desc}</div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {boosterBgMode !== "transparent" && (
                        <div>
                          <label className="block text-sm font-medium text-zinc-300 mb-2">Ziel-Seitenverhältnis</label>
                          <div className="grid grid-cols-4 gap-2">
                            {[
                              { value: "3:4", label: "Porträt 3:4", desc: "Klassisch" },
                              { value: "9:16", label: "Story 9:16", desc: "Vertikal" },
                              { value: "1:1", label: "Quadrat 1:1", desc: "Raster" },
                              { value: "16:9", label: "Querformat 16:9", desc: "Banner" }
                            ].map((ratio) => (
                              <button
                                key={ratio.value}
                                type="button"
                                onClick={() => setBoosterAspectRatio(ratio.value)}
                                disabled={isBoosterProcessing}
                                className={`p-3 rounded-xl border text-left transition-all ${
                                  boosterAspectRatio === ratio.value
                                    ? "border-purple-500 bg-purple-500/5 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.05)]"
                                    : "border-zinc-800 hover:border-zinc-700 bg-zinc-955/40 text-zinc-400 hover:text-zinc-200"
                                } ${isBoosterProcessing ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
                              >
                                <div className="text-xs font-bold">{ratio.label}</div>
                                <div className="text-[10px] text-zinc-500 mt-1 leading-normal">{ratio.desc}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Input Source Image Card */}
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex-1 flex flex-col min-h-[360px]">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Upload className="w-5 h-5 text-purple-400" />
                        2. Booster hochladen
                      </h2>
                      {boosterFile && !isBoosterProcessing && (
                        <button
                          type="button"
                          onClick={() => {
                            setBoosterFile(null);
                            setBoosterPreviewUrl(null);
                            setBoosterResultUrl(null);
                            setBoosterCutoutUrl(null);
                            setBoosterBgUrl(null);
                            setBoosterErrorMessage(null);
                            setBoosterSteps(BOOSTER_STEPS.map(s => ({ ...s, status: "idle" })));
                          }}
                          className="px-3 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200 transition-colors text-xs flex items-center gap-1.5 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                          Zurücksetzen
                        </button>
                      )}
                    </div>

                    {!boosterFile ? (
                      <div
                        {...getBoosterRootProps()}
                        className={`flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-8 text-center transition-all ${
                          isBoosterDragActive
                            ? "border-purple-500 bg-purple-600/5 shadow-[inset_0_0_20px_rgba(168,85,247,0.05)]"
                            : "border-zinc-800 hover:border-zinc-700 bg-zinc-955/40"
                        } ${isBoosterProcessing ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
                      >
                        <input {...getBoosterInputProps()} />
                        <div className="w-16 h-16 rounded-2xl bg-purple-600/10 border border-purple-500/20 text-purple-400 flex items-center justify-center mb-4 shadow-[0_8px_30px_rgba(0,0,0,0.3)]">
                          <Upload className="w-8 h-8" />
                        </div>
                        <p className="text-sm font-semibold text-zinc-200">
                          Ziehe dein Boosterpack-Bild hierher
                        </p>
                        <p className="text-xs text-zinc-550 mt-1.5 max-w-sm">
                          Unterstützt PNG, JPEG, WEBP. Direkt aus der Zwischenablage einfügen (Strg+V / Cmd+V).
                        </p>
                      </div>
                    ) : (
                      <div className="flex-1 relative rounded-xl border border-zinc-850 bg-zinc-955/60 overflow-hidden flex items-center justify-center p-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={boosterPreviewUrl || ""}
                          alt="Source booster"
                          className="max-h-[380px] w-auto object-contain rounded-lg shadow-2xl"
                        />
                        {!isBoosterProcessing && (
                          <button
                            onClick={handleReset}
                            className="absolute top-4 right-4 p-2 rounded-xl bg-black/60 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-black/80 transition-all cursor-pointer shadow-lg"
                            title="Bild entfernen"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                {/* Right panel - Result & Progress */}
                <section className="lg:col-span-5 flex flex-col gap-6 h-full">
                  {/* Output Preview */}
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex flex-col flex-1 min-h-[500px]">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-purple-400" />
                        Vorschau der Ausgabe
                      </h2>
                      
                      {boosterResultUrl && (
                        <div className="flex gap-2">
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setIsBoosterDownloadOpen(!isBoosterDownloadOpen)}
                              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Herunterladen
                              <ChevronDown className="w-3 h-3" />
                            </button>
                            
                            {isBoosterDownloadOpen && (
                              <>
                                <div className="fixed inset-0 z-20" onClick={() => setIsBoosterDownloadOpen(false)} />
                                <div className="absolute right-0 mt-1 w-52 rounded-lg border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1 shadow-2xl z-30 flex flex-col gap-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsBoosterDownloadOpen(false);
                                      triggerDownload(boosterResultUrl, `Booster_${newArtworkName.replace(/\s+/g, "_") || "showcase"}.png`);
                                    }}
                                    className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors cursor-pointer"
                                  >
                                    <ImageIcon className="w-3.5 h-3.5 text-zinc-400" />
                                    <span>Als PNG herunterladen</span>
                                  </button>
                                  {boosterBgUrl && boosterBgMode !== "transparent" && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setIsBoosterDownloadOpen(false);
                                        const filesToDownload = [
                                          { url: boosterBgUrl, filename: `Booster_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_background.png` },
                                          { url: boosterCutoutUrl || boosterResultUrl, filename: `Booster_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_cutout.png` }
                                        ];
                                        triggerZipDownload(filesToDownload, `Booster_${newArtworkName.replace(/\s+/g, "_") || "showcase"}_split.zip`);
                                      }}
                                      className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800 cursor-pointer"
                                    >
                                      <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                        <span className="text-[9px] font-bold text-indigo-400">ZIP</span>
                                      </div>
                                      <span>Hintergrund & Ausschnitt trennen</span>
                                    </button>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                          
                          <button
                            type="button"
                            onClick={() => {
                              setSaveTarget("booster");
                              setIsSaveModalOpen(true);
                            }}
                            className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <Bookmark className="w-3.5 h-3.5" />
                            Speichern
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex-1 border border-zinc-850 bg-zinc-950/80 rounded-xl relative overflow-hidden min-h-[420px] flex flex-col items-center justify-center p-6">
                      {boosterResultUrl ? (
                        <div className="w-full flex flex-col items-center animate-in fade-in duration-300">
                          <div 
                            className="relative rounded-lg overflow-hidden w-full max-w-[440px] cursor-pointer group transition-all duration-300"
                            style={{ aspectRatio: boosterAspectRatio.replace(":", "/") }}
                            onClick={() => setLightboxImage({ url: boosterResultUrl, title: newArtworkName || "Merged Booster Box" })}
                            title="Größere Ansicht (Klicken)"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={boosterResultUrl}
                              alt="Result showcase"
                              className={`w-full h-full ${boosterBgMode === "transparent" ? "object-contain" : "object-cover"} transition-transform duration-500 group-hover:scale-[1.02]`}
                            />
                            {/* Click to zoom overlay */}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300">
                              <div className="p-3 rounded-full bg-black/60 border border-zinc-850 text-white backdrop-blur-md scale-90 group-hover:scale-100 transition-all duration-300">
                                <Maximize2 className="w-5 h-5" />
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center p-8 flex flex-col items-center max-w-sm">
                          <div className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-555 flex items-center justify-center mb-3">
                            <Sparkles className="w-5 h-5" />
                          </div>
                          <h3 className="font-semibold text-zinc-350 text-sm">Noch kein Booster generiert</h3>
                          <p className="text-xs text-zinc-555 mt-1">
                            Konfiguriere Layout-Optionen, lade ein Bild eines Boosterpacks hoch und klicke auf Generieren.
                          </p>
                        </div>
                      )}
                    </div>

                    {boosterFile && !boosterResultUrl && (
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={handleProcessBoosterImage}
                          disabled={isBoosterProcessing}
                          className="w-full py-3.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg"
                        >
                          {isBoosterProcessing ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              Generierung läuft...
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-4 h-4" />
                              Booster freistellen
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Active Step status card */}
                  {isBoosterProcessing || boosterResultUrl || boosterErrorMessage ? (
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-5 shadow-2xl">
                      <div className="flex justify-between items-center mb-4 pb-3 border-b border-zinc-800/60">
                        <div className="flex items-center gap-2">
                          <Activity className="w-4 h-4 text-purple-400" />
                          <span className="text-sm font-semibold text-zinc-300">Generierungs-Status</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-xs text-zinc-400 bg-zinc-950 px-2.5 py-1 rounded-md border border-zinc-800/80">
                            {boosterElapsedTime.toFixed(1)}s
                          </span>
                          {isBoosterProcessing && (
                            <button
                              type="button"
                              onClick={handleCancelBoosterProcessing}
                              className="px-2.5 py-1 rounded bg-rose-600/10 border border-rose-500/30 text-[10px] font-extrabold tracking-wider uppercase text-rose-400 hover:bg-rose-600/25 transition-all cursor-pointer"
                            >
                              Abbrechen
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col gap-3">
                        {boosterSteps.map((step) => {
                          const isRunning = step.status === "running";
                          const isSuccess = step.status === "success";
                          const isError = step.status === "error";

                          return (
                            <div
                              key={step.id}
                              className={`flex items-start gap-3 p-2.5 rounded-xl transition-colors ${
                                isRunning ? "bg-purple-600/5 border border-purple-500/10" : ""
                              }`}
                            >
                              <div className="mt-0.5 shrink-0">
                                {isRunning ? (
                                  <div className="w-4 h-4 rounded-full border border-purple-500/30 border-t-purple-500 animate-spin" />
                                ) : isSuccess ? (
                                  <div className="w-4 h-4 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                                    <Check className="w-2.5 h-2.5 text-emerald-400" />
                                  </div>
                                ) : isError ? (
                                  <div className="w-4 h-4 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
                                    <AlertCircle className="w-2.5 h-2.5 text-rose-400" />
                                  </div>
                                ) : (
                                  <div className="w-4 h-4 rounded-full border border-zinc-800 bg-zinc-950 flex items-center justify-center">
                                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p
                                  className={`text-xs font-semibold leading-normal ${
                                    isRunning ? "text-purple-400" : isSuccess ? "text-zinc-300" : isError ? "text-rose-400" : "text-zinc-500"
                                  }`}
                                >
                                  {step.label}
                                </p>
                                <p className="text-[10px] text-zinc-550 mt-1 leading-normal">
                                  {step.description}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {boosterErrorMessage && (
                        <div className="mt-4 p-3 rounded-xl border border-rose-500/20 bg-rose-600/10 text-xs font-semibold text-rose-400 flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{boosterErrorMessage}</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </section>
              </div>
            )}
          </>
        ) : activeTab === "case" ? (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left panel - Case configuration & library selection */}
            <section className="lg:col-span-7 flex flex-col gap-6">
              {/* Select from Library */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-purple-400" />
                  TCG Case-Konfiguration
                </h2>
                
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2">Erweiterte Karte auswählen</label>
                    {savedArtworks.length === 0 && !caseCardImage ? (
                      <div className="p-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/20 text-center">
                        <p className="text-sm text-zinc-500">Deine Bibliothek ist leer.</p>
                        <p className="text-xs text-zinc-650 mt-1">Bitte erweitere zuerst eine Karte im Studio und speichere sie, oder verwende die aktuell generierte Karte.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <select
                          value={selectedArtworkId || (caseCardImage && !selectedArtworkId ? "current" : "")}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === "current") {
                              setSelectedArtworkId(null);
                              setCaseCardImage(trimmedCard);
                              setCaseBgImage(backgroundImageUrl);
                              setCaseResultUrl(null);
                              setCaseErrorMessage(null);
                            } else if (val === "") {
                              setSelectedArtworkId(null);
                              setCaseCardImage(null);
                              setCaseBgImage(null);
                              setCaseResultUrl(null);
                              setCaseErrorMessage(null);
                            } else {
                              handleSelectArtworkForCase(val);
                            }
                          }}
                          className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm"
                        >
                          <option value="">-- Karte auswählen --</option>
                          {caseCardImage && !selectedArtworkId && (
                            <option value="current">Aktuelle Sitzungskarte (Studio)</option>
                          )}
                          {savedArtworks.map(art => (
                            <option key={art.id} value={art.id}>
                              {art.name} ({art.aspectRatio}){!art.originalCardUrl ? " [Erzeugt Ambient-Hintergrund]" : ""}
                            </option>
                          ))}
                        </select>
                        
                        {/* Selected info card */}
                        {caseCardImage && caseBgImage ? (
                          <div className="flex flex-col gap-3">
                            <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/40 flex items-center gap-4">
                              <div className="w-16 h-20 relative rounded overflow-hidden border border-zinc-800 bg-zinc-900 flex-shrink-0">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={caseCardImage}
                                  alt="Card snippet"
                                  className="w-full h-full object-cover"
                                />
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-zinc-200">
                                  {selectedArtworkId 
                                    ? savedArtworks.find(a => a.id === selectedArtworkId)?.name 
                                    : "Aktuelle Sitzungskarte"}
                                </p>
                                <p className="text-xs text-purple-400 font-medium">
                                  {caseBgImage === "ambient" 
                                    ? "Bereit zum Einfügen in das Case (mit verschwommenem Ambient-Hintergrund)" 
                                    : "Bereit zum Einfügen in das Case (mit erweitertem Hintergrund)"}
                                </p>
                              </div>
                            </div>
                            
                            {caseBgImage === "ambient" && (
                              <div className="px-4 py-3 rounded-xl border border-purple-500/10 bg-purple-500/5 text-purple-400 flex gap-2 items-center text-xs">
                                <Info className="w-4 h-4 shrink-0" />
                                <span>Keine Hintergrundebene gefunden. Ein verschwommener Ambient-Hintergrund wird generiert.</span>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Generate Case Button */}
              {caseCardImage && caseBgImage && !caseResultUrl && !caseErrorMessage && (
                <button
                  type="button"
                  disabled={isCaseProcessing}
                  onClick={handleProcessCaseImage}
                  className="w-full py-4 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-md flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(147,51,234,0.3)] hover:shadow-[0_0_30px_rgba(147,51,234,0.5)] transition-all disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 disabled:pointer-events-none"
                >
                  {isCaseProcessing ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      Case-Bild wird erstellt...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-5 h-5" />
                      Case-Bild erstellen
                    </>
                  )}
                </button>
              )}

              {/* Error Display */}
              {caseErrorMessage && (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-red-400 flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                    <div>
                      <h3 className="font-semibold text-white">Case-Generierung fehlgeschlagen</h3>
                      <p className="text-sm text-zinc-400 mt-1">{caseErrorMessage}</p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCaseCardImage(null);
                        setCaseBgImage(null);
                        setSelectedArtworkId(null);
                        setCaseErrorMessage(null);
                      }}
                      className="px-3.5 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950/50 text-zinc-400 hover:text-zinc-200 text-xs font-semibold transition-colors"
                    >
                      Auswahl aufheben
                    </button>
                    <button
                      type="button"
                      onClick={handleProcessCaseImage}
                      className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                    >
                      Erneut versuchen
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Right panel - Case Showcase Preview */}
            <section className="lg:col-span-5 flex flex-col gap-6">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl flex-1 flex flex-col">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <Maximize2 className="w-5 h-5 text-purple-400" />
                  Case-Showcase-Vorschau
                </h2>

                <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950/80 rounded-xl border border-zinc-850 p-4 relative min-h-[350px]">
                  {isCaseProcessing ? (
                    <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                        <RefreshCw className="w-8 h-8 text-purple-400 animate-spin" />
                      </div>
                      <p className="text-sm font-semibold text-zinc-400">Case-Showcase wird gerendert...</p>
                      <p className="text-xs text-zinc-650 mt-2 max-w-[200px]">
                        Kombiniere Kartenebenen innerhalb der transparenten Kunststoff-Slab-Vorlage.
                      </p>
                    </div>
                  ) : caseResultUrl ? (
                    <div className="w-full flex flex-col items-center">
                      <div 
                        className="relative rounded-lg overflow-hidden border border-zinc-850 shadow-2xl w-full max-w-[340px] aspect-[3/4] cursor-pointer group transition-all duration-300 hover:border-purple-500/60 hover:shadow-[0_0_30px_rgba(168,85,247,0.25)]"
                        onClick={() => {
                          const artName = selectedArtworkId 
                            ? savedArtworks.find(a => a.id === selectedArtworkId)?.name 
                            : file?.name ? file.name.replace(/\.[^/.]+$/, "") : "Slab Showcase";
                          setLightboxImage({ url: caseResultUrl, title: `${artName} Slab` });
                        }}
                        title="Größere Ansicht (Klicken)"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={caseResultUrl}
                          alt="Final slab showcase"
                          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                        />
                        {/* Click to zoom overlay */}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300">
                          <div className="p-3 rounded-full bg-black/60 border border-zinc-855 text-white backdrop-blur-md scale-90 group-hover:scale-100 transition-all duration-300">
                            <Maximize2 className="w-5 h-5" />
                          </div>
                        </div>
                      </div>
                      
                      <div className="mt-6 flex flex-col sm:flex-row gap-3 w-full max-w-[340px]">
                        <div className="flex-1 relative">
                          <div className="flex rounded-xl bg-zinc-900 border border-zinc-700 divide-x divide-zinc-800 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.4)] overflow-hidden">
                            <button
                              type="button"
                              onClick={() => {
                                if (caseResultUrl) {
                                  const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                  triggerDownload(caseResultUrl, `Slab_${nameBase}.png`);
                                }
                              }}
                              className="flex-1 px-4 py-3 hover:bg-zinc-800 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all"
                            >
                              <Download className="w-4 h-4" />
                              Herunterladen
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsCaseDownloadOpen(!isCaseDownloadOpen)}
                              className="px-3 hover:bg-zinc-800 text-white flex items-center justify-center transition-all"
                              aria-haspopup="true"
                              aria-expanded={isCaseDownloadOpen}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </div>
                          
                          {isCaseDownloadOpen && (
                            <>
                              <div 
                                className="fixed inset-0 z-20" 
                                onClick={() => setIsCaseDownloadOpen(false)} 
                              />
                              <div className="absolute right-0 bottom-full mb-2 w-56 rounded-xl border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1.5 shadow-2xl z-30 flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsCaseDownloadOpen(false);
                                    if (caseResultUrl) {
                                      const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                      triggerDownload(caseResultUrl, `Slab_${nameBase}.png`);
                                    }
                                  }}
                                  className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors"
                                >
                                  <Layers className="w-4 h-4 text-purple-400" />
                                  <span>Zusammengefügtes Showcase (Slab + Hintergrund)</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsCaseDownloadOpen(false);
                                    const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                    const filesToDownload: { url: string; filename: string; fallbackUrl?: string }[] = [];
                                    if (caseBgResultUrl) {
                                      filesToDownload.push({
                                        url: caseBgResultUrl,
                                        filename: `Slab_${nameBase}_background.png`
                                      });
                                    }
                                    if (caseWithCardUrl) {
                                      filesToDownload.push({
                                        url: caseWithCardUrl,
                                        filename: `Slab_${nameBase}_case_with_card.png`
                                      });
                                    }
                                    if (filesToDownload.length > 1) {
                                      triggerZipDownload(filesToDownload, `Slab_${nameBase}_split_components.zip`);
                                    } else if (filesToDownload.length === 1) {
                                      triggerDownload(filesToDownload[0].url, filesToDownload[0].filename);
                                    }
                                  }}
                                  className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                    <span className="text-[10px] font-bold text-indigo-400">ZIP</span>
                                  </div>
                                  <span>Komponenten trennen (Hintergrund + Case)</span>
                                </button>
                                {caseCardImage && caseBgResultUrl && caseWithCardUrl && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsCaseDownloadOpen(false);
                                      const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                      const filesToDownload: { url: string; filename: string; fallbackUrl?: string }[] = [
                                        { url: caseBgResultUrl, filename: `Slab_${nameBase}_background.png` },
                                        { url: caseWithCardUrl, filename: `Slab_${nameBase}_case_with_card.png` },
                                        { url: caseCardImage, filename: `Slab_${nameBase}_card.png` }
                                      ];
                                      triggerZipDownload(filesToDownload, `Slab_${nameBase}_all_parts.zip`);
                                    }}
                                    className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                  >
                                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                      <span className="text-[10px] font-bold text-purple-400">ZIP</span>
                                    </div>
                                    <span>Alle Teile (Hintergrund + Case + Karte)</span>
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSaveTarget("case");
                            if (selectedArtworkId) {
                              setNewArtworkName(`${savedArtworks.find(a => a.id === selectedArtworkId)?.name} Slab`);
                            } else if (newArtworkName) {
                              setNewArtworkName(`${newArtworkName} Slab`);
                            } else {
                              setNewArtworkName(file?.name ? `${file.name.replace(/\.[^/.]+$/, "")} Slab` : "My Slab Showcase");
                            }
                            setIsSaveModalOpen(true);
                          }}
                          className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(147,51,234,0.2)]"
                        >
                          <Bookmark className="w-4 h-4" />
                          Speichern
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                        <Layers className="w-8 h-8 text-zinc-650" />
                      </div>
                      <p className="text-sm font-semibold text-zinc-400">Noch kein Case-Showcase generiert</p>
                      <p className="text-xs text-zinc-650 mt-2 max-w-[240px]">
                        Wähle eine erweiterte Karte aus der Konfigurationsliste und klicke auf die Schaltfläche, um das fertige TCG-Slab-Showcase zu generieren.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        ) : (
          /* Library Tab */
          <div 
            {...getLibraryRootProps()}
            className="flex-1 flex flex-col gap-6 relative min-h-[400px]"
          >
            <input {...getLibraryInputProps({ id: "library-file-input" })} />

            {/* Drag Overlay */}
            {isLibraryDragActive && (
              <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-purple-950/85 backdrop-blur-md border-2 border-dashed border-purple-500 rounded-3xl animate-[pulse_2s_infinite]">
                <div className="w-16 h-16 rounded-full border border-purple-500/30 bg-purple-900/40 flex items-center justify-center mb-4">
                  <Upload className="w-8 h-8 text-purple-400" />
                </div>
                <p className="text-lg font-bold text-white">Bild ablegen, um es in der Bibliothek zu speichern</p>
                <p className="text-xs text-purple-300 mt-2 font-medium">Unterstützt PNG, JPG, WEBP</p>
              </div>
            )}

            {/* Search Bar / Stats */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl">
              <div className="relative w-full sm:max-w-md">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                  <Search className="h-4 w-4 text-zinc-550" />
                </span>
                <input
                  type="text"
                  placeholder="Gespeicherte Karten nach Namen suchen..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-8 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-550 hover:text-zinc-350"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="flex w-full sm:w-auto items-center justify-between sm:justify-end gap-4">
                <button
                  type="button"
                  onClick={() => {
                    const inputEl = document.getElementById("library-file-input");
                    if (inputEl) {
                      inputEl.click();
                    }
                  }}
                  className="px-4 py-2.5 rounded-xl bg-purple-600/10 hover:bg-purple-600/20 border border-purple-500/30 hover:border-purple-500/50 text-purple-400 font-semibold text-xs flex items-center gap-2 transition-all"
                >
                  <Upload className="w-4 h-4" />
                  Karte hochladen
                </button>
                <div className="text-sm text-zinc-400 font-medium whitespace-nowrap">
                  Zeige {filteredArtworks.length} von {savedArtworks.length} gespeicherten Bildern
                </div>
              </div>
            </div>

            {/* Category / Filter Tabs */}
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
                <div className="flex gap-2">
                  {[
                    { id: "all", label: "Alle Einträge", icon: Bookmark },
                    { id: "cards", label: "Karten", icon: Layers },
                    { id: "displays", label: "Displays", icon: Package }
                  ].map((cat) => {
                    const Icon = cat.icon;
                    const count = cat.id === "all" 
                      ? savedArtworks.length 
                      : cat.id === "cards" 
                      ? savedArtworks.filter(a => !a.isDisplay).length
                      : savedArtworks.filter(a => !!a.isDisplay).length;

                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          setLibraryCategory(cat.id as any);
                          if (cat.id !== "cards") setLibraryCardSubCategory("all");
                        }}
                        className={`px-4 py-2 rounded-xl font-semibold text-xs transition-all flex items-center gap-1.5 border ${
                          libraryCategory === cat.id
                            ? "bg-purple-600/15 border-purple-500/30 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.05)]"
                            : "border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40"
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{cat.label}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          libraryCategory === cat.id 
                            ? "bg-purple-500/20 text-purple-300" 
                            : "bg-zinc-850 text-zinc-550"
                        }`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Secondary sub-filters for Cards */}
                {libraryCategory === "cards" && (
                  <div className="flex gap-2 bg-zinc-950 p-1 rounded-lg border border-zinc-850 animate-in fade-in slide-in-from-right-2 duration-200">
                    {[
                      { id: "all", label: "Alle Karten" },
                      { id: "case", label: "Mit Case" },
                      { id: "noCase", label: "Ohne Case" }
                    ].map((sub) => {
                      const count = sub.id === "all"
                        ? savedArtworks.filter(a => !a.isDisplay).length
                        : sub.id === "case"
                        ? savedArtworks.filter(a => !a.isDisplay && a.isCase).length
                        : savedArtworks.filter(a => !a.isDisplay && !a.isCase).length;

                      return (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => setLibraryCardSubCategory(sub.id as any)}
                          className={`px-3 py-1.5 rounded-md font-semibold text-[11px] transition-all flex items-center gap-1.5 ${
                            libraryCardSubCategory === sub.id
                              ? "bg-zinc-900 text-white border border-zinc-800 shadow-sm"
                              : "text-zinc-400 hover:text-zinc-200 border border-transparent"
                          }`}
                        >
                          <span>{sub.label}</span>
                          <span className={`text-[9px] px-1 py-0.2 rounded-full ${
                            libraryCardSubCategory === sub.id
                              ? "bg-zinc-800 text-zinc-350"
                              : "bg-zinc-900/60 text-zinc-555"
                          }`}>
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Artworks Grid */}
            {filteredArtworks.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {filteredArtworks.map((art) => (
                  <div
                    key={art.id}
                    className="group relative rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4 transition-all duration-300 hover:border-purple-500/50 hover:bg-zinc-900/40 hover:shadow-[0_0_30px_rgba(168,85,247,0.1)] flex flex-col"
                  >
                    {/* Image container */}
                    <div
                      className="relative rounded-lg overflow-hidden border border-zinc-850 bg-zinc-950 w-full mb-4 shadow-md aspect-[3/4] cursor-pointer group/img transition-all duration-300 hover:border-purple-500/40"
                      style={{ aspectRatio: art.aspectRatio ? art.aspectRatio.replace(":", "/") : "3/4" }}
                      onClick={() => setLightboxImage({ url: art.imageUrl, title: art.name })}
                      title="Größere Ansicht (Klicken)"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={art.imageUrl}
                        alt={art.name}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                      />
                      {/* Click to zoom overlay */}
                      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/40 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-all duration-300">
                        <div className="p-2.5 rounded-full bg-black/60 border border-zinc-850 text-white backdrop-blur-md scale-90 group-hover/img:scale-100 transition-all duration-300">
                          <Maximize2 className="w-4 h-4" />
                        </div>
                      </div>
                      
                      {/* Ratio Badge */}
                      <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/60 border border-zinc-850 text-[10px] text-zinc-355 font-bold z-10">
                        {art.aspectRatio || "3:4"}
                      </span>

                      {/* Delete Button (visible on hover) */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteArtwork(art.id);
                        }}
                        className="absolute top-2 right-12 p-1.5 rounded bg-black/60 hover:bg-rose-950/80 border border-zinc-800 text-zinc-400 hover:text-rose-400 transition-all z-10 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                        title="Aus Bibliothek löschen"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>

                      {/* Type Badge */}
                      <span className={`absolute top-2 left-2 px-2 py-0.5 rounded border text-[10px] font-bold z-10 ${
                        art.isDisplay 
                          ? "bg-purple-950/80 border-purple-800 text-purple-300"
                          : art.isCase
                          ? "bg-indigo-950/80 border-indigo-800 text-indigo-300"
                          : "bg-blue-950/80 border-blue-800 text-blue-300"
                      }`}>
                        {art.isDisplay ? "Display" : art.isCase ? "Case" : "Karte"}
                      </span>
                    </div>

                    <h3 className="font-bold text-white text-base truncate mb-1" title={art.name}>
                      {art.name}
                    </h3>
                    <p className="text-[10px] text-zinc-550 mb-4">
                      Gespeichert am {new Date(art.timestamp).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </p>

                    <div className="flex items-center justify-between mt-auto pt-3 border-t border-zinc-850/50 gap-2">
                      <div className="relative">
                        <div className="flex rounded-lg bg-zinc-800 border border-zinc-700 divide-x divide-zinc-750 transition-all overflow-hidden">
                          <button
                            type="button"
                            onClick={() => {
                              triggerDownload(art.imageUrl, `TCG_${art.name.replace(/\s+/g, "_")}.png`);
                            }}
                            className="py-2 px-2.5 hover:bg-zinc-700 text-white flex items-center justify-center transition-colors"
                            title="Herunterladen"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setOpenLibraryDownloadId(openLibraryDownloadId === art.id ? null : art.id)}
                            className="px-2 hover:bg-zinc-700 text-white flex items-center justify-center transition-all"
                            aria-haspopup="true"
                            aria-expanded={openLibraryDownloadId === art.id}
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </div>

                        {openLibraryDownloadId === art.id && (
                          <>
                            <div 
                              className="fixed inset-0 z-20" 
                              onClick={() => setOpenLibraryDownloadId(null)} 
                            />
                            <div className="absolute left-0 bottom-full mb-1.5 w-52 rounded-lg border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1 shadow-2xl z-30 flex flex-col gap-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenLibraryDownloadId(null);
                                  triggerDownload(art.imageUrl, `TCG_${art.name.replace(/\s+/g, "_")}.png`);
                                }}
                                className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors"
                              >
                                <Layers className="w-3.5 h-3.5 text-purple-400" />
                                <span>{art.isDisplay ? "Zusammengefügtes Display" : art.isCase ? "Zusammengefügtes Showcase" : "Zusammengefügte Karte"}</span>
                              </button>
                              {(art.cardOnlyUrl || art.originalCardUrl) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    const targetCardUrl = (art.isCase || art.isDisplay) ? (art.cardOnlyUrl || art.originalCardUrl) : art.originalCardUrl;
                                    if (targetCardUrl) {
                                      const suffix = art.isDisplay ? "cutout" : art.isCase ? "card_only" : "card";
                                      triggerDownload(
                                        targetCardUrl, 
                                        `TCG_${art.name.replace(/\s+/g, "_")}_${suffix}.png`,
                                        (art.isCase || art.isDisplay) ? art.originalCardUrl : undefined
                                      );
                                    }
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                                  <span>{art.isDisplay ? "Display-Ausschnitt (Kein HG)" : art.isCase ? "Nur Karte (Kein Case/HG)" : "Nur Karte (Kein HG)"}</span>
                                </button>
                              )}
                              {art.backgroundUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    const nameBase = art.name.replace(/\s+/g, "_");
                                    const cardUrl = art.isDisplay ? (art.cardOnlyUrl || art.originalCardUrl || art.imageUrl) : (art.originalCardUrl || art.imageUrl);
                                    const suffix = art.isDisplay ? "cutout" : "card";
                                    const filesToDownload: { url: string; filename: string; fallbackUrl?: string }[] = [
                                      { url: art.backgroundUrl!, filename: `TCG_${nameBase}_background.png` },
                                      { url: cardUrl, filename: `TCG_${nameBase}_${suffix}.png` }
                                    ];
                                    triggerZipDownload(filesToDownload, `TCG_${nameBase}_split_components.zip`);
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                    <span className="text-[9px] font-bold text-indigo-400">ZIP</span>
                                  </div>
                                  <span>{art.isDisplay ? "Hintergrund & Ausschnitt trennen" : art.isCase ? "Hintergrund & Case trennen" : "Hintergrund & Karte trennen"}</span>
                                </button>
                              )}
                              {art.isCase && art.backgroundUrl && art.originalCardUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    const nameBase = art.name.replace(/\s+/g, "_");
                                    const filesToDownload: { url: string; filename: string; fallbackUrl?: string }[] = [
                                      { url: art.backgroundUrl!, filename: `TCG_${nameBase}_background.png` },
                                      { url: art.originalCardUrl!, filename: `TCG_${nameBase}_case_with_card.png` }
                                    ];
                                    if (art.cardOnlyUrl) {
                                      filesToDownload.push({
                                        url: art.cardOnlyUrl,
                                        filename: `TCG_${nameBase}_card_only.png`,
                                        fallbackUrl: art.originalCardUrl
                                      });
                                    }
                                    triggerZipDownload(filesToDownload, `TCG_${nameBase}_all_parts.zip`);
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                    <span className="text-[9px] font-bold text-purple-400">ZIP</span>
                                  </div>
                                  <span>Alle Teile (Hintergrund + Case + Karte)</span>
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleFindCardName(art)}
                          disabled={identifyingArtworkId === art.id}
                          className={`p-2 rounded-lg border border-zinc-850 bg-zinc-950 text-zinc-500 hover:text-purple-400 hover:border-purple-500/30 transition-colors ${
                            identifyingArtworkId === art.id ? "cursor-wait opacity-65" : ""
                          }`}
                          title="Kartenname finden"
                        >
                          {identifyingArtworkId === art.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingArtwork(art);
                            setRenameValue(art.name);
                            setIsRenameModalOpen(true);
                          }}
                          className="p-2 rounded-lg border border-zinc-855 bg-zinc-950 text-zinc-500 hover:text-purple-400 hover:border-purple-500/30 transition-colors"
                          title="Karte umbenennen"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            handleSelectArtworkForCase(art.id);
                            setActiveTab("case");
                          }}
                          className="p-2 rounded-lg border border-zinc-855 bg-zinc-955 text-zinc-500 hover:text-purple-400 hover:border-purple-500/30 transition-colors"
                          title="Case-Showroom erstellen"
                        >
                          <Layers className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Empty state */
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/10 p-12 text-center flex flex-col items-center justify-center min-h-[400px]">
                <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4 text-zinc-500">
                  <Bookmark className="w-8 h-8 text-zinc-650" />
                </div>
                <h3 className="text-lg font-semibold text-white">
                  {searchQuery ? "Keine passenden Kunstwerke gefunden" : "Deine Bibliothek ist leer"}
                </h3>
                <p className="text-sm text-zinc-500 mt-2 max-w-sm">
                  {searchQuery
                    ? "Überprüfe die Schreibweise oder suche nach einem anderen Kartennamen."
                    : "Gehe zum Studio-Tab, erweitere deine Lieblingskarten und speichere sie, um deine persönliche Bibliothek aufzubauen."}
                </p>
                {!searchQuery && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("generate")}
                    className="mt-6 px-5 py-2.5 rounded-xl bg-purple-600/15 border border-purple-500/30 hover:bg-purple-600/25 text-purple-400 font-semibold text-sm transition-all"
                  >
                    Erstellungs-Studio öffnen
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 text-center text-xs text-zinc-650 border-t border-zinc-900 pt-8 pb-4">
          <p>© {new Date().getFullYear()} New World Legacy Shop Asset Generator. Powered by Google Gemini & Imagen 3.</p>
        </footer>
        {/* Save Modal Popup */}
        {isSaveModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-850 rounded-2xl p-6 shadow-2xl">
              <button
                onClick={closeSaveModal}
                disabled={isSaving}
                className="absolute top-4 right-4 p-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Bookmark className="w-5 h-5 text-purple-400" />
                In Bibliothek speichern
              </h3>
              <p className="text-sm text-zinc-400 mb-4">
                Gib einen Namen für dieses erweiterte Sammelkarten-Kunstwerk ein, um es in deiner Bibliothek zu speichern.
              </p>

              <input
                type="text"
                placeholder="z.B. Glurak Alt Art"
                value={newArtworkName}
                onChange={(e) => setNewArtworkName(e.target.value)}
                disabled={isSaving}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm mb-6 disabled:opacity-50"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newArtworkName.trim() && !isSaving) handleSaveArtwork();
                }}
              />

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={closeSaveModal}
                  disabled={isSaving}
                  className="px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-355 hover:text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={handleSaveArtwork}
                  disabled={!newArtworkName.trim() || isSaving}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-[0_4px_15px_rgba(147,51,234,0.2)] flex items-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Speichern...
                    </>
                  ) : (
                    "Kunstwerk speichern"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rename Modal Popup */}
        {isRenameModalOpen && renamingArtwork && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-850 rounded-2xl p-6 shadow-2xl">
              <button
                onClick={() => {
                  setIsRenameModalOpen(false);
                  setRenamingArtwork(null);
                }}
                className="absolute top-4 right-4 p-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Pencil className="w-5 h-5 text-purple-400" />
                Kunstwerk umbenennen
              </h3>
              <p className="text-sm text-zinc-400 mb-4">
                Gib einen neuen Namen für &quot;{renamingArtwork.name}&quot; ein.
              </p>

              <input
                type="text"
                placeholder="z.B. Glurak Alt Art"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm mb-6"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameValue.trim()) handleRenameArtwork();
                }}
              />

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setIsRenameModalOpen(false);
                    setRenamingArtwork(null);
                  }}
                  className="px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-350 hover:text-white text-sm font-semibold transition-colors"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={handleRenameArtwork}
                  disabled={!renameValue.trim() || renameValue.trim() === renamingArtwork.name}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-[0_4px_15px_rgba(147,51,234,0.2)]"
                >
                  Umbenennen
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Lightbox Modal */}
        {lightboxImage && (
          <div 
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-xl transition-all duration-300"
            onClick={() => setLightboxImage(null)}
          >
            {/* Close button */}
            <button
              type="button"
              className="absolute top-6 right-6 p-3 rounded-full bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white transition-all z-50 cursor-pointer shadow-lg"
              onClick={() => setLightboxImage(null)}
              title="Schließen (ESC)"
            >
              <X className="w-6 h-6" />
            </button>

            {/* Lightbox content */}
            <div 
              className="relative max-w-4xl w-full flex flex-col items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {/* The image */}
              <div className="relative rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl bg-zinc-950 max-h-[80vh] max-w-full flex items-center justify-center p-8">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={lightboxImage.url}
                  alt={lightboxImage.title}
                  className="max-h-[70vh] max-w-full object-contain"
                />
              </div>
              
              {/* Title / Info / Actions */}
              <div className="mt-4 flex flex-col items-center gap-2 text-center">
                <h3 className="text-lg font-bold text-white tracking-wide">
                  {lightboxImage.title}
                </h3>
                <a
                  href={lightboxImage.url}
                  download={`TCG_${lightboxImage.title.replace(/\s+/g, "_")}.png`}
                  className="mt-1 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs flex items-center gap-2 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
                >
                  <Download className="w-4 h-4" />
                  Bild herunterladen
                </a>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

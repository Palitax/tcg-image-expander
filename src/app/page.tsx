"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
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
  ChevronDown
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
  { id: "LAYOUT", label: "Layout Analysis", description: "Gemini detects inner card artwork bounding box", status: "idle" },
  { id: "CROP", label: "Artwork Extraction", description: "Sharp extracts the illustration using coordinates", status: "idle" },
  { id: "OUTPAINT", label: "Background Expansion", description: "Imagen 3 outpaints background in target aspect ratio", status: "idle" },
  { id: "MERGE", label: "Card Compositing", description: "Overlay card with elegant soft shadow and finish", status: "idle" }
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

const triggerDownload = async (url: string, filename: string, fallbackUrl?: string): Promise<void> => {
  try {
    // If it is already a base64 data URL, we can download it directly
    if (url.startsWith("data:")) {
      const mimeMatch = url.match(/^data:([^;]+);/);
      let adjustedFilename = filename;
      if (mimeMatch) {
        const mimeType = mimeMatch[1];
        let ext = "";
        if (mimeType === "image/webp") ext = "webp";
        else if (mimeType === "image/png") ext = "png";
        else if (mimeType === "image/jpeg" || mimeType === "image/jpg") ext = "jpg";
        
        if (ext) {
          adjustedFilename = filename.replace(/\.[^/.]+$/, "") + "." + ext;
        }
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = adjustedFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    // For external URLs (like Supabase storage), fetch the file as a Blob 
    // to bypass browser cross-origin download blocks and force standard saving
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const blob = await response.blob();
    const mimeType = blob.type;
    let adjustedFilename = filename;
    let ext = "";
    if (mimeType === "image/webp") ext = "webp";
    else if (mimeType === "image/png") ext = "png";
    else if (mimeType === "image/jpeg" || mimeType === "image/jpg") ext = "jpg";
    
    if (ext) {
      adjustedFilename = filename.replace(/\.[^/.]+$/, "") + "." + ext;
    }

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
    if (fallbackUrl) {
      console.log("Attempting download with fallback URL:", fallbackUrl);
      return triggerDownload(fallbackUrl, filename);
    }
    
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

// SavedArtwork interface is imported from @/utils/db

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string>("3:4");
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
  const [savedArtworks, setSavedArtworks] = useState<SavedArtwork[]>([]);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState<boolean>(false);
  const [saveTarget, setSaveTarget] = useState<"generate" | "case" | "upload">("generate");
  const [newArtworkName, setNewArtworkName] = useState<string>("");
  const [libraryUploadDataUrl, setLibraryUploadDataUrl] = useState<string | null>(null);
  const [libraryUploadAspectRatio, setLibraryUploadAspectRatio] = useState<string>("3:4");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Card renaming states
  const [isRenameModalOpen, setIsRenameModalOpen] = useState<boolean>(false);
  const [renamingArtwork, setRenamingArtwork] = useState<SavedArtwork | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");

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
            const originalCardUrl = row.original_card_url || undefined;
            const isCase = originalCardUrl ? (originalCardUrl.includes("case_with_card") || originalCardUrl.includes("/case_with_card")) : false;
            let cardOnlyUrl: string | undefined = undefined;
            if (isCase && originalCardUrl) {
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
              isCase: isCase
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
      setLoginError(message || "Failed to check space availability.");
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
          const originalCardUrl = row.original_card_url || undefined;
          const isCase = originalCardUrl ? (originalCardUrl.includes("case_with_card") || originalCardUrl.includes("/case_with_card")) : false;
          let cardOnlyUrl: string | undefined = undefined;
          if (isCase && originalCardUrl) {
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
            isCase: isCase
          };
        });
        setSavedArtworks(formatted);
        
        setLoginSpaceName("");
        setLoginPasscode("");
        setLoginStep("name");
      } else {
        setLoginError("Incorrect 4-digit passcode.");
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setLoginError(message || "An error occurred during login.");
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
      setLoginError(message || "Failed to create space.");
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

  const closeSaveModal = () => {
    setIsSaveModalOpen(false);
    setNewArtworkName("");
    setLibraryUploadDataUrl(null);
  };

  const handleSaveArtwork = async () => {
    const targetUrl = 
      saveTarget === "case" ? caseResultUrl : 
      saveTarget === "upload" ? libraryUploadDataUrl : 
      resultImageUrl;

    if (!targetUrl || !newArtworkName.trim()) return;

    const artId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();

    let imageUrl = targetUrl;
    let originalCardUrl = 
      saveTarget === "generate" ? (trimmedCard || undefined) : 
      saveTarget === "case" ? (caseWithCardUrl || caseCardImage || undefined) : 
      undefined;
    let backgroundUrl = 
      saveTarget === "generate" ? (backgroundImageUrl || undefined) : 
      saveTarget === "case" ? (caseBgResultUrl || caseBgImage || undefined) : 
      undefined;

    const timestamp = Date.now();

    if (!isLocalMode && currentSpace) {
      setIsLoginLoading(true);
      try {
        if (imageUrl.startsWith("data:image/")) {
          imageUrl = await uploadBase64ToSupabase(imageUrl, `spaces/${currentSpace.id}/${artId}/final.png`);
        }
        if (originalCardUrl && originalCardUrl.startsWith("data:image/")) {
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
            aspect_ratio: saveTarget === "upload" ? libraryUploadAspectRatio : aspectRatio,
            timestamp: timestamp
          });

        if (error) throw error;
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to save artwork to database: " + message);
        setIsLoginLoading(false);
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
        cardOnlyUrl: saveTarget === "case" ? (caseCardImage || undefined) : undefined,
        aspectRatio: saveTarget === "upload" ? libraryUploadAspectRatio : aspectRatio,
        timestamp: timestamp,
        isCase: saveTarget === "case"
      };

      try {
        await saveArtwork(localArtwork);
      } catch (err) {
        const message = getErrorMessage(err);
        alert("Failed to save artwork locally: " + message);
        return;
      }
    }

    // Reconstruct cardOnlyUrl in memory for the updated state (either local or supabase-predicted)
    let finalCardOnlyUrl: string | undefined = undefined;
    if (saveTarget === "case") {
      if (!isLocalMode && currentSpace) {
        if (originalCardUrl && originalCardUrl.includes("case_with_card.png")) {
          finalCardOnlyUrl = originalCardUrl.replace("case_with_card.png", "card_only.png");
        } else {
          finalCardOnlyUrl = caseCardImage || undefined;
        }
      } else {
        finalCardOnlyUrl = caseCardImage || undefined;
      }
    }

    const newArtworkRecord: SavedArtwork = {
      id: artId,
      name: newArtworkName.trim(),
      imageUrl: imageUrl,
      originalCardUrl: originalCardUrl,
      backgroundUrl: backgroundUrl,
      cardOnlyUrl: finalCardOnlyUrl,
      aspectRatio: saveTarget === "upload" ? libraryUploadAspectRatio : aspectRatio,
      timestamp: timestamp,
      isCase: saveTarget === "case"
    };

    const updated = [newArtworkRecord, ...savedArtworks];
    setSavedArtworks(updated);
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
              if (!isProcessing) {
                onDrop([pastedFile]);
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
  }, [activeTab, isProcessing, onDrop, onLibraryDrop]);

  const updateStepStatus = (stepId: string, status: "running" | "success" | "error") => {
    setSteps(prev => 
      prev.map(step => {
        if (step.id === stepId) {
          return { ...step, status };
        }
        // If this step succeeded, make sure all previous steps are marked success too
        if (status === "success" && prev.findIndex(s => s.id === stepId) > prev.findIndex(s => s.id === step.id)) {
          return { ...step, status: "success" };
        }
        return step;
      })
    );
  };

  const handleProcessImage = async () => {
    if (!file) return;
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
        body: cropFormData
      });

      const { croppedImage, trimmedCard: cropTrimmedCard, usedFallback: cropFallback } = await parseResponseData(
        cropResponse,
        "Failed to analyze and crop card artwork."
      );
      setUsedCropFallback(cropFallback || false);
      setTrimmedCard(cropTrimmedCard || null);
      updateStepStatus("LAYOUT", "success");
      updateStepStatus("CROP", "success");

      // STEP 3: Outpainting with style analysis & Imagen 3
      updateStepStatus("OUTPAINT", "running");
      setActiveStepMessage("Analyzing style with Gemini...");

      const outpaintResponse = await fetchWithRetry(
        "/api/pipeline/outpaint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ croppedImage, aspectRatio, mode: bgMode })
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
        })
      });

      const { resultImageUrl } = await parseResponseData(
        mergeResponse,
        "Failed to merge card and background."
      );
      updateStepStatus("MERGE", "success");
      setResultImageUrl(resultImageUrl);
      setActiveStepMessage("Completed!");

    } catch (error) {
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
  };

  const filteredArtworks = savedArtworks.filter(art =>
    art.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
              Welcome to New World Legacy – Bilder generieren
            </h2>
            <p className="text-sm text-zinc-400 mb-6 text-center">
              {loginStep === "name" 
                ? "Enter a Space name to access your library or create a new sharing Space."
                : loginStep === "code"
                ? `Enter the 4-digit passcode for Space "${loginSpaceName}".`
                : `Space "${loginSpaceName}" does not exist. Create it by setting a 4-digit passcode.`}
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
                  placeholder="Space Name (e.g. pikachu-fans)"
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
                  Remember me on this device
                </label>

                <button
                  type="submit"
                  disabled={isLoginLoading || !loginSpaceName.trim()}
                  className="w-full mt-2 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
                >
                  {isLoginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Continue"}
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
                    Back
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
                      "Unlock Space"
                    ) : (
                      "Create Space"
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
            AI-Powered TCG Showcases
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-zinc-300 to-purple-400 bg-clip-text text-transparent">
            New World Legacy – Bilder generieren
          </h1>
          <p className="mt-3 text-lg text-zinc-400 max-w-2xl">
            Expand card illustrations into immersive backgrounds. Display cards in stunning layouts optimized for web shops and social media sharing.
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
              Case Maker
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
              My Library ({savedArtworks.length})
            </button>
          </div>

          {/* Space indicator / Logout */}
          {!isLocalMode && currentSpace && (
            <div className="flex items-center gap-3 px-4 py-2 rounded-xl border border-zinc-800 bg-zinc-900/20 text-xs font-semibold text-zinc-400">
              <Layers className="w-3.5 h-3.5 text-purple-400" />
              <span>Space: <strong className="text-zinc-200">{currentSpace.name}</strong></span>
              {isSpaceSyncing && <RefreshCw className="w-3 h-3 text-purple-400 animate-spin" />}
              <span className="w-px h-3.5 bg-zinc-800 mx-1" />
              <button
                type="button"
                onClick={handleLogout}
                className="text-purple-400 hover:text-purple-300 transition-colors flex items-center gap-1 cursor-pointer"
              >
                Logout
              </button>
            </div>
          )}
        </div>

        {activeTab === "generate" ? (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left panel - Controls & Source */}
          <section className="lg:col-span-7 flex flex-col gap-6">
            
            {/* Aspect Ratio & Control Card */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Layers className="w-5 h-5 text-purple-400" />
                1. Configuration
              </h2>
              
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-2">Target Aspect Ratio</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { value: "3:4", label: "Portrait 3:4", desc: "Classic Showcase" },
                      { value: "9:16", label: "Story 9:16", desc: "Vertical Full" },
                      { value: "1:1", label: "Square 1:1", desc: "Grid/Instagram" },
                      { value: "16:9", label: "Landscape 16:9", desc: "Banner/Wallpaper" }
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
                2. Card Upload
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
                    Drag and drop your card image here, or <span className="text-purple-400">browse</span>
                  </p>
                  <p className="text-xs text-zinc-500 mt-2 text-center">
                    Supports PNG, JPG, JPEG, WEBP (up to 10MB)
                  </p>
                </div>
              ) : (
                <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950/50 p-4 flex flex-col items-center">
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
                      Auto-crop card edges (turn off if card is already clean/full-bleed)
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
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={handleReset}
                        className="px-3 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Remove
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
                    Processing ({elapsedTime.toFixed(1)}s)...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    Expand Card Illustration
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
                    <h3 className="font-semibold text-white">Pipeline Execution Failed</h3>
                    <p className="text-sm text-zinc-400 mt-1">{errorMessage}</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-3.5 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950/50 text-zinc-400 hover:text-zinc-200 text-xs font-semibold transition-colors"
                  >
                    Clear File
                  </button>
                  <button
                    type="button"
                    onClick={handleProcessImage}
                    className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                  >
                    Retry
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
                  <div className="text-xs text-zinc-400 flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-zinc-850 bg-zinc-950/60 font-mono">
                    <Clock className="w-3.5 h-3.5 text-zinc-500" />
                    {elapsedTime.toFixed(1)}s
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
                              Download
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
                                  <span>Merged Card (Single Image)</span>
                                </button>
                                {(trimmedCard || previewUrl) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsGenDownloadOpen(false);
                                      const nameBase = file?.name ? file.name.replace(/\.[^/.]+$/, "") : "expanded";
                                      const cardUrl = trimmedCard || previewUrl;
                                      if (cardUrl) {
                                        triggerDownload(cardUrl, `TCG_${nameBase}_card.png`);
                                      }
                                    }}
                                    className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                  >
                                    <ImageIcon className="w-4 h-4 text-blue-400" />
                                    <span>Card Only (No Background)</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsGenDownloadOpen(false);
                                    const nameBase = file?.name ? file.name.replace(/\.[^/.]+$/, "") : "expanded";
                                    // Download background
                                    if (backgroundImageUrl) {
                                      triggerDownload(backgroundImageUrl, `TCG_${nameBase}_background.png`);
                                    }
                                    // Download card
                                    setTimeout(() => {
                                      const cardUrl = trimmedCard || previewUrl;
                                      if (cardUrl) {
                                        triggerDownload(cardUrl, `TCG_${nameBase}_card.png`);
                                      }
                                    }, 250);
                                  }}
                                  className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                    <span className="text-[10px] font-bold text-indigo-400">2x</span>
                                  </div>
                                  <span>Split Components (BG + Card)</span>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSaveTarget("generate");
                            setNewArtworkName(file?.name ? file.name.replace(/\.[^/.]+$/, "") : "");
                            setIsSaveModalOpen(true);
                          }}
                          className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(147,51,234,0.2)]"
                        >
                          <Bookmark className="w-4 h-4" />
                          Save to Library
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
                        Create Case Showcase
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                      <ImageIcon className="w-8 h-8 text-zinc-650" />
                    </div>
                    <p className="text-sm font-semibold text-zinc-400">No showcase generated yet</p>
                    <p className="text-xs text-zinc-600 mt-2 max-w-[240px]">
                      Upload your trading card and run the pipeline to see the final product showcase.
                    </p>
                  </div>
                )}
              </div>
            </div>

          </section>

        </div>
        ) : activeTab === "case" ? (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left panel - Case configuration & library selection */}
            <section className="lg:col-span-7 flex flex-col gap-6">
              {/* Select from Library */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl p-6 shadow-2xl">
                <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-purple-400" />
                  TCG Case Configuration
                </h2>
                
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2">Select Expanded Card</label>
                    {savedArtworks.length === 0 && !caseCardImage ? (
                      <div className="p-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/20 text-center">
                        <p className="text-sm text-zinc-500">Your library is empty.</p>
                        <p className="text-xs text-zinc-650 mt-1">Please expand a card in the Studio and save it first, or use the currently generated card.</p>
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
                          <option value="">-- Choose a card --</option>
                          {caseCardImage && !selectedArtworkId && (
                            <option value="current">Current Session Card (Studio)</option>
                          )}
                          {savedArtworks.map(art => (
                            <option key={art.id} value={art.id}>
                              {art.name} ({art.aspectRatio}){!art.originalCardUrl ? " [Will generate ambient background]" : ""}
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
                                    : "Current Session Card"}
                                </p>
                                <p className="text-xs text-purple-400 font-medium">
                                  {caseBgImage === "ambient" 
                                    ? "Ready to insert into case (with ambient blurred background)" 
                                    : "Ready to insert into case (with expanded background)"}
                                </p>
                              </div>
                            </div>
                            
                            {caseBgImage === "ambient" && (
                              <div className="px-4 py-3 rounded-xl border border-purple-500/10 bg-purple-500/5 text-purple-400 flex gap-2 items-center text-xs">
                                <Info className="w-4 h-4 shrink-0" />
                                <span>No background layer was found. An ambient blurred background will be generated.</span>
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
                      Creating Case Image...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-5 h-5" />
                      Create Case Image
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
                      <h3 className="font-semibold text-white">Case Generation Failed</h3>
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
                      Clear Selection
                    </button>
                    <button
                      type="button"
                      onClick={handleProcessCaseImage}
                      className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                    >
                      Retry
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
                  Case Showcase Preview
                </h2>

                <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950/80 rounded-xl border border-zinc-850 p-4 relative min-h-[350px]">
                  {isCaseProcessing ? (
                    <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                        <RefreshCw className="w-8 h-8 text-purple-400 animate-spin" />
                      </div>
                      <p className="text-sm font-semibold text-zinc-400">Rendering case showcase...</p>
                      <p className="text-xs text-zinc-650 mt-2 max-w-[200px]">
                        Compositing card layers inside the transparent plastic slab template.
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
                              Download
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
                                  <span>Merged Showcase (Slab + BG)</span>
                                </button>
                                {caseCardImage && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsCaseDownloadOpen(false);
                                      const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                      triggerDownload(caseCardImage, `Slab_${nameBase}_card.png`);
                                    }}
                                    className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                  >
                                    <ImageIcon className="w-4 h-4 text-blue-400" />
                                    <span>Card Only (No Case/BG)</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsCaseDownloadOpen(false);
                                    const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                    // Download background
                                    if (caseBgResultUrl) {
                                      triggerDownload(caseBgResultUrl, `Slab_${nameBase}_background.png`);
                                    }
                                    // Download case with card
                                    setTimeout(() => {
                                      if (caseWithCardUrl) {
                                        triggerDownload(caseWithCardUrl, `Slab_${nameBase}_case_with_card.png`);
                                      }
                                    }, 250);
                                  }}
                                  className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                    <span className="text-[10px] font-bold text-indigo-400">2x</span>
                                  </div>
                                  <span>Split Components (BG + Case)</span>
                                </button>
                                {caseCardImage && caseBgResultUrl && caseWithCardUrl && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsCaseDownloadOpen(false);
                                      const nameBase = selectedArtworkId ? savedArtworks.find(a => a.id === selectedArtworkId)?.name : "Showcase";
                                      const cardImg = caseCardImage;
                                      const bgImg = caseBgResultUrl;
                                      const caseImg = caseWithCardUrl;
                                      if (cardImg && bgImg && caseImg) {
                                        // 1. Download background
                                        triggerDownload(bgImg, `Slab_${nameBase}_background.png`);
                                        // 2. Download case with card
                                        setTimeout(() => {
                                          triggerDownload(caseImg, `Slab_${nameBase}_case_with_card.png`);
                                        }, 250);
                                        // 3. Download only card
                                        setTimeout(() => {
                                          triggerDownload(cardImg, `Slab_${nameBase}_card.png`);
                                        }, 500);
                                      }
                                    }}
                                    className="w-full px-3 py-2.5 rounded-lg hover:bg-zinc-800/80 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                  >
                                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                      <span className="text-[10px] font-bold text-purple-400">3x</span>
                                    </div>
                                    <span>All Parts (BG + Case + Card)</span>
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
                            setNewArtworkName(
                              selectedArtworkId 
                                ? `${savedArtworks.find(a => a.id === selectedArtworkId)?.name} Slab`
                                : file?.name ? `${file.name.replace(/\.[^/.]+$/, "")} Slab` : "My Slab Showcase"
                            );
                            setIsSaveModalOpen(true);
                          }}
                          className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(147,51,234,0.2)]"
                        >
                          <Bookmark className="w-4 h-4" />
                          Save to Library
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center text-zinc-550 p-8 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full border border-zinc-850 bg-zinc-900/40 flex items-center justify-center mb-4">
                        <Layers className="w-8 h-8 text-zinc-650" />
                      </div>
                      <p className="text-sm font-semibold text-zinc-400">No case showcase generated yet</p>
                      <p className="text-xs text-zinc-600 mt-2 max-w-[240px]">
                        Select an expanded card from the config list and hit the button to generate the final TCG slab showcase.
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
                <p className="text-lg font-bold text-white">Drop image to save to Library</p>
                <p className="text-xs text-purple-300 mt-2 font-medium">Supports PNG, JPG, WEBP</p>
              </div>
            )}

            {/* Search Bar / Stats */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-xl">
              <div className="relative w-full sm:max-w-md">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                  <Search className="h-4 w-4 text-zinc-500" />
                </span>
                <input
                  type="text"
                  placeholder="Search saved cards by name..."
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
                  Upload Card
                </button>
                <div className="text-sm text-zinc-400 font-medium whitespace-nowrap">
                  Showing {filteredArtworks.length} of {savedArtworks.length} saved artworks
                </div>
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
                    </div>

                    <h3 className="font-bold text-white text-base truncate mb-1" title={art.name}>
                      {art.name}
                    </h3>
                    <p className="text-[10px] text-zinc-550 mb-4">
                      Saved {new Date(art.timestamp).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </p>

                    <div className="flex gap-2 mt-auto pt-2 border-t border-zinc-850/50">
                      <div className="flex-1 relative">
                        <div className="flex rounded-lg bg-zinc-800 border border-zinc-700 divide-x divide-zinc-750 transition-all overflow-hidden">
                          <button
                            type="button"
                            onClick={() => {
                              triggerDownload(art.imageUrl, `TCG_${art.name.replace(/\s+/g, "_")}.png`);
                            }}
                            className="flex-1 py-2 px-3 hover:bg-zinc-700 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Download
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
                            <div className="absolute right-0 bottom-full mb-1.5 w-52 rounded-lg border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1 shadow-2xl z-30 flex flex-col gap-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenLibraryDownloadId(null);
                                  triggerDownload(art.imageUrl, `TCG_${art.name.replace(/\s+/g, "_")}.png`);
                                }}
                                className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors"
                              >
                                <Layers className="w-3.5 h-3.5 text-purple-400" />
                                <span>{art.isCase ? "Merged Showcase" : "Merged Card"}</span>
                              </button>
                              {(art.cardOnlyUrl || art.originalCardUrl) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    const targetCardUrl = art.isCase ? (art.cardOnlyUrl || art.originalCardUrl) : art.originalCardUrl;
                                    if (targetCardUrl) {
                                      const suffix = art.isCase ? "card_only" : "card";
                                      triggerDownload(
                                        targetCardUrl, 
                                        `TCG_${art.name.replace(/\s+/g, "_")}_${suffix}.png`,
                                        art.isCase ? art.originalCardUrl : undefined
                                      );
                                    }
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                                  <span>{art.isCase ? "Card Only (No Case/BG)" : "Card Only (No BG)"}</span>
                                </button>
                              )}
                              {art.backgroundUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    // Download background
                                    triggerDownload(art.backgroundUrl!, `TCG_${art.name.replace(/\s+/g, "_")}_background.png`);
                                    // Download card
                                    setTimeout(() => {
                                      const cardUrl = art.originalCardUrl || art.imageUrl;
                                      triggerDownload(cardUrl, `TCG_${art.name.replace(/\s+/g, "_")}_card.png`);
                                    }, 250);
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                    <span className="text-[9px] font-bold text-indigo-400">2x</span>
                                  </div>
                                  <span>{art.isCase ? "Split BG & Case" : "Split BG & Card"}</span>
                                </button>
                              )}
                              {art.isCase && art.backgroundUrl && art.originalCardUrl && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenLibraryDownloadId(null);
                                    const targetCardUrl = art.cardOnlyUrl || art.originalCardUrl;
                                    if (targetCardUrl) {
                                      // 1. Download background
                                      triggerDownload(art.backgroundUrl!, `TCG_${art.name.replace(/\s+/g, "_")}_background.png`);
                                      // 2. Download case with card
                                      setTimeout(() => {
                                        triggerDownload(art.originalCardUrl!, `TCG_${art.name.replace(/\s+/g, "_")}_case_with_card.png`);
                                      }, 250);
                                      // 3. Download only card
                                      setTimeout(() => {
                                        triggerDownload(
                                          targetCardUrl,
                                          `TCG_${art.name.replace(/\s+/g, "_")}_card_only.png`,
                                          art.originalCardUrl
                                        );
                                      }, 500);
                                    }
                                  }}
                                  className="w-full px-2.5 py-2 rounded hover:bg-zinc-800 text-left text-xs text-white font-medium flex items-center gap-2 transition-colors border-t border-zinc-800"
                                >
                                  <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                    <span className="text-[9px] font-bold text-purple-400">3x</span>
                                  </div>
                                  <span>All Parts (BG + Case + Card)</span>
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingArtwork(art);
                          setRenameValue(art.name);
                          setIsRenameModalOpen(true);
                        }}
                        className="p-2 rounded-lg border border-zinc-850 bg-zinc-950 text-zinc-500 hover:text-purple-400 hover:border-purple-500/30 transition-colors"
                        title="Rename Card"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleSelectArtworkForCase(art.id);
                          setActiveTab("case");
                        }}
                        className="p-2 rounded-lg border border-zinc-850 bg-zinc-950 text-zinc-500 hover:text-purple-400 hover:border-purple-500/30 transition-colors"
                        title="Create Case Showroom"
                      >
                        <Layers className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteArtwork(art.id)}
                        className="p-2 rounded-lg border border-zinc-850 bg-zinc-955 text-zinc-500 hover:text-red-400 hover:border-red-500/30 transition-colors"
                        title="Delete from Library"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
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
                  {searchQuery ? "No matching artworks found" : "Your library is empty"}
                </h3>
                <p className="text-sm text-zinc-500 mt-2 max-w-sm">
                  {searchQuery
                    ? "Try checking for spelling errors or search for a different card name."
                    : "Go to the Studio tab, expand your favorite trading cards, and save them to build your personal library."}
                </p>
                {!searchQuery && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("generate")}
                    className="mt-6 px-5 py-2.5 rounded-xl bg-purple-600/15 border border-purple-500/30 hover:bg-purple-600/25 text-purple-400 font-semibold text-sm transition-all"
                  >
                    Open Generate Studio
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 text-center text-xs text-zinc-650 border-t border-zinc-900 pt-8 pb-4">
          <p>© {new Date().getFullYear()} New World Legacy – Bilder generieren. Powered by Google Gemini & Imagen 3.</p>
        </footer>
        {/* Save Modal Popup */}
        {isSaveModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-850 rounded-2xl p-6 shadow-2xl">
              <button
                onClick={closeSaveModal}
                className="absolute top-4 right-4 p-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Bookmark className="w-5 h-5 text-purple-400" />
                Save to Library
              </h3>
              <p className="text-sm text-zinc-400 mb-4">
                Enter a name for this expanded trading card artwork to save it to your library.
              </p>

              <input
                type="text"
                placeholder="e.g. Charizard Alt Art"
                value={newArtworkName}
                onChange={(e) => setNewArtworkName(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-550 focus:border-purple-500 focus:outline-none transition-colors text-sm mb-6"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newArtworkName.trim()) handleSaveArtwork();
                }}
              />

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={closeSaveModal}
                  className="px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-950 text-zinc-350 hover:text-white text-sm font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveArtwork}
                  disabled={!newArtworkName.trim()}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-[0_4px_15px_rgba(147,51,234,0.2)]"
                >
                  Save Artwork
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
                Rename Artwork
              </h3>
              <p className="text-sm text-zinc-400 mb-4">
                Enter a new name for &quot;{renamingArtwork.name}&quot;.
              </p>

              <input
                type="text"
                placeholder="e.g. Charizard Alt Art"
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
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRenameArtwork}
                  disabled={!renameValue.trim() || renameValue.trim() === renamingArtwork.name}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-purple-800 disabled:to-indigo-800 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-[0_4px_15px_rgba(147,51,234,0.2)]"
                >
                  Rename
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
              <div className="relative rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl bg-zinc-950 max-h-[80vh] max-w-full flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={lightboxImage.url}
                  alt={lightboxImage.title}
                  className="max-h-[75vh] max-w-full object-contain"
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

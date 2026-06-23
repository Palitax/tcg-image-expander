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
  Clock
} from "lucide-react";

interface ProgressStep {
  id: string;
  label: string;
  description: string;
  status: "idle" | "running" | "success" | "error";
}

const INITIAL_STEPS: ProgressStep[] = [
  { id: "LAYOUT", label: "Layout Analysis", description: "Gemini detects inner card artwork bounding box", status: "idle" },
  { id: "CROP", label: "Artwork Extraction", description: "Sharp extracts the illustration using pixel coordinates", status: "idle" },
  { id: "OUTPAINT", label: "Background Expansion", description: "Imagen 3 outpaints background in target aspect ratio", status: "idle" },
  { id: "MERGE", label: "Card Compositing", description: "Overlay card with elegant soft shadow and finish", status: "idle" }
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string>("3:4");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [steps, setSteps] = useState<ProgressStep[]>(INITIAL_STEPS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultImageUrl, setResultImageUrl] = useState<string | null>(null);
  
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
    setElapsedTime(0);
    setActiveStepMessage("Initializing connection...");
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: "idle" })));

    const formData = new FormData();
    formData.append("cardImage", file);
    formData.append("aspectRatio", aspectRatio);

    try {
      const response = await fetch("/api/expand", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Failed to process image.");
      }

      if (!response.body) {
        throw new Error("No response body received from server.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            
            if (data.step) {
              setActiveStepMessage(data.message || "");
              
              if (data.step === "LAYOUT") {
                updateStepStatus("LAYOUT", "running");
              } else if (data.step === "CROP") {
                updateStepStatus("LAYOUT", "success");
                updateStepStatus("CROP", "running");
              } else if (data.step === "OUTPAINT") {
                updateStepStatus("CROP", "success");
                updateStepStatus("OUTPAINT", "running");
              } else if (data.step === "MERGE") {
                updateStepStatus("OUTPAINT", "success");
                updateStepStatus("MERGE", "running");
              } else if (data.step === "SUCCESS") {
                updateStepStatus("MERGE", "success");
                if (data.data && data.data.resultImageUrl) {
                  setResultImageUrl(data.data.resultImageUrl);
                }
              } else if (data.step === "ERROR") {
                throw new Error(data.message || "An error occurred during pipeline execution.");
              }
            }
          } catch (e: any) {
            console.error("Failed to parse chunk:", e);
            throw new Error(e.message || "Error parsing server update stream.");
          }
        }
      }
    } catch (error: any) {
      console.error("Pipeline error:", error);
      setErrorMessage(error.message || "An unexpected error occurred.");
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
    setErrorMessage(null);
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: "idle" })));
    setElapsedTime(0);
    setActiveStepMessage("");
  };

  return (
    <div className="flex-1 w-full min-h-screen flex flex-col relative overflow-hidden bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-950/20 via-zinc-950 to-black">
      {/* Visual background accents */}
      <div className="absolute top-0 right-1/4 w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/4 w-[400px] h-[400px] bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Main container */}
      <main className="flex-1 flex flex-col max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-10 relative z-10">
        
        {/* Header */}
        <header className="text-center mb-10 flex flex-col items-center">
          <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-purple-500/20 bg-purple-500/5 text-purple-400 text-xs font-semibold uppercase tracking-wider mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            AI-Powered TCG Showcases
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-zinc-300 to-purple-400 bg-clip-text text-transparent">
            TCG Art Studio
          </h1>
          <p className="mt-3 text-lg text-zinc-400 max-w-2xl">
            Expand card illustrations into immersive backgrounds. Display cards in stunning portrait layouts optimized for websites and online stores.
          </p>
        </header>

        {/* Content grid */}
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
                  
                  <div className="w-full flex items-center justify-between mt-4 pt-4 border-t border-zinc-800/80">
                    <div className="truncate pr-4">
                      <p className="text-sm font-semibold text-zinc-200 truncate">{file.name}</p>
                      <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
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
                    const isIdle = step.status === "idle";
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
                            <p className="text-xs text-zinc-550 mt-0.5 truncate">{step.description}</p>
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
                      className={`relative rounded-lg overflow-hidden border border-zinc-850 shadow-2xl w-full max-w-[340px]`}
                      style={{ aspectRatio: aspectRatio.replace(":", "/") }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resultImageUrl}
                        alt="Final expanded trading card display"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    
                    <a
                      href={resultImageUrl}
                      download={`TCG_${file?.name || "expanded"}`}
                      className="mt-6 px-6 py-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.4)]"
                    >
                      <Download className="w-4 h-4" />
                      Download Expanded Image
                    </a>
                  </div>
                ) : (
                  <div className="text-center text-zinc-500 p-8 flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full border border-zinc-800 bg-zinc-900/40 flex items-center justify-center mb-4">
                      <ImageIcon className="w-8 h-8 text-zinc-600" />
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

        {/* Footer */}
        <footer className="mt-16 text-center text-xs text-zinc-600 border-t border-zinc-900 pt-8 pb-4">
          <p>© {new Date().getFullYear()} TCG Art Studio. Powered by Google Gemini & Imagen 3.</p>
        </footer>

      </main>
    </div>
  );
}

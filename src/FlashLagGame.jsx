import React, { useCallback, useEffect, useRef, useState } from "react";

const MODE_FLASH_LAG = "flash-lag";
const MODE_DISAPPEARING = "disappearing";
const ASPECT_RATIO = 280 / 900;
const PACMAN_IDLE_MOUTH = 0.28; // radians, per-side opening when static
const PACMAN_MIN_MOUTH = 0.12;
const PACMAN_MAX_MOUTH = 0.5;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (v) => Math.round(v * 100) / 100;

function computeTargetX(w, lead) {
  return w / 2 - lead;
}

function canStartTrialLogic(trialIndex, isRun, awaiting, name) {
  if (isRun) return false;
  if (!name.trim()) return false;
  if (trialIndex >= 3) return false;
  return trialIndex === 0 ? !awaiting : awaiting;
}

// Flash-Lag Illusion — Multi-Participant (centered flash, 3 trials each, leaderboard)
// Responsive edition:
// - Canvas resizes with its container via ResizeObserver
// - Positions are scaled on resize so running trials don't jump

export default function FlashLagGame() {
  // Canvas + animation refs
  const canvasRef = useRef(null);
  const stageWrapRef = useRef(null);               // NEW: wrapper to measure available width
  const rafRef = useRef(0);
  const devicePixelRatioRef = useRef(1);

  const runningRef = useRef(false);
  const posRef = useRef(0); // moving dot x (CSS px)
  const lastTsRef = useRef(0);
  const eventTriggeredRef = useRef(false); // true when flash/disappearance already occurred
  const eventXRef = useRef(null); // moving-dot x when event happens
  const flashHideAtRef = useRef(0);

  // NEW: gate for the post-motion response window
  const responseWindowRef = useRef(false);

  // UI state
  const [participant, setParticipant] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [trialIdx, setTrialIdx] = useState(0); // 0..2 (3 trials)
  const [awaitingNext, setAwaitingNext] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [responseLocked, setResponseLocked] = useState(false);
  const [mode, setMode] = useState(MODE_FLASH_LAG);

  // Parameters
  const [speed, setSpeed] = useState(280); // px/s
  const [flashLead, setFlashLead] = useState(80); // px ahead of moving dot AT FLASH MOMENT (centerX − lead is trigger X)
  const [flashYOffset, setFlashYOffset] = useState(0); // px vertical offset for flash dot (positive = lower)
  const [flashDuration, setFlashDuration] = useState(60); // ms (only for in-motion visibility)
  const [dotRadius, setDotRadius] = useState(10);
  const [bg] = useState("#0b1020");
  const [dotColor, setDotColor] = useState("#fffb00ff");
  const [flashColor, setFlashColor] = useState("#f97316");

  // Data
  const [results, setResults] = useState([]);          // all participants' trials
  const [summary, setSummary] = useState(null);        // current participant summary
  const [summaries, setSummaries] = useState([]);      // leaderboard

  const [message, setMessage] = useState("Enter your name to begin.");
  const [, setSelfTestStatus] = useState("pending"); // kept, but NOT shown

  // Layout (responsive)
  const padding = 24;
  // Maintain the original aspect ratio (~900x280)
  const [stageSize, setStageSize] = useState({ width: 900, height: 280 });

  // Basic canvas helpers
  const clear = useCallback(
    (ctx) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    },
    [bg]
  );

  const drawStage = useCallback(
    (ctx, dpr) => {
      // Border only (guideline removed)
      const { width, height } = stageSize;
      const r = 16 * dpr;
      ctx.save();
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 2 * dpr;
      roundRect(ctx, 4 * dpr, 4 * dpr, (width - 8) * dpr, (height - 8) * dpr, r);
      ctx.stroke();
      ctx.restore();
    },
    [stageSize]
  );

  // Observe wrapper width & update canvas size responsively
  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const wrapW = Math.max(320, entry.contentRect.width); // avoid too small
        const newWidth = Math.round(wrapW);
        const newHeight = Math.round(newWidth * ASPECT_RATIO);

        setStageSize((prev) => {
          // Scale any in-flight x positions so animation/feedback stays aligned
          if (prev && prev.width !== newWidth) {
            const prevPlayable = Math.max(1, prev.width - padding * 2);
            const newPlayable  = Math.max(1, newWidth - padding * 2);
            const scale = newPlayable / prevPlayable;

            posRef.current = padding + (posRef.current - padding) * scale;
            if (eventXRef.current != null) {
              eventXRef.current = padding + (eventXRef.current - padding) * scale;
            }
          }
          return { width: newWidth, height: newHeight };
        });
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef]);

  // Resize canvas for DPR crispness whenever stageSize changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    devicePixelRatioRef.current = dpr;
    canvas.width = Math.floor(stageSize.width * dpr);
    canvas.height = Math.floor(stageSize.height * dpr);
    canvas.style.width = stageSize.width + "px";
    canvas.style.height = stageSize.height + "px";

    // Repaint current static frame when not animating
    if (!runningRef.current) {
      const ctx = canvas.getContext("2d");
      clear(ctx);
      drawStage(ctx, dpr);
      // If in response window, keep flash dot visible
      if (responseWindowRef.current && eventTriggeredRef.current && mode === MODE_FLASH_LAG) {
        const y = Math.floor(stageSize.height / 2);
        const centerX = stageSize.width / 2;
        drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
      }
    }
  }, [stageSize.width, stageSize.height, flashYOffset, dotRadius, flashColor, clear, drawStage, mode]);

  const getPacManMouth = (timeMs) => {
    const oscillation = (Math.sin(timeMs * 0.05) + 1) / 2; // 0..1
    return PACMAN_MIN_MOUTH + oscillation * (PACMAN_MAX_MOUTH - PACMAN_MIN_MOUTH);
  };

  const drawPacMan = (ctx, xCss, yCss, radiusCss, dpr, color, mouth = PACMAN_IDLE_MOUTH) => {
    ctx.save();
    ctx.translate(xCss * dpr, yCss * dpr);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radiusCss * dpr, mouth, Math.PI * 2 - mouth, false);
    ctx.closePath();
    ctx.fill();

    // Eye (fixed position so Pac-Man looks alive)
    ctx.beginPath();
    ctx.fillStyle = "#0f172a";
    ctx.arc(radiusCss * dpr * 0.25, -radiusCss * dpr * 0.45, radiusCss * dpr * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const draw = (ts) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = devicePixelRatioRef.current;

    if (!runningRef.current) {
      // If we're in the response window, render static frame (flash dot shown only for flash-lag)
      renderIdleOrResponseFrame(ctx, dpr);
      return;
    }

    if (!lastTsRef.current) lastTsRef.current = ts;
    const dt = (ts - lastTsRef.current) / 1000; // seconds
    lastTsRef.current = ts;

    // Advance moving dot
    posRef.current += speed * dt;

    const { width, height } = stageSize;
    const xMax = width - padding;
    const y = Math.floor(height / 2);
    const centerX = width / 2;
    const targetX = computeTargetX(width, flashLead); // centerX - flashLead

    // Trigger the event when we cross targetX
    if (!eventTriggeredRef.current && posRef.current >= targetX) {
      eventTriggeredRef.current = true;
      eventXRef.current = posRef.current; // truth at event time
      if (mode === MODE_FLASH_LAG) {
        flashHideAtRef.current = ts + flashDuration; // visible briefly while in motion
      } else {
        posRef.current = eventXRef.current;
        runningRef.current = false;
        setIsRunning(false);
        responseWindowRef.current = true;
        setMessage(getResponsePrompt());
        renderIdleOrResponseFrame(ctx, dpr);
        return;
      }
    }

    // Stop the animation if we reached the right boundary (flash-lag mode only)
    if (mode === MODE_FLASH_LAG && posRef.current >= xMax) {
      runningRef.current = false;
      setIsRunning(false);

      // Open response window: keep flash-position dot visible until user answers
      responseWindowRef.current = true;
      setMessage(getResponsePrompt());
      // Draw one static frame for the response window
      renderIdleOrResponseFrame(ctx, dpr);
      return;
    }

    // Render frame (during motion)
    clear(ctx);
    drawStage(ctx, dpr);
    // Moving dot (hidden after disappearance)
    if (!(mode === MODE_DISAPPEARING && eventTriggeredRef.current)) {
      const mouthAngle = getPacManMouth(ts);
      drawPacMan(ctx, posRef.current, y, dotRadius, dpr, dotColor, mouthAngle);
    }
    // Flash dot (centered horizontally) — only during motion for flashDuration
    if (mode === MODE_FLASH_LAG && eventTriggeredRef.current && ts <= flashHideAtRef.current) {
      drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
    }

    rafRef.current = requestAnimationFrame(draw);
  };

  const renderIdleOrResponseFrame = (ctx, dpr) => {
    clear(ctx);
    drawStage(ctx, dpr);

    // During response window (flash-lag mode), show the flash dot persistently at its position
    if (responseWindowRef.current && eventTriggeredRef.current && mode === MODE_FLASH_LAG) {
      const y = Math.floor(stageSize.height / 2);
      const centerX = stageSize.width / 2;
      drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
    }
  };

  const drawDot = (ctx, xCss, yCss, radiusCss, dpr, color) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xCss * dpr, yCss * dpr, radiusCss * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  const getResponsePrompt = () =>
    mode === MODE_DISAPPEARING
      ? "Click where the moving dot disappeared."
      : "Click where the moving dot was when the flash occurred.";

  const getStartPrompt = () =>
    mode === MODE_DISAPPEARING
      ? "Watch the moving dot. Respond after it disappears."
      : "Watch for the flash (center). Respond after the dot disappears.";

  // Start a trial
  const startTrial = () => {
    if (!participant.trim()) {
      setMessage("Please enter the participant name first.");
      return;
    }

    cancelAnimationFrame(rafRef.current);
    const canvas = canvasRef.current;
    if (!canvas) return;

    posRef.current = padding; // reset to left
    lastTsRef.current = 0;
    eventTriggeredRef.current = false;
    eventXRef.current = null;
    flashHideAtRef.current = 0;
    responseWindowRef.current = false;

    // unlock response collection at the start of the trial
    setResponseLocked(false);

    runningRef.current = true;
    setIsRunning(true);
    setAwaitingNext(false);
    setMessage(getStartPrompt());
    rafRef.current = requestAnimationFrame(draw);
  };

  // Start a fresh participant without clearing prior results/summaries
  const startNewParticipant = () => {
    if (!participant.trim()) {
      setMessage("Please enter a new participant name.");
      return;
    }
    setSummary(null);
    setTrialIdx(0);
    setAwaitingNext(false);
    setMessage(`Ready for Trial 1. ${getStartPrompt()}`);
  };

  // Handle response — only after motion finished AND flash happened
  const onCanvasClick = (e) => {
    if (responseLocked) return;
    if (!responseWindowRef.current) return;                 // accept only after dot has disappeared
    if (!eventTriggeredRef.current || eventXRef.current == null) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left; // CSS px

    // close response window
    responseWindowRef.current = false;

    runningRef.current = false;
    setIsRunning(false);
    cancelAnimationFrame(rafRef.current);

    // Ground truth = moving dot x at flash time (constrained)
    const { width } = stageSize;
    const truth = clamp(eventXRef.current, padding, width - padding);
    const signedError = clickX - truth;
    const absError = Math.abs(signedError);

    const trial = {
      participant: participant.trim(),
      trial: trialIdx + 1,
      mode,
      abs_error_px: round2(absError),
      // keep internal bookkeeping (not shown in Results)
      speed_px_s: speed,
      flash_lead_px: flashLead,
      flash_yoffset_px: flashYOffset,
      flash_duration_ms: flashDuration,
      truth_x_px: round2(truth),
      click_x_px: round2(clickX),
      signed_error_px: round2(signedError),
      timestamp: new Date().toISOString(),
    };

    const newResults = [...results, trial];
    setResults(newResults);

    // Visual feedback: flash dot + truth + click marker + error bar
    drawFeedback(truth, clickX);

    // lock further responses for this trial
    setResponseLocked(true);

    // Prepare next step
    const completedTrials = trialIdx + 1;
    setTrialIdx(completedTrials);

    if (completedTrials >= 3) {
      const rowsThisParticipant = newResults.filter((r) => r.participant === participant.trim());
      const avg = rowsThisParticipant.reduce((a, r) => a + r.abs_error_px, 0) / rowsThisParticipant.length;
      const newSummary = { participant: participant.trim(), average_abs_error_px: round2(avg) };
      setSummary(newSummary);
      setSummaries((prev) => {
        const withoutDup = prev.filter((s) => s.participant !== newSummary.participant);
        return [...withoutDup, newSummary];
      });
      setMessage(`All trials done for ${participant.trim()}. Average absolute error = ${round2(avg)} px. Enter another name to continue.`);
      setAwaitingNext(false);
    } else {
      setMessage('Response recorded. Click "Next trial" when ready.');
      setAwaitingNext(true);
    }
  };

  const drawFeedback = (truthX, clickX) => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = devicePixelRatioRef.current;
    clear(ctx);
    drawStage(ctx, dpr);

    const y = Math.floor(stageSize.height / 2);
    const centerX = stageSize.width / 2;

    // Flash position dot (persist) only for flash-lag mode
    if (mode === MODE_FLASH_LAG) {
      drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
    }
    // True moving-dot position at event time (Pac-Man)
    drawPacMan(ctx, truthX, y, dotRadius, dpr, dotColor, PACMAN_IDLE_MOUTH);

    // Click marker
    ctx.save();
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(clickX * dpr, y * dpr, (dotRadius + 6) * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Horizontal error bar
    ctx.save();
    ctx.strokeStyle = "#e5e7eb";
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.beginPath();
    ctx.moveTo(truthX * dpr, (y - 36) * dpr);
    ctx.lineTo(clickX * dpr, (y - 36) * dpr);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(truthX * dpr, (y - 42) * dpr);
    ctx.lineTo(truthX * dpr, (y - 30) * dpr);
    ctx.moveTo(clickX * dpr, (y - 42) * dpr);
    ctx.lineTo(clickX * dpr, (y - 30) * dpr);
    ctx.stroke();

    ctx.fillStyle = "#e5e7eb";
    ctx.font = `${14 * dpr}px ui-sans-serif, system-ui, -apple-system`;
    const err = (clickX - truthX).toFixed(1);
    ctx.fillText(`error: ${err} px`, ((truthX + clickX) / 2) * dpr - 40 * dpr, (y - 50) * dpr);
    ctx.restore();
  };

  const stop = () => {
    runningRef.current = false;
    setIsRunning(false);
    cancelAnimationFrame(rafRef.current);
  };

  const reset = () => {
    stop();
    setResults([]);
    setSummary(null);
    setSummaries([]);
    setTrialIdx(0);
    setAwaitingNext(false);
    setParticipant("");
    responseWindowRef.current = false;
    eventTriggeredRef.current = false;
    eventXRef.current = null;
    setMessage("Enter your name to begin.");
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      clear(ctx);
      drawStage(ctx, devicePixelRatioRef.current);
    }
  };

  // Export CSV (full log + leaderboard)
  const exportCSV = () => {
    if (results.length === 0) return;

    const header = Object.keys(results[0]);
    const rows = results.map((r) => header.map((k) => r[k]));

    const csvParts = [];
    csvParts.push("TRIALS");
    csvParts.push(header.join(","));
    csvParts.push(...rows.map((r) => r.join(",")));

    if (summaries.length) {
      csvParts.push("");
      csvParts.push("LEADERBOARD");
      csvParts.push("participant,average_abs_error_px");
      const sorted = [...summaries].sort((a, b) => a.average_abs_error_px - b.average_abs_error_px);
      sorted.forEach((s) => csvParts.push(`${s.participant},${s.average_abs_error_px}`));
    }

    const csv = csvParts.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashlag_all_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --------------------------
  // Lightweight self-tests (silent)
  // --------------------------
  const runSelfTests = useCallback(() => {
    try {
      console.assert(clamp(5, 0, 10) === 5, "clamp in-range");
      console.assert(round2(1.2345) === 1.23, "round2 works");
      console.assert(computeTargetX(900, 80) === 370, "targetX 900, lead 80 => 450-80");
      console.assert(canStartTrialLogic(0, false, false, "A") === true, "trial0 start enabled");
      console.assert(canvasRef.current instanceof HTMLCanvasElement, "canvas exists");
      return true;
    } catch {
      return false;
    }
  }, [canvasRef]);

  // One-time initial paint + silent self-tests
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    clear(ctx);
    drawStage(ctx, devicePixelRatioRef.current);

    const passed = runSelfTests();
    setSelfTestStatus(passed ? "passed" : "failed"); // not shown in UI

    return () => cancelAnimationFrame(rafRef.current);
  }, [clear, drawStage, runSelfTests]);

  const trialsRemaining = Math.max(0, 3 - trialIdx);
  const canStartTrial = canStartTrialLogic(trialIdx, isRunning, awaitingNext, participant);
  const canStartNewParticipant = !isRunning && trialIdx >= 3;
  const leadLabel = mode === MODE_DISAPPEARING ? `Disappearing offset: ${flashLead} px` : `Flash lead: ${flashLead} px`;
  const introCopy =
    mode === MODE_FLASH_LAG
      ? "Flash-lag mode: A dot moves left to right while a second dot briefly flashes at the center. After it finishes moving, click where you believe the moving dot was at the flash."
      : "Disappearing mode: A single dot moves left to right and vanishes at the chosen offset. Click where you believe the moving dot disappeared.";

  return (
    <div className="min-h-screen w-full bg-slate-900 text-slate-100 flex flex-col items-center py-6">
      <div className="w-full max-w-6xl px-4 md:px-8 mx-auto">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-2">Flash-Lag Illusion</h1>
        <p className="text-slate-300 mb-4">{introCopy}</p>

        <div
  className={`grid gap-4 mb-4 ${showSettings ? "lg:grid-cols-3" : "lg:grid-cols-1"}`}
>
          {/* Stage & primary controls */}
          <div
  className={`${showSettings ? "lg:col-span-2" : ""} bg-slate-800/60 rounded-2xl p-3 shadow min-w-0`}
>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  placeholder="Participant name"
                  value={participant}
                  onChange={(e) => setParticipant(e.target.value)}
                  className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 focus:outline-none"
                />
                <button
                  onClick={startTrial}
                  disabled={!canStartTrial}
                  className={`px-4 py-2 rounded-xl shadow ${canStartTrial ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-700 text-slate-400 cursor-not-allowed"}`}
                >
                  {trialIdx === 0 ? "Start trial" : trialIdx < 3 ? "Next trial" : "Finished"}
                </button>
                <button
                  onClick={startNewParticipant}
                  disabled={!canStartNewParticipant}
                  className={`px-4 py-2 rounded-xl shadow ${canStartNewParticipant ? "bg-sky-500 hover:bg-sky-600" : "bg-slate-700 text-slate-400 cursor-not-allowed"}`}
                >
                  Start new participant
                </button>

                {/* Settings toggle (now also contains Reset) */}
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow"
                >
                  Settings
                </button>
              </div>
              <div className="text-sm text-slate-300 text-right">
                {summary && trialIdx >= 3 ? (
                  <span>Last avg abs error: <span className="font-semibold">{summary.average_abs_error_px} px</span></span>
                ) : (
                  <span>Trials done: <span className="font-semibold">{trialIdx}</span> • Remaining: <span className="font-semibold">{trialsRemaining}</span></span>
                )}
                <div className="text-xs text-slate-400 mt-1 uppercase tracking-wide">Mode: {mode === MODE_FLASH_LAG ? "Flash-lag" : "Disappearing"}</div>
              </div>
            </div>

            {/* Responsive wrapper measured by ResizeObserver */}
            <div ref={stageWrapRef} className="rounded-2xl overflow-hidden border border-slate-700 w-full mx-auto">
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                className={`block select-none ${responseLocked ? "cursor-not-allowed" : "cursor-crosshair"}`}
                aria-label="Flash-lag illusion canvas"
              />
            </div>

            <div className="pt-3 flex items-center gap-3">
              <button
                onClick={exportCSV}
                disabled={results.length === 0}
                className={`px-3 py-2 rounded-lg text-sm shadow ${results.length ? "bg-indigo-500 hover:bg-indigo-600" : "bg-slate-700 text-slate-400 cursor-not-allowed"}`}
              >
                Export CSV (all)
              </button>
              {/* self-test status intentionally hidden */}
              <div className="text-xs text-slate-400">{message}</div>
            </div>
          </div>

          {/* Controls (wrapped in Settings toggle) */}
          {showSettings && (
            <div className="bg-slate-800/60 rounded-2xl p-4 shadow">
              <h2 className="text-lg font-semibold mb-3">Controls</h2>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-slate-300 mb-2 select-none">Mode</div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setMode(MODE_FLASH_LAG)}
                      className={`px-3 py-2 rounded-lg border ${mode === MODE_FLASH_LAG ? "bg-emerald-500/20 border-emerald-400" : "bg-slate-900/40 border-slate-700 hover:border-slate-500"}`}
                    >
                      Flash-lag (flash)
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode(MODE_DISAPPEARING)}
                      className={`px-3 py-2 rounded-lg border ${mode === MODE_DISAPPEARING ? "bg-emerald-500/20 border-emerald-400" : "bg-slate-900/40 border-slate-700 hover:border-slate-500"}`}
                    >
                      Disappearing
                    </button>
                  </div>
                </div>
                <LabeledRange label={`Speed: ${speed} px/s`} min={80} max={600} step={10} value={speed} onChange={setSpeed} />
                <LabeledRange label={leadLabel} min={-60} max={200} step={5} value={flashLead} onChange={setFlashLead} />
                {mode === MODE_DISAPPEARING && (
                  <div className="text-xs text-slate-400">
                    Offset is measured from the screen center (positive = dot disappears before center).
                  </div>
                )}
                {mode === MODE_FLASH_LAG && (
                  <LabeledRange label={`Flash vertical offset: ${flashYOffset} px`} min={-100} max={100} step={5} value={flashYOffset} onChange={setFlashYOffset} />
                )}
                {mode === MODE_FLASH_LAG && (
                  <LabeledRange label={`Flash duration: ${flashDuration} ms`} min={20} max={200} step={5} value={flashDuration} onChange={setFlashDuration} />
                )}
                <LabeledRange label={`Dot radius: ${dotRadius} px`} min={4} max={16} step={1} value={dotRadius} onChange={setDotRadius} />
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <ColorSwatch label="Dot" value={dotColor} onChange={setDotColor} />
                  {mode === MODE_FLASH_LAG && (
                    <ColorSwatch label="Flash" value={flashColor} onChange={setFlashColor} />
                  )}
                </div>

                {/* Moved here: Reset all */}
                <div className="pt-4 border-t border-slate-700 mt-4">
                  <button onClick={reset} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow w-full">
                    Reset all
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Results + Leaderboard */}
        <ResultsTable results={results} currentParticipant={participant.trim()} />
        <Leaderboard summaries={summaries} />
      </div>
    </div>
  );
}

// --------------------------
// UI helper components
// --------------------------
function LabeledRange({ label, min, max, step, value, onChange }) {
  return (
    <label className="block">
      <div className="text-slate-300 mb-1 select-none">{label}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  );
}

function ColorSwatch({ label, value, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-12 text-slate-300 select-none">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 rounded cursor-pointer bg-slate-900/60 border border-slate-700"
      />
    </label>
  );
}

// (3) Results: only current participant + two columns (Participant, Abs error (px))
function ResultsTable({ results, currentParticipant }) {
  const rows = results.filter((r) => r.participant === currentParticipant);
  if (!currentParticipant) {
    return <div className="mt-2 text-sm text-slate-400">No participant selected.</div>;
  }
  if (!rows.length) {
    return <div className="mt-2 text-sm text-slate-400">No trials yet for this Participant.</div>;
  }
  return (
    <div className="mt-4">
      <h3 className="text-lg font-semibold mb-2">Results</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Participant</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Abs error (px)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-slate-900/40" : "bg-slate-900/20"}>
                <td className="px-3 py-2 text-slate-300">{r.participant}</td>
                <td className="px-3 py-2 text-slate-300">{r.abs_error_px}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// (4) Leaderboard title simplified
function Leaderboard({ summaries }) {
  if (!summaries.length) return null;
  const sorted = [...summaries].sort((a, b) => a.average_abs_error_px - b.average_abs_error_px);
  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold mb-2">Leaderboard</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Rank</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Participant</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Average abs error (px)</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => (
              <tr key={s.participant + i} className={i % 2 ? "bg-slate-900/40" : "bg-slate-900/20"}>
                <td className="px-3 py-2">{i + 1}</td>
                <td className="px-3 py-2">{s.participant}</td>
                <td className="px-3 py-2">{s.average_abs_error_px}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

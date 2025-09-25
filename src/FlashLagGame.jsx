import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MODE_FLASH_LAG = "flash-lag";
const MODE_DISAPPEARING = "disappearing";
const ASPECT_RATIO = 280 / 900;
const PACMAN_IDLE_MOUTH = 0.28; // radians, per-side opening when static
const PACMAN_MIN_MOUTH = 0.12;
const PACMAN_MAX_MOUTH = 0.5;
const TARGET_PACMAN = "pacman";
const TARGET_DOT = "dot";

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

function pickRandomOffset(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (hi === lo) return lo;
  const raw = Math.random() * (hi - lo) + lo;
  const stepped = Math.round(raw / 5) * 5;
  return clamp(stepped, lo, hi);
}

function pseudoRandomAngle(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // keep 32-bit int
  }
  const normalized = (Math.abs(hash) % 360) * (Math.PI / 180);
  return normalized;
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
  const currentLeadRef = useRef(0);
  const disappearRangeRef = useRef({ min: -80, max: 80 });

  // NEW: gate for the post-motion response window
  const responseWindowRef = useRef(false);

  // UI state
  const [participant, setParticipant] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [trialIdx, setTrialIdx] = useState(0); // 0..2 (3 trials)
  const [awaitingNext, setAwaitingNext] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [responseLocked, setResponseLocked] = useState(false);
  const [mode, setMode] = useState(MODE_DISAPPEARING);
  const [targetShape, setTargetShape] = useState(TARGET_PACMAN);
  const [showErrorCloud, setShowErrorCloud] = useState(true);

  // Parameters
  const [speed, setSpeed] = useState(280); // px/s
  const [flashLead, setFlashLead] = useState(80); // px ahead of moving dot AT FLASH MOMENT (centerX − lead is trigger X)
  const [disappearRange, setDisappearRange] = useState({ min: -80, max: 80 });
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

  const [message, setMessage] = useState("Inserisci il tuo nome per iniziare.");
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
    const targetX = computeTargetX(width, currentLeadRef.current); // centerX - lead

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
      if (targetShape === TARGET_PACMAN) {
        const mouthAngle = getPacManMouth(ts);
        drawPacMan(ctx, posRef.current, y, dotRadius, dpr, dotColor, mouthAngle);
      } else {
        drawDot(ctx, posRef.current, y, dotRadius, dpr, dotColor);
      }
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
      ? "Fai clic dove il bersaglio è scomparso."
      : "Fai clic dove si trovava il bersaglio in movimento quando è apparso il flash.";

  const getStartPrompt = () =>
    mode === MODE_DISAPPEARING
      ? "Osserva il bersaglio in movimento. Rispondi dopo che è scomparso."
      : "Osserva il bersaglio in movimento. Rispondi dopo che il bersaglio è scomparso.";

  // Start a trial
  const startTrial = () => {
    if (!participant.trim()) {
      setMessage("Inserisci prima il nome del partecipante.");
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

    const leadForTrial =
      mode === MODE_DISAPPEARING
        ? pickRandomOffset(disappearRange.min, disappearRange.max)
        : flashLead;
    disappearRangeRef.current = { ...disappearRange };
    currentLeadRef.current = leadForTrial;

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
      setMessage("Inserisci un nuovo nome partecipante.");
      return;
    }
    setSummary(null);
    setTrialIdx(0);
    setAwaitingNext(false);
    setMessage(`Pronto per la prova 1. ${getStartPrompt()}`);
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
      target_shape: targetShape,
      abs_error_px: round2(absError),
      // keep internal bookkeeping (not shown in Results)
      speed_px_s: speed,
      lead_px: round2(currentLeadRef.current),
      disappear_range_min_px:
        mode === MODE_DISAPPEARING ? disappearRangeRef.current.min : null,
      disappear_range_max_px:
        mode === MODE_DISAPPEARING ? disappearRangeRef.current.max : null,
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
      setMessage(`Tutte le prove completate per ${participant.trim()}. Errore medio = ${round2(avg)} px. Inserisci un altro nome per continuare.`);
      setAwaitingNext(false);
    } else {
      setMessage('Risposta registrata. Clicca su "Prossima prova" quando sei pronto.');
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
    // True moving-dot position at event time
    if (targetShape === TARGET_PACMAN) {
      drawPacMan(ctx, truthX, y, dotRadius, dpr, dotColor, PACMAN_IDLE_MOUTH);
    } else {
      drawDot(ctx, truthX, y, dotRadius, dpr, dotColor);
    }

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
    setMessage("Inserisci il tuo nome per iniziare.");
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      clear(ctx);
      drawStage(ctx, devicePixelRatioRef.current);
    }
  };

  // Export CSV (full log + leaderboard)
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
      console.assert(pickRandomOffset(10, 10) === 10, "constant offset range");
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

  useEffect(() => {
    if (isRunning) return;
    currentLeadRef.current =
      mode === MODE_DISAPPEARING
        ? (disappearRange.min + disappearRange.max) / 2
        : flashLead;
    if (mode === MODE_DISAPPEARING) {
      disappearRangeRef.current = {
        min: disappearRange.min,
        max: disappearRange.max,
      };
    }
  }, [mode, disappearRange.min, disappearRange.max, flashLead, isRunning]);

  const trialsRemaining = Math.max(0, 3 - trialIdx);
  const canStartTrial = canStartTrialLogic(trialIdx, isRunning, awaitingNext, participant);
  const canStartNewParticipant = !isRunning && trialIdx >= 3;
  const leadLabel =
    mode === MODE_DISAPPEARING
      ? `Intervallo di scomparsa: ${disappearRange.min} – ${disappearRange.max} px`
      : `Lead del flash: ${flashLead} px`;
  const targetLabel = targetShape === TARGET_PACMAN ? "Pac-Man" : "punto";
  const targetSubject = targetShape === TARGET_PACMAN ? "Pac-Man" : "il punto";
  const introCopy =
    mode === MODE_FLASH_LAG
      ? `Modalità flash-lag: ${targetLabel} si muove da sinistra a destra mentre un secondo punto lampeggia brevemente al centro. Quando termina il movimento, fai clic dove pensi che ${targetSubject} fosse al momento del flash.`
      : `Modalità scomparsa: ${targetLabel} si muove da sinistra a destra e ad un certo punto scompare. Fai clic sul punto dove pensi che ${targetSubject} sia scomparso.`;
  const trimmedParticipant = participant.trim();

  const errorPoints = useMemo(() => {
    if (!results.length) return [];
    return results
      .map((trial, index) => {
        const signedError =
          typeof trial.signed_error_px === "number"
            ? trial.signed_error_px
            : typeof trial.abs_error_px === "number"
            ? trial.abs_error_px
            : null;
        if (signedError == null || !Number.isFinite(signedError)) return null;
        const magnitude = Math.abs(signedError);
        const seed = `${trial.participant}-${trial.trial}-${trial.timestamp ?? ""}-${index}`;
        const angle = pseudoRandomAngle(seed);
        const isCurrent = trimmedParticipant && trial.participant === trimmedParticipant;
        return {
          signedError,
          magnitude,
          angle,
          participant: trial.participant,
          trialNumber: trial.trial,
          mode: trial.mode,
          isCurrent,
        };
      })
      .filter(Boolean);
  }, [results, trimmedParticipant]);

  const maxErrorMagnitude = useMemo(() => {
    if (!errorPoints.length) return 1;
    return errorPoints.reduce((m, p) => Math.max(m, p.magnitude), 1);
  }, [errorPoints]);

  return (
    <div className="min-h-screen w-full bg-slate-900 text-slate-100 flex flex-col items-center py-6">
      <div className="w-full max-w-screen-2xl px-4 md:px-8 xl:px-16 mx-auto">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-2">Il tuo cervello ti inganna?</h1>
        <p className="text-slate-300 mb-4">{introCopy}</p>

        <div
  className={`grid gap-4 mb-4 ${showSettings || showErrorCloud ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "lg:grid-cols-1"}`}
>
          {/* Stage & primary controls */}
          <div
  className={`${showSettings || showErrorCloud ? "lg:col-span-2" : ""} bg-slate-800/60 rounded-2xl p-3 shadow min-w-0`}
>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  placeholder="Nome partecipante"
                  value={participant}
                  onChange={(e) => setParticipant(e.target.value)}
                  className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 focus:outline-none"
                />
                <button
                  onClick={startTrial}
                  disabled={!canStartTrial}
                  className={`px-4 py-2 rounded-xl shadow ${canStartTrial ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-700 text-slate-400 cursor-not-allowed"}`}
                >
                  {trialIdx === 0 ? "Avvia prova" : trialIdx < 3 ? "Prossima prova" : "Concluso"}
                </button>
                <button
                  onClick={startNewParticipant}
                  disabled={!canStartNewParticipant}
                  className={`px-4 py-2 rounded-xl shadow ${canStartNewParticipant ? "bg-sky-500 hover:bg-sky-600" : "bg-slate-700 text-slate-400 cursor-not-allowed"}`}
                >
                  Nuovo partecipante
                </button>

                {/* Settings toggle (now also contains Reset) */}
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow"
                >
                  Impostazioni
                </button>
              </div>
              <div className="text-sm text-slate-300 text-right">
                {summary && trialIdx >= 3 ? (
                  <span>Ultimo errore: <span className="font-semibold">{summary.average_abs_error_px} px</span></span>
                ) : (
                  <span>Prove svolte: <span className="font-semibold">{trialIdx}</span> • Restanti: <span className="font-semibold">{trialsRemaining}</span></span>
                )}
                <div className="text-xs text-slate-400 mt-1 uppercase tracking-wide">Modalità: {mode === MODE_FLASH_LAG ? "Flash-lag" : "Scomparsa"}</div>
              </div>
            </div>

            {/* Responsive wrapper measured by ResizeObserver */}
            <div ref={stageWrapRef} className="rounded-2xl overflow-hidden border border-slate-700 w-full mx-auto">
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                className={`block select-none ${responseLocked ? "cursor-not-allowed" : "cursor-crosshair"}`}
                aria-label="Canvas dell'illusione flash-lag"
              />
            </div>

            <div className="pt-3 flex items-center justify-between gap-3">
              <div className="text-xs text-slate-400">{message}</div>
              <button
                type="button"
                onClick={() => setShowErrorCloud((v) => !v)}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200"
              >
                {showErrorCloud ? "Nascondi" : "Mostra"} nuvola errori
              </button>
            </div>
          </div>

          {/* Controls (wrapped in Settings toggle) */}
          {showSettings && (
            <div className="bg-slate-800/60 rounded-2xl p-4 shadow">
              <h2 className="text-lg font-semibold mb-3">Controlli</h2>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-slate-300 mb-2 select-none">Modalità</div>
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
                      Scomparsa
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-slate-300 mb-2 select-none">Bersaglio</div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setTargetShape(TARGET_PACMAN)}
                      className={`px-3 py-2 rounded-lg border ${targetShape === TARGET_PACMAN ? "bg-yellow-300/20 border-yellow-300 text-yellow-200" : "bg-slate-900/40 border-slate-700 hover:border-slate-500"}`}
                    >
                      Pac-Man
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetShape(TARGET_DOT)}
                      className={`px-3 py-2 rounded-lg border ${targetShape === TARGET_DOT ? "bg-emerald-500/20 border-emerald-400" : "bg-slate-900/40 border-slate-700 hover:border-slate-500"}`}
                    >
                      Punto
                    </button>
                  </div>
                </div>
                <LabeledRange label={`Velocità: ${speed} px/s`} min={80} max={600} step={10} value={speed} onChange={setSpeed} />
                {mode === MODE_DISAPPEARING ? (
                  <div className="space-y-2">
                    <RangeField
                      label="Offset minimo di scomparsa"
                      value={disappearRange.min}
                      min={-200}
                      max={200}
                      step={5}
                      onChange={(val) =>
                        setDisappearRange((prev) => {
                          const clamped = Math.min(val, 200);
                          if (clamped > prev.max) {
                            return { min: prev.max, max: clamped };
                          }
                          return { min: clamped, max: prev.max };
                        })
                      }
                    />
                    <RangeField
                      label="Offset massimo di scomparsa"
                      value={disappearRange.max}
                      min={-200}
                      max={200}
                      step={5}
                      onChange={(val) =>
                        setDisappearRange((prev) => {
                          const clamped = Math.max(val, -200);
                          if (clamped < prev.min) {
                            return { min: clamped, max: prev.min };
                          }
                          return { min: prev.min, max: clamped };
                        })
                      }
                    />
                    <div className="text-xs text-slate-400">
                      L'offset è misurato dal centro dello schermo (positivo = il bersaglio scompare prima del centro). A ogni prova viene estratto un valore casuale da questo intervallo.
                    </div>
                  </div>
                ) : (
                  <LabeledRange label={leadLabel} min={-60} max={200} step={5} value={flashLead} onChange={setFlashLead} />
                )}
                {mode === MODE_FLASH_LAG && (
                  <LabeledRange label={`Offset verticale del flash: ${flashYOffset} px`} min={-100} max={100} step={5} value={flashYOffset} onChange={setFlashYOffset} />
                )}
                {mode === MODE_FLASH_LAG && (
                  <LabeledRange label={`Durata del flash: ${flashDuration} ms`} min={20} max={200} step={5} value={flashDuration} onChange={setFlashDuration} />
                )}
                <LabeledRange label={`Raggio del bersaglio: ${dotRadius} px`} min={4} max={16} step={1} value={dotRadius} onChange={setDotRadius} />
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <ColorSwatch label="Bersaglio" value={dotColor} onChange={setDotColor} />
                  {mode === MODE_FLASH_LAG && (
                    <ColorSwatch label="Flash" value={flashColor} onChange={setFlashColor} />
                  )}
                </div>

                {/* Moved here: Reset all */}
                <div className="pt-4 border-t border-slate-700 mt-4">
                  <button onClick={reset} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow w-full">
                    Reimposta tutto
                  </button>
                </div>
              </div>
            </div>
          )}

          {showErrorCloud && (
            <div className="bg-slate-800/60 rounded-2xl p-4 shadow flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Nuvola degli errori</h2>
                <span className="text-xs text-slate-400">{errorPoints.length} campioni</span>
              </div>
              {errorPoints.length ? (
                <ErrorCloud points={errorPoints} maxError={maxErrorMagnitude} targetLabel={targetLabel} />
              ) : (
                <div className="text-sm text-slate-400">Nessun dato disponibile. Esegui alcune prove per popolare la nuvola.</div>
              )}
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

function RangeField({ label, min, max, step, value, onChange }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1 text-slate-300 select-none">
        <span>{label}</span>
        <span className="text-slate-200 font-medium">{value} px</span>
      </div>
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

const POSITIVE_COLOR = "rgba(96, 165, 250, 0.85)";
const NEGATIVE_COLOR = "rgba(74, 222, 128, 0.85)";
const REFERENCE_COLOR = "rgba(248, 113, 113, 0.6)";
const HIGHLIGHT_COLOR = "#fffb00ff";

function ErrorCloud({ points, maxError, targetLabel }) {
  const size = 260;
  const center = size / 2;
  const padding = 16;
  const plotRadius = center - padding;
  const referenceRadius = 6;
  const logDenominator = Math.log10((maxError || 1) + 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <svg
          width={size}
          height={size}
          className="w-full max-w-xs"
          viewBox={`0 0 ${size} ${size}`}
        >
          <circle
            cx={center}
            cy={center}
            r={plotRadius}
            fill="#0f172a"
            stroke="#334155"
            strokeWidth={1.5}
          />
          {points.map((point, idx) => {
            const logScaled = logDenominator > 0 ? Math.log10(point.magnitude + 1) / logDenominator : 0;
            const dist = Math.min(logScaled * plotRadius, plotRadius - 4);

            const collapsed = ((point.angle % Math.PI) + Math.PI) % Math.PI - Math.PI / 2; // [-π/2, π/2]
            const horizontal = Math.cos(collapsed) * dist * (point.signedError >= 0 ? 1 : -1);
            const vertical = Math.sin(collapsed) * dist;

            const x = center + horizontal;
            const y = center + vertical;
            const isPositive = point.signedError >= 0;
            const fillColor = point.isCurrent ? HIGHLIGHT_COLOR : isPositive ? POSITIVE_COLOR : NEGATIVE_COLOR;
            const radius = point.isCurrent ? 5.5 : 4;

            return (
              <circle
                key={`${point.participant}-${point.trialNumber}-${idx}`}
                cx={x}
                cy={y}
                r={radius}
                fill={fillColor}
              >
                <title>
                  {`${point.participant} • Prova ${point.trialNumber}\nErrore: ${point.signedError.toFixed(1)} px`}
                </title>
              </circle>
            );
          })}
          <circle cx={center} cy={center} r={referenceRadius} fill={REFERENCE_COLOR} />
        </svg>
      </div>
      <div className="text-xs text-slate-300 space-y-1">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: REFERENCE_COLOR }}
            aria-hidden="true"
          />
          <span className="text-slate-100">Posizione di scomparsa del {targetLabel} (centro)</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: POSITIVE_COLOR }}
            aria-hidden="true"
          />
          <span>Davanti</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NEGATIVE_COLOR }}
            aria-hidden="true"
          />
          <span>Dietro</span>
        </div>
      </div>
    </div>
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
    return <div className="mt-2 text-sm text-slate-400">Nessun partecipante selezionato.</div>;
  }
  if (!rows.length) {
    return <div className="mt-2 text-sm text-slate-400">Ancora nessuna prova per questo partecipante.</div>;
  }
  return (
    <div className="mt-4">
      <h3 className="text-lg font-semibold mb-2">Risultati</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Partecipante</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Errore (px)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-slate-900/40" : "bg-slate-900/20"}>
                <td className="px-3 py-2 text-slate-300">{r.participant}</td>
                <td className="px-3 py-2 text-slate-300">{r.signed_error_px ?? r.abs_error_px}</td>
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
      <h3 className="text-lg font-semibold mb-2">Classifica</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Posizione</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Partecipante</th>
              <th className="px-3 py-2 text-left font-medium text-slate-200">Errore medio (px)</th>
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

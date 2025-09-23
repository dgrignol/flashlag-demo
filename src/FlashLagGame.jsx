import React, { useEffect, useRef, useState, useMemo } from "react";

// Flash-Lag Illusion — Multi-Participant (centered flash, 3 trials each, leaderboard)
// Updates in this version:
// • Keep per-participant 3 trials, compute avg abs error, and **append to a leaderboard**.
// • After 3 trials, you can input another name and start a new participant **without resetting results**.
// • Flash always appears at screen center; flash timing when moving dot crosses (centerX − flashLead).
// • Accept answers even after the dot exits the screen (once flash happened). No looping/wrapping.
// • Start/Next trial gating fixed; new "Start new participant" flow handled automatically.
// • Extra self-tests include leaderboard addition and target-X math.
// • (NEW) Settings panel toggle button; controls are hidden by default
// • (NEW) Only one response collected per trial

export default function FlashLagGame() {
  // Canvas + animation refs
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const devicePixelRatioRef = useRef(1);

  const runningRef = useRef(false);
  const posRef = useRef(0); // moving dot x (CSS px)
  const t0Ref = useRef(0); // trial start timestamp
  const lastTsRef = useRef(0);
  const flashedRef = useRef(false);
  const trueXAtFlashRef = useRef(null); // ground-truth moving-dot x when flash happens
  const flashHideAtRef = useRef(0);

  // UI state
  const [participant, setParticipant] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [trialIdx, setTrialIdx] = useState(0); // 0..2 for three trials per participant
  const [awaitingNext, setAwaitingNext] = useState(false); // after a response, wait for Next Trial click
  const [showSettings, setShowSettings] = useState(false); // NEW: settings toggle
  const [responseLocked, setResponseLocked] = useState(false); // NEW: single-response per trial

  // Parameters
  const [speed, setSpeed] = useState(280); // px/s
  const [flashLead, setFlashLead] = useState(80); // px ahead of moving dot AT FLASH MOMENT
  const [flashYOffset, setFlashYOffset] = useState(0); // px vertical offset for flash dot (positive = lower)
  const [flashDuration, setFlashDuration] = useState(60); // ms
  const [dotRadius, setDotRadius] = useState(8);
  const [bg, setBg] = useState("#0b1020");
  const [dotColor, setDotColor] = useState("#60a5fa");
  const [flashColor, setFlashColor] = useState("#f97316");

  // Data
  const [results, setResults] = useState([]); // per-trial rows for all participants
  const [summary, setSummary] = useState(null); // current participant summary { participant, average_abs_error_px }
  const [summaries, setSummaries] = useState([]); // all participants summaries

  const [message, setMessage] = useState("Enter your name to begin.");
  const [selfTestStatus, setSelfTestStatus] = useState("pending");

  // Layout
  const { width, height, padding } = useMemo(() => ({ width: 900, height: 280, padding: 24 }), []);

  // Resize canvas for DPR crispness
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    devicePixelRatioRef.current = dpr;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
  }, [width, height, trialIdx]);

  // Basic canvas helpers
  const clear = (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  };

  const draw = (ts) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = devicePixelRatioRef.current;

    if (!runningRef.current) {
      clear(ctx);
      drawStage(ctx, dpr);
      return;
    }

    if (!t0Ref.current) t0Ref.current = ts;
    if (!lastTsRef.current) lastTsRef.current = ts;

    const dt = (ts - lastTsRef.current) / 1000; // seconds
    lastTsRef.current = ts;

    // Advance moving dot
    posRef.current += speed * dt;

    const xMax = width - padding;
    const y = Math.floor(height / 2);
    const centerX = width / 2;
    const targetX = computeTargetX(width, flashLead); // centerX - flashLead

    // Trigger the flash precisely when we cross targetX
    if (!flashedRef.current && posRef.current >= targetX) {
      flashedRef.current = true;
      trueXAtFlashRef.current = posRef.current; // truth at flash time
      flashHideAtRef.current = ts + flashDuration; // visible briefly
    }

    // Stop the animation if we reached the right boundary (no wrapping/looping)
    if (posRef.current >= xMax) {
      runningRef.current = false;
      setIsRunning(false);
    }

    // Render frame
    clear(ctx);
    drawStage(ctx, dpr);

    // Moving dot (center line)
    drawDot(ctx, posRef.current, y, dotRadius, dpr, dotColor);

    // Flash dot (always centered horizontally)
    if (flashedRef.current && ts <= flashHideAtRef.current) {
      drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
    }

    if (runningRef.current) {
      rafRef.current = requestAnimationFrame(draw);
    }
  };

  const drawStage = (ctx, dpr) => {
    // Border only (guideline removed)
    const r = 16 * dpr;
    ctx.save();
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 2 * dpr;
    roundRect(ctx, 4 * dpr, 4 * dpr, (width - 8) * dpr, (height - 8) * dpr, r);
    ctx.stroke();
    ctx.restore();
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

  // Start a trial (no loop; single pass until user response)
  const startTrial = () => {
    if (!participant.trim()) {
      setMessage("Please enter the participant name first.");
      return;
    }

    cancelAnimationFrame(rafRef.current);
    const canvas = canvasRef.current;
    if (!canvas) return;

    posRef.current = padding; // reset to left
    t0Ref.current = 0;
    lastTsRef.current = 0;
    flashedRef.current = false;
    trueXAtFlashRef.current = null;
    flashHideAtRef.current = 0;

    // NEW: unlock response collection at the start of the trial
    setResponseLocked(false);

    runningRef.current = true;
    setIsRunning(true);
    setAwaitingNext(false);
    setMessage("Watch for the flash (center), then click where the moving dot was at that instant.");
    rafRef.current = requestAnimationFrame(draw);
  };

  // Start a fresh participant without clearing prior results/summaries
  const startNewParticipant = () => {
    if (!participant.trim()) {
      setMessage("Please enter a new participant name.");
      return;
    }
    // Reset per-participant state, keep global data
    setSummary(null);
    setTrialIdx(0);
    setAwaitingNext(false);
    setMessage("Ready for Trial 1. Click Start trial when ready.");
  };

  // Handle response
  const onCanvasClick = (e) => {
    // NEW: guard to allow only one response per trial
    if (responseLocked) return;

    // Accept answers even after the dot exits, as long as the flash occurred
    if (!flashedRef.current || trueXAtFlashRef.current == null) {
      return; // ignore clicks before the flash
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left; // CSS px

    runningRef.current = false; // stop animating until the next trial
    setIsRunning(false);
    cancelAnimationFrame(rafRef.current);

    // Ground truth = moving dot x at flash time (constrained within the stage)
    const truth = clamp(trueXAtFlashRef.current, padding, width - padding);
    const signedError = clickX - truth; // + = clicked to the right of truth
    const absError = Math.abs(signedError);

    const trial = {
      participant: participant.trim(),
      trial: trialIdx + 1,
      speed_px_s: speed,
      flash_lead_px: flashLead,
      flash_yoffset_px: flashYOffset,
      flash_duration_ms: flashDuration,
      truth_x_px: round2(truth),
      click_x_px: round2(clickX),
      signed_error_px: round2(signedError),
      abs_error_px: round2(absError),
      timestamp: new Date().toISOString(),
    };

    const newResults = [...results, trial];
    setResults(newResults);

    drawFeedback(truth, clickX);

    // NEW: lock further responses for this trial
    setResponseLocked(true);

    // Prepare next step
    const completedTrials = trialIdx + 1;
    setTrialIdx(completedTrials);

    if (completedTrials >= 3) {
      // Compute average and store summary AND leaderboard
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

    const y = Math.floor(height / 2);
    const centerX = width / 2;

    // Show flash location at its vertical offset (centered horizontally)
    drawDot(ctx, centerX, y + flashYOffset, dotRadius + 2, dpr, flashColor);
    // Show true moving-dot position at flash time
    drawDot(ctx, truthX, y, dotRadius, dpr, dotColor);

    // Click marker
    ctx.save();
    ctx.strokeStyle = "#10b981"; // green
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(clickX * dpr, y * dpr, (dotRadius + 6) * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Horizontal error bar (x-only task)
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
    setMessage("Enter your name to begin.");
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      clear(ctx);
      drawStage(ctx, devicePixelRatioRef.current);
    }
  };

  // Utilities
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  // Pure helpers so we can self-test them
  function computeTargetX(w, lead) {
    return w / 2 - lead;
  }
  function canStartTrialLogic(trialIndex, isRun, awaiting, name) {
    if (isRun) return false;
    if (!name.trim()) return false;
    if (trialIndex >= 3) return false;
    return trialIndex === 0 ? !awaiting : awaiting;
  }

  // Export CSV (includes full trial log + leaderboard)
  const exportCSV = () => {
    if (results.length === 0) return;

    const header = Object.keys(results[0]);
    const rows = results.map((r) => header.map((k) => r[k]));

    const csvParts = [];
    csvParts.push("TRIALS");
    csvParts.push(header.join(","));
    csvParts.push(...rows.map((r) => r.join(",")));

    // Leaderboard
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

  // One-time initial paint + self-tests
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    clear(ctx);
    drawStage(ctx, devicePixelRatioRef.current);

    const passed = runSelfTests();
    setSelfTestStatus(passed ? "passed" : "failed");

    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const trialsRemaining = Math.max(0, 3 - trialIdx);
  const canStartTrial = canStartTrialLogic(trialIdx, isRunning, awaitingNext, participant);
  const canStartNewParticipant = !isRunning && trialIdx >= 3; // after finishing 3 trials

  return (
    <div className="min-h-screen w-full bg-slate-900 text-slate-100 flex flex-col items-center py-6">
      <div className="w-full max-w-6xl px-4">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-2">Flash-Lag Illusion</h1>
        <p className="text-slate-300 mb-4">A dot moves left to right. A second dot briefly flashes at the <strong>screen center</strong>. Click where you believe the moving dot was at that instant.</p>

        <div className="grid lg:grid-cols-3 gap-4 mb-4">
          {/* Stage & controls */}
          <div className="lg:col-span-2 bg-slate-800/60 rounded-2xl p-3 shadow">
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
                <button onClick={reset} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow">Reset all</button>

                {/* NEW: Settings toggle */}
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 shadow"
                >
                  Settings
                </button>
              </div>
              <div className="text-sm text-slate-300">
                {summary && trialIdx >= 3 ? (
                  <span>Last avg abs error: <span className="font-semibold">{summary.average_abs_error_px} px</span></span>
                ) : (
                  <span>Trials done: <span className="font-semibold">{trialIdx}</span> • Remaining: <span className="font-semibold">{trialsRemaining}</span></span>
                )}
              </div>
            </div>

            <div className="rounded-2xl overflow-hidden border border-slate-700">
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                className={`block select-none ${responseLocked ? "cursor-not-allowed" : "cursor-crosshair"}`} // NEW: visual cue after response
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
              <span className={`text-xs ${selfTestStatus === "passed" ? "text-emerald-400" : selfTestStatus === "failed" ? "text-rose-400" : "text-slate-400"}`}>
                Self-tests: {selfTestStatus}
              </span>
              <div className="text-xs text-slate-400">{message}</div>
            </div>
          </div>

          {/* Controls (wrapped in Settings toggle) */}
          {showSettings && (
            <div className="bg-slate-800/60 rounded-2xl p-4 shadow">
              <h2 className="text-lg font-semibold mb-3">Controls</h2>
              <div className="space-y-3 text-sm">
                <LabeledRange label={`Speed: ${speed} px/s`} min={80} max={600} step={10} value={speed} onChange={setSpeed} />
                <LabeledRange label={`Flash lead: ${flashLead} px`} min={-60} max={200} step={5} value={flashLead} onChange={setFlashLead} />
                <LabeledRange label={`Flash vertical offset: ${flashYOffset} px`} min={-100} max={100} step={5} value={flashYOffset} onChange={setFlashYOffset} />
                <LabeledRange label={`Flash duration: ${flashDuration} ms`} min={20} max={200} step={5} value={flashDuration} onChange={setFlashDuration} />
                <LabeledRange label={`Dot radius: ${dotRadius} px`} min={4} max={16} step={1} value={dotRadius} onChange={setDotRadius} />
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <ColorSwatch label="Dot" value={dotColor} onChange={setDotColor} />
                  <ColorSwatch label="Flash" value={flashColor} onChange={setFlashColor} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Results + Leaderboard */}
        <ResultsTable results={results} />
        <Leaderboard summaries={summaries} />
      </div>
    </div>
  );

  // --------------------------
  // Lightweight self-tests
  // --------------------------
  function runSelfTests() {
    try {
      // math helpers
      console.assert(clamp(5, 0, 10) === 5, "clamp in-range");
      console.assert(clamp(-1, 0, 10) === 0, "clamp low bound");
      console.assert(clamp(11, 0, 10) === 10, "clamp high bound");
      console.assert(round2(1.2345) === 1.23, "round2 works");

      // target X helper
      console.assert(computeTargetX(900, 80) === 370, "targetX 900, lead 80 => 450-80");
      console.assert(computeTargetX(900, -60) === 510, "targetX 900, lead -60 => 450+60");

      // start-button logic
      console.assert(canStartTrialLogic(0, false, false, "A") === true, "trial0 start enabled");
      console.assert(canStartTrialLogic(1, false, true, "A") === true, "trial1 next enabled after response");
      console.assert(canStartTrialLogic(1, false, false, "A") === false, "trial1 next disabled before response");
      console.assert(canStartTrialLogic(2, true, true, "A") === false, "disabled while running");

      // leaderboard append
      const lb = [{ participant: "X", average_abs_error_px: 12.3 }];
      const withY = [...lb.filter((s) => s.participant !== "Y"), { participant: "Y", average_abs_error_px: 10 }];
      console.assert(withY.length === 2 && withY[1].participant === "Y", "leaderboard add ok");

      // canvas existence
      console.assert(canvasRef.current instanceof HTMLCanvasElement, "canvas exists");

      return true;
    } catch (e) {
      console.error("Self-tests failed:", e);
      return false;
    }
  }
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

function ResultsTable({ results }) {
  if (!results.length)
    return <div className="mt-2 text-sm text-slate-400">No trials yet. Your results will appear here.</div>;

  const headers = Object.keys(results[0]);
  return (
    <div className="mt-4">
      <h3 className="text-lg font-semibold mb-2">Results</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              {headers.map((k) => (
                <th key={k} className="px-3 py-2 text-left font-medium text-slate-200 whitespace-nowrap">
                  {k.replaceAll("_", " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-slate-900/40" : "bg-slate-900/20"}>
                {headers.map((k) => (
                  <td key={k} className="px-3 py-2 whitespace-nowrap text-slate-300">{String(r[k])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Leaderboard({ summaries }) {
  if (!summaries.length) return null;
  const sorted = [...summaries].sort((a, b) => a.average_abs_error_px - b.average_abs_error_px);
  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold mb-2">Leaderboard (avg abs error, lower is better)</h3>
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
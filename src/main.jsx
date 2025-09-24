import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { BrowserRouter, Routes, Route, Link, Navigate } from "react-router-dom";
import FlashLagGame from "./modes/FlashLagGame.jsx";
import VanishDotGame from "./modes/VanishDotGame.jsx";

function Home() {
  return (
    <div style={{maxWidth:900, margin:"0 auto", padding:16}}>
      <h1>Predictive Brain Demos</h1>
      <p>Choose a mode:</p>
      <ul>
        <li><Link to="/flash">Flash-Lag</Link></li>
        <li><Link to="/vanish">Extrapolation (Disappearing Dot)</Link></li>
      </ul>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/flash" element={<FlashLagGame />} />
      <Route path="/vanish" element={<VanishDotGame />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>
);
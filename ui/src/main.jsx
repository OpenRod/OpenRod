import React from "react";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="openshell-theme">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);

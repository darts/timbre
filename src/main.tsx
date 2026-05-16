import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "@/App";
import { FirstRun } from "@/routes/FirstRun";
import { Studio } from "@/routes/Studio";
import { Library } from "@/routes/Library";
import { Models } from "@/routes/Models";
import { Settings } from "@/routes/Settings";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <HashRouter>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Navigate to="/studio" replace />} />
            <Route path="/first-run" element={<FirstRun />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/library" element={<Library />} />
            <Route path="/models" element={<Models />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

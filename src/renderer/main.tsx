import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createTimelineStore } from "./state/timeline-store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root is missing");
const store = createTimelineStore(window.branchestra);
createRoot(root).render(<App store={store} />);

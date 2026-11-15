import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/base.css";
import "./styles/table.css";
import "./styles/people.css";
import "./styles/controls.css";
import "./styles/logs.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("React root not found");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Phone } from "./Phone";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  const page = location.pathname === "/m" || location.pathname.startsWith("/m/") ? <Phone /> : <App />;
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}

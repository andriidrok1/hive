import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import os from "node:os";

// First non-internal IPv4 address, baked into the bundle so the QR code can point a phone at /m.
function lanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

const server = process.env.HIVE_API ?? "http://localhost:4317";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __HIVE_LAN_IP__: JSON.stringify(lanIp()) },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: server, changeOrigin: true },
      "/ws": { target: server, ws: true, changeOrigin: true },
      "/yjs": { target: server, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

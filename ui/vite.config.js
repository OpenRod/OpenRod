import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { openshellApi } from "./server/api.js";

// The console talks to the gateway only through ./server, which holds the
// operator's mTLS bundle. Bound to loopback: this surface is the gateway's
// full authority and is never meant to be reachable from the LAN.
export default defineConfig({
  plugins: [react(), tailwindcss(), openshellApi()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { host: "127.0.0.1", port: 4600, strictPort: true },
});

import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { openshellApi } from "./server/api.js";

// The console talks to the gateway only through ./server, which holds the
// operator's mTLS bundle. Bound to loopback: this surface is the gateway's
// full authority and is never meant to be reachable from the LAN.
if (process.env.OPENROD_MODE && process.env.OPENROD_MODE !== 'local' && process.env.OPENROD_BUILD !== '1') throw new Error('OpenRod cloud and worker modes are not part of this release.')

export default defineConfig({
  plugins: [react(), tailwindcss(), openshellApi()],
  define: { __OPENROD_CLOUD_ORIGIN__: JSON.stringify(process.env.OPENROD_CLOUD_ORIGIN ?? '') },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: { host: "127.0.0.1", port: 4600, strictPort: true },
  preview: { host: "127.0.0.1", port: 4600, strictPort: true },
});

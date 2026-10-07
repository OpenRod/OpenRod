import path from "path";
import fs from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { openshellApi } from "./server/api.js";
import { DEFAULT_CLOUD_ORIGIN } from "./shared/cloud-origin.js";

// The console talks to the gateway only through ./server, which holds the
// operator's mTLS bundle. Bound to loopback: this surface is the gateway's
// full authority and is never meant to be reachable from the LAN.
if (process.env.OPENROD_MODE && process.env.OPENROD_MODE !== 'local' && process.env.OPENROD_BUILD !== '1') throw new Error('OpenRod cloud and worker modes are not part of this release.')

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env }
  const release = JSON.parse(fs.readFileSync(new URL('./shared/analytics-release.json', import.meta.url), 'utf8'))
  const version = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  return {
  plugins: [react(), tailwindcss(), openshellApi()],
  define: {
    __OPENROD_CLOUD_ORIGIN__: JSON.stringify(process.env.OPENROD_CLOUD_ORIGIN ?? DEFAULT_CLOUD_ORIGIN),
    // Only the publish workflow sets OPENROD_ANALYTICS_RELEASE=1, so source builds,
    // forks and previews never report to the production dashboard.
    __OPENROD_ANALYTICS__: JSON.stringify({ projectToken: env.OPENROD_POSTHOG_TOKEN ?? release.projectToken,
      host: env.OPENROD_POSTHOG_HOST ?? release.host, version,
      environment: env.OPENROD_ANALYTICS_RELEASE === '1' ? 'production' : 'development',
      enabled: env.OPENROD_ANALYTICS_RELEASE === '1' || env.OPENROD_ANALYTICS_DEV === '1' }),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: { host: "127.0.0.1", port: 4600, strictPort: true },
  preview: { host: "127.0.0.1", port: 4600, strictPort: true },
  }
});

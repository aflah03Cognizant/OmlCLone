import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server runs on :5173 (the origin the backend's /api CORS allows).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});

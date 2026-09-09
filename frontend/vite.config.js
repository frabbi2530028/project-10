import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In local dev the React app runs on :5173 while FastAPI runs on :8000.
    // Proxying keeps the frontend talking to a same-origin URL, so no
    // VITE_BACKEND_URL and no CORS setup is needed just to work locally.
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
});

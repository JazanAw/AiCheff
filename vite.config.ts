import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'backend/**/*.test.ts',
      // Mobile services/utils that only touch fetch + plain TS (no RN
      // runtime imports) — see docs/pantry-scanner.md.
      'mobile/src/**/*.test.ts',
    ],
  },
})

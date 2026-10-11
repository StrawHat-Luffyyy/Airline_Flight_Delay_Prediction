import { defineConfig } from 'vitest/config';

// Tests must not depend on a developer's local .env (CI has none).
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017',
      MONGODB_DB: 'flight_delay_test',
      PORT: '3999',
    },
  },
});

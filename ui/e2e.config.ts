import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{
    name: 'chromium', engine: web(),
    app: {
      url: 'http://127.0.0.1:0',
      command: { executable: 'node', args: ['tests/browser/serve.js', '{port}'] },
    },
  }],
  tests: 'tests/browser/**/*.e2e.ts', workers: 1, retries: 0,
} satisfies E2EConfig;

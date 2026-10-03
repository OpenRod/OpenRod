import type { Browser } from '@e2e-dev/web';

export const location = { gateway: 'test-gateway', workspace: 'default', context: '["test-gateway","default"]', label: 'Test gateway', connected: true, remote: false };
export const template = { name: 'test-template', status: 'ready', image: 'test:latest', recipe: { command: 'shell' }, location };
export const overview = { gateway: { name: 'test-gateway', endpoint: 'https://127.0.0.1:1', status: 'healthy', version: '0.1.2', drivers: [] }, sandboxes: [], providers: [] };
export const ingress = { services: [], sessions: { ttlSeconds: null }, auth: { mode: 'mtls', remote: false } };

export async function mockConsole(browser: Browser) {
  await browser.route('**/api/**', async route => {
    const pathname = new URL(route.request.url).pathname;
    if (pathname === '/api/os/stream') {
      await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'event: sandboxes\ndata: []\n\n' });
      return;
    }
    const responses = {
      '/api/auth/config': { mode: 'local' },
      '/api/os/context': { ...location, configured: true, gateways: [], workspaces: [] },
      '/api/os/overview': overview,
      '/api/os/inventory': { locations: [location], templates: [template], sandboxes: [] },
      '/api/os/image-templates': [template],
      '/api/os/org': { groups: [], policies: [], members: {}, assignments: {}, setupMembers: {}, ungrouped: [], total: 0 },
      '/api/os/activity': { events: [], coverage: null },
      '/api/os/ingress': ingress,
      '/api/os/connections': { hosts: [], locals: [], active: null, tools: {} },
    };
    if (!(pathname in responses)) throw new Error(`Unexpected API request: ${route.request.method} ${pathname}`);
    await route.fulfill({ json: responses[pathname] });
  });
}

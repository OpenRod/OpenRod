import { test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';
import { mockConsole, overview, ingress } from './fixtures';

beforeEach(async ({ browser }) => { await mockConsole(browser); });

test('ingress failure is visible without sandbox inventory and Retry recovers', async ({ app, browser, screen }) => {
  let failing = true;
  await browser.route(/\/api\/os\/(overview|ingress)(?:\?|$)/, async route => {
    await route.fulfill(failing ? { status: 503, json: { error: 'Gateway unavailable' } } : { json: route.request.url.includes('/overview') ? overview : ingress });
  });
  await browser.route(/\/api\/os\/stream(?:\?|$)/, async route => {
    await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'event: gateway-error\ndata: {}\n\n' });
  });
  await app.open('/#ingress');
  await expect(screen.getByRole('alert')).toContainText('Gateway unavailable');
  await expect(screen.getByText('No sandboxes yet.')).not.toBeVisible();
  failing = false;
  // Deliver recovered inventory so Retry covers both the page API and live data.
  await browser.route(/\/api\/os\/stream(?:\?|$)/, async route => {
    await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'event: sandboxes\ndata: []\n\n' });
  });
  await screen.getByRole('button', 'Retry').tap();
  await expect(screen.getByText('No sandboxes yet.')).toBeVisible();
});

test('overview failure is visible even when ingress responds successfully', async ({ app, browser, screen }) => {
  await browser.route(/\/api\/os\/overview(?:\?|$)/, async route => {
    await route.fulfill({ status: 503, json: { error: 'Inventory unavailable' } });
  });
  await app.open('/#ingress');
  await expect(screen.getByRole('alert')).toContainText('Inventory unavailable');
  await expect(screen.getByText('No sandboxes yet.')).not.toBeVisible();
});

test('unloaded inventory shows loading rather than an empty state', async ({ app, browser, screen }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await browser.route(/\/api\/os\/overview(?:\?|$)/, async route => { await gate; await route.fulfill({ json: overview }); });
  await browser.route(/\/api\/os\/stream(?:\?|$)/, async route => {
    await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: ': waiting for inventory\n\n' });
  });
  try {
    await app.open('/#ingress');
    await expect(screen.getByText('Loading…', { exact: true })).toBeVisible();
    await expect(screen.getByText('No sandboxes yet.')).not.toBeVisible();
  } finally { release(); }
  await expect(screen.getByText('No sandboxes yet.')).toBeVisible();
});

test('healthy empty inventory still shows the empty state', async ({ app, screen }) => {
  await app.open('/#ingress');
  await expect(screen.getByText('No sandboxes yet.')).toBeVisible();
  await expect(screen.getByRole('button', 'Retry')).not.toBeVisible();
});

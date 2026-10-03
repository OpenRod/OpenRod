import { test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';
import { mockConsole, overview } from './fixtures';

beforeEach(async ({ browser }) => { await mockConsole(browser); });

for (const [title, typed, expected] of [
  ['preserves a typed name', 'custom-sandbox', 'custom-sandbox'],
  ['preserves an intentionally cleared name', '', ''],
  ['suggests a name for an untouched form', null, 'sandbox-1'],
] as const) {
  test(`delayed overview ${title}`, async ({ app, browser, screen }) => {
    await app.open('/#templates');
    await expect(screen.getByRole('table', 'Image templates')).toBeVisible();
    let release!: () => void, captured!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { captured = resolve; });
    await browser.route(/\/api\/os\/overview(?:\?|$)/, async route => {
      captured();
      await gate;
      await route.fulfill({ json: overview });
    });
    await screen.getByRole('button', 'Use template').tap();
    await requested;
    if (typed !== null) {
      await screen.getByLabel('Name').fill('temporary');
      await screen.getByLabel('Name').fill(typed);
    }
    const response = browser.waitForResponse(/\/api\/os\/overview(?:\?|$)/);
    release();
    await response;
    await browser.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(screen.getByLabel('Name')).toHaveValue(expected);
    if (typed !== null) {
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Use template').tap();
      await expect(screen.getByLabel('Name')).toHaveValue('sandbox-1');
    }
  });
}

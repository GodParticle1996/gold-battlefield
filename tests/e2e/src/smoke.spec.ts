import { expect, test } from '@playwright/test';

const DISCLAIMER =
  'Educational market visualization only. Not financial advice, not a price forecast, and not a trading signal.';

test.describe('GOLD BATTLEFIELD smoke', () => {
  test('boots with disclaimer, battlefield, and honest mode labels', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto('/');

    // Persistent disclaimer (spec §12/§20).
    await expect(page.getByText(DISCLAIMER)).toBeVisible();

    // 3D canvas present and filling the cinematic stage.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(600);

    // Switch to simulation and verify it is never presented as live.
    const source = page.locator('.controls select').first();
    await source.selectOption('simulation');
    await expect(
      page.getByText('Synthetic simulation. Not live market data.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Replay is labelled accurately too.
    await source.selectOption('replay');
    await expect(page.getByText('Historical replay', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // No console errors during boot + mode switches.
    expect(consoleErrors).toEqual([]);
  });

  test('accessibility toggles and the scene legend work', async ({ page }) => {
    await page.goto('/');

    // Accessibility controls live in the settings drawer.
    await page.getByRole('button', { name: /Settings/ }).click();

    const reducedMotion = page.getByLabel('Reduced motion');
    await reducedMotion.check();
    await expect(reducedMotion).toBeChecked();

    const colorBlind = page.getByLabel('Colour-blind palette');
    await colorBlind.check();
    await expect(colorBlind).toBeChecked();

    // The legend decodes the metaphor without narrating the market.
    await page.getByRole('button', { name: /What am I looking at/ }).click();
    await expect(page.getByText(/Resting buy orders — bids/)).toBeVisible();
    await expect(page.getByText(/most likely cancelled/)).toBeVisible();
  });

  test('hides the HUD but never the disclaimer in TV mode', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'TV mode' }).click();

    // Panels are gone, the honest statement is not.
    await expect(page.locator('.hud')).toHaveClass(/hud-hidden/);
    await expect(page.getByText(DISCLAIMER)).toBeVisible();
    await expect(page.locator('.tv-overlay')).toBeVisible();

    // 'T' returns to the full layout.
    await page.keyboard.press('t');
    await expect(page.locator('.tv-overlay')).toHaveCount(0);
  });

  test('CVD is labelled with the window it was computed over', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Settings/ }).click();

    await expect(page.getByText('CVD (1m)')).toBeVisible();
    await page.getByLabel('CVD window').selectOption('10000');
    await expect(page.getByText('CVD (10s)')).toBeVisible();
  });
});

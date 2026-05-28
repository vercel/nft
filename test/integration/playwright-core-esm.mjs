import playwright from 'playwright-core';

if (playwright.chromium.name() !== 'chromium')
  throw new Error('playwright-core-esm: could not get name')

if (!playwright.chromium.executablePath())
  throw new Error('playwright-core-esm: could not get executablePath')

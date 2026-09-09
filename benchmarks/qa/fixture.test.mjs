/* global document */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture, claims, defects } from './fixture.mjs';
import { score } from './score.mjs';

for (const buggy of [false, true]) {
  test(`fixture independently establishes all eight outcomes (buggy=${buggy})`, async () => {
    const fixture = await startFixture(buggy);
    const act = async (action, data = {}) => {
      const response = await fetch(fixture.url + '/api/action', {
        method: 'POST',
        body: JSON.stringify({ action, ...data }),
      });
      return response.json();
    };
    try {
      const observations = [];
      let result = await act('invite', { email: 'new@example.com' });
      observations.push(
        result.message === 'Invitation created' && result.state.invitations.length === 1,
      );
      await act('reset');
      await act('configure', { role: 'viewer', occupied: 1, limit: 3 });
      result = await act('invite', { email: 'new@example.com' });
      observations.push(
        result.message === 'Permission denied' && result.state.invitations.length === 0,
      );
      await act('reset');
      await act('invite', { email: 'new@example.com' });
      result = await act('invite', { email: 'NEW@example.com' });
      observations.push(
        result.message === 'Already invited' && result.state.invitations.length === 1,
      );
      await act('reset');
      await act('configure', { role: 'admin', occupied: 3, limit: 3 });
      result = await act('invite', { email: 'new@example.com' });
      observations.push(
        result.message === 'Seat limit reached' && result.state.invitations.length === 0,
      );
      await act('reset');
      result = await act('accept', { token: 'valid-token' });
      observations.push(
        result.message === 'Membership activated' && result.state.members.length === 1,
      );
      await act('reset');
      result = await act('accept', { token: 'expired-token' });
      observations.push(
        result.message === 'Invitation expired' && result.state.members.length === 0,
      );
      await act('reset');
      await act('accept', { token: 'valid-token' });
      result = await act('accept', { token: 'valid-token' });
      observations.push(
        result.message === 'Invitation already used' && result.state.members.length === 1,
      );
      await act('reset');
      result = await act('invite', { email: 'invalid' });
      observations.push(
        result.message === 'Invalid email' && result.state.invitations.length === 0,
      );
      assert.deepEqual(
        observations,
        claims.map(([id]) => !(buggy && defects.has(id))),
      );
    } finally {
      await fixture.close();
    }
  });
}

test('scoring never rewards omitted or duplicated defect results', () => {
  const scored = score(
    {
      results: [
        { id: 'invite/viewer', status: 'failed' },
        { id: 'invite/viewer', status: 'passed' },
        { id: 'invented', status: 'failed' },
      ],
    },
    true,
  );
  assert.equal(scored.detected, 0);
  assert.equal(scored.missed, 4);
  assert.equal(scored.untested, 8);
  assert.deepEqual(scored.unexpectedIds, ['invented']);
});

test('browser UI exposes the same healthy and defective permission outcomes', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    for (const buggy of [false, true]) {
      const fixture = await startFixture(buggy);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(fixture.url);
        await page.waitForFunction(
          () => document.querySelector('#message').textContent === 'Workspace ready',
        );
        await page.locator('#role').selectOption('viewer');
        await page.locator('#configure').click();
        await page.waitForFunction(
          () => document.querySelector('#message').textContent === 'Setup applied',
        );
        await page.locator('#email').fill('new@example.com');
        await page.locator('#invite').click();
        const expected = buggy ? 'Invitation created' : 'Permission denied';
        await page.waitForFunction(
          (text) => document.querySelector('#message').textContent === text,
          expected,
        );
        const state = JSON.parse(await page.locator('#state').textContent());
        assert.equal(state.invitations.length, buggy ? 1 : 0);
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
});

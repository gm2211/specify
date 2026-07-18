import assert from 'node:assert/strict';
import test from 'node:test';
import { envFlag, learnedSkillsEnabled, monitorVerdictsEnabled } from './feature-flags.js';

test('envFlag defaults to false', () => {
  const prev = process.env.SPECIFY_TEST_FLAG;
  delete process.env.SPECIFY_TEST_FLAG;
  try {
    assert.equal(envFlag('SPECIFY_TEST_FLAG'), false);
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_TEST_FLAG;
    else process.env.SPECIFY_TEST_FLAG = prev;
  }
});

test('envFlag accepts explicit truthy values only', () => {
  const prev = process.env.SPECIFY_TEST_FLAG;
  try {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.SPECIFY_TEST_FLAG = value;
      assert.equal(envFlag('SPECIFY_TEST_FLAG'), true);
    }
    for (const value of ['0', 'false', 'no', 'off', '']) {
      process.env.SPECIFY_TEST_FLAG = value;
      assert.equal(envFlag('SPECIFY_TEST_FLAG'), false);
    }
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_TEST_FLAG;
    else process.env.SPECIFY_TEST_FLAG = prev;
  }
});

test('learnedSkillsEnabled reads SPECIFY_ENABLE_LEARNED_SKILLS', () => {
  const prev = process.env.SPECIFY_ENABLE_LEARNED_SKILLS;
  try {
    process.env.SPECIFY_ENABLE_LEARNED_SKILLS = 'true';
    assert.equal(learnedSkillsEnabled(), true);
    process.env.SPECIFY_ENABLE_LEARNED_SKILLS = 'false';
    assert.equal(learnedSkillsEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_ENABLE_LEARNED_SKILLS;
    else process.env.SPECIFY_ENABLE_LEARNED_SKILLS = prev;
  }
});

test('monitorVerdictsEnabled reads SPECIFY_ENABLE_MONITOR_VERDICTS and defaults off', () => {
  const prev = process.env.SPECIFY_ENABLE_MONITOR_VERDICTS;
  try {
    delete process.env.SPECIFY_ENABLE_MONITOR_VERDICTS;
    assert.equal(monitorVerdictsEnabled(), false);
    process.env.SPECIFY_ENABLE_MONITOR_VERDICTS = 'true';
    assert.equal(monitorVerdictsEnabled(), true);
    process.env.SPECIFY_ENABLE_MONITOR_VERDICTS = 'false';
    assert.equal(monitorVerdictsEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_ENABLE_MONITOR_VERDICTS;
    else process.env.SPECIFY_ENABLE_MONITOR_VERDICTS = prev;
  }
});

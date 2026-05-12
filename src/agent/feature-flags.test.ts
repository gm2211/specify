import assert from 'node:assert/strict';
import test from 'node:test';
import { envFlag, learnedSkillsEnabled } from './feature-flags.js';

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

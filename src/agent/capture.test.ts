import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { shouldCapture, registrableDomain } from './capture.js';

test('registrableDomain: strips subdomains down to the registrable domain', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('api.example.com'), 'example.com');
  assert.equal(registrableDomain('deep.nested.api.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('registrableDomain: handles common two-level public suffixes', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('api.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com.au'), 'example.com.au');
});

test('registrableDomain: leaves IPs and single-label hosts untouched', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('shouldCapture: same registrable domain across subdomains is captured (fixes SP-l39)', () => {
  // Page hostname is www.example.com; API calls go to api.example.com.
  // With naive `hostname.includes(hostFilter)` matching this produced zero
  // captured entries for the API host, making evidence-based verdicts unsound.
  const hostFilter = 'www.example.com';
  assert.equal(shouldCapture('https://api.example.com/v1/orders', hostFilter), true);
  assert.equal(shouldCapture('https://cdn.example.com/v1/assets.json', hostFilter), true);
  assert.equal(shouldCapture('https://www.example.com/api/orders', hostFilter), true);
});

test('shouldCapture: rejects genuinely cross-origin hosts by default', () => {
  const hostFilter = 'www.example.com';
  assert.equal(shouldCapture('https://tracker.other-domain.com/pixel', hostFilter), false);
});

test('shouldCapture: SPECIFY_CAPTURE_HOST_FILTER widens the filter to extra domains', () => {
  const orig = process.env.SPECIFY_CAPTURE_HOST_FILTER;
  process.env.SPECIFY_CAPTURE_HOST_FILTER = 'payments.example';
  try {
    assert.equal(
      shouldCapture('https://api.payments.example/charge', 'www.example.com'),
      true,
    );
  } finally {
    if (orig === undefined) delete process.env.SPECIFY_CAPTURE_HOST_FILTER;
    else process.env.SPECIFY_CAPTURE_HOST_FILTER = orig;
  }
});

test('shouldCapture: SPECIFY_CAPTURE_HOST_FILTER="*" disables host filtering', () => {
  const orig = process.env.SPECIFY_CAPTURE_HOST_FILTER;
  process.env.SPECIFY_CAPTURE_HOST_FILTER = '*';
  try {
    assert.equal(
      shouldCapture('https://totally-unrelated.io/anything', 'www.example.com'),
      true,
    );
  } finally {
    if (orig === undefined) delete process.env.SPECIFY_CAPTURE_HOST_FILTER;
    else process.env.SPECIFY_CAPTURE_HOST_FILTER = orig;
  }
});

test('shouldCapture: still filters static assets regardless of host', () => {
  assert.equal(shouldCapture('https://api.example.com/app.js', 'www.example.com'), false);
  assert.equal(shouldCapture('https://api.example.com/logo.png', 'www.example.com'), false);
});

test('shouldCapture: no hostFilter captures everything but static assets', () => {
  assert.equal(shouldCapture('https://anywhere.example/data.json', ''), true);
  assert.equal(shouldCapture('https://anywhere.example/style.css', ''), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalize, slugify } from '../src/strings.js';

test('capitalize', () => {
  assert.equal(capitalize('hello'), 'Hello');
});

test('slugify', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  a  b  '), 'a-b');
  assert.equal(slugify(''), '');
});

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { formatApiError } from '../errorFormatting.ts';

it('condenses a chained Python traceback to the final exception line', () => {
  const traceback = [
    'CAD worker response:',
    'Traceback (most recent call last):',
    '  File "/private/build/worker.py", line 13, in build',
    'FileNotFoundError: Missing fixture',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "/private/build/worker.py", line 26, in run',
    'Exception: Could not validate geometry',
    '',
  ].join('\n');
  assert.equal(
    formatApiError(new Error(traceback), 'Build failed'),
    'Exception: Could not validate geometry',
  );
});

it('keeps ordinary errors readable and caps long messages', () => {
  assert.equal(
    formatApiError(new Error('Invalid parameters'), 'Build failed'),
    'Invalid parameters',
  );
  assert.equal(
    formatApiError(new Error('Invalid\n parameters'), 'Build failed'),
    'Invalid parameters',
  );
  assert.equal(formatApiError({}, 'Build failed'), 'Build failed');
  const formatted = formatApiError(new Error('x'.repeat(400)), 'Build failed');
  assert.equal(formatted.length, 240);
  assert.equal(formatted.at(-1), '…');
});

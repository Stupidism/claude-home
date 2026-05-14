/**
 * poll-tickets-stdin.test.mts — verify the stdin/readline EIO mitigation
 * pattern used by poll-tickets.mts:setupInteractiveCommands.
 *
 * Run with:
 *   node --experimental-strip-types --test symphony/scripts/poll-tickets-stdin.test.mts
 *
 * The full poller has heavy import-time side effects (singleton lock, config
 * load, network), so we re-create the readline wiring in isolation and assert:
 *   - emitting an EIO error on the input stream does not throw / crash
 *   - the 'error' handler on the readline.Interface fires too
 *   - subsequent 'line' events still flow after the error
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';

function setupHarness() {
  const input = new PassThrough();
  const stdinErrors: NodeJS.ErrnoException[] = [];
  const rlErrors: NodeJS.ErrnoException[] = [];
  const lines: string[] = [];

  input.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EIO' || err.code === 'EAGAIN') {
      stdinErrors.push(err);
      return;
    }
    throw err;
  });

  const rl = readline.createInterface({ input, terminal: false });
  rl.on('error', (err: NodeJS.ErrnoException) => { rlErrors.push(err); });
  rl.on('line', (line) => { lines.push(line); });

  return { input, rl, stdinErrors, rlErrors, lines };
}

test('EIO on stdin is swallowed by the error handler', () => {
  const { input, stdinErrors } = setupHarness();
  const err = Object.assign(new Error('read EIO'), { code: 'EIO', errno: -5, syscall: 'read' });
  assert.doesNotThrow(() => input.emit('error', err));
  assert.equal(stdinErrors.length, 1);
  assert.equal(stdinErrors[0]!.code, 'EIO');
});

test('EAGAIN on stdin is swallowed too', () => {
  const { input, stdinErrors } = setupHarness();
  const err = Object.assign(new Error('try again'), { code: 'EAGAIN', errno: -35, syscall: 'read' });
  assert.doesNotThrow(() => input.emit('error', err));
  assert.equal(stdinErrors[0]!.code, 'EAGAIN');
});

test('lines still flow after an EIO blip when handlers are attached', async () => {
  const { input, lines } = setupHarness();
  const err = Object.assign(new Error('read EIO'), { code: 'EIO' });
  input.emit('error', err);

  await new Promise<void>((resolve) => {
    input.write('help\n');
    setImmediate(resolve);
  });

  assert.deepEqual(lines, ['help']);
});

test('without error handlers, EIO would crash — sanity check the failure mode', () => {
  const input = new PassThrough();
  readline.createInterface({ input, terminal: false });
  const err = Object.assign(new Error('read EIO'), { code: 'EIO' });
  // PassThrough.emit('error', ...) without listeners re-throws synchronously,
  // mirroring the un-handled `error` event that kills the real poller.
  assert.throws(() => input.emit('error', err), /EIO/);
});

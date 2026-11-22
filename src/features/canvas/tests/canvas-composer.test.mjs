import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INITIAL_CANVAS_COMPOSER_STATE,
  canSubmitPrompt,
  reduceCanvasComposerState,
} from '../model/composerState.ts';

function typeDraft(state, text) {
  return reduceCanvasComposerState(state, { type: 'changeDraft', text });
}

function submit(state) {
  return reduceCanvasComposerState(state, { type: 'submit' });
}

describe('canvas composer state', () => {
  it('starts with an empty draft that cannot be submitted', () => {
    assert.equal(INITIAL_CANVAS_COMPOSER_STATE.draft, '');
    assert.equal(INITIAL_CANVAS_COMPOSER_STATE.lastSubmittedPrompt, null);
    assert.equal(canSubmitPrompt(INITIAL_CANVAS_COMPOSER_STATE.draft), false);
  });

  it('updates the draft while typing and keeps the same state for identical text', () => {
    const typed = typeDraft(INITIAL_CANVAS_COMPOSER_STATE, 'Build a lamp');

    assert.equal(typed.draft, 'Build a lamp');
    assert.equal(canSubmitPrompt(typed.draft), true);
    assert.equal(typeDraft(typed, 'Build a lamp'), typed);
  });

  it('refuses to submit whitespace-only drafts', () => {
    const blank = typeDraft(INITIAL_CANVAS_COMPOSER_STATE, '   \n\t ');

    assert.equal(canSubmitPrompt(blank.draft), false);
    assert.equal(submit(blank), blank);
  });

  it('submits a trimmed prompt and clears the draft', () => {
    const submitted = submit(typeDraft(INITIAL_CANVAS_COMPOSER_STATE, '  Build a lamp \n'));

    assert.equal(submitted.draft, '');
    assert.deepEqual(submitted.lastSubmittedPrompt, { id: 1, text: 'Build a lamp' });
    assert.equal(canSubmitPrompt(submitted.draft), false);
  });

  it('assigns increasing ids to consecutive submissions', () => {
    const first = submit(typeDraft(INITIAL_CANVAS_COMPOSER_STATE, 'First'));
    const second = submit(typeDraft(first, 'Second'));
    const third = submit(typeDraft(second, 'Third'));

    assert.deepEqual(first.lastSubmittedPrompt, { id: 1, text: 'First' });
    assert.deepEqual(second.lastSubmittedPrompt, { id: 2, text: 'Second' });
    assert.deepEqual(third.lastSubmittedPrompt, { id: 3, text: 'Third' });
  });
});

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PINS,
  MAX_TEXT,
  PinError,
  addPin,
  emptyState,
  normalizeState,
  pinStats,
  removePin,
  renderPinBlock,
  setInject,
  snapshot,
  updatePin,
} from '../store.js'

const at = 1_760_000_000_000

test('a fresh board is empty, injects, and renders no prompt block', () => {
  const state = emptyState()
  assert.deepEqual(state.pins, [])
  assert.equal(state.settings.inject, true)
  assert.equal(renderPinBlock(state), '')
  assert.deepEqual(pinStats(state), {
    count: 0,
    chars: 0,
    inject: true,
    maxPins: MAX_PINS,
    maxText: MAX_TEXT,
    maxInjectChars: 2400,
  })
})

test('adding a pin bumps the revision and renders one prompt line', () => {
  const first = addPin(emptyState(), { text: '  always run pnpm test  ', tag: ' workflow ' }, at)
  assert.equal(first.duplicate, false)
  assert.equal(first.state.revision, 1)
  assert.equal(first.pin.text, 'always run pnpm test')
  assert.equal(first.pin.tag, 'workflow')
  assert.equal(first.pin.createdAt, at)
  const block = renderPinBlock(first.state)
  assert.match(block, /pinned memory/)
  assert.match(block, /- \[workflow\] always run pnpm test/)
})

test('the same text is not pinned twice', () => {
  const first = addPin(emptyState(), { text: 'same note' }, at)
  const again = addPin(first.state, { text: 'same note' }, at + 1)
  assert.equal(again.duplicate, true)
  assert.equal(again.state, first.state)
  assert.equal(again.state.revision, 1)
  assert.equal(again.state.pins.length, 1)
})

test('invalid input is rejected with a stable code', () => {
  assert.throws(() => addPin(emptyState(), { text: '   ' }), (error) => error instanceof PinError && error.code === 'text-required')
  assert.throws(() => addPin(emptyState(), { text: 'x'.repeat(MAX_TEXT + 1) }), (error) => error.code === 'text-too-long')
  assert.throws(() => addPin(emptyState(), { text: 'ok', tag: 'y'.repeat(25) }), (error) => error.code === 'tag-too-long')
  assert.throws(() => addPin(emptyState(), {}), (error) => error.code === 'text-required')
  assert.throws(() => updatePin(emptyState(), { id: 'nope', text: 'x' }), (error) => error.code === 'not-found')
  assert.throws(() => removePin(emptyState(), ''), (error) => error.code === 'id-required')
  assert.throws(() => setInject(emptyState(), 'yes'), (error) => error.code === 'inject-invalid')
})

test('control characters and line endings are normalized', () => {
  const pin = addPin(emptyState(), { text: 'a\u0000b\r\nc\rd' }, at).pin
  assert.equal(pin.text, 'ab\nc\nd')
  assert.match(renderPinBlock(addPin(emptyState(), { text: 'a\nb' }, at).state), /- a b/)
})

test('the board holds at most MAX_PINS pins', () => {
  let state = emptyState()
  for (let index = 0; index < MAX_PINS; index += 1) state = addPin(state, { text: `pin ${index}` }, at + index).state
  assert.throws(() => addPin(state, { text: 'one more' }), (error) => error.code === 'pin-limit')
  assert.equal(removePin(state, state.pins[0].id).state.pins.length, MAX_PINS - 1)
})

test('updating text and clearing a tag keeps ids stable', () => {
  const first = addPin(emptyState(), { text: 'old', tag: 'keep' }, at)
  const updated = updatePin(first.state, { id: first.pin.id, text: 'new', tag: '' }, at + 5)
  assert.equal(updated.pin.id, first.pin.id)
  assert.equal(updated.pin.text, 'new')
  assert.equal(updated.pin.tag, null)
  assert.equal(updated.pin.createdAt, at)
  assert.equal(updated.pin.updatedAt, at + 5)
  assert.equal(updated.state.revision, 2)
  const noop = updatePin(updated.state, { id: first.pin.id, text: 'new' }, at + 9)
  assert.equal(noop.state, updated.state)
  assert.throws(() => updatePin(updated.state, { id: first.pin.id }), (error) => error.code === 'no-change')
})

test('turning injection off empties the prompt block without losing pins', () => {
  const withPin = addPin(emptyState(), { text: 'remember me' }, at).state
  const off = setInject(withPin, false)
  assert.equal(off.state.revision, withPin.revision + 1)
  assert.equal(off.state.pins.length, 1)
  assert.equal(renderPinBlock(off.state), '')
  assert.equal(setInject(off.state, false).state, off.state)
  assert.match(renderPinBlock(setInject(off.state, true).state), /remember me/)
})

test('the prompt block respects its character budget and reports the omitted count', () => {
  let state = emptyState()
  for (let index = 0; index < 12; index += 1) state = addPin(state, { text: 'n'.repeat(390) + ` #${index}` }, at).state
  const block = renderPinBlock(state)
  assert.ok(block.length <= 2400, `block was ${block.length} characters`)
  assert.match(block, /\(\+\d+ more pinned notes? not shown here/)
})

test('a corrupt document degrades to what is still readable', () => {
  assert.deepEqual(normalizeState(null), emptyState())
  assert.deepEqual(normalizeState({ pins: 'nope' }), emptyState())
  const state = normalizeState({
    revision: 7.9,
    settings: { inject: false, other: 1 },
    pins: [
      { id: 'a', text: 'first', createdAt: 1 },
      { id: 'a', text: 'duplicate id' },
      { text: 42 },
      { id: 'b', text: ' third ', tag: '  two   words ' },
    ],
  })
  assert.equal(state.revision, 7)
  assert.equal(state.settings.inject, false)
  assert.equal(state.pins.length, 3)
  assert.notEqual(state.pins[1].id, 'a')
  assert.equal(state.pins[2].text, 'third')
  assert.equal(state.pins[2].tag, 'two words')
})

test('the wire snapshot reports figures without leaking internals', () => {
  const state = addPin(emptyState(), { text: 'hello' }, at).state
  assert.deepEqual(snapshot(state), {
    ok: true,
    revision: 1,
    pins: state.pins,
    settings: { inject: true },
    stats: {
      count: 1,
      chars: 5,
      inject: true,
      maxPins: MAX_PINS,
      maxText: MAX_TEXT,
      maxInjectChars: 2400,
    },
  })
})

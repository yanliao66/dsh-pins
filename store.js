/**
 * dsh-pins data layer — pure validation, state transitions, and prompt
 * rendering. Persistence (read/write of `$DSH_HOME/dsh-pins/pins.json`) lives
 * in `index.js`, so every rule in this file is testable without a Host.
 *
 * The store is deliberately small and plain JSON: pins are text with an
 * optional tag, and the only setting is whether the board is injected into the
 * system prompt. State transitions return a NEW state object, and return the
 * SAME reference when the transition changes nothing (a duplicate add, for
 * instance), which lets the caller skip the write.
 *
 * @module dsh-pins/store
 */

import { randomUUID } from 'node:crypto'

/** On-disk document version. Bump only on an incompatible shape change. */
export const SCHEMA_VERSION = 1

/** Maximum number of pinned notes one board holds. */
export const MAX_PINS = 24

/** Maximum characters of one pin's text. */
export const MAX_TEXT = 400

/** Maximum characters of one pin's tag. */
export const MAX_TAG = 24

/** Character budget the injected prompt block may spend. */
export const MAX_INJECT_CHARS = 2400

/** A rejected operation carrying a stable machine-readable code. */
export class PinError extends Error {
  /**
   * @param {string} code - stable code the HTTP layer maps onto a status.
   * @param {string} message - human-readable reason.
   */
  constructor(code, message) {
    super(message)
    this.name = 'PinError'
    this.code = code
  }
}

/** @returns {object} a fresh empty board. */
export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    revision: 0,
    pins: [],
    settings: { inject: true },
  }
}

/** @param {unknown} value @returns {string} a string view of a possibly-missing value. */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {unknown} value @returns {boolean} whether the value is a finite number. */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Normalize one pin body: unify line endings, drop control characters that
 * would corrupt the stored document or the prompt, and trim.
 * @param {unknown} value - raw text.
 * @returns {string} the cleaned text.
 * @throws {PinError} when the text is empty or too long.
 */
export function cleanText(value) {
  const text = asText(value)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (text.length === 0) throw new PinError('text-required', 'pin text is required')
  if (text.length > MAX_TEXT) {
    throw new PinError('text-too-long', `pin text must be at most ${MAX_TEXT} characters`)
  }
  return text
}

/**
 * Normalize one tag: single spaces, no line breaks, empty becomes null.
 * @param {unknown} value - raw tag.
 * @returns {string|null} the cleaned tag.
 * @throws {PinError} when the tag is too long.
 */
export function cleanTag(value) {
  if (value === undefined || value === null) return null
  const tag = asText(value)
    .replace(/[\s\u0000-\u001f]+/g, ' ')
    .trim()
  if (tag.length === 0) return null
  if (tag.length > MAX_TAG) {
    throw new PinError('tag-too-long', `pin tag must be at most ${MAX_TAG} characters`)
  }
  return tag
}

/**
 * Coerce a stored document into a valid board: unknown fields dropped, bad
 * entries skipped, and limits applied. A corrupt file therefore degrades to
 * whatever is still readable instead of failing the plugin.
 * @param {unknown} raw - the parsed JSON document.
 * @returns {object} a valid board.
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object') return emptyState()
  const source = /** @type {Record<string, unknown>} */ (raw)
  const seen = new Set()
  /** @type {object[]} */
  const pins = []
  const rawPins = Array.isArray(source.pins) ? source.pins : []
  for (const entry of rawPins) {
    if (entry === null || typeof entry !== 'object') continue
    const item = /** @type {Record<string, unknown>} */ (entry)
    const text = asText(item.text)
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_TEXT)
    if (text.length === 0) continue
    let id = asText(item.id).trim().slice(0, 64)
    if (id.length === 0 || seen.has(id)) id = 'p_' + randomUUID().slice(0, 8)
    seen.add(id)
    const tag = asText(item.tag).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG)
    const createdAt = isFiniteNumber(item.createdAt) ? /** @type {number} */ (item.createdAt) : Date.now()
    const updatedAt = isFiniteNumber(item.updatedAt) ? /** @type {number} */ (item.updatedAt) : createdAt
    pins.push({ id, text, tag: tag.length > 0 ? tag : null, createdAt, updatedAt })
    if (pins.length >= MAX_PINS) break
  }
  const settings = source.settings !== null && typeof source.settings === 'object'
    ? /** @type {Record<string, unknown>} */ (source.settings)
    : {}
  const inject = typeof settings.inject === 'boolean' ? settings.inject : true
  const revision = isFiniteNumber(source.revision) ? Math.max(0, Math.floor(/** @type {number} */ (source.revision))) : 0
  return { version: SCHEMA_VERSION, revision, pins, settings: { inject } }
}

/**
 * Add one pin. Adding text that is already pinned is a no-op that returns the
 * existing pin, so a repeated tool call cannot duplicate a note.
 * @param {object} state - current board.
 * @param {{ text?: unknown, tag?: unknown }} input - requested pin.
 * @param {number} [now] - timestamp seam for tests.
 * @returns {{ state: object, pin: object, duplicate: boolean }} the transition.
 * @throws {PinError} when the text is invalid or the board is full.
 */
export function addPin(state, input, now = Date.now()) {
  const text = cleanText(input === undefined ? undefined : input.text)
  const tag = cleanTag(input === undefined ? undefined : input.tag)
  const existing = state.pins.find((pin) => pin.text === text)
  if (existing !== undefined) return { state, pin: existing, duplicate: true }
  if (state.pins.length >= MAX_PINS) {
    throw new PinError('pin-limit', `the board is full (${MAX_PINS} pins); remove one first`)
  }
  const pin = {
    id: 'p_' + randomUUID().slice(0, 8),
    text,
    tag,
    createdAt: now,
    updatedAt: now,
  }
  return {
    state: { ...state, revision: state.revision + 1, pins: [...state.pins, pin] },
    pin,
    duplicate: false,
  }
}

/**
 * Update one pin's text and/or tag. An omitted field keeps its current value;
 * `tag: null` (or `''`) clears the tag.
 * @param {object} state - current board.
 * @param {{ id?: unknown, text?: unknown, tag?: unknown }} input - the edit.
 * @param {number} [now] - timestamp seam for tests.
 * @returns {{ state: object, pin: object }} the transition.
 * @throws {PinError} when the pin is unknown or the edit is invalid.
 */
export function updatePin(state, input, now = Date.now()) {
  const id = asText(input === undefined ? undefined : input.id).trim()
  if (id.length === 0) throw new PinError('id-required', 'pin id is required')
  const index = state.pins.findIndex((pin) => pin.id === id)
  if (index < 0) throw new PinError('not-found', `no pin with id ${JSON.stringify(id)}`)
  const pin = state.pins[index]
  const edits = input === undefined ? {} : input
  const hasText = Object.prototype.hasOwnProperty.call(edits, 'text') && edits.text !== undefined
  const hasTag = Object.prototype.hasOwnProperty.call(edits, 'tag')
  if (!hasText && !hasTag) throw new PinError('no-change', 'pass text and/or tag to update')
  const text = hasText ? cleanText(edits.text) : pin.text
  const tag = hasTag ? cleanTag(edits.tag) : pin.tag
  if (text === pin.text && tag === pin.tag) return { state, pin }
  const next = { ...pin, text, tag, updatedAt: now }
  const pins = state.pins.slice()
  pins[index] = next
  return { state: { ...state, revision: state.revision + 1, pins }, pin: next }
}

/**
 * Remove one pin by id.
 * @param {object} state - current board.
 * @param {unknown} id - the pin id.
 * @returns {{ state: object, removed: object }} the transition.
 * @throws {PinError} when the pin is unknown.
 */
export function removePin(state, id) {
  const wanted = asText(id).trim()
  if (wanted.length === 0) throw new PinError('id-required', 'pin id is required')
  const index = state.pins.findIndex((pin) => pin.id === wanted)
  if (index < 0) throw new PinError('not-found', `no pin with id ${JSON.stringify(wanted)}`)
  const pins = state.pins.slice()
  const [removed] = pins.splice(index, 1)
  return { state: { ...state, revision: state.revision + 1, pins }, removed }
}

/**
 * Toggle whether the board is injected into the system prompt.
 * @param {object} state - current board.
 * @param {unknown} value - the requested boolean.
 * @returns {{ state: object }} the transition (the same state when unchanged).
 * @throws {PinError} when the value is not a boolean.
 */
export function setInject(state, value) {
  if (typeof value !== 'boolean') throw new PinError('inject-invalid', 'inject must be a boolean')
  if (state.settings.inject === value) return { state }
  return { state: { ...state, revision: state.revision + 1, settings: { ...state.settings, inject: value } } }
}

/**
 * Summary figures the panel renders in its footer and header.
 * @param {object} state - current board.
 * @returns {{ count: number, chars: number, inject: boolean, maxPins: number, maxText: number, maxInjectChars: number }} figures.
 */
export function pinStats(state) {
  let chars = 0
  for (const pin of state.pins) chars += pin.text.length
  return {
    count: state.pins.length,
    chars,
    inject: state.settings.inject,
    maxPins: MAX_PINS,
    maxText: MAX_TEXT,
    maxInjectChars: MAX_INJECT_CHARS,
  }
}

/**
 * Render the board as one system-prompt block, or the empty string when the
 * board is empty or injection is off. The block states its own contract so a
 * model that has never seen the board understands the pins are standing
 * context rather than the current request.
 * @param {object} state - current board.
 * @returns {string} the prompt block, or ''.
 */
export function renderPinBlock(state) {
  if (state.settings.inject !== true || state.pins.length === 0) return ''
  const header = [
    '## 记忆钉 · pinned memory',
    'The user pinned the following notes. They persist across sessions and are',
    'standing context: honor them as preferences and constraints unless the',
    'current request explicitly overrides them. Maintain them only through the',
    '`memory_pins` tool (or the memory pins panel), never by inventing pins.',
  ].join('\n')
  const lines = []
  let used = header.length
  for (const pin of state.pins) {
    const body = pin.text.replace(/\n/g, ' ').trim()
    const line = `- ${pin.tag === null ? '' : `[${pin.tag}] `}${body}`
    if (used + line.length + 1 > MAX_INJECT_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  const omitted = state.pins.length - lines.length
  if (omitted > 0) {
    lines.push(`- (+${omitted} more pinned note${omitted === 1 ? '' : 's'} not shown here; read them with \`memory_pins\` action=list)`)
  }
  return header + '\n' + lines.join('\n')
}

/**
 * The JSON-serializable view one HTTP response or tool result returns.
 * @param {object} state - current board.
 * @returns {object} the wire snapshot.
 */
export function snapshot(state) {
  return {
    ok: true,
    revision: state.revision,
    pins: state.pins,
    settings: { inject: state.settings.inject },
    stats: pinStats(state),
  }
}

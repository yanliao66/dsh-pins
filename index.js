/**
 * dsh-pins — Host half.
 *
 * A shared board of pinned notes ("记忆钉"): the user pins a preference, a
 * convention, or a reminder once, and every later session carries it. This
 * half owns the board (JSON document under `$DSH_HOME/dsh-pins/`), serves the
 * panel's HTTP API, exposes the `memory_pins` tool so the Agent can read and
 * maintain the same board, and contributes the board to the system prompt.
 *
 * One operation, two callers: both the HTTP routes and the tool dispatch
 * through the same `mutate()` path, so a UI edit and a tool call can never
 * disagree about validation, limits, or the revision counter.
 *
 * @module dsh-pins/host
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
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
} from './store.js'

/** Cordis plugin name; also the browser module id it pairs with. */
export const name = 'dsh-pins'

/**
 * The panel is served by the Web GUI host, so this row waits for the HTTP
 * carrier. The tool and prompt contributions register in the same activation.
 */
export const inject = ['webServer']

/** Version reported by the health route; keep in sync with package.json. */
const VERSION = '1.0.0'

/** Document-relative API prefix the browser half calls. */
const API = '/api/dsh-pins'

/** Maximum accepted request body; the largest legal request is a 400-char pin. */
const MAX_BODY_BYTES = 32 * 1024

/** Log one line under the plugin's own tag. */
function log(level, message) {
  const line = `[dsh-pins] ${message}`
  if (level === 'warn') console.warn(line)
  else if (level === 'error') console.error(line)
  else console.log(line)
}

/**
 * Resolve `$DSH_HOME`, mirroring the shared resolver the plugin family uses:
 * the environment override wins, then the platform home fallback.
 * @returns {string} the absolute DSH home directory.
 */
function resolveDshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(homedir(), trimmed.slice(2))
    return path.resolve(trimmed)
  }
  return path.join(homedir(), '.dsh')
}

/** @param {string} address @returns {boolean} whether the socket address is loopback. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  const v4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** @param {string} hostname @returns {boolean} whether the URL host names loopback. */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isLoopbackAddress(hostname)
}

/**
 * Request-level trust fence: a loopback socket address and loopback `Host`,
 * no forwarding header, and same-origin browser markers. A request that came
 * through a proxy, or from a cross-site page on this machine, is refused
 * rather than treated as local. The native shell presents a non-http(s)
 * origin, which only it can produce, so that case is accepted.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} whether the request may read or mutate the board.
 */
function isLocalRequest(request) {
  if (!isLoopbackAddress(request.socket === null || request.socket === undefined ? undefined : request.socket.remoteAddress)) {
    return false
  }
  if (request.headers['cf-connecting-ip'] !== undefined || request.headers['x-forwarded-for'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return true
  return originUrl.host === hostUrl.host
}

/**
 * Write one JSON response with the plugin's cache policy.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * Read and parse a JSON request body, bounded by {@link MAX_BODY_BYTES}.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<object>} the parsed body (an empty object when absent).
 * @throws {PinError} when the body is too large or not JSON.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new PinError('body-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PinError('body-invalid', 'request body must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PinError('body-invalid', 'request body must be a JSON object')
  }
  return parsed
}

/**
 * Map a thrown error onto an HTTP status and a machine-readable code.
 * @param {unknown} error - the caught value.
 * @returns {{ status: number, code: string, message: string }} the answer.
 */
function describeError(error) {
  if (error instanceof PinError) {
    const status = error.code === 'not-found' ? 404 : error.code === 'pin-limit' ? 409 : 400
    return { status, code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, code: 'internal', message }
}

/**
 * Build the board service: one lazily-loaded document, one serialized write
 * queue, and transitions that only touch disk when the state actually changed.
 * @returns {{ file: string, load: () => Promise<object>, peek: () => object, mutate: (change: (state: object) => object) => Promise<any> }} the service.
 */
function createService() {
  const file = path.join(resolveDshHome(), 'dsh-pins', 'pins.json')
  /** @type {object|null} */
  let current = null
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()

  const load = async () => {
    if (current !== null) return current
    try {
      const raw = await fs.readFile(file, 'utf8')
      current = normalizeState(JSON.parse(raw))
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        log('warn', `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`)
        try {
          await fs.rename(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          // A rename failure must not fail the plugin; the board starts empty.
        }
      }
      current = emptyState()
    }
    return current
  }

  const save = async (state) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${process.pid}`
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fs.rename(temporary, file)
  }

  const mutate = (change) => {
    const run = queue.then(async () => {
      const state = await load()
      const result = change(state)
      if (result !== undefined && result.state !== state) {
        await save(result.state)
        current = result.state
      }
      return result
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    file,
    load,
    peek: () => current === null ? emptyState() : current,
    mutate,
  }
}

/**
 * Build the `memory_pins` tool definition. The raw definition shape is used
 * rather than the `defineTool` helper so the plugin keeps zero imports from
 * the Harness installation: name, description, JSON-Schema parameters, an
 * output declaration with a text renderer, and an execute body.
 * @param {ReturnType<typeof createService>} service - the board service.
 * @param {(level: string, message: string) => void} logger - diagnostic sink.
 * @returns {object} the tool definition.
 */
function createToolDefinition(service, logger) {
  const run = async (input) => {
    const action = typeof input === 'object' && input !== null ? input.action : undefined
    if (action === 'list') {
      const result = await service.mutate((state) => ({ state }))
      const state = result.state
      return {
        ok: true,
        count: state.pins.length,
        pins: state.pins.map((pin) => ({ id: pin.id, text: pin.text, tag: pin.tag })),
        settings: { inject: state.settings.inject },
      }
    }
    if (action === 'add') {
      const result = await service.mutate((state) => addPin(state, input))
      return {
        ok: true,
        count: result.state.pins.length,
        message: result.duplicate
          ? `Already pinned (id ${result.pin.id}).`
          : `Pinned (id ${result.pin.id}): ${result.pin.text}`,
      }
    }
    if (action === 'update') {
      const result = await service.mutate((state) => updatePin(state, input))
      return { ok: true, count: result.state.pins.length, message: `Updated pin ${result.pin.id}.` }
    }
    if (action === 'remove') {
      const result = await service.mutate((state) => removePin(state, input.id))
      return { ok: true, count: result.state.pins.length, message: `Removed pin ${result.removed.id}.` }
    }
    if (action === 'set_inject') {
      const result = await service.mutate((state) => setInject(state, input.inject))
      return {
        ok: true,
        count: result.state.pins.length,
        settings: { inject: result.state.settings.inject },
        message: `Prompt injection is now ${result.state.settings.inject ? 'on' : 'off'}.`,
      }
    }
    throw new PinError('action-invalid', 'action must be one of list, add, update, remove, set_inject')
  }

  return {
    name: 'memory_pins',
    description: [
      'Read or maintain the shared "memory pins" board (记忆钉): short notes the user',
      'pinned so they survive across sessions. The board is already injected into your',
      'system prompt when it is non-empty and injection is on.',
      'Use action=list to read every pin with its id; action=add to pin a durable',
      'preference, convention, or reminder the user asked you to remember; action=update',
      'or action=remove with an id to maintain existing pins; action=set_inject turns the',
      'system-prompt injection on or off. Pin durable facts, not transient task state, and',
      'never invent pins the user did not ask for.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove', 'set_inject'],
          description: 'The operation to perform.',
        },
        text: {
          type: 'string',
          description: `For add: the note to pin (1-${MAX_TEXT} characters). For update: the replacement text.`,
        },
        tag: {
          type: 'string',
          description: 'Optional short tag, for example "preference", "project", or "never".',
        },
        id: {
          type: 'string',
          description: 'For update and remove: the pin id returned by list.',
        },
        inject: {
          type: 'boolean',
          description: 'For set_inject: whether the board is injected into the system prompt.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
          count: { type: 'number', description: 'Pins on the board after the operation.' },
          message: { type: 'string', description: 'Human-readable outcome.' },
          pins: {
            type: 'array',
            description: 'action=list only: every pin with its id.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                tag: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['id', 'text'],
            },
          },
          settings: {
            type: 'object',
            additionalProperties: false,
            properties: { inject: { type: 'boolean' } },
            required: ['inject'],
          },
        },
        required: ['ok'],
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    timeoutMs: 15_000,
    async execute(input) {
      try {
        return await run(input)
      } catch (error) {
        logger('warn', `tool call failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
  }
}

/**
 * Read an optional service without letting a missing or not-yet-loaded
 * service turn into an activation failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the host context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch (error) {
    log('warn', `service ${JSON.stringify(name)} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Register one exact route behind the local-only fence.
 * @param {object} webServer - the host web server service.
 * @param {string} path - exact route path.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handler - the handler.
 * @returns {() => void} the disposer.
 */
function registerRoute(webServer, path, handler) {
  return webServer.register({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (!isLocalRequest(request)) {
        writeJson(response, 403, { ok: false, error: 'forbidden: local requests only' })
        return
      }
      try {
        await handler(request, response)
      } catch (error) {
        const described = describeError(error)
        if (described.status >= 500) log('error', `${path}: ${described.message}`)
        writeJson(response, described.status, { ok: false, error: described.code, message: described.message })
      }
    },
  })
}

/**
 * Plugin activation: load the board, serve the panel API, register the tool,
 * and contribute the prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the host context.
 */
export function apply(ctx) {
  const service = createService()

  // Begin loading before the first request or prompt assembly so `peek()` is
  // warm; a failure here never rejects activation.
  void service.load().catch((error) => log('warn', `initial load failed: ${String(error)}`))

  ctx.effect(() => {
    const webServer = safeGet(ctx, 'webServer')
    if (webServer === undefined) {
      log('warn', 'no webServer service; the panel API is not served')
      return () => {}
    }
    const routes = []
    routes.push(registerRoute(webServer, `${API}/pins`, async (request, response) => {
      if (request.method === 'GET') {
        const state = await service.load()
        writeJson(response, 200, snapshot(state))
        return
      }
      if (request.method === 'POST') {
        const body = await readJsonBody(request)
        const result = await service.mutate((state) => addPin(state, body))
        writeJson(response, result.duplicate ? 200 : 201, {
          ...snapshot(result.state),
          pin: result.pin,
          duplicate: result.duplicate,
        })
        return
      }
      if (request.method === 'PATCH') {
        const body = await readJsonBody(request)
        const result = await service.mutate((state) => updatePin(state, body))
        writeJson(response, 200, { ...snapshot(result.state), pin: result.pin })
        return
      }
      if (request.method === 'DELETE') {
        const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
        const result = await service.mutate((state) => removePin(state, query.get('id') ?? ''))
        writeJson(response, 200, { ...snapshot(result.state), removed: result.removed })
        return
      }
      writeJson(response, 405, { ok: false, error: 'method-not-allowed', message: `${request.method} is not supported` })
    }))
    routes.push(registerRoute(webServer, `${API}/settings`, async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: 'method-not-allowed', message: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      const result = await service.mutate((state) => setInject(state, body.inject))
      writeJson(response, 200, snapshot(result.state))
    }))
    routes.push(registerRoute(webServer, `${API}/health`, async (_request, response) => {
      const state = await service.load()
      writeJson(response, 200, {
        ok: true,
        name,
        version: VERSION,
        file: service.file,
        revision: state.revision,
        pins: state.pins.length,
        stats: pinStats(state),
      })
    }))
    log('info', `serving ${API} from ${service.file}`)
    return () => {
      for (const dispose of routes.reverse()) {
        try {
          dispose()
        } catch {
          // A route already removed by teardown is not an error.
        }
      }
    }
  }, 'dsh-pins: routes')

  // The tool registry and prompt registry are optional services: the board
  // still works through the panel when a composition omits them.
  ctx.effect(() => {
    const tools = safeGet(ctx, 'tools')
    if (tools === undefined) {
      log('warn', 'no tools service; memory_pins is unavailable to this Agent')
      return () => {}
    }
    try {
      return tools.register(createToolDefinition(service, log))
    } catch (error) {
      log('warn', `could not register memory_pins: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }, 'dsh-pins: memory_pins tool')

  ctx.effect(() => {
    const systemPrompt = safeGet(ctx, 'systemPrompt')
    if (systemPrompt === undefined) {
      log('warn', 'no systemPrompt service; pins are not injected into sessions')
      return () => {}
    }
    const disposers = []
    try {
      disposers.push(systemPrompt.variable('memory_pins', () => {
        try {
          return renderPinBlock(service.peek())
        } catch {
          return ''
        }
      }))
      disposers.push(systemPrompt.section({
        name: 'memory:pins',
        order: 1500,
        text: '{{memory_pins}}',
      }))
    } catch (error) {
      log('warn', `could not contribute the prompt section: ${error instanceof Error ? error.message : String(error)}`)
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Disposing an already-disposed contribution is not an error.
        }
      }
    }
  }, 'dsh-pins: prompt section')
}

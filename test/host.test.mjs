import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The service resolves $DSH_HOME at activation, so every test activates
// against its own throwaway directory.
const homes = []
let home = ''
process.env.DSH_HOME = await mkdtemp(path.join(tmpdir(), 'dsh-pins-host-'))
const { apply } = await import('../index.js')

/** Point $DSH_HOME at a fresh directory and remember it for cleanup. */
async function newHome() {
  home = await mkdtemp(path.join(tmpdir(), 'dsh-pins-host-'))
  homes.push(home)
  process.env.DSH_HOME = home
  return home
}

/** Activate the plugin against a fresh board and return the recording harness. */
async function activate() {
  await newHome()
  const harness = createHarness()
  apply(harness.ctx)
  return { ...harness, home }
}

/** A minimal Cordis-shaped context whose services record registrations. */
function createHarness() {
  const routes = []
  const tools = []
  const variables = []
  const sections = []
  const effects = []
  const ctx = {
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return disposer
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        }
      }
      if (name === 'tools') {
        return {
          register(definition) {
            tools.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          variable(variableName, read) {
            variables.push({ name: variableName, read })
            return () => {}
          },
          section(section) {
            sections.push(section)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  return { ctx, routes, tools, variables, sections, effects }
}

/** A response double that records the status, headers, and body. */
function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload)
    },
  }
}

/**
 * A request double. `body` is yielded through the async iterator the host code
 * consumes, and `remoteAddress`/`headers` drive the local trust fence.
 */
function createRequest(options = {}) {
  const { method = 'GET', url = '/api/dsh-pins/health', headers = {}, remoteAddress = '127.0.0.1', body = '' } = options
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:53862', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
  return request
}

/** Dispatch one request through the registered route with the same path. */
async function dispatch(harness, request) {
  const route = harness.routes.find((candidate) => candidate.path === request.url.split('?')[0])
  assert.ok(route, `no route registered for ${request.url}`)
  const response = createResponse()
  await route.handler(request, response)
  return { status: response.statusCode, body: response.body === '' ? null : JSON.parse(response.body) }
}

/** Read the data document one activation wrote. */
async function readDocument(directory) {
  return JSON.parse(await readFile(path.join(directory, 'dsh-pins', 'pins.json'), 'utf8'))
}

test('activation registers three routes, one tool, one variable, one section', async () => {
  const harness = await activate()
  assert.deepEqual(harness.routes.map((route) => [route.kind, route.path]), [
    ['exact', '/api/dsh-pins/pins'],
    ['exact', '/api/dsh-pins/settings'],
    ['exact', '/api/dsh-pins/health'],
  ])
  assert.equal(harness.tools.length, 1)
  const tool = harness.tools[0]
  assert.equal(tool.name, 'memory_pins')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
  assert.deepEqual(harness.variables.map((variable) => variable.name), ['memory_pins'])
  assert.deepEqual(harness.sections, [{ name: 'memory:pins', order: 1500, text: '{{memory_pins}}' }])
  assert.equal(harness.variables[0].read(), '')
})

test('a pin added over HTTP is persisted, listed, and rendered into the prompt', async () => {
  const harness = await activate()
  const created = await dispatch(harness, createRequest({
    method: 'POST',
    url: '/api/dsh-pins/pins',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '  讲中文  ', tag: 'pref' }),
  }))
  assert.equal(created.status, 201)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.pin.text, '讲中文')
  assert.equal(created.body.pin.tag, 'pref')
  assert.equal(created.body.stats.count, 1)

  const listed = await dispatch(harness, createRequest({ url: '/api/dsh-pins/pins' }))
  assert.equal(listed.body.pins.length, 1)

  const document = await readDocument(harness.home)
  assert.equal(document.version, 1)
  assert.equal(document.pins[0].text, '讲中文')

  // The prompt variable reads the live board, so the section is now non-empty.
  assert.match(harness.variables[0].read(), /讲中文/)
})

test('a duplicate add answers 200 and does not grow the board', async () => {
  const harness = await activate()
  const post = (body) => dispatch(harness, createRequest({
    method: 'POST',
    url: '/api/dsh-pins/pins',
    headers: { 'content-type': 'application/json' },
    body,
  }))
  await post(JSON.stringify({ text: 'same' }))
  const again = await post(JSON.stringify({ text: ' same ' }))
  assert.equal(again.status, 200)
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.stats.count, 1)
})

test('the injection switch empties the prompt block without dropping pins', async () => {
  const harness = await activate()
  await dispatch(harness, createRequest({
    method: 'POST',
    url: '/api/dsh-pins/pins',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'keep me' }),
  }))
  const off = await dispatch(harness, createRequest({
    method: 'POST',
    url: '/api/dsh-pins/settings',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inject: false }),
  }))
  assert.equal(off.status, 200)
  assert.equal(off.body.settings.inject, false)
  assert.equal(harness.variables[0].read(), '')
  assert.equal(off.body.stats.count, 1)

  await dispatch(harness, createRequest({
    method: 'POST',
    url: '/api/dsh-pins/settings',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inject: true }),
  }))
  assert.match(harness.variables[0].read(), /keep me/)
})

test('the tool and the HTTP API share one board', async () => {
  const harness = await activate()
  const tool = harness.tools[0]
  const added = await tool.execute({ action: 'add', text: 'tool pin' })
  assert.equal(added.ok, true)
  const listed = await dispatch(harness, createRequest({ url: '/api/dsh-pins/pins' }))
  assert.deepEqual(listed.body.pins.map((pin) => pin.text), ['tool pin'])
  const listedByTool = await tool.execute({ action: 'list' })
  assert.equal(listedByTool.count, 1)
  assert.equal(listedByTool.pins[0].text, 'tool pin')
  await tool.execute({ action: 'remove', id: listedByTool.pins[0].id })
  const after = await dispatch(harness, createRequest({ url: '/api/dsh-pins/pins' }))
  assert.equal(after.body.pins.length, 0)
})

test('a foreign request is refused by the trust fence', async () => {
  const harness = await activate()
  const refused = [
    { url: '/api/dsh-pins/pins', remoteAddress: '10.0.0.5' },
    { url: '/api/dsh-pins/pins', headers: { 'x-forwarded-for': '1.2.3.4' } },
    { url: '/api/dsh-pins/pins', headers: { 'cf-connecting-ip': '1.2.3.4' } },
    { url: '/api/dsh-pins/pins', headers: { 'sec-fetch-site': 'cross-site' } },
    { url: '/api/dsh-pins/pins', headers: { host: 'example.com' } },
    { url: '/api/dsh-pins/pins', headers: { origin: 'https://evil.example' } },
  ]
  for (const scenario of refused) {
    const answer = await dispatch(harness, createRequest(scenario))
    assert.equal(answer.status, 403, JSON.stringify(scenario))
  }
  const sameOrigin = await dispatch(harness, createRequest({
    url: '/api/dsh-pins/pins',
    headers: { origin: 'http://127.0.0.1:53862' },
  }))
  assert.equal(sameOrigin.status, 200)
})

test('invalid requests map onto stable status codes', async () => {
  const harness = await activate()
  const empty = await dispatch(harness, createRequest({
    method: 'POST', url: '/api/dsh-pins/pins', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
  }))
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error, 'text-required')

  const badJson = await dispatch(harness, createRequest({
    method: 'POST', url: '/api/dsh-pins/pins', headers: { 'content-type': 'application/json' }, body: 'not json',
  }))
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.error, 'body-invalid')

  const wrongMethod = await dispatch(harness, createRequest({ method: 'PUT', url: '/api/dsh-pins/pins' }))
  assert.equal(wrongMethod.status, 405)

  const missing = await dispatch(harness, createRequest({ method: 'DELETE', url: '/api/dsh-pins/pins?id=p_nope' }))
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'not-found')
})

test('the board reloads from disk in a fresh activation', async () => {
  const first = await activate()
  await dispatch(first, createRequest({
    method: 'POST', url: '/api/dsh-pins/pins', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'durable' }),
  }))

  // A second activation over the SAME home reloads the document the first one
  // wrote, which is what a Host restart does.
  process.env.DSH_HOME = first.home
  const secondHarness = createHarness()
  apply(secondHarness.ctx)
  const second = { ...secondHarness, home: first.home }
  const listed = await dispatch(second, createRequest({ url: '/api/dsh-pins/pins' }))
  assert.deepEqual(listed.body.pins.map((pin) => pin.text), ['durable'])
  assert.match(second.variables[0].read(), /durable/)
})

test('a corrupt document is quarantined and the board starts empty', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const directory = path.join(await newHome(), 'dsh-pins')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'pins.json'), '{"pins": [broken', 'utf8')
  const harness = createHarness()
  apply(harness.ctx)
  const answer = await dispatch(harness, createRequest({ url: '/api/dsh-pins/pins' }))
  assert.equal(answer.status, 200)
  assert.equal(answer.body.stats.count, 0)
})

test.after(async () => {
  for (const directory of homes) await rm(directory, { recursive: true, force: true })
})

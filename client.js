/**
 * dsh-pins — browser half.
 *
 * Two surfaces, one shared store:
 *
 * 1. `conversation.composer.dock` seats a compact trigger chip in the same
 *    bottom row as the host's context meter. It is auto-width and inline, so it
 *    never covers or pushes the row's other occupants (token usage, session
 *    stats, skin switcher).
 * 2. `conversation.input.overlay` renders the board itself only while open.
 *    The host's overlay anchor is a zero-height element at the top edge of the
 *    composer card, so the panel is absolutely positioned *above* the composer
 *    (`bottom: 100% + gap`) and opens upward, away from everything below.
 *
 * The module is plain JavaScript: `window.__ModuleLoader__.load` registers a
 * lazy factory whose id equals the package name, React comes from the browser
 * module table, and styles are rendered as a component-local <style> element so
 * unmounting removes them.
 *
 * @module dsh-pins/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-pins',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this plugin registers and binds. */
    const NS = 'dsh-pins'

    /** Host API prefix, document-relative so a sub-path deployment resolves it. */
    const API = 'api/dsh-pins'

    /** Poll cadence for the board while the page is visible. */
    const POLL_MS = 30_000

    /** Per-request ceiling: a stalled Host must not pile up requests. */
    const FETCH_TIMEOUT_MS = 8_000

    /** Mirror of `MAX_TEXT` in store.js, used as the input's maxlength. */
    const MAX_TEXT = 400

    /** Shipped dictionaries; the Host's locale service prefers these over raw text. */
    const ZH = {
      title: '记忆钉',
      panelTitle: '记忆钉',
      summaryEmpty: '还没有钉任何东西',
      summaryLoading: '读取中…',
      summaryError: '读取失败',
      summaryCount: '{count} 条',
      injecting: '注入系统提示',
      notInjecting: '未注入',
      add: '钉住',
      placeholder: '钉一条跨会话都记得的事…',
      empty: '空板。钉下偏好、约定或提醒，之后的每个会话都会带上它们。',
      remove: '移除',
      close: '关闭',
      injectLabel: '注入系统提示',
      budget: '{used}/{max} 字',
      errorNetwork: '连不上本地服务',
      errorBoard: '操作失败',
    }

    /** English dictionary; both shipped locales are required by the locale service. */
    const EN = {
      title: 'Pins',
      panelTitle: 'Memory pins',
      summaryEmpty: 'nothing pinned yet',
      summaryLoading: 'loading…',
      summaryError: 'could not load',
      summaryCount: '{count} pinned',
      injecting: 'in system prompt',
      notInjecting: 'not injected',
      add: 'Pin',
      placeholder: 'Pin something that should survive across sessions…',
      empty: 'Nothing pinned yet. Pin a preference, a convention, or a reminder and every later session carries it.',
      remove: 'Remove',
      close: 'Close',
      injectLabel: 'Inject into system prompt',
      budget: '{used}/{max} chars',
      errorNetwork: 'cannot reach the local service',
      errorBoard: 'operation failed',
    }

    /**
     * Interpolate `{name}` groups, matching the Host locale service's syntax.
     * @param {string} template - dictionary entry.
     * @param {Record<string, unknown>} [vars] - values.
     * @returns {string} the filled text.
     */
    function fill(template, vars) {
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = vars[key]
        return value === undefined || value === null ? match : String(value)
      })
    }

    /**
     * Read one JSON answer from the Host Plugin API.
     * @param {string} path - path after the API prefix.
     * @param {RequestInit} [options] - fetch options.
     * @returns {Promise<any>} the parsed body.
     */
    async function call(path, options) {
      let response
      try {
        response = await fetch(`${API}/${path}`, {
          ...options,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (error) {
        throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network')
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || body === null || body.ok === false) {
        const reason = body !== null && typeof body.message === 'string'
          ? body.message
          : body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return body
    }

    /**
     * The board cache every mounted surface shares, plus the panel's open flag
     * so the trigger and the panel stay in sync across slot remounts.
     * @returns {object} a small external store.
     */
    function createUiStore() {
      let state = { status: 'idle', board: null, error: '', open: false }
      /** @type {Set<() => void>} */
      const listeners = new Set()
      const publish = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // A broken subscriber must not break the publisher.
          }
        }
      }
      const accept = (body) => {
        publish({
          status: 'ready',
          error: '',
          board: {
            revision: body.revision,
            pins: Array.isArray(body.pins) ? body.pins : [],
            settings: body.settings === undefined || body.settings === null ? { inject: true } : body.settings,
            stats: body.stats === undefined || body.stats === null ? null : body.stats,
          },
        })
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        get() {
          return state
        },
        setOpen(open) {
          if (state.open === open) return
          publish({ open })
        },
        toggle() {
          this.setOpen(!state.open)
        },
        async refresh() {
          try {
            accept(await call('pins'))
          } catch (error) {
            publish({ status: 'error', error: error instanceof Error ? error.message : 'error' })
          }
        },
        async add(text) {
          accept(await call('pins', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          }))
        },
        async remove(id) {
          accept(await call(`pins?id=${encodeURIComponent(id)}`, { method: 'DELETE' }))
        },
        async setInject(inject) {
          accept(await call('settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ inject }),
          }))
        },
        resetError() {
          if (state.error !== '') publish({ error: '' })
        },
      }
    }

    /** Pin glyph: an original pushpin drawn on a 16px grid. */
    function PinGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false',
      },
      h('path', {
        d: 'M5.6 1.6h4.8l-.9 3.7 2.9 2.2v1.3H8.6v5.6L8 15.8l-.6-1.4V8.8H3.6V7.5l2.9-2.2z',
        fill: 'currentColor',
      }))
    }

    /** Small removal glyph. */
    function CrossGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M4 4 12 12 M12 4 4 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        }))
    }

    /**
     * Compact trigger seated in the composer dock row: an inline chip with the
     * pin count, never wider than its own label and never full-width.
     * @param {{ t: Function, store: object }} props - render context.
     * @returns {object} a React element.
     */
    function PinsTrigger(props) {
      const t = props.t
      const store = props.store
      const state = React.useSyncExternalStore(store.subscribe, store.get)
      const count = state.board === null ? 0 : state.board.pins.length
      return h('button', {
        type: 'button',
        className: 'dsp-trigger',
        'data-pins-trigger': '1',
        'aria-haspopup': 'dialog',
        'aria-expanded': state.open,
        title: t('panelTitle'),
        onClick: () => {
          store.toggle()
        },
      },
      h(PinGlyph),
      h('span', { className: 'dsp-trigger-label' }, t('title')),
      count > 0 ? h('span', { className: 'dsp-trigger-count', 'aria-hidden': true }, String(count)) : null)
    }

    /**
     * Render one pin row.
     * @param {object} pin - the pin.
     * @param {object} props - render context.
     * @returns {object} a React element.
     */
    function PinRow(pin, props) {
      return h('li', { className: 'dsp-item', key: pin.id },
        h('span', { className: 'dsp-item-lead', 'aria-hidden': true }, h('span', { className: 'dsp-dot' })),
        h('div', { className: 'dsp-item-main' },
          h('div', { className: 'dsp-item-text' }, pin.text),
          pin.tag === null || pin.tag === undefined || pin.tag === ''
            ? null
            : h('span', { className: 'dsp-tag' }, pin.tag)),
        props.readOnly
          ? null
          : h('button', {
            type: 'button',
            className: 'dsp-del',
            title: props.t('remove'),
            'aria-label': props.t('remove'),
            onClick: () => {
              props.onRemove(pin.id)
            },
          }, h(CrossGlyph)))
    }

    /**
     * The board panel, rendered in the composer's overlay seat and positioned
     * above the composer card. Renders nothing while closed.
     * @param {{ t: Function, store: object }} props - render context.
     * @returns {object|null} a React element, or null while closed.
     */
    function PinsPanel(props) {
      const t = props.t
      const store = props.store
      const state = React.useSyncExternalStore(store.subscribe, store.get)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const inputRef = React.useRef(null)

      // Follow the open flag: fetch on open, and listen for the usual dismissal
      // gestures (Escape, a press outside both the panel and the trigger).
      React.useEffect(() => {
        if (!state.open) return undefined
        void store.refresh()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') store.setOpen(false)
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-pins-panel], [data-pins-trigger]') !== null) return
          store.setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [state.open])

      React.useEffect(() => {
        if (state.open && inputRef.current !== null) inputRef.current.focus()
      }, [state.open])

      // Keep the count fresh on a page that stays open for a long while.
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void store.refresh()
        }, POLL_MS)
        return () => {
          clearInterval(timer)
        }
      }, [])

      if (!state.open) return null

      const board = state.board
      const pins = board === null ? [] : board.pins
      const inject = board === null ? true : board.settings.inject !== false
      const stats = board === null ? null : board.stats

      const run = async (operation) => {
        setBusy(true)
        setFailure('')
        store.resetError()
        try {
          await operation()
        } catch (error) {
          setFailure(error instanceof Error && error.message === 'network'
            ? t('errorNetwork')
            : `${t('errorBoard')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const submit = (event) => {
        if (event !== undefined) event.preventDefault()
        const text = draft.trim()
        if (text === '' || busy) return
        void run(async () => {
          await store.add(text)
          setDraft('')
        })
      }

      const visibleError = failure !== ''
        ? failure
        : state.status === 'error' && state.error !== ''
          ? `${t('errorBoard')}: ${state.error}`
          : ''

      return h('section', {
        className: 'dsp-panel',
        'data-pins-panel': '1',
        role: 'dialog',
        'aria-label': t('panelTitle'),
        onPointerDown: (event) => {
          // A press inside the panel must not reach the composer's own handlers.
          event.stopPropagation()
        },
      },
      h('style', { key: 'dsp-css' }, CSS),
      h('div', { className: 'dsp-head' },
        h('span', { className: 'dsp-lead', 'aria-hidden': true }, h(PinGlyph)),
        h('span', { className: 'dsp-title' }, t('panelTitle')),
        h('span', { className: 'dsp-head-count' },
          board === null
            ? t('summaryLoading')
            : pins.length === 0 ? t('summaryEmpty') : fill(t('summaryCount'), { count: pins.length })),
        h('button', {
          type: 'button',
          className: 'dsp-close',
          title: t('close'),
          'aria-label': t('close'),
          onClick: () => {
            store.setOpen(false)
          },
        }, h(CrossGlyph))),
      h('ul', { className: 'dsp-list' },
        pins.length === 0
          ? h('li', { className: 'dsp-empty' }, t('empty'))
          : pins.map((pin) => PinRow(pin, {
            t,
            readOnly: busy,
            onRemove: (id) => {
              void run(() => store.remove(id))
            },
          }))),
      h('form', { className: 'dsp-add', onSubmit: submit },
        h('input', {
          ref: inputRef,
          className: 'dsp-input',
          value: draft,
          maxLength: MAX_TEXT,
          placeholder: t('placeholder'),
          'aria-label': t('placeholder'),
          disabled: busy,
          onChange: (event) => {
            setDraft(event.target.value)
          },
        }),
        h('button', {
          type: 'submit',
          className: 'dsp-add-button',
          disabled: busy || draft.trim().length === 0,
        }, t('add'))),
      h('div', { className: 'dsp-foot' },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': inject,
          'aria-label': t('injectLabel'),
          className: 'dsp-switch',
          'data-on': inject ? '1' : '0',
          disabled: busy,
          onClick: () => {
            void run(() => store.setInject(!inject))
          },
        }, h('span', { className: 'dsp-knob' })),
        h('span', { className: 'dsp-foot-label' }, inject ? t('injecting') : t('notInjecting')),
        h('span', { className: 'dsp-budget' },
          stats === null ? '' : fill(t('budget'), { used: stats.chars, max: stats.maxInjectChars }))),
      visibleError === ''
        ? null
        : h('p', { className: 'dsp-error', role: 'alert' }, visibleError))
    }

    /**
     * Styles use only host theme tokens. The trigger matches the context
     * meter's metrics (its inline neighbour in the dock row); the panel borrows
     * the composer card's surface tokens and floats above the card.
     */
    const CSS = `
.dsp-trigger{flex:none;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:var(--dsw-radius-sm);border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:20px;white-space:nowrap;cursor:pointer}
.dsp-trigger:hover,.dsp-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsp-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.dsp-trigger-label{min-width:0}
.dsp-trigger-count{font-size:11px;line-height:16px;min-width:16px;padding:0 4px;border-radius:999px;text-align:center;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.dsp-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:40;display:flex;flex-direction:column;width:min(360px,calc(100vw - 24px));max-height:min(52vh,440px);box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);border:1px solid var(--dsw-alias-border-l2);overflow:hidden;color:var(--dsw-alias-label-primary);text-align:left}
.dsp-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;flex:none}
.dsp-lead{flex:none;display:grid;place-items:center;color:var(--dsw-alias-brand-primary)}
.dsp-title{flex:none;font-size:13px;font-weight:500;line-height:20px}
.dsp-head-count{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsp-close{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsp-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsp-close:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.dsp-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:2px 12px 8px;list-style:none;overflow-y:auto;min-height:0;scrollbar-width:thin}
.dsp-item{display:flex;align-items:flex-start;gap:8px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsp-item-lead{flex:none;display:grid;place-items:center;height:20px;color:var(--dsw-alias-brand-primary)}
.dsp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}
.dsp-item-main{flex:auto;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.dsp-item-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsp-tag{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.dsp-del{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsp-del:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.dsp-del:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.dsp-empty{margin:0;padding:2px 0 6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsp-add{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.dsp-input{flex:auto;min-width:0;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsp-input::placeholder{color:var(--dsw-alias-markdown-placeholder,#8a8f99)}
.dsp-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsp-add-button{flex:none;height:28px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.dsp-add-button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsp-add-button:disabled{opacity:.45;cursor:default}
.dsp-foot{display:flex;align-items:center;gap:8px;padding:0 12px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:none}
.dsp-switch{flex:none;position:relative;width:28px;height:16px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background 140ms ease}
.dsp-switch[data-on="1"]{background:var(--dsw-alias-brand-primary)}
.dsp-switch:disabled{opacity:.5;cursor:default}
.dsp-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.dsp-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform 140ms ease}
.dsp-switch[data-on="1"] .dsp-knob{transform:translateX(12px)}
.dsp-foot-label{flex:none}
.dsp-budget{margin-left:auto;flex:none;font-variant-numeric:tabular-nums}
.dsp-error{margin:0;padding:0 12px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);flex:none}
@media (prefers-reduced-motion: reduce){.dsp-knob,.dsp-switch{transition:none}}
`

    /**
     * Pick the translation function: the Host locale service when present,
     * otherwise the shipped dictionary matching the document language.
     * @param {object} ctx - client context.
     * @returns {(key: string, vars?: Record<string, unknown>) => string} the translator.
     */
    function makeTranslator(ctx) {
      const locale = ctx.get === undefined ? undefined : ctx.get('locale')
      if (locale !== undefined && locale !== null) {
        try {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') {
            return (key, vars) => {
              try {
                return vars === undefined ? bound(key) : bound(key, vars)
              } catch {
                return fallback(key, vars)
              }
            }
          }
        } catch {
          // Fall through to the shipped dictionary.
        }
      }
      return fallback
    }

    /** Dictionary fallback that reads the document language once per call. */
    function fallback(key, vars) {
      const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang
      const dictionary = typeof language === 'string' && language.toLowerCase().startsWith('zh') ? ZH : EN
      const template = dictionary[key] === undefined ? (EN[key] === undefined ? key : EN[key]) : dictionary[key]
      return fill(template, vars)
    }

    /**
     * Client plugin body: register the dictionary, the dock trigger, and the
     * overlay panel. Both surfaces read one store, so they cannot disagree
     * about the board or the open flag.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      const locale = ctx.get === undefined ? undefined : ctx.get('locale')
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        ctx.effect(() => {
          try {
            return locale.register(NS, { zh: ZH, en: EN })
          } catch {
            return () => {}
          }
        }, 'dsh-pins: dictionaries')
      }

      const t = makeTranslator(ctx)
      const store = createUiStore()

      // Compact trigger: same bottom row as the host's context meter, but only
      // as wide as its own label.
      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-pins',
        order: 20,
      }, (props) => h(PinsTrigger, { ...props, t, store }))), 'dsh-pins: dock trigger')

      // The board itself: the composer's overlay seat, which the host anchors
      // to the top edge of the composer card, so the panel opens upward.
      ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'dsh-pins',
        order: 20,
      }, (props) => h(PinsPanel, { ...props, t, store }))), 'dsh-pins: overlay panel')
    }

    return { name: NS, inject: ['slots'], apply }
  },
})

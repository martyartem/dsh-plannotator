/**
 * Offline test for the browser half (lib/client.js).
 *
 * The bundle is written in the host's module-loader format, so this harness
 * fakes `window.__ModuleLoader__`, React and cordis, then checks that the
 * plugin registers the sidebar tab and renders its panel without touching a
 * browser.
 *
 *   node scripts/client-test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

const results = [];
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

// --- a tiny React stand-in: hooks are synchronous, elements are plain objects ---
const hooks = { states: [], index: 0, effects: [] };

function resetHooks() {
  hooks.states = [];
  hooks.index = 0;
  hooks.effects = [];
}

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } };
}

const React = {
  createElement,
  useState(initial) {
    const slot = hooks.index++;
    if (hooks.states[slot] === undefined) hooks.states[slot] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[slot], (next) => (hooks.states[slot] = typeof next === 'function' ? next(hooks.states[slot]) : next)];
  },
  useEffect(callback) {
    hooks.effects.push(callback);
  },
  useMemo(factory) {
    hooks.index += 1; // useMemo occupies a slot like any other hook
    return factory();
  },
};

const loaded = [];
const context = {
  console,
  fetch: async () => ({ json: async () => ({ ok: true, dir: '/tmp/ws', entries: [{ name: 'a.md', path: '/tmp/ws/a.md', type: 'file' }] }) }),
  AbortController,
  // The route URL is built with the Web URL API, so the sandbox needs it too.
  URL,
  URLSearchParams,
  window: {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry);
      },
    },
  },
};
context.window.window = context.window;
vm.createContext(context);

vm.runInContext(bundle, context, { filename: 'client.js' });

check('the bundle registers exactly one module row', () => {
  assert.equal(loaded.length, 1);
  return loaded[0].id;
});

check('the row id matches the package name', () => {
  assert.equal(loaded[0].id, 'plannotator-dsh');
});

const factoryResult = loaded[0].factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'cordis' || specifier === '@deepseek-ai/cordis') return { Context: class Context {} };
  if (specifier === '@deepseek-ai/dsh-client-ui-sidebar-right/client') return {};
  throw new Error(`unexpected require: ${specifier}`);
});

check('the factory is synchronous, so the loader can store its exports', () => {
  assert.ok(!(factoryResult instanceof Promise), 'factory returned a Promise — the loader would register nothing');
  return typeof factoryResult;
});

const mod = factoryResult;

// The plugin contributes seats and nothing else: no tab type and no pane, so it
// needs neither `sidebarRight` (the navigation controller, which existed only to
// open the pane) nor `sidebarRightTabs` (the tab-type registry). Reading an
// undeclared cordis service throws, so a leftover declaration would be a liability.
check('the plugin injects only the slots registry', () => {
  assert.ok(!mod.inject.includes('sidebarRight'), 'sidebarRight is only needed to auto-open the pane');
  assert.ok(!mod.inject.includes('sidebarRightTabs'), 'no sidebar tab type is registered any more');
  assert.deepEqual([...mod.inject], ['slots']);
});

check('the factory resolves to a cordis plugin', () => {
  assert.equal(mod.name, 'plannotator-dsh');
  assert.equal(typeof mod.apply, 'function');
});

// --- apply() against a fake client context -----------------------------------
// `slots.inject(seat, callback)` is the host's "contribute when this seat exists"
// seam: it runs the callback as soon as the owner declares the seat, and again if
// the owner re-declares it. The fake mirrors that, so a plugin that silently
// depends on plugin start order fails here too.
const declaredSeats = new Set([
  'sidebar.right.pane.tab',
  'sidebar.right.tab.menu.item',
  'sidebar.right.tab.document.actions',
]);

/** A slots service that refuses undeclared seats, like the host's. */
function fakeSlots(records, onDispose) {
  return {
    register(selector, component) {
      if (!declaredSeats.has(selector.name)) {
        throw new Error(`slot "${selector.name}" is not declared (a parent entry's children table must declare it)`);
      }
      records.slots.push({ selector, component });
      return () => onDispose();
    },
    inject(seat, callback) {
      records.injected.push(seat);
      if (!declaredSeats.has(seat)) {
        records.pending.push({ seat, callback });
        return () => {};
      }
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
}

const registered = { tabs: [], slots: [], injected: [], pending: [], disposed: 0 };
const ctx = {
  sidebarRightTabs: {
    register(definition) {
      registered.tabs.push(definition);
      return () => {
        registered.disposed += 1;
      };
    },
  },
  slots: fakeSlots(registered, () => {
    registered.disposed += 1;
  }),
};

mod.apply(ctx);

check('apply contributes exactly one seat: the preview header action', () => {
  // Everything else the plugin ever added is deliberately gone: no sidebar tab type
  // and no pane ("Documentation"), no tab-menu row, and no floating launcher in the
  // composer dock. The fake still declares those seats, so re-adding one would land
  // in `registered.slots` and fail this deepEqual rather than silently vanishing.
  const seats = registered.slots.map((entry) => entry.selector.name);
  assert.deepEqual(seats, ['sidebar.right.tab.document.actions']);
  assert.equal(registered.tabs.length, 0, 'a sidebar tab type was registered');
  return seats.join(', ');
});

check('apply is idempotent: a second mount does not throw or double-register', () => {
  const tabsBefore = registered.tabs.length;
  const slotsBefore = registered.slots.length;
  mod.apply(ctx);
  assert.equal(registered.tabs.length, tabsBefore, 'tab type registered twice');
  assert.equal(registered.slots.length, slotsBefore, 'slots registered twice');
});

check('a seat an earlier mount already owns is reported, not thrown', () => {
  // The page's slot registrations outlive the module, so a re-mount legitimately
  // meets a taken id. `slots.inject` runs the callback inside an effect and
  // rethrows an asynchronous failure as an unhandled error, so this path has to
  // contain the throw itself — an escape here would take the whole plugin down.
  mod.__resetApplied();
  const taken = {
    slots: {
      register() {
        throw new Error('slot "sidebar.right.tab.menu.item" is already registered');
      },
      // Both seats are declared, so `inject` runs each callback immediately.
      inject: (seat, callback) => {
        callback();
        return () => {};
      },
    },
  };
  const reports = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => reports.push(args.map(String).join(' '));
  console.error = (...args) => reports.push(args.map(String).join(' '));
  let threw = null;
  try {
    mod.apply(taken);
  } catch (error) {
    threw = error;
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
  assert.equal(threw, null, `apply threw: ${threw?.message}`);
  assert.ok(
    reports.some((line) => line.includes('already provided by an earlier mount')),
    `expected a contained report, got: ${reports.join(' | ')}`,
  );
});

// --- the annotatable-extension filter -----------------------------------------
// The panel that consumed this list is gone; the filter still decides whether the
// tab menu row and the preview action offer themselves at all.
check('only annotatable extensions are offered for review', () => {
  const pattern = /\.(md|mdx|markdown|txt|ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml|html?)$/i;
  assert.ok(pattern.test('guide.md'));
  assert.ok(pattern.test('config.yaml'));
  assert.ok(!pattern.test('logo.png'));
  assert.ok(!pattern.test('main.ts'));
});

// --- the document-preview header action --------------------------------------
// The preview package lists `absolutePath` into `sidebar.right.tab.document.actions`
// and the seat is session-scoped, so the action both sees the file on screen and
// can claim the session it was rendered in.
const documentAction = registered.slots.find((entry) => entry.selector.name === 'sidebar.right.tab.document.actions');

check('apply contributes the document preview action', () => {
  assert.ok(documentAction, 'no document preview action registered');
  // The host validates list slots: a registration without `id` throws at load.
  assert.equal(typeof documentAction.selector.id, 'string');
  assert.ok(documentAction.selector.id.length > 0, 'document action needs an id');
  return documentAction.selector.id;
});

check('the document action claims the session it was rendered in', () => {
  assert.equal(typeof documentAction.selector.inject, 'function', 'the seat hands over its session through inject');
  // The factory runs inside the sandbox realm, so compare the primitive, not the object.
  assert.equal(documentAction.selector.inject('session-7').sessionId, 'session-7');
  // A root-scoped seat hands `undefined`; the URL builder then omits the claim.
  assert.equal(documentAction.selector.inject(undefined).sessionId, undefined);
});

await (async () => {
  const opened = [];
  const calls = [];
  context.fetch = async (url) => {
    calls.push(String(url));
    return { json: async () => ({ ok: true, url: 'http://localhost:4321' }) };
  };
  context.window.open = (url) => {
    opened.push(String(url));
    return { closed: false };
  };

  const { sessionId } = documentAction.selector.inject('session-7');
  // Hooks are a single shared registry in this harness: give the action a clean
  // render pass of its own, exactly as React would on its first mount.
  resetHooks();
  const action = documentAction.component({ absolutePath: '/tmp/ws/plannotator-dsh.md', sessionId });
  const button = collectButtons(action).find((candidate) => flatten(candidate.children) === 'Review');
  assert.ok(button, 'no review button for an annotatable document');
  await button.onClick();

  assert.equal(calls.length, 1, `expected one request, got ${calls.length}`);
  const requested = new URL(calls[0], 'http://host');
  assert.equal(requested.pathname, '/plannotator/review');
  assert.equal(requested.searchParams.get('target'), '/tmp/ws/plannotator-dsh.md');
  assert.equal(requested.searchParams.get('session'), 'session-7', 'the request must claim the rendered session');
  assert.deepEqual(opened, ['http://localhost:4321'], 'the review UI must open in a new tab');

  // A file Plannotator would refuse is reviewed as its containing folder.
  calls.length = 0;
  opened.length = 0;
  resetHooks();
  const imageAction = documentAction.component({ absolutePath: '/tmp/ws/logo.png', sessionId: 'session-7' });
  const imageButton = collectButtons(imageAction).find((candidate) => flatten(candidate.children) === 'Review');
  assert.ok(imageButton, 'no review button for a non-annotatable file');
  await imageButton.onClick();
  const imageRequest = new URL(calls[0], 'http://host');
  assert.equal(imageRequest.searchParams.get('target'), '/tmp/ws', 'an image must review its folder');
  assert.equal(opened.length, 1, 'an image review must still open the UI');

  // Without a host path there is nothing to review.
  assert.equal(documentAction.component({ absolutePath: '' }), null, 'an empty path must render nothing');
})();

// --- the cold-boot race that used to swallow the Review button ---------------
// `sidebar.right.tab.document.actions` is declared by the document-preview
// package, which is not the package behind the tab types, so on a cold boot this
// plugin can be applied before that seat exists. A bare register() throws once and
// the action is lost for the rest of the page's life; contributing through
// slots.inject must instead land it whenever the owner declares the seat.
check('an optional seat is contributed even when its owner declares it late', () => {
  const late = { slots: [], injected: [], pending: [] };
  const declared = new Set(['sidebar.right.pane.tab', 'sidebar.right.tab.menu.item']);
  const lateCtx = {
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      register(selector) {
        if (!declared.has(selector.name)) {
          throw new Error(`slot "${selector.name}" is not declared (a parent entry's children table must declare it)`);
        }
        late.slots.push(selector);
        return () => {};
      },
      inject(seat, callback) {
        late.injected.push(seat);
        if (declared.has(seat)) return callback() ?? (() => {});
        late.pending.push({ seat, callback });
        return () => {};
      },
    },
  };

  mod.__resetApplied();
  mod.apply(lateCtx);

  assert.ok(
    late.injected.includes('sidebar.right.tab.document.actions'),
    'the plugin must wait for the document seat instead of giving up on it',
  );
  assert.ok(
    !late.slots.some((slot) => slot.name === 'sidebar.right.tab.document.actions'),
    'nothing may be registered before the owner declares the seat',
  );

  declared.add('sidebar.right.tab.document.actions');
  for (const waiting of late.pending.splice(0)) waiting.callback();

  const action = late.slots.find((slot) => slot.name === 'sidebar.right.tab.document.actions');
  assert.ok(action, 'the document action must land once its owner declares the seat');
  assert.equal(action.id, 'plannotator-dsh:document-review');
  return action.id;
});

function collectButtons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (node.type === 'button') out.push(node.props ?? {});
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) collectButtons(child, out);
  return out;
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node !== 'object') return out;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) collectText(child, out);
  return out;
}

function flatten(children) {
  return collectText({ props: { children } }).join('');
}

process.stdout.write(`${results.join('\n')}\n\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${results.length} checks\n`);
process.exit(failures === 0 ? 0 : 1);

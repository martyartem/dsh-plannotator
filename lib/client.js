// plannotator-dsh — browser half.
//
// Hand-written in the module-loader format the host serves
// (`window.__ModuleLoader__.load`), so the plugin needs no bundler: require()
// resolves the shared React instance, and the returned plugin contributes exactly
// one seat: the Review action in the document preview's header.
//
// The factory MUST stay synchronous: the loader stores its return value as the
// plugin exports, so returning a Promise registers nothing and the page never
// appears.
//
// Registration failures are contained: if a client API differs from what this
// file expects, it logs and leaves the rest of the UI untouched.

window.__ModuleLoader__.load({
  id: 'plannotator-dsh',
  factory: (require) => {
    // Only `react` is required, and only from the platform seed table, so the
    // boot graph needs no `dsh.client.external` declaration.
    const { createElement: h, useState } = require('react');

    const loadState = { applied: false };

    /** Extensions Plannotator's `annotate` accepts. */
    const ANNOTATABLE = /\.(md|mdx|markdown|txt|ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml|html?)$/i;

    /**
     * Build a review route URL, claiming the session this UI was rendered in.
     *
     * DSH hands a session-scoped slot its `sessionId` through the registration's
     * `inject` factory. Stamping it onto the route is what keeps the annotations
     * in the chat the human pressed the button in: without it the host has to
     * guess, and it guesses whichever session happens to be running.
     */
    function reviewUrl({ target, sessionId }) {
      const params = new URLSearchParams({ target });
      if (typeof sessionId === 'string' && sessionId !== '') params.set('session', sessionId);
      return `/plannotator/review?${params.toString()}`;
    }

    function parentPath(absolutePath) {
      const cut = absolutePath.lastIndexOf('/');
      return cut > 0 ? absolutePath.slice(0, cut) : absolutePath;
    }

    /** Forward a client-side note to the host log, so failures are visible there too. */
    function report(level, message) {
      try {
        if (level === 'error') console.error('[plannotator-dsh]', message);
        else console.info('[plannotator-dsh]', message);
      } catch {
        // console is best effort
      }
      try {
        fetch('/plannotator/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level, message: String(message) }),
        }).catch(() => {});
      } catch {
        // reporting must never break the plugin
      }
    }

    const styles = {
      button: {
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '4px 8px',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '18px',
      },
      muted: { opacity: 0.7, fontSize: '12px' },
    };

    /**
     * The preview header's review action.
     *
     * The document-preview tab hands its occupants the absolute path of the file
     * on screen (`sidebar.right.tab.document.actions`). Annotatable documents go
     * to Plannotator as themselves; anything else (PDF, image, Office, an exotic
     * suffix) is opened as its containing folder, which Plannotator does accept —
     * so the button is never a dead end.
     */
    function DocumentReviewAction(props) {
      // Hooks first: the early return below must not change their call order.
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);
      const [fallbackUrl, setFallbackUrl] = useState(null);
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : '';
      const sessionId = props?.sessionId ?? null;

      if (absolutePath === '') return null;
      const annotatable = ANNOTATABLE.test(absolutePath);
      const target = annotatable ? absolutePath : parentPath(absolutePath);

      async function review() {
        setBusy(true);
        setFailure(null);
        setFallbackUrl(null);
        try {
          const response = await fetch(reviewUrl({ target, sessionId }));
          const payload = await response.json();
          if (!payload.ok) {
            setFailure(payload.error ?? 'review failed');
            return;
          }
          // The tab was opened by a click, so the popup is allowed. If a blocker
          // still swallows it, keep the URL on screen as a link.
          const opened = window.open(payload.url, '_blank', 'noopener');
          if (!opened) setFallbackUrl(payload.url);
        } catch (error) {
          setFailure(String(error?.message ?? error));
        } finally {
          setBusy(false);
        }
      }

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        h(
          'button',
          {
            type: 'button',
            style: { ...styles.button, borderColor: 'transparent', background: '#4d6bfe', color: '#fff', opacity: busy ? 0.6 : 1 },
            disabled: busy,
            title: annotatable ? `Review ${absolutePath} in Plannotator` : `Review the folder of ${absolutePath} in Plannotator`,
            onClick: review,
          },
          busy ? 'Starting…' : 'Review',
        ),
        fallbackUrl === null
          ? null
          : h('a', { href: fallbackUrl, target: '_blank', rel: 'noreferrer', style: { ...styles.muted, textDecoration: 'underline' } }, fallbackUrl),
        failure === null ? null : h('span', { style: { ...styles.muted, color: '#f2555a' }, title: failure }, 'review failed'),
      );
    }

    return {
      name: 'plannotator-dsh',
      // Only the slots registry is injected. The plugin contributes a single
      // optional seat and nothing else: it registers no sidebar tab type, opens no
      // pane and adds no tab-menu row, so `sidebarRight` (the navigation
      // controller) and `sidebarRightTabs` (the tab-type registry) are both
      // unnecessary. Reading a cordis service that is not declared here throws
      // ("cannot get property X without inject"), so an unused declaration would be
      // a liability rather than a convenience.
      inject: ['slots'],
      /** Test seam: clears the one-shot registration guard. */
      __resetApplied() {
        loadState.applied = false;
      },
      apply(ctx) {
        // The host may mount the client plugin more than once per page (a reload or
        // an HMR re-mount does), so a second mount must not contribute the seats
        // twice: the host rejects a duplicate id and the plugin would lose the page.
        if (loadState.applied) {
          report('info', 'apply: already registered in this page; skipping');
          return;
        }
        loadState.applied = true;
        report('info', `apply: slots=${ctx.slots === undefined ? 'no' : 'yes'}`);
        /**
         * Contribute one optional seat without depending on plugin start order.
         *
         * `ctx.slots.inject(seat, ...)` runs the registration once that seat's
         * owner declares it — at once when it is already declared, and again if the
         * owner re-declares it — and it rides this plugin's own fiber, so an unload
         * (or an HMR re-mount) cancels a pending wait and disposes an active
         * contribution. A bare `ctx.slots.register` only works when this plugin
         * happens to be applied *after* the owning client package, which is a
         * startup race rather than an ordering guarantee. Losing that race costs the
         * action for the rest of the page's life: the seat reports "is not declared
         * (a parent entry's children table must declare it)" and nothing retries it.
         *
         * The wrapper keeps failures contained, because `inject` rethrows an
         * asynchronous callback failure through a microtask — an uncaught throw
         * would surface as an unhandled error rather than a log line — and a second
         * mount legitimately meets an id that an earlier mount already took.
         *
         * @param seat - declared SlotMap key to wait for.
         * @param label - human name for the log.
         * @param register - creates one disposer once the seat exists.
         */
        const optionalSeat = (seat, label, register) => {
          try {
            ctx.slots.inject(seat, () => {
              try {
                const dispose = register();
                report('info', `${label} registered`);
                return dispose;
              } catch (error) {
                report('info', `${label} already provided by an earlier mount: ${String(error?.message ?? error)}`);
                return undefined;
              }
            });
          } catch (error) {
            report('error', `${label} unavailable: ${String(error?.message ?? error)}`);
          }
        };

        // The document-preview header action: the seat is owned by the preview
        // package and lists `absolutePath`, so the button reviews exactly the file
        // the pane is showing. That package is not the one behind the sidebar tab
        // types, so on a cold boot this seat appears after this plugin is applied —
        // which is precisely why it must go through `inject`.
        optionalSeat('sidebar.right.tab.document.actions', 'document preview action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'plannotator-dsh:document-review',
              order: 400,
              inject: (sessionId) => ({ sessionId }),
            },
            DocumentReviewAction,
          ),
        );
      },
    };
  },
});

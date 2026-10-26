/*!
 * dsh-chat-link-actions — client half.
 *
 * Right-click menu for file links in the transcript, drawn in the app's own
 * style (theme tokens, radius, elevation, blur) instead of the WebView's native
 * menu. Two actions:
 *
 *   引用到对话               insert `@path` into the composer as one undoable edit
 *   在访达/资源管理器中查看    reveal the file in the OS file manager (服务端接口)
 *
 * Wiring:
 * - `inputActions` is a standard prop of session-scoped slots
 *   (`ctx.uiSession.provide({ props: ["inputActions"] })` in ui-conversation).
 *   A zero-size occupant of `conversation.input.overlay` captures it per
 *   session; the menu uses `captureInsertion()` + `insertText(text, span)`,
 *   which only lands while the captured `draftRev` is still current.
 * - Revealing needs process access, so it runs in the 服务端半
 *   (`POST /chat-link-actions`).
 *
 * Bundle format: the official client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }).
 */
window.__ModuleLoader__.load({
  id: "dsh-chat-link-actions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");

    /* ── composer draft handles ─────────────────────────────────────────── */

    /** SessionId -> inputActions for that session's composer. */
    var drafts = new Map();
    /** Session whose composer rendered most recently. */
    var activeSession = null;

    function readInputActions(props) {
      if (props === null || typeof props !== "object") return null;
      var candidates = [props.inputActions, props.actions, props.input && props.input.actions];
      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        if (candidate !== null && typeof candidate === "object" && typeof candidate.insertText === "function") {
          return candidate;
        }
      }
      return null;
    }

    /** Invisible occupant: remembers the composer handle of the session it rendered for. */
    function DraftCapture(props) {
      var actions = readInputActions(props);
      var sessionId = props.sessionId;
      if (actions !== null) {
        if (sessionId !== undefined) drafts.set(sessionId, actions);
        activeSession = sessionId === undefined ? activeSession : sessionId;
      }
      return null;
    }

    function draftCandidates() {
      var ordered = [];
      if (activeSession !== null && drafts.has(activeSession)) ordered.push(drafts.get(activeSession));
      drafts.forEach(function (actions) {
        if (ordered.indexOf(actions) === -1) ordered.push(actions);
      });
      return ordered;
    }

    /** `@path`; a path containing whitespace uses the quoted mention form. */
    function referenceText(path) {
      return /[\s"]/.test(path) ? '@"' + path.replace(/"/g, '\\"') + '"' : "@" + path;
    }

    /** Insert the reference into a live composer. Returns true on success. */
    function quoteIntoComposer(path) {
      var candidates = draftCandidates();
      for (var i = 0; i < candidates.length; i += 1) {
        var actions = candidates[i];
        try {
          if (typeof actions.captureInsertion !== "function") continue;
          var span = actions.captureInsertion();
          if (span === null || span === undefined) continue;
          if (actions.insertText(referenceText(path) + " ", span) === true) return true;
        } catch (error) {
          /* try the next session's composer */
        }
      }
      return false;
    }

    /* ── resolving a file path out of the clicked node ──────────────────── */

    /** Trim a candidate down to the bare file path a link carries. */
    function normalizeCandidate(value) {
      if (typeof value !== "string") return null;
      var candidate = value.trim();
      if (candidate === "") return null;
      if (candidate.charAt(0) === "@") candidate = candidate.slice(1).trim();
      if (candidate.length > 1 && /^["']/.test(candidate) && /["']$/.test(candidate)) {
        candidate = candidate.slice(1, -1);
      }
      candidate = candidate.replace(/[.,;:!?，。；：！？]+$/u, "");
      return looksAbsolute(candidate) ? candidate : null;
    }

    function looksAbsolute(value) {
      return typeof value === "string" && (value.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(value));
    }

    /** Highest-confidence marker: the file route an inline link or image points at. */
    function decodePathFromHref(href) {
      if (typeof href !== "string" || href === "") return null;
      try {
        var url = new URL(href, document.baseURI);
        var fromQuery = normalizeCandidate(url.searchParams.get("path"));
        if (fromQuery !== null) return fromQuery;
        if (url.protocol === "file:") return normalizeCandidate(decodeURIComponent(url.pathname));
        if (url.origin === location.origin && looksAbsolute(url.pathname) && /\.[A-Za-z0-9]{1,6}$/.test(url.pathname)) {
          return normalizeCandidate(decodeURIComponent(url.pathname));
        }
      } catch (error) {
        /* not a URL shape we handle */
      }
      return null;
    }

    /**
     * Walk up from the clicked node looking for a link that names a file: href
     * first, then an absolute `data-*` value, then the reference chip title.
     */
    function pathFromNode(start) {
      for (var node = start; node !== null && node !== undefined && node !== document.body; node = node.parentElement) {
        if (node.nodeType !== 1) continue;
        var fromHref = decodePathFromHref(node.getAttribute("href"));
        if (fromHref !== null) return fromHref;
        var dataset = node.dataset || {};
        var keys = Object.keys(dataset);
        for (var k = 0; k < keys.length; k += 1) {
          var fromData = normalizeCandidate(dataset[keys[k]]);
          if (fromData !== null && /\.[A-Za-z0-9]{1,6}$/.test(fromData)) return fromData;
        }
        var fromTitle = normalizeCandidate(node.getAttribute("title"));
        if (fromTitle !== null) return fromTitle;
      }
      return null;
    }

    /* ── wording ────────────────────────────────────────────────────────── */

    function isMac() {
      return /Mac/i.test(navigator.platform || navigator.userAgent || "");
    }

    /* ── menu styling: project tokens only, no new palette ──────────────── */

    var STYLE_ID = "dsh-chat-link-actions-style";
    var CSS = [
      ".dcla-menu{position:fixed;z-index:1100;box-sizing:border-box;padding:6px;min-width:200px;",
      "max-width:min(320px,calc(100vw - 24px));background:var(--dsw-specific-menu,rgba(30,32,38,.96));",
      "backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "border:1px solid var(--dsw-elevation-stroke-color,rgba(255,255,255,.08));",
      "border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.4));",
      "font-family:var(--dsw-font-family,system-ui),-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;",
      "font-size:var(--dsw-font-xs-13,13px);line-height:20px;",
      "color:var(--dsw-alias-label-primary,#f2f3f5);user-select:none;-webkit-user-select:none;}",
      ".dcla-path{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary,rgba(242,243,245,.45));",
      "font-size:var(--dsw-font-xxs-12,12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}",
      ".dcla-sep{height:1px;margin:2px 6px 6px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));}",
      ".dcla-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;",
      "border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;",
      "text-align:left;cursor:default;white-space:nowrap;overflow:hidden;}",
      ".dcla-item[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));}",
      ".dcla-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4c8dff);outline-offset:-1px;}",
      ".dcla-glyph{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;",
      "color:var(--dsw-alias-label-secondary,rgba(242,243,245,.65));}",
      ".dcla-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}",
      ".dcla-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1100;",
      "padding:6px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-elevation-panel,rgba(30,32,38,.96));",
      "border:1px solid var(--dsw-elevation-stroke-color,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f3f5);",
      "font:inherit;font-size:var(--dsw-font-xs-13,13px);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.3));}",
      "@media (prefers-reduced-motion:no-preference){.dcla-menu{animation:dcla-in 90ms ease-out;}}",
      "@keyframes dcla-in{from{opacity:0;transform:translateY(-2px);}to{opacity:1;transform:none;}}"
    ].join("");

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ── icons: 16px outline, currentColor ──────────────────────────────── */

    var ICONS = {
      quote: ["M2.5 4.5h11M2.5 8h7M2.5 11.5h9"],
      reveal: ["M2 5.7A1.6 1.6 0 0 1 3.6 4.1h2.2l1.2 1.5h4.6A1.6 1.6 0 0 1 13.2 7.2v4.6A1.6 1.6 0 0 1 11.6 13.4h-8A1.6 1.6 0 0 1 2 11.8V5.7Z"],
      copy: ["M5.6 5.6h6.8v6.8H5.6z", "M10.4 5.6V4.2A1.6 1.6 0 0 0 8.8 2.6H4.2A1.6 1.6 0 0 0 2.6 4.2v4.6A1.6 1.6 0 0 0 4.2 10.4h1.4"]
    };

    function icon(name) {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "none");
      svg.setAttribute("aria-hidden", "true");
      var paths = ICONS[name];
      for (var i = 0; i < paths.length; i += 1) {
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", paths[i]);
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.3");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      }
      return svg;
    }

    /* ── menu ───────────────────────────────────────────────────────────── */

    var open = null;

    function closeMenu(restoreFocus) {
      if (open === null) return;
      var state = open;
      open = null;
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("contextmenu", onContextDuringMenu, true);
      window.removeEventListener("resize", onViewportChange, true);
      window.removeEventListener("scroll", onViewportChange, true);
      if (state.layer.parentNode !== null) state.layer.parentNode.removeChild(state.layer);
      if (restoreFocus === true && state.restoreFocus !== null && document.contains(state.restoreFocus)) {
        state.restoreFocus.focus({ preventScroll: true });
      }
    }

    function onPointerDown(event) {
      if (open === null || open.layer.contains(event.target)) return;
      closeMenu(false);
    }

    function onContextDuringMenu(event) {
      if (open !== null && open.layer.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function onKeyDown(event) {
      if (open === null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        var count = open.items.length;
        var step = event.key === "ArrowDown" ? 1 : -1;
        open.index = ((open.index + step) % count + count) % count;
        paintActive();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        var item = open.items[open.index];
        if (item === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu(false);
        item.run();
      }
    }

    function onViewportChange() {
      if (open === null) return;
      placeMenu(open.layer, open.x, open.y);
    }

    /** Place the panel at the pointer, flipped inward at the viewport edges. */
    function placeMenu(layer, x, y) {
      var margin = 8;
      var rect = layer.getBoundingClientRect();
      var left = x;
      var top = y;
      if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, x - rect.width);
      if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height);
      layer.style.left = Math.round(left) + "px";
      layer.style.top = Math.round(top) + "px";
    }

    function paintActive() {
      if (open === null) return;
      for (var i = 0; i < open.buttons.length; i += 1) {
        open.buttons[i].setAttribute("data-active", i === open.index ? "true" : "false");
      }
    }

    function buildMenu(path, items) {
      var panel = document.createElement("div");
      panel.className = "dcla-menu";
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", "文件操作");

      var caption = document.createElement("div");
      caption.className = "dcla-path";
      caption.title = path;
      caption.textContent = path;
      panel.appendChild(caption);

      var separator = document.createElement("div");
      separator.className = "dcla-sep";
      panel.appendChild(separator);

      var buttons = [];
      items.forEach(function (item, position) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "dcla-item";
        button.setAttribute("role", "menuitem");
        button.setAttribute("data-active", position === 0 ? "true" : "false");

        var glyph = document.createElement("span");
        glyph.className = "dcla-glyph";
        glyph.appendChild(icon(item.icon));
        button.appendChild(glyph);

        var label = document.createElement("span");
        label.className = "dcla-label";
        label.textContent = item.label;
        button.appendChild(label);

        button.addEventListener("mouseenter", function () {
          if (open === null) return;
          open.index = position;
          paintActive();
        });
        button.addEventListener("click", function () {
          closeMenu(false);
          item.run();
        });
        panel.appendChild(button);
        buttons.push(button);
      });

      return { panel: panel, buttons: buttons };
    }

    function openMenu(path, x, y) {
      closeMenu(false);
      ensureStyle();

      var items = [
        { id: "quote", label: "引用到对话", icon: "quote", run: function () {
          if (!quoteIntoComposer(path)) {
            navigator.clipboard.writeText(referenceText(path)).then(function () {
              toast("已复制引用");
            }, function () {});
          }
        } },
        { id: "reveal", label: isMac() ? "在访达中查看" : "在文件管理器中查看", icon: "reveal", run: function () {
          reveal(path);
        } },
        { id: "copy", label: "复制路径", icon: "copy", run: function () {
          navigator.clipboard.writeText(path).then(function () {
            toast("已复制路径");
          }, function () {});
        } }
      ];

      var layer = document.createElement("div");
      layer.className = "dcla-layer";
      var built = buildMenu(path, items);
      layer.appendChild(built.panel);
      document.body.appendChild(layer);

      open = {
        layer: layer,
        buttons: built.buttons,
        items: items,
        index: 0,
        path: path,
        x: x,
        y: y,
        restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null
      };
      placeMenu(layer, x, y);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("contextmenu", onContextDuringMenu, true);
      window.addEventListener("resize", onViewportChange, true);
      window.addEventListener("scroll", onViewportChange, true);
    }

    /* ── small toast for the actions that do not change the screen ──────── */

    var toastTimer = null;
    var toastNode = null;

    function toast(text) {
      ensureStyle();
      if (toastNode !== null && toastNode.parentNode !== null) toastNode.parentNode.removeChild(toastNode);
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastNode = document.createElement("div");
      toastNode.className = "dcla-toast";
      toastNode.setAttribute("role", "status");
      toastNode.textContent = text;
      document.body.appendChild(toastNode);
      toastTimer = setTimeout(function () {
        if (toastNode !== null && toastNode.parentNode !== null) toastNode.parentNode.removeChild(toastNode);
        toastNode = null;
        toastTimer = null;
      }, 1400);
    }

    /** Ask the 服务端 to select the file in the OS file manager. */
    function reveal(path) {
      fetch("/chat-link-actions?action=reveal&path=" + encodeURIComponent(path), { method: "POST" }).catch(function () {
        toast("无法打开文件管理器");
      });
    }

    /* ── interception ───────────────────────────────────────────────────── */

    function onContextMenu(event) {
      if (!(event.target instanceof Element)) return;
      var target = event.target;
      var path = pathFromNode(target);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      openMenu(path, event.clientX, event.clientY);
    }

    /* ── plugin entry ───────────────────────────────────────────────────── */

    var inject = ["slots"];

    function apply(ctx) {
      ctx.effect(function () {
        document.addEventListener("contextmenu", onContextMenu, true);
        return function () {
          document.removeEventListener("contextmenu", onContextMenu, true);
          closeMenu(false);
        };
      });
      ctx.effect(function () {
        return ctx.slots.inject("conversation.input.overlay", function () {
          return ctx.slots.register({
            name: "conversation.input.overlay",
            id: "chat-link-actions",
            order: 900
          }, DraftCapture);
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});

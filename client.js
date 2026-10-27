/*!
 * dsh-chat-link-actions — client half.
 *
 * Right-click menu for file links in the transcript, drawn in the app's own
 * style (theme tokens, radius, elevation, blur) instead of the WebView's native
 * menu. Two actions:
 *
 *   引用到对话               insert `@path` into the composer as one undoable edit
 *   在文件管理器中查看    reveal the file in the OS file manager (服务端接口)
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
    /** Client root context, kept for the session-scoped chip event. */
    var rootContext = null;
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
      var seen = [];
      function add(sessionId) {
        if (sessionId === undefined || sessionId === null) return;
        var actions = drafts.get(sessionId);
        if (actions === undefined || seen.indexOf(actions) !== -1) return;
        seen.push(actions);
        ordered.push({ sessionId: sessionId, actions: actions });
      }
      add(activeSession);
      drafts.forEach(function (_actions, sessionId) {
        add(sessionId);
      });
      return ordered;
    }

    /** `@path`; a path containing whitespace uses the quoted mention form. */
    function referenceText(path) {
      return /[\s"]/.test(path) ? '@"' + path.replace(/"/g, '\\"') + '"' : "@" + path;
    }

    /** Directory links carry a trailing separator; files never do. */
    function looksLikeDirectory(path) {
      return path.charAt(path.length - 1) === "/" || path.charAt(path.length - 1) === "\\";
    }

    /** 问不到会话时只好按形状猜：末尾没有扩展名，多半是目录。 */
    function guessDirectory(path) {
      if (looksLikeDirectory(path)) return true;
      var trimmed = path.replace(/[\\/]+$/, "");
      var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      var name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
      if (name.charAt(0) === ".") return true;
      return !/\.[A-Za-z0-9]{1,8}$/.test(name);
    }

    /** Last path segment, the same label the composer's own reference chips show. */
    function displayLabel(path, directory) {
      var trimmed = path.replace(/[\\/]+$/, "");
      var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      var name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
      if (name === "") name = trimmed;
      return directory ? name + "/" : name;
    }

    /**
     * Insert the reference as the composer's own reference chip (the `(</> name)`
     * node), which the shell only builds for its file-drop and `@`-picker paths.
     * The shell owns that insertion behind a session-scoped event; when the event
     * is not reachable the caller falls back to plain `insertText`.
     */
    function insertChip(sessionId, actions, path, knownDirectory) {
      if (rootContext === null || typeof rootContext.sessions !== "object" || rootContext.sessions === null) return false;
      var binding = null;
      try {
        binding = rootContext.sessions.binding(sessionId);
      } catch (error) {
        return false;
      }
      var sessionContext = binding === null || binding === undefined ? null : binding.ctx;
      if (sessionContext === null || sessionContext === undefined || typeof sessionContext.emit !== "function") return false;
      var before = actions.captureInsertion();
      if (before === null || before === undefined) return false;
      var directory = typeof knownDirectory === "boolean" ? knownDirectory : looksLikeDirectory(path);
      var mention = referenceText(path);
      var reference = {};
      reference.source = "reference";
      reference.ref = mention;
      reference.label = displayLabel(path, directory);
      reference.appearance = directory ? "folder" : "file";
      reference.clipboardText = mention;
      var request = {};
      request.reference = reference;
      request.span = before;
      var delivered = false;
      try {
        delivered = sessionContext.emit("slash/input-insert-reference", request);
      } catch (error) {
        return false;
      }
      if (delivered === false) return false;
      var after = actions.captureInsertion();
      if (after === null || after === undefined) return true;
      return after.start !== before.start || after.end !== before.end;
    }

    /** Insert the reference into a live composer. Returns true on success. */
    function quoteIntoComposer(path, knownDirectory) {
      var candidates = draftCandidates();
      for (var i = 0; i < candidates.length; i += 1) {
        var sessionId = candidates[i].sessionId;
        var actions = candidates[i].actions;
        try {
          if (typeof actions.captureInsertion !== "function") continue;
          if (insertChip(sessionId, actions, path, knownDirectory)) return true;
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
    /** Drop sentence punctuation that followed the path in prose. */
    function trimProsePunctuation(value) {
      var text = value.replace(/[.,;:!?]+$/u, "");
      while (text.length > 1 && (text.charAt(text.length - 1) === ")" || text.charAt(text.length - 1) === "]")) {
        var open = text.charAt(text.length - 1) === ")" ? "(" : "[";
        var close = text.charAt(text.length - 1);
        var opens = text.split(open).length - 1;
        var closes = text.split(close).length - 1;
        if (closes <= opens) break;
        text = text.slice(0, -1);
      }
      return text;
    }

    function normalizeCandidate(value) {
      if (typeof value !== "string") return null;
      var candidate = value.trim();
      if (candidate === "") return null;
      if (candidate.charAt(0) === "@") candidate = candidate.slice(1).trim();
      if (candidate.length > 1 && /^["']/.test(candidate) && /["']$/.test(candidate)) {
        candidate = candidate.slice(1, -1);
      }
      if (/^["'<]/u.test(candidate)) candidate = candidate.slice(1);
      if (/>$/u.test(candidate)) candidate = candidate.slice(0, -1);
      candidate = candidate.replace(/[.,;:!?，。；：！？]+$/u, "");
      candidate = stripLineSuffix(candidate);
      if (/^file:\/\//i.test(candidate)) {
        candidate = candidate.replace(/^file:\/\/(?:localhost)?/i, "");
        candidate = decodePercent(candidate);
        if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
      }
      if (/^[A-Za-z]:(?![\\/])/u.test(candidate)) candidate = candidate.slice(0, 2) + "/" + candidate.slice(2);
      if (!/^(?:[A-Za-z]:[\\/]?|[\\/]{1,2})$/u.test(candidate)) candidate = candidate.replace(/[\\/]+$/u, "");
      candidate = trimProsePunctuation(candidate);
      return looksAbsolute(candidate) ? candidate : null;
    }

    function looksAbsolute(value) {
      if (typeof value !== "string" || value === "") return false;
      if (value.charAt(0) === "/") return true;
      if (/^[A-Za-z]:[\\/]/.test(value)) return true;
      return /^\\\\[^\\]+\\[^\\]+/.test(value);
    }

    /** 只在能安全解码时解开百分号转义。 */
    function decodePercent(value) {
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    }

    /** Highest-confidence marker: the file route an inline link or image points at. */
    function decodePathFromHref(href) {
      if (typeof href !== "string" || href === "") return null;
      try {
        var url = new URL(href, document.baseURI);
        var fromQuery = normalizeCandidate(url.searchParams.get("path"));
        if (fromQuery !== null) return fromQuery;
        for (var i = 0; i < ["file", "filepath", "abs", "target"].length; i += 1) {
          var fromNamed = normalizeCandidate(url.searchParams.get(["file", "filepath", "abs", "target"][i]));
          if (fromNamed !== null) return fromNamed;
        }
        if (url.protocol === "file:") return normalizeCandidate(decodeURIComponent(url.pathname));
        /* 尾斜杠说明指向目录，没有扩展名也接受。 */
        if (url.origin === location.origin && looksAbsolute(url.pathname) && (/\.[A-Za-z0-9]{1,6}$/.test(url.pathname) || /\/$/.test(url.pathname))) {
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
    var PATH_ATTRS = ["href", "src"];

    /** `data-*` values that may carry a path, in confidence order. */
    function datasetPath(node) {
      var dataset = node.dataset || {};
      var keys = Object.keys(dataset);
      for (var i = 0; i < keys.length; i += 1) {
        if (!/path|file|href|src|dir|folder|abs/i.test(keys[i])) continue;
        var candidate = normalizeCandidate(dataset[keys[i]]);
        if (candidate !== null) return candidate;
      }
      return null;
    }

    /** An absolute path written as plain text inside the clicked element. */
    var proseCandidate = false;

    var PATH_IN_TEXT = /(?:^|[\s"'“”「」()（）\[\]<>])(@?"?(?:\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~\/(?!\/))[^\s"'“”「」<>，。；：！？（）【】《》]*)/u;

    /** 路径结尾成立的样子：有扩展名，或以分隔符收尾。 */
    var PATH_TAIL = /(?:\.[A-Za-z0-9]{1,8}(?:#L\d+(?:-L?\d+)?(?::\d+)?)?[.,;:!?)\]]*|#L\d+(?:-L?\d+)?(?::\d+)?|[\\/])$/u;

    /** 一段词像不像同一路径的下一段：不以分隔符或盘符开头，也不带句子标点。 */
    function continuesPath(word) {
      if (word === "" || /^[\/"'\u201c\u201d\u300c\u300d<>]/u.test(word)) return false;
      if (/^[A-Za-z]:/u.test(word)) return false;
      return true;
    }

    /**
     * `C:\Users\apple\Desktop\a b.md` 这类带空格的路径，正则只吃到第一个空格。
     * 往后最多接三段，取「结尾仍然像一个路径」的最长一段。
     */
    /** 往后看两段，判断中文词后面是否跟着文件名。 */
    function nextWordsLookLikeFile(rest) {
      var probe = rest;
      for (var round = 0; round < 2; round += 1) {
        var space = /^[ \t]+/u.exec(probe);
        if (space === null) return false;
        var word = /^[^ \t"'“”「」<>，。；：！？、（）【】《》]+/u.exec(probe.slice(space[0].length));
        if (word === null) return false;
        if (/\.[A-Za-z0-9]{1,8}$/u.test(word[0])) return true;
        probe = probe.slice(space[0].length + word[0].length);
      }
      return false;
    }

    function joinPathWords(text, rest) {
      var best = text;
      var remaining = rest;
      for (var round = 0; round < 3; round += 1) {
        var space = /^[ \t]+/u.exec(remaining);
        if (space === null) break;
        var word = /^[^ \t"'“”「」<>，。；：！？、（）【】《》]+/u.exec(remaining.slice(space[0].length));
        if (word === null) break;
        remaining = remaining.slice(space[0].length + word[0].length);
        if (!continuesPath(word[0])) break;
        /* 中文句子在路径后继续说话时，不要把后面的词吞进路径；
           但后两段里出现扩展名，说明中文词其实是文件名的一部分。 */
        if (/^[\u3400-\u9fff]+$/u.test(word[0]) && !/\.[A-Za-z0-9]{1,8}$/u.test(word[0]) && !nextWordsLookLikeFile(remaining)) break;
        var joined = best + " " + word[0];
        if (PATH_TAIL.test(joined)) best = joined;
        else if (!PATH_TAIL.test(best)) {
          /* 还没成句：继续接，等扩展名出现 */
          best = joined;
        }
      }
      return best;
    }

    /** 正文纯文本里，取光标落点所在的那段路径。 */
    function pathFromCaret(x, y) {
      if (typeof document.caretRangeFromPoint !== "function") return null;
      var range = null;
      try {
        range = document.caretRangeFromPoint(x, y);
      } catch (error) {
        return null;
      }
      if (range === null || range.startContainer === null || range.startContainer.nodeType !== 3) return null;
      var node = range.startContainer;
      var data = node.data;
      var offset = Math.min(range.startOffset, data.length);
      var lead = 0;
      for (var back = 0, walker = node; back < 2; back += 1) {
        walker = walker.previousSibling;
        if (walker === null || walker.nodeType !== 3) break;
        lead += walker.data.length;
      }
      if (lead > 0) {
        var merged = "";
        for (var step = 0, cursor = node; step < 2; step += 1) {
          cursor = cursor.previousSibling;
          if (cursor === null || cursor.nodeType !== 3) break;
          merged = cursor.data + merged;
        }
        data = merged + data;
        offset += lead;
      }
      var bounds = [];
      var matcher = new RegExp(PATH_IN_TEXT.source, "gu");
      var hit = null;
      while ((hit = matcher.exec(data)) !== null) {
        var captured = hit[1] === undefined ? hit[0] : hit[1];
        var start = hit.index + hit[0].length - captured.length;
        var joined = joinPathWords(captured, data.slice(start + captured.length));
        bounds.push({ text: joined, start: start, end: start + joined.length });
        if (hit[0].length === 0) matcher.lastIndex += 1;
      }
      for (var i = 0; i < bounds.length; i += 1) {
        if (offset >= bounds[i].start && offset <= bounds[i].end) return normalizeCandidate(bounds[i].text);
      }
      return null;
    }

    /** 节点上的内部属性键前缀。 */
    var FIBER_KEY = /^__(?:reactFiber|reactInternalInstance)\$/;

    /** 可能带文件的属性名。 */
    var PROP_KEYS = ["destination", "path", "absolutePath", "filePath", "localPath", "assetPath", "sourcePath", "src", "href"];
    var PROP_CONTAINERS = ["file", "asset", "attachment", "source", "item"];

    /** Strip the line suffix a Markdown file link carries (`path#L12`). */
    function stripLineSuffix(value) {
      if (typeof value !== "string") return value;
      var trimmed = value.replace(/#L[0-9]+(?:C[0-9]+)?(?:-L?[0-9]+)?(?::[0-9]+)?$/u, "");
      /* Windows 风格的 match:line 后缀（a.md:12）也当行号剥掉。 */
      return trimmed.replace(/(\.[A-Za-z0-9]{1,8}):[0-9]+(?::[0-9]+)?(?:-[0-9]+)?$/u, "$1");
    }

    /** Read the path a component's props carry, if any. */
    function pathFromProps(props) {
      if (props === null || typeof props !== "object") return null;
      for (var c = 0; c < PROP_CONTAINERS.length; c += 1) {
        var box = props[PROP_CONTAINERS[c]];
        if (box === null || typeof box !== "object") continue;
        for (var k = 0; k < PROP_KEYS.length; k += 1) {
          var nested = normalizeCandidate(stripLineSuffix(box[PROP_KEYS[k]]));
          if (nested !== null) return nested;
        }
      }
      for (var i = 0; i < PROP_KEYS.length; i += 1) {
        var fromProp = normalizeCandidate(stripLineSuffix(props[PROP_KEYS[i]]));
        if (fromProp !== null) return fromProp;
      }
      return null;
    }

    /**
     * React file cards keep their path in the owning component's props, not in
     * the DOM: a Markdown image renders an icon and a file name only. Walk the
     * fiber chain up from the clicked node until a prop names a file.
     */
    function fiberOf(node) {
      for (var owner = node; owner !== null && owner !== undefined && owner !== document.body; owner = owner.parentElement) {
        if (owner.nodeType !== 1) continue;
        var keys = Object.keys(owner);
        for (var i = 0; i < keys.length; i += 1) {
          if (FIBER_KEY.test(keys[i])) return owner[keys[i]];
        }
      }
      return null;
    }

    function pathFromFiber(node) {
      var fiber = fiberOf(node);
      for (var depth = 0; fiber !== null && fiber !== undefined && depth < 24; depth += 1) {
        var found = pathFromProps(fiber.memoizedProps);
        if (found !== null) return found;
        fiber = fiber.return;
      }
      return null;
    }

    /** 组件自己知道这是个文件夹：appearance / isDirectory 之类的提示。 */
    function directoryHintFromProps(props) {
      if (props === null || typeof props !== "object") return undefined;
      var round = [props];
      var file = props.file;
      if (file !== null && typeof file === "object") round.push(file);
      var inner = props.reference;
      if (inner !== null && typeof inner === "object") round.push(inner);
      for (var i = 0; i < round.length; i += 1) {
        var item = round[i];
        if (item === null || typeof item !== "object") continue;
        if (item.appearance === "folder" || item.appearance === "directory") return true;
        if (item.appearance === "file") return false;
        if (item.isDirectory === true || item.directory === true) return true;
        if (item.isDirectory === false) return false;
      }
      return undefined;
    }

    function directoryHint(node) {
      for (var owner = node; owner !== null && owner !== undefined && owner !== document.body; owner = owner.parentElement) {
        if (owner.nodeType !== 1) continue;
        var attr = owner.getAttribute("data-appearance") || owner.getAttribute("data-type") || owner.getAttribute("data-kind");
        if (attr !== null) {
          var value = attr.toLowerCase();
          if (value === "folder" || value === "directory") return true;
          if (value === "file") return false;
        }
      }
      var fiber = fiberOf(node);
      for (var depth = 0; fiber !== null && fiber !== undefined && depth < 24; depth += 1) {
        var hint = directoryHintFromProps(fiber.memoizedProps);
        if (hint !== undefined) return hint;
        fiber = fiber.return;
      }
      return undefined;
    }

    /**
     * Walk up from the clicked node looking for a file link: href/src first, then
     * an absolute `data-*` value, then a title, then the element's own text. The
     * text pass covers paths the transcript renders as plain prose.
     */
    /** `srcset` 里第一条绝对路径（图片芯片常用多倍图）。 */
    function srcsetPath(node) {
      var value = node.getAttribute("srcset");
      if (value === null || value === undefined || value.indexOf("/") === -1) return null;
      var pieces = String(value).split(",");
      for (var i = 0; i < pieces.length; i += 1) {
        var first = pieces[i].replace(/\s+\d+(?:\.\d+)?[wx]\s*$/u, "").trim();
        var decoded = decodePathFromHref(first);
        if (decoded !== null) return decoded;
      }
      return null;
    }

    function pathFromNode(start, point) {
      for (var node = start; node !== null && node !== undefined && node !== document.body; node = node.parentElement) {
        if (node.nodeType !== 1) continue;
        for (var a = 0; a < PATH_ATTRS.length; a += 1) {
          var fromHref = decodePathFromHref(node.getAttribute(PATH_ATTRS[a]));
          if (fromHref !== null) return fromHref;
        }
        var fromSrcset = srcsetPath(node);
        if (fromSrcset !== null) return fromSrcset;
        var fromData = datasetPath(node);
        if (fromData !== null) return fromData;
        var fromTitle = normalizeCandidate(node.getAttribute("title"));
        if (fromTitle !== null) return fromTitle;
      }
      var fromFiber = pathFromFiber(start);
      if (fromFiber !== null) return fromFiber;
      if (point !== null && point !== undefined && point.allowProse !== false) {
        var fromCaret = pathFromCaret(point.x, point.y);
        if (fromCaret !== null) {
          proseCandidate = true;
          return fromCaret;
        }
      }
      return null;
    }

    /* ── wording ────────────────────────────────────────────────────────── */

    /* ── menu styling: project tokens only, no new palette ──────────────── */

    var STYLE_ID = "dsh-chat-link-actions-style";
    var CSS = [
      ".dcla-layer{position:fixed;inset:0;z-index:1100;pointer-events:none;}",
      ".dcla-menu{position:fixed;z-index:1100;pointer-events:auto;box-sizing:border-box;padding:6px;min-width:200px;",
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

    /** 界面语言跟着宿主走：宿主把当前语言写在 <html lang> 上。 */  // ui-copy-ignore
    var TEXT = {
      zh: {  // ui-copy-ignore
        menu: "文件操作",  // ui-copy-ignore
        quote: "引用到对话",  // ui-copy-ignore
        reveal: "在文件管理器中查看",  // ui-copy-ignore
        copy: "复制路径",  // ui-copy-ignore
        copiedPath: "已复制路径",  // ui-copy-ignore
        copiedQuote: "已复制引用",  // ui-copy-ignore
        missing: "目标文件不存在",  // ui-copy-ignore
        managerFailed: "无法打开文件管理器",
        clipboardFailed: "剪贴板不可用"  // ui-copy-ignore
      },
      en: {  // ui-copy-ignore
        menu: "File actions",  // ui-copy-ignore
        quote: "Quote in chat",  // ui-copy-ignore
        reveal: "Show in file manager",  // ui-copy-ignore
        copy: "Copy path",  // ui-copy-ignore
        copiedPath: "Path copied",  // ui-copy-ignore
        copiedQuote: "Reference copied",  // ui-copy-ignore
        missing: "File not found",  // ui-copy-ignore
        managerFailed: "Could not open the file manager",
        clipboardFailed: "Clipboard unavailable"  // ui-copy-ignore
      }
    };

    function strings() {
      var element = document.documentElement;
      var lang = element === null ? "" : element.getAttribute("lang");
      var tag = typeof lang === "string" && lang !== "" ? lang : (typeof navigator === "undefined" ? "" : navigator.language);
      return /^zh/i.test(String(tag === null || tag === undefined ? "" : tag)) ? TEXT.zh : TEXT.en;
    }

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
      var typing = editableField(event.target) === true || (open.restoreFocus !== null && editableField(open.restoreFocus) === true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (typing && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        /* 用户已经在打字，就当放弃了菜单，别抢键。 */
        closeMenu(false);
        return;
      }
      if (event.key === "Tab") {
        closeMenu(false);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        open.index = event.key === "Home" ? 0 : open.items.length - 1;
        paintActive();
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
      placeMenu(open.panel, open.x, open.y);
    }

    /** Place the panel at the pointer, flipped inward at the viewport edges. */
    function placeMenu(panel, x, y) {
      var margin = 8;
      var rect = panel.getBoundingClientRect();
      var left = x;
      var top = y;
      if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, x - rect.width);
      if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height);
      panel.style.left = Math.round(left) + "px";
      panel.style.top = Math.round(top) + "px";
    }

    function paintActive() {
      if (open === null) return;
      for (var i = 0; i < open.buttons.length; i += 1) {
        open.buttons[i].setAttribute("data-active", i === open.index ? "true" : "false");
      }
      var active = open.buttons[open.index];
      if (active !== undefined) open.panel.setAttribute("aria-activedescendant", active.id);
    }

    function buildMenu(path, items) {
      var panel = document.createElement("div");
      panel.className = "dcla-menu";
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", strings().menu);
      panel.setAttribute("aria-activedescendant", "dcla-item-0");

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
        button.id = "dcla-item-" + position;
        button.setAttribute("role", "menuitem");
        button.setAttribute("tabindex", "-1");
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
          report("menu-click " + item.id);
          closeMenu(false);
          try {
            item.run();
          } catch (error) {
            report("run-threw " + item.id + " " + String((error && error.message) || error));
            toast(strings().managerFailed);
          }
        });
        panel.appendChild(button);
        buttons.push(button);
      });

      return { panel: panel, buttons: buttons };
    }

    function openMenu(path, x, y, options) {
      closeMenu(false);
      ensureStyle();
      var settings = options === null || options === undefined ? {} : options;

      var items = [
        { id: "quote", label: strings().quote, icon: "quote", run: function () {
          probePath(path, function (kind) {
            var directory = kind === "directory" ? true : kind === "file" ? false : settings.directory;
            if (directory === undefined && kind !== "file" && kind !== "directory") directory = guessDirectory(path);
            var inserted = quoteIntoComposer(path, directory);
            if (inserted) return;
            navigator.clipboard.writeText(referenceText(path)).then(function () {
              toast(strings().copiedQuote);
            }, function () {
              toast(strings().clipboardFailed);
            });
          });
        } },
        { id: "reveal", label: strings().reveal, icon: "reveal", run: function () {
          reveal(path);
        } },
        { id: "copy", label: strings().copy, icon: "copy", run: function () {
          navigator.clipboard.writeText(path).then(function () {
            toast(strings().copiedPath);
          }, function () {
            toast(strings().clipboardFailed);
          });
        } }
      ];

      if (settings.inField === true) {
        items = items.filter(function (item) {
          return item.id !== "quote";
        });
      }

      var layer = document.createElement("div");
      layer.className = "dcla-layer";
      var built = buildMenu(path, items);
      layer.appendChild(built.panel);
      document.body.appendChild(layer);

      var state = {};
      state.layer = layer;
      state.panel = built.panel;
      state.buttons = built.buttons;
      state.items = items;
      state.index = 0;
      state.path = path;
      state.x = x;
      state.y = y;
      state.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      open = state;
      placeMenu(built.panel, x, y);
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

    /** 当前会话提供的应用服务；没有会话时返回空。 */
    function sessionRemote() {
      var context = sessionContext();
      var remote = context === null ? undefined : context.remote;
      if (remote !== undefined && remote !== null) return remote;
      var root = rootContext === null ? undefined : rootContext.remote;
      return root === undefined || root === null ? null : root;
    }

    /** 第一条可用会话的上下文，应用的会话服务挂在它上面。 */
    function sessionContext() {
      if (rootContext === null || typeof rootContext.sessions !== "object" || rootContext.sessions === null) return null;
      var candidates = draftCandidates();
      for (var i = 0; i < candidates.length; i += 1) {
        try {
          var binding = rootContext.sessions.binding(candidates[i].sessionId);
          var context = binding === null || binding === undefined ? null : binding.ctx;
          if (context !== null && context !== undefined) return context;
        } catch (error) {
          /* try the next session */
        }
      }
      return null;
    }

    /** 路径是否存在：先当文件问，再当目录问；多个会话依次问，问到一个就够。 */
    /** 某个会话自己的 workspaceFiles；拿不到时退回当前会话的那一份。 */
    function filesFor(sessionId, fallback) {
      try {
        var context = rootContext === null || typeof rootContext.sessions !== "object" || rootContext.sessions === null
          ? null
          : rootContext.sessions.binding(sessionId);
        var sessionContext = context === null || context === undefined ? null : context.ctx;
        var remote = sessionContext === null || sessionContext === undefined ? null : sessionContext.remote;
        var files = remote === null || remote === undefined ? null : remote.workspaceFiles;
        if (files !== null && files !== undefined && typeof files.stat === "function") return files;
      } catch (error) {
        /* fall through to the shared remote */
      }
      return fallback;
    }

    function probePath(path, done) {
      var remote = sessionRemote();
      var shared = remote === null ? null : remote.workspaceFiles;
      var candidates = draftCandidates();
      if (candidates.length === 0) {
        done("unknown");
        return;
      }
      var settled = false;
      var position = 0;
      var probeTimer = setTimeout(function () {
        finish("unknown");
      }, 700);
      function finish(kind) {
        if (settled) return;
        settled = true;
        clearTimeout(probeTimer);
        done(kind);
      }
      function next() {
        if (settled) return;
        if (position >= candidates.length) {
          finish("missing");
          return;
        }
        var sessionId = candidates[position].sessionId;
        position += 1;
        var files = filesFor(sessionId, shared);
        if (files === null || files === undefined || typeof files.stat !== "function") {
          next();
          return;
        }
        var moved = false;
        function move() {
          if (settled || moved) return;
          moved = true;
          next();
        }
        function askDirectory() {
          try {
            files.list(sessionId, path).then(function () {
              finish("directory");
            }, move);
          } catch (error) {
            move();
          }
        }
        try {
          files.stat(sessionId, path).then(function () {
            /* stat 不区分文件与目录：用列举确认，列得出来就是目录。 */
            files.list(sessionId, path).then(function () {
              finish("directory");
            }, function (error) {
              /* 只有后端明确说「不是目录」才算文件；别的失败当作问不到。 */
              var code = error === null || error === undefined ? "" : String(error.code === undefined ? "" : error.code);
              var message = error === null || error === undefined ? "" : String(error.message === undefined ? "" : error.message);
              if (/not-directory/i.test(code) || /not-directory|is a file/i.test(message)) finish("file");
              else finish("unknown");
            });
          }, askDirectory);
        } catch (error) {
          askDirectory();
        }
      }
      next();
    }

    /** 在系统文件管理器里选中路径；路径不存在时直接告知。 */
    /** 去掉末尾分隔符：菜单标题常带着它，文件路径带上就打不开了。 */
    function withoutTrailingSeparator(path) {
      var trimmed = path.replace(/[\\/]+$/u, "");
      if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed)) return path;
      return trimmed;
    }

    /** 点击路径上的每一步都留一行日志，静默失败就不再只能靠猜。 */
    var reported = {};
    function report(note) {
      try {
        var text = String(note);
        if (reported[text] === true) return;
        reported[text] = true;
        fetch("/chat-link-actions?action=trace&note=" + encodeURIComponent(text), { method: "POST", keepalive: true }).catch(function () {});
      } catch (ignored) {
        /* diagnostics must never throw */
      }
    }

    /**
     * One click, one attempt: the native call can hang on a stalled link and the
     * fallback can stall too, so a watchdog guarantees the click always answers.
     */
    var revealAttempt = null;

    function reveal(path) {
      var attempt = { done: false };
      revealAttempt = attempt;
      report("reveal-start " + path);
      try {
        probePath(path, function (kind) {
        if (attempt.done || revealAttempt !== attempt) return;
        if (kind === "missing") {
          /* 探测只看得到已打开会话的工作区：路径可能在 /tmp 或别处，交给宿主判定。 */
          revealViaRoute(withoutTrailingSeparator(path), attempt);
          return;
        }
        revealNative(path, true, attempt);
        });
      } catch (error) {
        attempt.done = true;
        report("reveal-threw " + String((error && error.message) || error));
        toast(strings().managerFailed);
      }
      setTimeout(function () {
        if (attempt.done) return;
        attempt.done = true;
        toast(strings().managerFailed);
      }, 4500);
    }

    /** 首选：应用的原生打开能力，macOS 访达、Windows 资源管理器同一套。 */
    function revealNative(path, allowTrim, attempt) {
      if (attempt !== undefined && attempt.done) return;
      var remote = sessionRemote();
      var session = remote === null ? null : remote.session;
      if (session === null || session === undefined || typeof session.openWorkspacePath !== "function") {
        revealViaRoute(path, attempt);
        return;
      }
      var pending;
      try {
        pending = session.openWorkspacePath({ path: path, action: "reveal" });
      } catch (error) {
        afterReveal(path, allowTrim, null, error, attempt);
        return;
      }
      if (pending === null || pending === undefined || typeof pending.then !== "function") {
        afterReveal(path, allowTrim, pending, null, attempt);
        return;
      }
      /* 原生调用不该成为终点：等不到回执就走退路。 */
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        afterReveal(path, allowTrim, null, new Error("timeout"), attempt);
      }, 2500);
      var stop = function (result, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        afterReveal(path, allowTrim, result, error, attempt);
      };
      pending.then(function (result) {
        stop(result, null);
      }, function (error) {
        stop(null, error);
      });
    }

    /** 成功即结束；失败先去掉末尾分隔符重试一次，再退到 HTTP 路由。 */
    function afterReveal(path, allowTrim, result, error, attempt) {
      if (attempt !== undefined && attempt.done) return;
      if (isOpened(result)) {
        if (attempt !== undefined) attempt.done = true;
        return;
      }
      var trimmed = withoutTrailingSeparator(path);
      if (allowTrim === true && trimmed !== path) {
        revealNative(trimmed, false, attempt);
        return;
      }
      revealViaRoute(trimmed, attempt);
    }

    /** 应用打开成功的回执：`{ opened: true }`，旧版本曾用 `{ ok: true }`。 */
    function isOpened(result) {
      return result !== null && result !== undefined && (result.opened === true || result.ok === true);
    }

    /** 退路：插件自己的 HTTP 路由（页面同源时可用）。 */
    function revealViaRoute(path, attempt) {
      if (attempt !== undefined && attempt.done) return;
      var finish = function (message) {
        if (attempt !== undefined && attempt.done) return;
        if (attempt !== undefined) attempt.done = true;
        if (message !== undefined) toast(message);
      };
      report("route " + path);
      fetch("/chat-link-actions?action=reveal&path=" + encodeURIComponent(path), { method: "POST" }).then(function (response) {
        report("route-status " + response.status + " " + path);
        if (response.ok) {
          finish();
          return;
        }
        finish(response.status === 404 ? strings().missing : strings().managerFailed);
      }, function () {
        finish(strings().managerFailed);
      });
    }

    /* ── interception ───────────────────────────────────────────────────── */

    var EDITABLE_SELECTOR = "textarea,input,[contenteditable=''],[contenteditable=true],[contenteditable=plaintext-only]";

    /** 输入框里右键通常是要粘贴：只有点到引用芯片这类带路径的元素才接管。 */
    function editableField(node) {
      if (node instanceof Element && node.closest(EDITABLE_SELECTOR) !== null) return true;
      return node instanceof Element && node.isContentEditable;
    }

    /** 插件自己的故障只记一条日志，绝不让页面上的右键整体失效。 */
    function noteFailure(error) {
      try {
        var context = rootContext;
        if (context !== null && context !== undefined && typeof context.logger?.warn === "function") {
          context.logger.warn("chat-link-actions: menu failed: " + String(error && error.message ? error.message : error));
        }
      } catch (ignored) {
        /* logging must never throw */
      }
    }

    /** Prose needs a real path shape: /help and skill chips must stay native. */
    function looksLikePath(value) {
      if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
      var rest = value.replace(/^(?:[A-Za-z]:)?[\\/]+/u, "");
      if (rest === "") return false;
      if (/[\\/]/u.test(rest)) return true;
      return /\.[A-Za-z0-9]{1,8}$/u.test(rest);
    }

    function onContextMenu(event) {
      if (!(event.target instanceof Element)) return;
      var target = event.target;
      try {
        var inField = editableField(target);
        proseCandidate = false;
        var path = pathFromNode(target, { x: event.clientX, y: event.clientY, allowProse: !inField });
        if (path === null) return;
        if (proseCandidate && !looksLikePath(path)) return;
        openMenu(path, event.clientX, event.clientY, { inField: inField, directory: directoryHint(target) });
        event.preventDefault();
        event.stopPropagation();
      } catch (error) {
        closeMenu(false);
        noteFailure(error);
      }
    }

    /* ── plugin entry ───────────────────────────────────────────────────── */

    var inject = ["slots", "sessions", "remote", "remote.session"];

    function apply(ctx) {
      rootContext = ctx;
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

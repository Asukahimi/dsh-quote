/**
 * dsh-quote — 引用回答。
 *
 * 逻辑（按用户要求）：
 *   1. 点「引用」= 取这条回答的正文（等同复制），完整文本记在内存里；
 *   2. 输入框上方出现引用条，只显示开头一段（约 100 字），右侧 × 可取消；
 *   3. 输入框预填 "> 摘要"，发送后引用条和引用状态一起清除。
 */
window.__ModuleLoader__.load({
  id: 'dsh-quote',
  factory: () => {
    'use strict';

    const BTN = 'dsh-quote-btn';
    const DONE = 'dsh-quote-btn--done';
    const BAR = 'dsh-quote-bar';

    const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
      + '<path d="M6.17 6h4.3v5.9h-2.9c0 1.9 1.05 3.1 3.05 3.4v2.1c-3.2-.3-5.45-2.5-5.45-6.3V6zm8 0h4.3v5.9h-2.9c0 1.9 1.05 3.1 3.05 3.4v2.1c-3.2-.3-5.45-2.5-5.45-6.3V6z"/></svg>';

    let quote = { summary: '', full: '' };
    /** 拦截到的最近一次「复制」内容。 */
    let lastCopied = '';
    /** apply 时保存的客户端 context，用来取会话数据层。 */
    let pluginCtx = null;
    let snapshotDumped = false;
    let debugInfo = '';
    let alertShown = false;

    /** 把消息 content（string / 数组 / {text}）拍平成纯文本。 */
    function flatten(content) {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        }).filter(Boolean).join('\n');
      }
      if (content && typeof content.text === 'string') return content.text;
      return '';
    }

    /**
     * 从会话数据层取最近一条 assistant 消息的完整正文。
     * DOM 是分块渲染的、剪贴板要用户手动复制，只有数据层是全量文本。
     */
    function snapshotText() {
      try {
        const sessions = pluginCtx && pluginCtx.get ? pluginCtx.get('sessions') : null;
        if (!sessions || !sessions.list) return '';
        const list = sessions.list.getSnapshot();
        const id = list && list.current;
        if (!id) return '';
        const binding = sessions.binding(id);
        const face = binding && binding.session;
        const snap = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null;
        if (!snap) return '';

        const items = snap.transcript || snap.items || snap.messages;
        if (!snapshotDumped) {
          snapshotDumped = true;
          debugInfo = 'snapshot=' + JSON.stringify(Object.keys(snap))
            + ' item=' + (Array.isArray(items) && items[0] ? JSON.stringify(Object.keys(items[0])) : 'none')
            + ' transcriptLen=' + (Array.isArray(items) ? items.length : -1);
          console.log('[dsh-quote]', debugInfo);
        }
        if (!Array.isArray(items)) return '';

        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (!item) continue;
          const role = item.role || (item.message && item.message.role);
          if (role !== 'assistant') continue;
          const content = item.content !== undefined ? item.content : (item.message && item.message.content);
          const text = flatten(content);
          if (text && text.trim().length > 20) return text.trim();
        }
      } catch (e) {
        debugInfo = 'err=' + (e && e.message ? e.message : String(e));
      }
      if (!debugInfo) debugInfo = 'sessions 不可用';
      return '';
    }

    /**
     * 从 React fiber 上拿这条回答的完整正文。
     * 操作行的 MessageIconActions 组件 props 里就有 text（复制按钮复制的就是它），
     * 这是数据层的原文，不受分块渲染影响。
     */
    function reactText(el) {
      if (!el) return '';
      const key = Object.keys(el).find((k) =>
        k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
      if (!key) return '';
      let fiber = el[key];
      let depth = 0;
      while (fiber && depth < 40) {
        const props = fiber.memoizedProps;
        if (props && typeof props.text === 'string' && props.text.trim().length > 20) {
          return props.text.trim();
        }
        fiber = fiber.return;
        depth++;
      }
      return '';
    }

    function cleanText(text) {
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^已完成/.test(line) && !/用时/.test(line) && !/^思考/.test(line))
        .join('\n');
    }

    /**
     * 取这一轮的回答正文：
     * 从 turnTail 开始逐层往上，每一层都检查它前面的兄弟节点，
     * 取第一块足够长的文本（回答正文比"已完成/时间"这些行长得多）。
     * 页面有选区时优选取区。
     */
    function turnText(tail) {
      const sel = window.getSelection ? window.getSelection().toString() : '';
      if (sel && sel.trim().length > 0) return sel.trim().slice(0, 8000);

      let scope = tail;
      for (let depth = 0; depth < 6 && scope; depth++) {
        let sib = scope.previousElementSibling;
        while (sib) {
          const text = cleanText((sib.innerText || '').replace(/\u00a0/g, ' '));
          if (text.length > 120) return text.slice(0, 8000);
          sib = sib.previousElementSibling;
        }
        scope = scope.parentElement;
      }
      return '';
    }

    function composerInput() {
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) return active;
      return document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    }

    function setInput(text) {
      const el = composerInput();
      if (!el) return false;
      if (el.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      }
      return true;
    }

    function clearQuote() {
      quote = { summary: '', full: '' };
      document.querySelectorAll('.' + BAR).forEach((n) => n.remove());
    }

    function buildBar() {
      const bar = document.createElement('div');
      bar.className = BAR;
      const label = document.createElement('span');
      label.className = BAR + '-text';
      label.textContent = quote.summary;
      label.title = quote.full.slice(0, 500);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = BAR + '-close';
      close.textContent = '×';
      close.title = '取消引用';
      close.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearQuote();
      });
      bar.appendChild(label);
      bar.appendChild(close);
      return bar;
    }

    /** 引用条：作为输入框卡片的前一个兄弟插入，水平居中、贴在卡片上方。 */
    function ensureBar() {
      if (!quote.summary) return;
      if (document.querySelector('.' + BAR)) return;
      const el = composerInput();
      if (!el) return;
      let card = el;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        if (card.className && /composer/i.test(String(card.className))) break;
      }
      const parent = card.parentElement || document.body;
      const bar = buildBar();
      bar.style.width = 'min(520px, 80%)';
      bar.style.margin = '0 auto 6px';
      parent.insertBefore(bar, card);
    }

    /** 回答的操作行（复制/点赞/踩/分享那一排）。 */
    function actionRow(tail) {
      let best = null;
      const nodes = tail.querySelectorAll('div');
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        let count = 0;
        for (let j = 0; j < el.children.length; j++) {
          if (el.children[j].tagName === 'BUTTON') count++;
        }
        if (count >= 2) best = el;
      }
      return best;
    }

    /**
     * 不主动点任何按钮（之前点“操作行第一个按钮”误触了反馈弹窗）。
     * 只读取用户自己点「复制」时被拦截到的完整文本。
     */
    function getCopiedText() {
      return lastCopied && lastCopied.trim().length > 20 ? lastCopied : '';
    }

    function decorate(tail) {
      if (!tail || tail.querySelector('.' + BTN)) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN;
      btn.title = '引用这条回答';
      btn.innerHTML = ICON;
      btn.addEventListener('mousedown', (event) => {
        const sel = window.getSelection ? window.getSelection().toString() : '';
        if (sel && sel.trim().length > 0) event.preventDefault();
      });
      btn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          // React props（原文） > 数据层 > 用户复制时拦截的内容 > DOM 片段
          const actionBar = actionRow(tail);
          let text = (actionBar && reactText(actionBar)) || snapshotText() || getCopiedText();
          if (!text) {
            if (debugInfo && !alertShown) { alertShown = true; alert('dsh-quote 诊断：' + debugInfo); }
            text = turnText(tail);
          }
          if (!text) {
            alert('dsh-quote: 没取到回答正文，可以先选中要引用的文字再点');
            return;
          }
          const summary = text.replace(/\s+/g, ' ').trim().slice(0, 100);
          quote = { summary, full: text };
          ensureBar();
          // 回退版：引用内容直接预填进输入框，这样模型才能读到
          setInput('> ' + text + '\n\n');
          const input = composerInput();
          if (input) input.focus();
        } catch (err) {
          alert('dsh-quote error: ' + (err && err.message ? err.message : err));
        }
      });
      (actionRow(tail) || tail).appendChild(btn);
    }

    function scan() {
      document.querySelectorAll('[data-turn-tail]').forEach(decorate);
      ensureBar();
    }

    function apply(ctx) {
      pluginCtx = ctx;
      // 拦截「复制」写入剪贴板的内容：不读剪贴板（权限/手势限制），只记一份副本。
      try {
        const clipboard = navigator.clipboard;
        if (clipboard && typeof clipboard.writeText === 'function') {
          const original = clipboard.writeText.bind(clipboard);
          clipboard.writeText = (text) => {
            lastCopied = String(text || '');
            return original(text);
          };
        }
      } catch (e) { /* 忽略 */ }
      document.addEventListener('copy', () => {
        const sel = window.getSelection ? window.getSelection().toString() : '';
        if (sel) lastCopied = sel;
      }, true);

      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-quote';
      style.textContent = [
        '.' + BTN + ' { display: inline-flex; align-items: center; justify-content: center;',
        '  width: 26px; height: 26px; margin: 0 2px; padding: 0;',
        '  color: var(--dsw-alias-label-secondary, #8a8a99); background: transparent;',
        '  border: 1px solid transparent; border-radius: 6px; cursor: pointer;',
        '  opacity: .6; transition: opacity .15s ease, color .15s ease, border-color .15s ease, background .15s ease; }',
        '[data-turn-tail]:hover .' + BTN + ' { opacity: 1; }',
        '.' + BTN + ':hover { color: var(--dsw-alias-brand-text, #6c7cff);',
        '  background: var(--dsw-alias-interactive-bg-hover, rgba(120,120,150,.15));',
        '  border-color: var(--dsw-alias-border-l3, rgba(140,140,160,.35)); }',
        '.' + BTN + '.' + DONE + ' { color: var(--dsw-alias-success, #3aa675); opacity: 1; }',
        '.' + BAR + ' { display: flex; align-items: center; gap: 6px; margin: 4px 10px 0; padding: 3px 8px;',
        '  border-left: 3px solid var(--dsw-alias-brand-primary, #6c7cff);',
        '  background: rgba(120,120,150,.14); border-radius: 6px; font-size: 11px;',
        '  color: var(--dsw-alias-label-secondary, #9a9aa8); max-height: 26px; max-width: 520px;',
        '  width: fit-content; overflow: hidden; }',
        '.' + BAR + '-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.' + BAR + '-send { border: 1px solid var(--dsw-alias-border-l3, rgba(140,140,160,.35));',
        '  background: transparent; color: inherit; font-size: 11px; line-height: 1.4;',
        '  padding: 1px 6px; border-radius: 4px; cursor: pointer; }',
        '.' + BAR + '-send:hover { color: var(--dsw-alias-brand-text, #6c7cff); border-color: currentColor; }',
        '.' + BAR + '-close { border: 0; background: transparent; color: inherit; cursor: pointer;',
        '  font-size: 15px; line-height: 1; padding: 0 2px; }',
        '.' + BAR + '-close:hover { color: var(--dsw-alias-label-primary, #fff); }',
      ].join('\n');
      document.head.appendChild(style);

      scan();
      const observer = new MutationObserver(() => scan());
      observer.observe(document.body, { childList: true, subtree: true });

      // 发送后清掉引用条和引用状态（Enter 发送 / 点发送按钮都算；Shift+Enter 换行不算）
      const onSend = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (!quote.summary) return;
        // 按下的当帧就削掉引用条（不动输入框，发送内容不受影响）
        clearQuote();
      };
      const onSendClick = (event) => {
        if (!quote.summary) return;
        const btn = event.target && event.target.closest ? event.target.closest('button') : null;
        if (!btn) return;
        const label = (btn.getAttribute('aria-label') || '') + ' ' + (btn.title || '');
        if (/send|发送|submit/i.test(label)) clearQuote();
      };
      document.addEventListener('keydown', onSend, true);
      document.addEventListener('click', onSendClick, true);

      return () => {
        observer.disconnect();
        document.removeEventListener('keydown', onSend, true);
        document.removeEventListener('click', onSendClick, true);
        style.remove();
        document.querySelectorAll('.' + BTN).forEach((node) => node.remove());
        clearQuote();
      };
    }

    return { inject: [], apply };
  },
});

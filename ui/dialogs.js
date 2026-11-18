/* dialogs.js — 原生 prompt/confirm 的沙箱替代品。
 *
 * DBX 工作台的 iframe 是 sandbox="allow-scripts"（无 allow-modals），
 * window.prompt / confirm / alert 被浏览器静默禁用，点「新建分组」等
 * 按钮会毫无反应。本模块用 DOM 模态框（复用 index.html 的 #modalBg
 * 与 app.css 的 .modal 样式）提供：
 *
 *   PD.ask(title, {value, placeholder, okText}, cb)  cb(text|null)
 *   PD.confirm(title, {okText}, cb)                  cb(true|false)
 *
 * 必须在 app.js 之前加载；只在被调用时才碰 DOM。
 */
(function () {
  'use strict';

  function bgEl() {
    var b = document.getElementById('modalBg');
    if (!b) { b = document.createElement('div'); b.id = 'modalBg'; document.body.appendChild(b); }
    return b;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function openModal(title, sub, bodyHtml, okText, onOk, onCancel) {
    var bg = bgEl();
    bg.innerHTML = '';
    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      '<h3>' + esc(title) + '</h3>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      bodyHtml +
      '<div class="acts"><div style="flex:1"></div>' +
      '<button class="btn ghost" data-act="cancel">取消</button>' +
      '<button class="btn primary" data-act="ok">' + esc(okText || '确定') + '</button>' +
      '</div>';
    bg.appendChild(m);
    bg.classList.add('open');

    function close() { bg.classList.remove('open'); bg.innerHTML = ''; }
    function ok() { onOk(close); }
    m.querySelector('[data-act="ok"]').onclick = ok;
    m.querySelector('[data-act="cancel"]').onclick = function () { close(); if (onCancel) onCancel(); };
    bg.onclick = function (e) { if (e.target === bg) { close(); if (onCancel) onCancel(); } };
    m.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') ok();
      if (e.key === 'Escape') { close(); if (onCancel) onCancel(); }
    });
    return m;
  }

  /* 文本输入：cb(value|null)。空串按原样返回，调用方自行决定是否接受 */
  function ask(title, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var html =
      '<div class="field"><label>' + esc(opts.label || title) + '</label>' +
      '<input type="text" value="' + esc(opts.value == null ? '' : opts.value) + '"' +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
      ' spellcheck="false" /></div>';
    var m = openModal(title, opts.sub, html, opts.okText, function (close) {
      var v = m.querySelector('input').value;
      close(); cb(v);
    });
    var input = m.querySelector('input');
    input.focus(); if (input.select) input.select();
  }

  /* 确认：cb(true|false) */
  function confirm(title, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var html = '<div class="field"><label style="white-space:normal;line-height:1.6">' + esc(title) + '</label></div>';
    openModal(opts.title || '请确认', opts.sub, html, opts.okText || '确定', function (close) {
      close(); cb(true);
    }, function () { cb(false); });
  }

  window.PD = { ask: ask, confirm: confirm };
})();

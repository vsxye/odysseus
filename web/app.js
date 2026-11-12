/* TechMart Product Assistant — UI wiring. All retrieval/answer logic lives in engine.js (window.TechMartEngine). */
(function () {
  'use strict';
  var E = window.TechMartEngine;
  var $ = function (id) { return document.getElementById(id); };

  var SAMPLES = [
    { q: 'Does the NovaBook Air have enough RAM for coding?', stage: 1 },
    { q: 'Which earbuds have the longest battery life?', stage: 1 },
    { q: 'I need wireless headphones under ₹10,000 with good battery life', stage: 2 },
    { q: 'What laptops do you have for students?', stage: 2 },
    { q: 'Which laptop is best for video editing under ₹70,000?', stage: 3 }
  ];
  var STAGE_HELP = {
    1: 'Stage 1 — no retrieval. The starter catalog (P01–P04, 4 products) is pasted into the prompt in full.',
    2: 'Stage 2 — 50-product catalog. Query parsing, hard filters and BM25 + spec scoring pick the top-k; only those go into the prompt.',
    3: 'Stage 3 — same retrieval plus use-case reasoning (e.g. RAM, GPU, storage for video editing) and one recommendation with a reason.'
  };
  var KEY_STORE = 'techmart_api_key';
  var MODEL_STORE = 'techmart_model';

  var products = null;
  var busy = false;
  var stage = 3;
  var catFilter = '';

  // ------------------------------------------------------------ utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(key, val) { // sessionStorage only; silently unavailable in private modes
    try {
      if (val === undefined) return window.sessionStorage.getItem(key) || '';
      if (val) window.sessionStorage.setItem(key, val); else window.sessionStorage.removeItem(key);
    } catch (e) { /* ignore */ }
    return '';
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_(.+?)_(?=[\s.,)]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  // Minimal markdown: paragraphs, **bold**, _em_, `code`, "- " / "1. " lists, "#" headings as bold lines.
  function renderMarkdown(md) {
    var lines = String(md).replace(/\r/g, '').split('\n');
    var html = [], list = null, para = [];
    function flushPara() { if (para.length) { html.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } }
    function flushList() {
      if (!list) return;
      html.push('<' + list.type + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.type + '>');
      list = null;
    }
    lines.forEach(function (line) {
      var t = line.trim(), m;
      if (!t) { flushPara(); flushList(); return; }
      if ((m = t.match(/^[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); return; }
      if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); return; }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { flushPara(); flushList(); html.push('<p><strong>' + inline(m[1]) + '</strong></p>'); return; }
      flushList(); para.push(t);
    });
    flushPara(); flushList();
    return html.join('');
  }
  function fmtNum(n) { return Number(n).toLocaleString('en-IN'); }
  // set bar widths after paint so the CSS width transition runs
  function animateBars(root) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        Array.prototype.forEach.call(root.querySelectorAll('[data-w]'), function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
      });
    });
  }

  // ------------------------------------------------------------ segmented pills
  function moveSlider(seg) {
    var active = seg.querySelector('.seg-item[aria-selected="true"], .seg-item[aria-checked="true"]');
    var slider = seg.querySelector('.seg-slider');
    if (!active || !slider) return;
    slider.style.top = active.offsetTop + 'px';
    slider.style.height = active.offsetHeight + 'px';
    slider.style.width = active.offsetWidth + 'px';
    slider.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
  function moveAllSliders() { Array.prototype.forEach.call(document.querySelectorAll('.seg'), moveSlider); }
  window.addEventListener('resize', moveAllSliders);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveAllSliders);

  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#nav .seg-item'), function (b) {
      var on = b.getAttribute('data-view') === name;
      b.setAttribute('aria-selected', String(on));
      $('view-' + b.getAttribute('data-view')).hidden = !on;
    });
    moveSlider($('nav'));
    if (name === 'assistant') moveSlider($('stages'));
  }
  $('nav').addEventListener('click', function (e) {
    var b = e.target.closest('.seg-item');
    if (b) showTab(b.getAttribute('data-view'));
  });

  function setStage(n) {
    stage = n;
    Array.prototype.forEach.call(document.querySelectorAll('#stages .seg-item'), function (b) {
      b.setAttribute('aria-checked', String(Number(b.getAttribute('data-stage')) === n));
    });
    $('stage-help').textContent = STAGE_HELP[n] || '';
    moveSlider($('stages'));
  }
  $('stages').addEventListener('click', function (e) {
    var b = e.target.closest('.seg-item');
    if (!b) return;
    setStage(Number(b.getAttribute('data-stage')));
    if ($('question').value.trim()) ask($('question').value);
  });

  // ------------------------------------------------------------ settings popover
  function toggleSettings(open) {
    var pop = $('settings');
    if (open === undefined) open = pop.hidden;
    pop.hidden = !open;
    $('settings-btn').setAttribute('aria-expanded', String(open));
    if (open) $('api-key').focus();
  }
  $('settings-btn').addEventListener('click', function () { toggleSettings(); });
  $('settings-done').addEventListener('click', function () { toggleSettings(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('settings').hidden) toggleSettings(false); });
  document.addEventListener('click', function (e) {
    if ($('settings').hidden) return;
    if (!e.target.closest('#settings') && !e.target.closest('#settings-btn')) toggleSettings(false);
  });

  // ------------------------------------------------------------ catalog
  function renderCatalogFilter() {
    var cats = [''].concat(E.CATEGORIES);
    $('cat-filter').innerHTML = cats.map(function (c) {
      var n = c ? products.filter(function (p) { return p.category === c; }).length : products.length;
      return '<button type="button" class="option" data-cat="' + esc(c) + '" aria-pressed="' + (c === catFilter) + '">' +
        esc(c || 'All') + ' <span class="muted">' + n + '</span></button>';
    }).join('');
  }
  function renderCatalog() {
    var rows = products.filter(function (p) { return !catFilter || p.category === catFilter; });
    $('cat-count').textContent = rows.length + ' of ' + products.length + ' products';
    $('catalog-table').querySelector('tbody').innerHTML = rows.map(function (p, i) {
      return '<tr style="animation-delay:' + Math.min(i, 15) * 25 + 'ms"><td class="mono">' + esc(p.id) + '</td>' +
        '<td><strong>' + esc(p.name) + '</strong><br><span class="muted">' + esc(p.description) + '</span></td>' +
        '<td>' + esc(p.category) + '</td><td class="num">' + esc(E.inr(p.price)) + '</td>' +
        '<td class="catalog-specs">' + esc(p.specs) + '</td>' +
        '<td>' + (p.in_stock === false ? '<span class="muted">Out of stock</span>' : 'In stock') + '</td></tr>';
    }).join('');
  }
  $('cat-filter').addEventListener('click', function (e) {
    var b = e.target.closest('.option');
    if (!b) return;
    catFilter = b.getAttribute('data-cat');
    renderCatalogFilter();
    renderCatalog();
  });

  // ------------------------------------------------------------ trace
  function block(html) { return '<div class="trace-block">' + html + '</div>'; }

  function planChips(r) {
    var plan = r.retrieval.plan;
    var c = [];
    c.push(['category', r.retrieval.categories_used.length ? r.retrieval.categories_used.join(', ') : 'any']);
    if (plan.price_max != null) c.push(['price', '≤ ' + E.inr(plan.price_max)]);
    if (plan.price_min != null) c.push(['price', '≥ ' + E.inr(plan.price_min)]);
    c.push(['use case', plan.use_case ? plan.use_case.replace('_', ' ') : 'none']);
    if (plan.need_wireless) c.push(['wireless', 'required']);
    if (plan.need_anc) c.push(['ANC', 'required']);
    Object.keys(plan.boosts).forEach(function (k) { c.push(['boost', k]); });
    if (plan.pinned_ids.length) c.push(['named product', plan.pinned_ids.join(', ')]);
    c.push(['keywords', plan.keywords.length ? plan.keywords.join(' ') : '—']);
    return '<div class="kv">' + c.map(function (x) { return '<span>' + esc(x[0]) + ' <b>' + esc(x[1]) + '</b></span>'; }).join('') + '</div>';
  }

  function renderTrace(r) {
    var ret = r.retrieval;
    var h = [];

    var plan = '<h3>1 · Query plan</h3>' + planChips(r);
    if (ret.profile.length) {
      plan += '<p class="help">Spec weights (renormalised over attributes present in the candidate set): ' +
        esc(ret.profile.map(function (a) { return a.label + ' ' + a.weight.toFixed(2); }).join(', ')) + '. Score = 0.6 × spec + 0.4 × BM25.</p>';
    } else {
      plan += '<p class="help">No use-case profile, so score = normalised BM25' + (ret.mode === 'bm25_fallback' ? ' over the whole catalog (fallback mode).' : '.') + '</p>';
    }
    h.push(block(plan));

    var max = ret.funnel[0].count || 1;
    var funnel = '<h3>2 · Filter funnel</h3>';
    if (r.stage === 1) funnel += '<p class="help">Stage 1 sends every product to the LLM. This funnel only drives the offline answer.</p>';
    funnel += '<ul class="funnel">' + ret.funnel.map(function (f) {
      return '<li><span class="' + (f.relaxed ? 'relaxed' : '') + '">' + esc(f.label) + '</span><span class="count">' + f.count +
        '</span><span class="bar"><i data-w="' + Math.round(100 * f.count / max) + '"></i></span></li>';
    }).join('') + '</ul>';
    if (ret.relaxed) funnel += '<div class="notice">Nothing matched every constraint, so the price filter was dropped (category kept).</div>';
    h.push(block(funnel));

    var table = '<h3>3 · Retrieved products (' + ret.results.length + ')</h3>';
    if (!ret.results.length) {
      table += '<p class="muted">No products matched.</p>';
    } else {
      table += '<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Product</th><th class="num">Price</th><th>Score</th><th>Why</th></tr></thead><tbody>' +
        ret.results.map(function (x, i) {
          var p = x.product;
          var spec = x.spec_score == null ? '—' : x.spec_score.toFixed(2);
          return '<tr style="animation-delay:' + (i * 40) + 'ms"><td>' + (i + 1) + '</td>' +
            '<td><strong>' + esc(p.name) + '</strong><br><span class="muted mono">' + esc(p.id) + ' · ' + esc(p.category) + '</span></td>' +
            '<td class="num">' + esc(E.inr(p.price)) + '</td>' +
            '<td class="score"><span class="mono">' + x.score.toFixed(2) + '</span>' +
            '<div class="bar"><i data-w="' + Math.round(Math.min(1, x.score) * 100) + '"></i></div>' +
            '<small>spec ' + spec + ' · bm25 ' + x.bm25_norm.toFixed(2) + '</small></td>' +
            '<td><ul class="why">' + x.why.map(function (w) {
              return '<li' + (/in set\)/.test(w) ? ' class="best"' : '') + '>' + esc(w) + '</li>';
            }).join('') + '</ul></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (ret.excluded.length) {
      table += '<p class="help">Excluded by price filter: ' + esc(ret.excluded.map(function (e) { return e.product.name + ' (' + E.inr(e.product.price) + ')'; }).join(', ')) + '</p>';
    }
    h.push(block(table));

    var tk = '<h3>4 · Prompt size (estimate, ~4 chars per token)</h3>';
    var full = r.tokens.full_catalog, sent = r.tokens.sent, top = Math.max(full, sent);
    if (r.stage === 1) {
      tk += '<p class="tokens">Whole starter catalog in the prompt (' + r.catalog_size + ' products): <strong>~' + fmtNum(sent) + ' tokens</strong>. ' +
        'The same approach with all ' + products.length + ' products costs ~' + fmtNum(full) + ' tokens per question.</p>';
    } else {
      tk += '<p class="tokens"><strong>~' + fmtNum(full) + '</strong> tokens → <strong>~' + fmtNum(sent) + '</strong> tokens, <strong>' + r.tokens.saved_pct + '% saved</strong></p>';
    }
    tk += '<div class="token-bars">' +
      '<span>Full catalog (' + products.length + ')</span><span class="bar"><i data-w="' + Math.round(100 * full / top) + '"></i></span><span class="num">' + fmtNum(full) + '</span>' +
      '<span>Sent (' + (r.stage === 1 ? r.catalog_size : ret.results.length) + ')</span><span class="bar"><i data-w="' + Math.round(100 * sent / top) + '"></i></span><span class="num">' + fmtNum(sent) + '</span>' +
      '</div>';
    h.push(block(tk));

    h.push(block('<details class="prompt-box"><summary>5 · Prompt sent to LLM</summary>' +
      '<pre class="prompt"><b>SYSTEM</b>\n' + esc(r.prompt.system) + '\n\n<b>USER</b>\n' + esc(r.prompt.user) + '</pre></details>'));

    $('trace').innerHTML = h.join('');
    animateBars($('trace'));
  }

  // ------------------------------------------------------------ run
  function setAnswer(md, source, note) {
    var a = $('answer');
    a.classList.remove('enter');
    a.innerHTML = renderMarkdown(md);
    void a.offsetWidth; // restart the arrive animation
    a.classList.add('enter');
    $('answer-source').textContent = source;
    var n = $('answer-note');
    if (note) { n.textContent = note; n.hidden = false; } else { n.hidden = true; n.textContent = ''; }
  }

  var loadTimer = null;
  function loading(on) {
    var bar = $('loadbar'), fill = bar.querySelector('i');
    clearTimeout(loadTimer);
    if (on) {
      bar.classList.add('on');
      fill.style.opacity = '1';
      fill.style.width = '0';
      requestAnimationFrame(function () { fill.style.width = '35%'; });
      loadTimer = setTimeout(function () { fill.style.width = '75%'; }, 900);
    } else {
      fill.style.width = '100%';
      loadTimer = setTimeout(function () { fill.style.opacity = '0'; bar.classList.remove('on'); fill.style.width = '0'; }, 500);
    }
  }

  function updateUrl(q) {
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('q', q);
      u.searchParams.set('stage', String(stage));
      window.history.replaceState(null, '', u.toString());
    } catch (e) { /* ignore */ }
  }

  function ask(q) {
    q = (q || '').trim();
    if (!q || !products || busy) return;
    var r = E.run(q, products, { stage: stage, k: 5 });
    renderTrace(r);
    updateUrl(q);
    var key = $('api-key').value.trim();
    var model = $('model').value.trim() || E.DEFAULT_MODEL;
    if (!key) {
      setAnswer(r.offline_answer, 'offline template', null);
      return;
    }
    busy = true;
    $('ask-btn').disabled = true;
    loading(true);
    $('answer').innerHTML = '<p class="muted">Waiting for ' + esc(model) + '…</p>';
    $('answer-source').textContent = '';
    E.callAnthropic(r.prompt, key, model).then(function (res) {
      var usage = res.usage ? ' · ' + res.usage.input_tokens + ' in / ' + res.usage.output_tokens + ' out' : '';
      setAnswer(res.text, (res.model || model) + usage, null);
    }).catch(function (err) {
      setAnswer(r.offline_answer, 'offline template', 'LLM call failed, so this is the offline answer. ' + (err && err.message ? err.message : String(err)));
    }).then(function () {
      busy = false;
      $('ask-btn').disabled = false;
      loading(false);
    });
  }

  // ------------------------------------------------------------ init
  function init() {
    $('chips').innerHTML = SAMPLES.map(function (s, i) {
      return '<button type="button" class="option" data-i="' + i + '" aria-pressed="false"><span class="badge">S' + s.stage + '</span>' + esc(s.q) + '</button>';
    }).join('');
    $('chips').addEventListener('click', function (e) {
      var b = e.target.closest('.option');
      if (!b) return;
      Array.prototype.forEach.call($('chips').children, function (c) { c.setAttribute('aria-pressed', String(c === b)); });
      var s = SAMPLES[Number(b.getAttribute('data-i'))];
      setStage(s.stage);
      $('question').value = s.q;
      ask(s.q);
    });
    $('ask-form').addEventListener('submit', function (e) { e.preventDefault(); ask($('question').value); });

    $('api-key').value = store(KEY_STORE);
    $('model').value = store(MODEL_STORE) || E.DEFAULT_MODEL;
    $('api-key').addEventListener('input', function () { store(KEY_STORE, $('api-key').value.trim()); });
    $('model').addEventListener('input', function () { store(MODEL_STORE, $('model').value.trim()); });
    $('clear-key').addEventListener('click', function () { $('api-key').value = ''; store(KEY_STORE, ''); });

    var params = new URLSearchParams(window.location.search);
    var st = Number(params.get('stage'));
    setStage(st >= 1 && st <= 3 ? st : 3);
    showTab(params.get('tab') === 'catalog' ? 'catalog' : 'assistant');
    var q0 = params.get('q');

    fetch('../data/products.json', { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        products = data;
        var cats = E.CATEGORIES.filter(function (c) { return products.some(function (p) { return p.category === c; }); });
        $('status-text').textContent = products.length + ' products · ' + cats.length + ' categories';
        $('status').classList.add('ready');
        renderCatalogFilter();
        renderCatalog();
        if (q0) {
          $('question').value = q0;
          var idx = SAMPLES.map(function (s) { return s.q; }).indexOf(q0);
          if (idx !== -1) $('chips').children[idx].setAttribute('aria-pressed', 'true');
          ask(q0);
        }
      })
      .catch(function (err) {
        $('status-text').textContent = 'Catalog not loaded';
        var el = $('load-error');
        el.hidden = false;
        el.textContent = 'Could not load ../data/products.json (' + err.message + '). Serve the repository root over HTTP (e.g. python -m http.server) and open /web/.';
      });
  }
  init();
})();

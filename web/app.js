/* TechMart Product Assistant — chat UI. Retrieval/answer logic lives in engine.js (window.TechMartEngine);
   streaming generation comes from scripts/serve.py (POST /api/chat, NDJSON) backed by a local Ollama model. */
(function () {
  'use strict';
  var E = window.TechMartEngine;
  var $ = function (id) { return document.getElementById(id); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  var SAMPLES = [
    { q: 'Does the NovaBook Air have enough RAM for coding?', stage: 1 },
    { q: 'Which earbuds have the longest battery life?', stage: 1 },
    { q: 'I need wireless headphones under ₹10,000 with good battery life', stage: 2 },
    { q: 'What laptops do you have for students?', stage: 2 },
    { q: 'Which laptop is best for video editing under ₹70,000?', stage: 3 }
  ];
  var FUN = [
    'Surprise me with a gift under ₹5,000',
    'What do you sell?',
    'Compare Zentra Vision 15 vs Pixelon Slim 14'
  ];
  var STAGE_HELP = {
    1: 'Stage 1 — no retrieval. The full catalog is sent to the model.',
    2: 'Stage 2 — 50-product catalog. Query parsing, hard filters and BM25 + spec scoring pick the top-k; only those go into the prompt.',
    3: 'Stage 3 — same retrieval plus use-case reasoning (e.g. RAM, GPU, storage for video editing) and one recommendation with a reason.'
  };
  var CHATS_KEY = 'techmart.chats.v1';
  var USE_LLM_KEY = 'techmart.useLLM.v1';
  var CHATS_MAX = 40;
  var HISTORY_TURNS = 6;          // messages sent to the LLM (incl. the current user message)
  var FIRST_TOKEN_MS = 12000;
  var TOTAL_MS = 60000;
  var QUEUE_MS = 45000; // max wait in the server's request queue before falling back
  var BUSY_NOTE = "The assistant is busy right now — here's the instant catalog answer.";
  var GUARD_NOTE = 'Corrected: the model mentioned something not in our catalog, so here is the catalog answer.';
  var INSTANT_MS = 350;

  var products = null;
  var stage = 3;
  var catFilter = '';
  var chat = newChat();
  var gen = null;                  // the in-flight assistant turn
  var stick = true;                // auto-scroll while the user is at the bottom
  var useLLM = readUseLLM();
  var health = { status: 'checking', model: 'qwen2.5:3b' };

  // ------------------------------------------------------------ utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
  function clock(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function relTime(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    if (d < 30) return d + (d === 1 ? ' day ago' : ' days ago');
    return new Date(ts).toLocaleDateString('en-IN');
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  // set bar widths after paint so the CSS width transition runs
  function animateBars(root) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        each(root.querySelectorAll('[data-w]'), function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
      });
    });
  }
  function readUseLLM() {
    try { return window.localStorage.getItem(USE_LLM_KEY) !== '0'; } catch (e) { return true; }
  }
  function focusComposer() {
    try { $('question').focus({ preventScroll: true }); } catch (e) { $('question').focus(); }
  }

  // ------------------------------------------------------------ segmented pills
  function moveSlider(seg) {
    var active = seg.querySelector('.seg-item[aria-selected="true"], .seg-item[aria-checked="true"]');
    var slider = seg.querySelector('.seg-slider');
    if (!active || !slider || !active.offsetWidth) return;
    slider.style.top = active.offsetTop + 'px';
    slider.style.height = active.offsetHeight + 'px';
    slider.style.width = active.offsetWidth + 'px';
    slider.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
  function moveAllSliders() { each(document.querySelectorAll('.seg'), moveSlider); }
  window.addEventListener('resize', moveAllSliders);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveAllSliders);

  function showTab(name) {
    each(document.querySelectorAll('#nav .seg-item'), function (b) {
      var on = b.getAttribute('data-view') === name;
      b.setAttribute('aria-selected', String(on));
      $('view-' + b.getAttribute('data-view')).hidden = !on;
    });
    document.body.setAttribute('data-view', name);
    moveSlider($('nav'));
    if (name === 'assistant') { moveSlider($('stages')); scrollToBottom(true); }
    if (name === 'history') renderHistory();
  }
  $('nav').addEventListener('click', function (e) {
    var b = e.target.closest('.seg-item');
    if (b) showTab(b.getAttribute('data-view'));
  });

  function setStage(n) {
    stage = n;
    each(document.querySelectorAll('#stages .seg-item'), function (b) {
      b.setAttribute('aria-checked', String(Number(b.getAttribute('data-stage')) === n));
    });
    $('stages').title = STAGE_HELP[n] || '';
    var help = $('stage-help');
    if (help) help.textContent = STAGE_HELP[n] || '';
    moveSlider($('stages'));
  }
  $('stages').addEventListener('click', function (e) {
    var b = e.target.closest('.seg-item');
    if (!b) return;
    setStage(Number(b.getAttribute('data-stage')));
    focusComposer();
  });

  // ------------------------------------------------------------ settings popover
  function toggleSettings(open) {
    var pop = $('settings');
    if (open === undefined) open = pop.hidden;
    pop.hidden = !open;
    $('settings-btn').setAttribute('aria-expanded', String(open));
    if (open) $('use-llm').focus();
  }
  $('settings-btn').addEventListener('click', function () { toggleSettings(); });
  $('settings-done').addEventListener('click', function () { toggleSettings(false); });
  $('status').addEventListener('click', function () { toggleSettings(true); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('settings').hidden) toggleSettings(false); });
  document.addEventListener('click', function (e) {
    if ($('settings').hidden) return;
    if (!e.target.closest('#settings') && !e.target.closest('#settings-btn') && !e.target.closest('#status')) toggleSettings(false);
  });
  $('use-llm').addEventListener('change', function () {
    useLLM = $('use-llm').checked;
    try { window.localStorage.setItem(USE_LLM_KEY, useLLM ? '1' : '0'); } catch (e) { /* ignore */ }
    renderStatus();
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

  // ------------------------------------------------------------ pipeline trace ("How I found this")
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
    Object.keys(plan.boosts || {}).forEach(function (k) { c.push(['boost', k]); });
    if (plan.pinned_ids && plan.pinned_ids.length) c.push(['named product', plan.pinned_ids.join(', ')]);
    c.push(['keywords', plan.keywords && plan.keywords.length ? plan.keywords.join(' ') : '—']);
    return '<div class="kv">' + c.map(function (x) { return '<span>' + esc(x[0]) + ' <b>' + esc(x[1]) + '</b></span>'; }).join('') + '</div>';
  }

  function renderTrace(r, meta) {
    meta = meta || {};
    var ret = r.retrieval;
    var h = [];
    if (meta.guard && meta.guard.length) h.push(guardBlock(meta.guard));

    var plan = '<h3>1 · Query plan</h3>';
    if (meta.resolved && meta.asked && meta.resolved.trim().toLowerCase() !== meta.asked.trim().toLowerCase()) {
      plan += '<p class="help resolved">Follow-up resolved to: <strong>' + esc(meta.resolved) + '</strong></p>';
    }
    plan += '<p class="help stage-note">' + esc(STAGE_HELP[r.stage] || '') + '</p>';
    plan += planChips(r);
    if (ret.profile.length) {
      plan += '<p class="help">Spec weights (renormalised over attributes present in the candidate set): ' +
        esc(ret.profile.map(function (a) { return a.label + ' ' + a.weight.toFixed(2); }).join(', ')) + '. Score = 0.6 × spec + 0.4 × BM25.</p>';
    } else {
      plan += '<p class="help">No use-case profile, so score = normalised BM25' + (ret.mode === 'bm25_fallback' ? ' over the whole catalog (fallback mode).' : '.') + '</p>';
    }
    h.push(block(plan));

    var max = (ret.funnel[0] && ret.funnel[0].count) || 1;
    var funnel = '<h3>2 · Filter funnel</h3>';
    if (r.stage === 1) funnel += '<p class="help">Stage 1 sends every product to the LLM. This funnel only drives the rule-based answer.</p>';
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
    var full = r.tokens.full_catalog, sent = r.tokens.sent, top = Math.max(full, sent) || 1;
    if (r.stage === 1) {
      tk += '<p class="tokens">All ' + r.catalog_size + ' catalog products go into the prompt: <strong>~' + fmtNum(sent) + ' tokens</strong>. ' +
        'This uses more tokens than retrieval, which sends only the top matches.</p>';
    } else {
      tk += '<p class="tokens"><strong>~' + fmtNum(full) + '</strong> tokens → <strong>~' + fmtNum(sent) + '</strong> tokens, <strong>' + r.tokens.saved_pct + '% saved</strong></p>';
    }
    tk += '<div class="token-bars">' +
      '<span>Full catalog (' + products.length + ')</span><span class="bar"><i data-w="' + Math.round(100 * full / top) + '"></i></span><span class="num">' + fmtNum(full) + '</span>' +
      '<span>Sent (' + (r.stage === 1 ? r.catalog_size : ret.results.length) + ')</span><span class="bar"><i data-w="' + Math.round(100 * sent / top) + '"></i></span><span class="num">' + fmtNum(sent) + '</span>' +
      '</div>';
    h.push(block(tk));

    var pr = meta.llm || r.prompt;
    h.push(block('<details class="prompt-box"><summary>5 · Prompt ' + (meta.llm ? 'sent to the LLM' : 'for the LLM') + '</summary>' +
      '<pre class="prompt"><b>SYSTEM</b>\n' + esc(pr.system) + '\n\n<b>USER</b>\n' + esc(pr.user) + '</pre></details>'));
    return h.join('');
  }

  // ------------------------------------------------------------ engine: converse() with a thin fallback over run()
  var GREETING_RE = /^\s*(hi+|hello+|hey+|hiya|yo|namaste|hola|good\s+(morning|afternoon|evening))\b[\s!.?]*$/i;
  var THANKS_RE = /^\s*(thanks|thank\s*you|thx|ty|cool|great|awesome|ok(ay)?)\b[\s!.?]*$/i;
  var DEFAULT_SUGGESTIONS = ['Best laptop for students', 'Earbuds with ANC under ₹5,000', 'What do you sell?'];

  function adapterConverse(message, prods, state, opts) {
    var t = String(message || '').trim();
    var turn = (state && state.turn ? state.turn : 0) + 1;
    var base = { products: [], suggestions: DEFAULT_SUGGESTIONS.slice(), run: null, llm: null, resolved_query: t };
    function instant(kind, answer) {
      return Object.assign({}, base, { kind: kind, needs_llm: false, answer: answer,
        state: Object.assign({}, state || {}, { turn: turn, last_kind: kind }) });
    }
    if (!t) return instant('clarify', 'Ask me about any laptop, phone, tablet, earbuds, headset, smartwatch, speaker or monitor we sell.');
    if (GREETING_RE.test(t)) return instant('greeting', "Hi! I'm the TechMart assistant. Tell me what you're shopping for — a budget or a use case helps — and I'll pick from our catalog.");
    if (THANKS_RE.test(t)) return instant('thanks', 'Happy to help! Anything else you want to compare or look up?');
    var r = E.run(t, prods, opts);
    var res = r.retrieval.results;
    var cards = res.slice(0, 3).map(function (x, i) {
      var p = x.product;
      return { id: p.id, name: p.name, category: p.category, price: p.price, specs: p.specs,
        why: (x.why || []).slice(0, 3), badge: i === 0 ? 'Best pick' : (i === 1 ? 'Runner-up' : '') };
    });
    return {
      kind: r.answer_kind || 'recommendation', needs_llm: true, answer: r.offline_answer, products: cards,
      suggestions: cards.length > 1 ? ['Anything cheaper?', 'Compare the top two', 'Tell me more about ' + cards[0].name] : DEFAULT_SUGGESTIONS.slice(),
      run: r, llm: { system: r.prompt.system, user: r.prompt.user }, resolved_query: t,
      state: { turn: turn, last_query: t, last_plan: r.retrieval.plan, last_ids: cards.map(function (c) { return c.id; }), last_kind: r.answer_kind }
    };
  }
  function converse(text) {
    var opts = { stage: stage, k: 5, stage1Catalog: 'full' };
    var out = null;
    if (typeof E.converse === 'function') {
      try { out = E.converse(text, products, chat.state, opts); } catch (err) {
        if (window.console) console.warn('converse() failed, using run() fallback:', err);
        out = null;
      }
    }
    if (!out) out = adapterConverse(text, products, chat.state, opts);
    out.products = Array.isArray(out.products) ? out.products.slice(0, 3) : [];
    out.suggestions = Array.isArray(out.suggestions) ? out.suggestions.filter(Boolean).slice(0, 3) : [];
    out.answer = String(out.answer || "I couldn't find anything for that — try asking about a product category, a budget or a use case.");
    if (out.needs_llm && !(out.llm && out.llm.system != null && out.llm.user)) out.needs_llm = false;
    return out;
  }

  // ------------------------------------------------------------ answer guard (web/guard.js): catalog-grounding check on LLM replies
  function guardAnswer(answer, conv, asked) {
    var Gd = window.TechMartGuard;
    if (!Gd || typeof Gd.checkAnswer !== 'function' || !products) return { ok: true, problems: [] };
    try {
      // numbers/names the model legitimately saw: recent user turns (budgets, products they named), earlier replies, the prompt
      var recent = chat.messages.slice(-HISTORY_TURNS);
      var users = recent.filter(function (m) { return m.role === 'user'; }).map(function (m) { return String(m.content || ''); });
      if (users.indexOf(asked) < 0) users.push(asked);
      var prior = recent.filter(function (m) { return m.role === 'assistant' && !/…\(stopped\)$/.test(String(m.content || '')); }).map(function (m) { return String(m.content || ''); });
      return Gd.checkAnswer(answer, {
        catalog: products,
        allowed: Gd.allowedFromConv(conv, products),
        userMessage: users.join('\n'),
        engineAnswer: conv.answer || '',
        context: [conv.resolved_query || '', conv.llm ? conv.llm.user : ''].concat(prior).join('\n')
      });
    } catch (err) {
      if (window.console) console.warn('answer guard failed, keeping the model reply:', err);
      return { ok: true, problems: [] };
    }
  }
  // engine's must_include (e.g. "Sorry, we don't carry the MacBook.") is prepended when the model skipped saying so
  function withMustInclude(reply, conv) {
    var mi = conv && typeof conv.must_include === 'string' ? conv.must_include.trim() : '';
    if (!mi) return reply;
    if (/don['’]?t\s+carry|do\s+not\s+carry|not\s+in\s+our\s+catalog|don['’]?t\s+stock|do\s+not\s+stock/i.test(reply)) return reply;
    return mi + '\n\n' + reply;
  }
  function guardBlock(problems) {
    return block('<h3>Answer check</h3><p class="help">The model\'s reply was replaced with the catalog answer because:</p>' +
      '<ul class="why">' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>');
  }

  // ------------------------------------------------------------ health / model status
  function apiUrl(path) { return new URL('../api/' + path, window.location.href).toString(); }
  function llmAvailable() { return useLLM && (health.status === 'ready' || health.status === 'warming'); }
  function renderStatus() {
    var el = $('status'), txt;
    var st = useLLM ? health.status : 'off';
    if (st === 'ready') txt = health.model + ' · ready';
    else if (st === 'warming') txt = health.model + ' · warming up';
    else if (st === 'checking') txt = health.model + ' · checking…';
    else if (st === 'off') txt = 'Local LLM off · rule-based answers';
    else txt = health.model + ' · offline (rule-based answers)';
    $('status-text').textContent = txt;
    el.setAttribute('data-state', st);
    el.setAttribute('aria-label', 'Model status: ' + txt + '. Open settings.');
    var s = $('settings-status');
    if (s) {
      s.textContent = st === 'off' ? health.model + ' is available but switched off — answers come from the rule-based engine.'
        : st === 'ready' ? health.model + ' is loaded in Ollama and ready to stream answers.'
        : st === 'warming' ? health.model + ' is reachable and loading into memory; the first answer may take a few seconds.'
        : st === 'checking' ? 'Checking the local model…'
        : 'No local model reachable (start Ollama and run scripts/serve.py). Answers come from the rule-based engine, grounded in the same catalog.';
    }
  }
  function checkHealth() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, 3000);
    return fetch(apiUrl('health'), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (d) {
        if (d && d.model) health.model = d.model;
        health.status = d && d.ok ? (d.warm === false ? 'warming' : 'ready') : 'offline';
      })
      .catch(function () { health.status = 'offline'; })
      .then(function () { clearTimeout(t); renderStatus(); });
  }

  // ------------------------------------------------------------ streaming POST /api/chat (NDJSON)
  // Line types: {"queued":N} (N requests ahead; repeated as keepalive), {"start":true}, {"delta":"..."},
  // {"done":true,...}, {"error":"..."} / {"error":"busy","retry_after":s}.
  // Without queued/start lines (older server) the first-token / total timers run from request start.
  function streamChat(body, h) {
    var ctrl = new AbortController();
    var reason = null, gotFirst = false, finished = false, started = false;
    function abortWith(r) { return function () { reason = r; ctrl.abort(); }; }
    var firstTimer = setTimeout(abortWith('first_token'), FIRST_TOKEN_MS);
    var totalTimer = setTimeout(abortWith('total'), TOTAL_MS);
    var queueTimer = null;
    function cleanup() { clearTimeout(firstTimer); clearTimeout(totalTimer); clearTimeout(queueTimer); }
    function end(fn, arg) { if (finished) return; finished = true; cleanup(); fn(arg); }
    var t0 = Date.now();

    fetch(apiUrl('chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '', doneInfo = null;
      function handle(line) {
        line = line.trim();
        if (!line) return;
        var obj;
        try { obj = JSON.parse(line); } catch (e) { return; }
        if (obj.error) {
          if (obj.error === 'busy') reason = 'busy';
          throw new Error(String(obj.error));
        }
        if (typeof obj.queued === 'number' && !started && !gotFirst) {
          // waiting in the server queue: generation timers wait for {"start"}; the queue itself gets QUEUE_MS from request start
          clearTimeout(firstTimer); clearTimeout(totalTimer);
          if (!queueTimer) queueTimer = setTimeout(abortWith('queue'), Math.max(0, QUEUE_MS - (Date.now() - t0)));
          if (h.onQueued) h.onQueued(Math.max(0, obj.queued));
        }
        if (obj.start && !started) {
          started = true;
          clearTimeout(queueTimer); clearTimeout(firstTimer); clearTimeout(totalTimer);
          if (!gotFirst) firstTimer = setTimeout(abortWith('first_token'), FIRST_TOKEN_MS);
          totalTimer = setTimeout(abortWith('total'), TOTAL_MS);
          if (h.onQueued) h.onQueued(0);
        }
        if (typeof obj.delta === 'string' && obj.delta) {
          if (!started && queueTimer) { // server skipped {"start"}: first token counts as the start
            started = true; clearTimeout(queueTimer);
            totalTimer = setTimeout(abortWith('total'), TOTAL_MS);
          }
          if (!gotFirst) { gotFirst = true; clearTimeout(firstTimer); }
          h.onDelta(obj.delta);
        }
        if (obj.done) doneInfo = obj;
      }
      function drain() {
        return reader.read().then(function (chunk) { if (!chunk.done) return drain(); }, function () { /* ignore */ });
      }
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            buf += dec.decode();
            buf.split('\n').forEach(handle);
            if (!doneInfo && !gotFirst) throw new Error('stream ended without a reply');
            end(h.onDone, doneInfo || {});
            return;
          }
          buf += dec.decode(chunk.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(handle);
          // after {"done"}: finish now, then read quietly to EOF. Cancelling the reader here would abort the request
          // and log "POST /api/chat net::ERR_ABORTED" on every reply.
          if (doneInfo) { end(h.onDone, doneInfo); return drain(); }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (reason === 'user') end(h.onStop);
      else end(h.onError, { reason: reason || 'error', message: err && err.message ? err.message : String(err), partial: gotFirst });
    });
    return { stop: function () { if (!finished) { reason = 'user'; ctrl.abort(); } } };
  }

  // ------------------------------------------------------------ conversation storage (localStorage)
  function newChat() { return { id: uid(), title: '', created: Date.now(), updated: Date.now(), stage: 3, state: null, messages: [] }; }
  var memChats = [];
  function loadChats() {
    try {
      var raw = window.localStorage.getItem(CHATS_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) { memChats = arr.filter(function (c) { return c && c.id && Array.isArray(c.messages); }); return memChats; }
      }
    } catch (e) { /* storage blocked or corrupt */ }
    return memChats;
  }
  function writeChats(list) {
    memChats = list.slice(0, CHATS_MAX);
    try { window.localStorage.setItem(CHATS_KEY, JSON.stringify(memChats)); } catch (e) { /* quota / blocked */ }
  }
  function serialize(c) {
    return {
      id: c.id, title: c.title, created: c.created, updated: c.updated, stage: c.stage, state: c.state,
      messages: c.messages.map(function (m) {
        var o = {};
        Object.keys(m).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = m[k]; });
        return o;
      })
    };
  }
  function saveChat() {
    if (!chat.messages.length) return;
    chat.updated = Date.now();
    chat.stage = stage;
    var list = loadChats().filter(function (c) { return c.id !== chat.id; });
    list.unshift(serialize(chat));
    writeChats(list);
  }

  // ------------------------------------------------------------ thread rendering
  var thread = $('thread');
  var ICON = {
    copy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    send: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    stop: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    spark: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>'
  };

  function isNearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; }
  function scrollToBottom(force) {
    if (!force && !stick) { $('jump').hidden = false; return; }
    thread.scrollTop = thread.scrollHeight;
    $('jump').hidden = true;
  }
  thread.addEventListener('scroll', function () {
    stick = isNearBottom();
    if (stick) $('jump').hidden = true;
  }, { passive: true });
  $('jump').addEventListener('click', function () {
    stick = true;
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
    $('jump').hidden = true;
    focusComposer();
  });

  function welcomeHtml() {
    return '<div class="welcome" id="welcome">' +
      '<div class="welcome-mark" aria-hidden="true">' + ICON.spark + '</div>' +
      '<h2 class="welcome-title">Hi, I\'m the TechMart assistant</h2>' +
      '<p class="welcome-lead">Ask me anything about our 50 laptops, phones, tablets, audio gear, watches and monitors. ' +
      'I only recommend products we actually stock — follow-ups like <em>"anything cheaper?"</em> or <em>"compare them"</em> work too.</p>' +
      '<span class="eyebrow">Assignment test queries</span>' +
      '<div class="options starters">' + SAMPLES.map(function (s, i) {
        return '<button type="button" class="option" data-sample="' + i + '"><span class="badge">S' + s.stage + '</span>' + esc(s.q) + '</button>';
      }).join('') + '</div>' +
      '<span class="eyebrow">Or just for fun</span>' +
      '<div class="options starters">' + FUN.map(function (q) {
        return '<button type="button" class="option" data-send="' + esc(q) + '">' + esc(q) + '</button>';
      }).join('') + '</div></div>';
  }
  function renderWelcome() { thread.innerHTML = welcomeHtml(); stick = true; $('jump').hidden = true; }

  function userEl(m) {
    var el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = '<div class="bubble">' + esc(m.content).replace(/\n/g, '<br>') + '</div>' +
      '<div class="msg-foot"><time datetime="' + new Date(m.ts).toISOString() + '">' + esc(clock(m.ts)) + '</time></div>';
    return el;
  }
  function botShell() {
    var el = document.createElement('div');
    el.className = 'msg bot';
    el.innerHTML = '<div class="avatar" aria-hidden="true">T</div><div class="msg-body">' +
      '<div class="bubble"><div class="md"></div></div><div class="msg-extra"></div></div>';
    return el;
  }
  function typingHtml(label) {
    return '<span class="typing" role="status" aria-label="Assistant is typing"><i></i><i></i><i></i></span>' +
      (label ? '<span class="typing-label">' + esc(label) + '</span>' : '');
  }
  function cardsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="pcards">' + list.map(function (p, i) {
      var why = (p.why || []).slice(0, 3);
      return '<button type="button" class="pcard" style="animation-delay:' + (i * 70) + 'ms" data-name="' + esc(p.name) + '" aria-label="Tell me more about ' + esc(p.name) + '">' +
        '<span class="pcard-top"><span class="pcard-cat">' + esc(p.category || '') + '</span>' +
        (p.badge ? '<span class="pbadge' + (p.badge === 'Best pick' ? ' best' : '') + '">' + esc(p.badge) + '</span>' : '') + '</span>' +
        '<span class="pcard-name">' + esc(p.name) + '</span>' +
        '<span class="pcard-price">' + esc(E.inr(p.price)) + '</span>' +
        (why.length ? '<span class="pcard-why">' + why.map(function (w) { return '<span>' + esc(w) + '</span>'; }).join('') + '</span>' : '') +
        '</button>';
    }).join('') + '</div>';
  }
  function suggestHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="suggest options" role="group" aria-label="Suggested follow-ups">' + list.map(function (s, i) {
      return '<button type="button" class="option chip" style="animation-delay:' + (120 + i * 60) + 'ms" data-send="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('') + '</div>';
  }
  function fillBot(el, m, opts) {
    opts = opts || {};
    var md = el.querySelector('.md');
    md.innerHTML = renderMarkdown(m.content);
    el.querySelector('.bubble').classList.remove('pending', 'streaming');
    var extra = el.querySelector('.msg-extra');
    var h = '';
    if (m.note) h += '<div class="msg-note">' + esc(m.note) + '</div>';
    h += cardsHtml(m.products);
    h += '<div class="msg-foot"><span class="src" data-src="' + (/local/.test(m.source || '') ? 'llm' : 'rule') + '">' + esc(m.source || 'rule-based answer') + '</span>' +
      '<time datetime="' + new Date(m.ts).toISOString() + '">' + esc(clock(m.ts)) + '</time>' +
      '<button type="button" class="mini copy" aria-label="Copy answer">' + ICON.copy + '<span>Copy</span></button></div>';
    if (m.hasTrace) h += '<details class="how"><summary>How I found this</summary><div class="how-body"></div></details>';
    if (opts.latest) h += suggestHtml(m.suggestions);
    extra.innerHTML = h;
    if (opts.animate !== false) el.classList.add('done');
  }
  function clearSuggestions() { each(thread.querySelectorAll('.suggest'), function (s) { s.remove(); }); }

  // caret goes at the end of the last text block while streaming
  function renderStreaming(el, text) {
    var md = el.querySelector('.md');
    md.innerHTML = renderMarkdown(text) || '<p></p>';
    var last = md.lastElementChild;
    if (last && (last.tagName === 'UL' || last.tagName === 'OL')) last = last.lastElementChild || last;
    var caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    (last || md).appendChild(caret);
  }

  function renderChat() {
    thread.innerHTML = '';
    if (!chat.messages.length) { renderWelcome(); return; }
    var lastBot = -1;
    chat.messages.forEach(function (m, i) { if (m.role === 'assistant') lastBot = i; });
    var frag = document.createDocumentFragment();
    chat.messages.forEach(function (m, i) {
      if (m.role === 'user') { frag.appendChild(userEl(m)); return; }
      var el = botShell();
      el.messageRef = m;
      fillBot(el, m, { latest: i === lastBot && i === chat.messages.length - 1, animate: false });
      frag.appendChild(el);
    });
    thread.appendChild(frag);
    stick = true;
    scrollToBottom(true);
  }

  // ------------------------------------------------------------ sending a turn
  function setGenerating(on) {
    var b = $('send-btn');
    b.classList.toggle('stop', on);
    b.innerHTML = on ? ICON.stop + '<span>Stop</span>' : ICON.send + '<span>Send</span>';
    b.setAttribute('aria-label', on ? 'Stop generating' : 'Send message');
    b.type = on ? 'button' : 'submit';
    thread.setAttribute('aria-busy', String(on));
    $('composer').classList.toggle('busy', on);
  }

  function llmMessages(finalUser) {
    var prior = chat.messages.slice(0, -1).filter(function (m) { return m.content && String(m.content).trim(); });
    var msgs = prior.slice(-(HISTORY_TURNS - 1)).map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).replace(/…\(stopped\)$/, '').trim() };
    });
    while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    msgs.push({ role: 'user', content: finalUser });
    return msgs;
  }

  function send(text, opts) {
    text = String(text || '').trim();
    if (!text || !products) return;
    if (gen) return;
    opts = opts || {};
    if (opts.stage) setStage(opts.stage);
    var w = $('welcome');
    if (w) w.remove();
    clearSuggestions();

    var um = { role: 'user', content: text, ts: Date.now() };
    chat.messages.push(um);
    if (!chat.title) chat.title = text.slice(0, 90);
    thread.appendChild(userEl(um));
    $('question').value = '';
    autosize();
    stick = true;
    scrollToBottom(true);

    var conv = converse(text);
    if (conv.state) chat.state = conv.state;
    var bm = {
      role: 'assistant', content: '', ts: Date.now(), kind: conv.kind, source: '', note: '',
      products: conv.products, suggestions: conv.suggestions, resolved_query: conv.resolved_query || text,
      asked: text, stage: stage, hasTrace: !!conv.run
    };
    bm._run = conv.run;
    bm._llm = conv.llm;

    var el = botShell();
    el.messageRef = bm;
    var bubble = el.querySelector('.bubble');
    bubble.classList.add('pending');
    el.querySelector('.md').innerHTML = typingHtml('');
    thread.appendChild(el);
    scrollToBottom();

    gen = { msg: bm, el: el, conv: conv, text: '', stream: null, timer: null, labelTimer: null, raf: 0 };
    setGenerating(true);

    if (!conv.needs_llm) {
      gen.timer = setTimeout(function () { finish(conv.answer, 'rule-based answer', ''); }, INSTANT_MS);
      return;
    }
    if (!llmAvailable()) {
      gen.timer = setTimeout(function () { finish(conv.answer, 'rule-based answer', ''); }, 250);
      return;
    }

    gen.labelTimer = setTimeout(function () {
      if (gen && !gen.text && !gen.queued) {
        el.querySelector('.md').innerHTML = typingHtml(health.status === 'warming' ? 'Waking up ' + health.model + '…' : 'Thinking…');
      }
    }, 3500);
    var g = gen;
    g.stream = streamChat({ system: conv.llm.system, messages: llmMessages(conv.llm.user) }, {
      onQueued: function (n) {
        if (gen !== g || g.text) return;
        var was = g.queued;
        g.queued = n;
        if (n > 0) el.querySelector('.md').innerHTML = typingHtml('Waiting for the model — ' + n + ' ahead of you…');
        else if (was) el.querySelector('.md').innerHTML = typingHtml('Thinking…');
      },
      onDelta: function (d) {
        if (gen !== g) return;
        if (!g.text) { clearTimeout(g.labelTimer); bubble.classList.remove('pending'); bubble.classList.add('streaming'); }
        g.text += d;
        if (!g.raf) {
          g.raf = requestAnimationFrame(function () {
            g.raf = 0;
            if (gen !== g) return;
            renderStreaming(el, g.text);
            scrollToBottom();
          });
        }
      },
      onDone: function (info) {
        if (gen !== g) return;
        health.status = 'ready';
        if (info && info.model) health.model = info.model;
        renderStatus();
        if (!g.text.trim()) { finish(conv.answer, 'rule-based answer', 'The local model returned an empty reply, so this is the catalog answer.'); return; }
        var verdict = guardAnswer(g.text.trim(), conv, text);
        if (!verdict.ok) {
          bm.guard = verdict.problems;
          bm.hasTrace = true;
          if (window.console) console.info('Answer guard replaced the model reply:', verdict.problems, '\n' + g.text);
          finish(conv.answer, 'rule-based (verified)', GUARD_NOTE);
          return;
        }
        finish(withMustInclude(g.text.trim(), conv), (info && info.model ? info.model : health.model) + ' · local', '');
      },
      onStop: function () {
        if (gen !== g) return;
        if (g.text.trim()) finish(g.text.trimEnd() + '…(stopped)', health.model + ' · local', '');
        else finish(conv.answer, 'rule-based answer', 'Stopped before the model replied — here is the catalog answer instead.');
      },
      onError: function (e) {
        if (gen !== g) return;
        if (e.reason === 'busy' || e.reason === 'queue') { finish(conv.answer, 'rule-based answer', BUSY_NOTE); return; }
        var why = e.reason === 'first_token' ? 'The local model did not start answering within 12 s'
          : e.reason === 'total' ? 'The local model took longer than 60 s'
          : 'The local model is unavailable (' + e.message + ')';
        if (e.reason === 'error') checkHealth(); // re-check now instead of marking the model offline until the next poll
        finish(conv.answer, 'rule-based answer', why + ', so this is the rule-based answer from the same catalog data.');
      }
    });
  }

  function finish(text, source, note) {
    var g = gen;
    if (!g) return;
    clearTimeout(g.timer);
    clearTimeout(g.labelTimer);
    if (g.raf) cancelAnimationFrame(g.raf);
    var m = g.msg;
    m.content = text;
    m.source = source;
    m.note = note || '';
    m.ts = Date.now();
    chat.messages.push(m);
    fillBot(g.el, m, { latest: true });
    gen = null;
    setGenerating(false);
    saveChat();
    renderHistory();
    scrollToBottom();
    focusComposer();
  }

  function stop() {
    if (!gen) return;
    if (gen.stream) { gen.stream.stop(); return; }
    finish(gen.conv.answer, 'rule-based answer', '');
  }

  // abandon an in-flight turn without writing it into the chat (used when switching chats)
  function abandon() {
    if (!gen) return;
    var g = gen;
    gen = null;
    clearTimeout(g.timer);
    clearTimeout(g.labelTimer);
    if (g.stream) g.stream.stop();
    setGenerating(false);
  }

  function resetChat() {
    abandon();
    chat = newChat();
    renderWelcome();
    focusComposer();
  }

  // ------------------------------------------------------------ thread interactions (delegated)
  thread.addEventListener('click', function (e) {
    var s = e.target.closest('[data-sample]');
    if (s) { var sm = SAMPLES[Number(s.getAttribute('data-sample'))]; send(sm.q, { stage: sm.stage }); focusComposer(); return; }
    var c = e.target.closest('[data-send]');
    if (c) { send(c.getAttribute('data-send')); focusComposer(); return; }
    var card = e.target.closest('.pcard');
    if (card) { send('Tell me more about ' + card.getAttribute('data-name')); focusComposer(); return; }
    var cp = e.target.closest('.copy');
    if (cp) { copyMsg(cp); }
  });
  thread.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d.classList || !d.classList.contains('how') || !d.open) return;
    var body = d.querySelector('.how-body');
    if (body.getAttribute('data-ready')) return;
    var el = d.closest('.msg');
    var m = el && el.messageRef;
    if (!m) return;
    var r = m._run;
    if (!r) { // restored from history: re-run retrieval deterministically (no LLM call)
      try { r = E.run(m.resolved_query || m.asked || '', products, { stage: m.stage || 3, k: 5, stage1Catalog: 'full' }); m._run = r; } catch (err) { r = null; }
    }
    if (!r) {
      body.innerHTML = (m.guard && m.guard.length ? guardBlock(m.guard) : '') + '<p class="muted">No retrieval trace for this message.</p>';
      return;
    }
    body.innerHTML = renderTrace(r, { llm: m._llm, resolved: m.resolved_query, asked: m.asked, guard: m.guard });
    body.setAttribute('data-ready', '1');
    animateBars(body);
  }, true);

  function copyMsg(btn) {
    var m = btn.closest('.msg').messageRef;
    var text = m ? m.content : btn.closest('.msg').querySelector('.md').innerText;
    function ok() {
      btn.innerHTML = ICON.check + '<span>Copied</span>';
      btn.classList.add('ok');
      setTimeout(function () { btn.innerHTML = ICON.copy + '<span>Copy</span>'; btn.classList.remove('ok'); }, 1400);
    }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { /* ignore */ }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, legacy);
    else legacy();
  }

  // ------------------------------------------------------------ composer
  var input = $('question');
  function autosize() {
    input.style.height = 'auto';
    if (!input.value) { input.style.height = ''; return; } // don't size to a wrapped placeholder
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!gen) send(input.value);
    }
  });
  $('composer').addEventListener('submit', function (e) { e.preventDefault(); if (!gen) send(input.value); });
  $('send-btn').addEventListener('click', function (e) {
    if (gen) { e.preventDefault(); stop(); focusComposer(); }
  });
  $('new-chat').addEventListener('click', resetChat);

  // ------------------------------------------------------------ history view (whole conversations)
  function renderHistory() {
    var list = loadChats();
    $('hist-count').textContent = list.length ? list.length + (list.length === 1 ? ' conversation' : ' conversations') : '';
    $('hist-clear').hidden = !list.length;
    $('hist-empty').hidden = !!list.length;
    $('hist-list').innerHTML = list.map(function (c, i) {
      var n = c.messages.length;
      var lastBot = null;
      c.messages.forEach(function (m) { if (m.role === 'assistant' && m.products && m.products.length) lastBot = m; });
      var pick = lastBot ? '<span class="pick">' + esc(lastBot.products[0].name) + ' · ' + esc(E.inr(lastBot.products[0].price)) + '</span>' : '';
      return '<li class="hist-row" style="animation-delay:' + Math.min(i, 12) * 25 + 'ms">' +
        '<button type="button" class="hist-open" data-id="' + esc(c.id) + '">' +
        '<span class="hist-q">' + esc(c.title || 'Untitled chat') + '</span>' +
        '<span class="hist-meta"><span class="tag">Stage ' + esc(c.stage || 3) + '</span><span>' + n + (n === 1 ? ' message' : ' messages') + '</span>' +
        '<span>' + esc(relTime(c.updated || c.created)) + '</span>' + pick + (c.id === chat.id ? '<span class="tag">open</span>' : '') + '</span></button>' +
        '<button type="button" class="hist-del" data-del="' + esc(c.id) + '" aria-label="Delete conversation: ' + esc(c.title || 'Untitled chat') + '">' + ICON.trash + '</button></li>';
    }).join('');
  }
  function openChat(id) {
    var c = loadChats().filter(function (x) { return x.id === id; })[0];
    if (!c || !products) return;
    abandon();
    chat = JSON.parse(JSON.stringify(c));
    setStage(Number(chat.stage) || 3);
    showTab('assistant');
    renderChat();
    focusComposer();
  }
  $('hist-list').addEventListener('click', function (e) {
    var del = e.target.closest('.hist-del');
    if (del) {
      var id = del.getAttribute('data-del');
      writeChats(loadChats().filter(function (c) { return c.id !== id; }));
      if (id === chat.id) { chat.id = uid(); } // keep the open thread, but as a new unsaved chat
      renderHistory();
      return;
    }
    var open = e.target.closest('.hist-open');
    if (open) openChat(open.getAttribute('data-id'));
  });
  $('hist-clear').addEventListener('click', function () {
    if (!window.confirm('Delete all saved conversations? This cannot be undone.')) return;
    writeChats([]);
    chat.id = uid();
    renderHistory();
  });

  // another tab saved/deleted a conversation: refresh the list (each tab keeps its own open chat + state in memory)
  window.addEventListener('storage', function (e) {
    if (e.key === CHATS_KEY || e.key === null) { memChats = []; renderHistory(); }
  });

  // ------------------------------------------------------------ init
  function init() {
    $('use-llm').checked = useLLM;
    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) input.placeholder = 'Ask about any product…';
    setGenerating(false);
    renderWelcome();
    renderHistory();
    renderStatus();

    var params = new URLSearchParams(window.location.search);
    var st = Number(params.get('stage'));
    setStage(st >= 1 && st <= 3 ? st : 3);
    var tab0 = params.get('tab');
    showTab(tab0 === 'catalog' || tab0 === 'history' ? tab0 : 'assistant');
    var q0 = params.get('q');

    var healthReady = checkHealth();
    setInterval(checkHealth, 30000);

    fetch('../data/products.json', { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        products = data;
        renderCatalogFilter();
        renderCatalog();
        if (q0) {
          var waited = new Promise(function (resolve) { setTimeout(resolve, 1500); });
          Promise.race([healthReady, waited]).then(function () {
            try { // drop ?q so a reload does not re-ask
              var u = new URL(window.location.href);
              u.searchParams.delete('q');
              window.history.replaceState(null, '', u.toString());
            } catch (e) { /* ignore */ }
            send(q0);
          });
        }
      })
      .catch(function (err) {
        $('status-text').textContent = 'Catalog not loaded';
        var el = $('load-error');
        el.hidden = false;
        el.textContent = 'Could not load ../data/products.json (' + err.message + '). Serve the repository root over HTTP (e.g. python scripts/serve.py) and open /web/.';
      });
    focusComposer();
  }
  init();
})();

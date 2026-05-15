// Content script: один универсальный режим — TreeWalker по text-нодам.
// Регулярка ищет "число + р./BYN/Br/руб.", при матче на месте текстовой ноды
// в DOM появляется трио: [текст-до] + [span.byn-converter-suffix] + [текст-после].
//
// Запускается:
//   - автоматически на kufar.by/realt.by/av.by (статический content_scripts в manifest);
//   - по запросу на любых других сайтах, добавленных через popup
//     (chrome.scripting.registerContentScripts из background.js).

(() => {
  'use strict';

  // STRICT: число + маркер валюты (`р./руб./BYN/Br/p.`). Используется в
  // text-walker и в container-walker, когда у контейнера НЕТ class-подсказки.
  // Маркер — единственный сигнал, что число это цена в BYN, а не год,
  // километраж, телефон, м² и т.п.
  //
  // `\b` не ставим: в JS-regex без /u флага `\b` — граница между \w (ASCII)
  // и не-\w, а кириллица не входит в \w, поэтому "210 497 р." после `\b` не
  // матчится. Альтернативы упорядочены от длинной к короткой, иначе для
  // "5000 руб." сначала срабатывает `р\.?` и суффикс лезет в середину слова.
  // `p\.` — латинская p с обязательной точкой; salon.av.by кладёт U+0070
  // вместо кириллической U+0440 (визуально одинаковые).
  const PRICE_REGEX_STRICT = /(\d[\d\s .,]*\d|\d)\s*(руб\.?|BYN|Br|р\.?|p\.)/i;

  // LOOSE: просто число (мин. 2 цифры). Используется только когда у контейнера
  // class-хинт `price/prices/cost/cena/byn` — сам класс заменяет маркер валюты.
  const PRICE_REGEX_LOOSE = /(\d[\d\s .,]*\d)/;

  // Класс-подсказка: «этот узел — про цену». Word boundary защищает от
  // совпадений в стиле «enterprise/spritzer».
  const CLASS_HINT = /\b(price|prices|cost|cena|byn)\b/i;
  // Если рядом уже есть иностранный знак (или наша конвертация после первого
  // прохода) — поверх не накладываем.
  const SKIP_NEAR = /[$€₽]|USD|EUR|RUB/i;

  const PROCESSED_ATTR = 'data-byn-converted';
  const SUFFIX_CLASS = 'byn-converter-suffix';

  // Реестр shadow root'ов, в которые мы уже спускались. Нужен, чтобы resetAll
  // мог найти и удалить наши суффиксы внутри web components.
  const knownShadowRoots = new Set();

  // Состояние, синхронизируется со storage.
  const state = {
    rates: null,
    targetCurrency: 'USD',
    enabled: true,
  };

  // ---------- Парсинг цены ----------

  // "1 250" → 1250, "1 250,50" → 1250.50, "1.250" → 1250.
  function normalizeAmount(raw) {
    raw = raw.replace(/[\s ]/g, '');

    const lastComma = raw.lastIndexOf(',');
    const lastDot = raw.lastIndexOf('.');

    let normalized;
    if (lastComma >= 0 && lastDot >= 0) {
      const decSep = lastComma > lastDot ? ',' : '.';
      const thouSep = decSep === ',' ? '.' : ',';
      normalized = raw.split(thouSep).join('').replace(decSep, '.');
    } else if (lastComma >= 0) {
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else if (lastDot >= 0) {
      const afterDot = raw.length - lastDot - 1;
      // 1-2 цифры после точки трактуем как десятичную часть (1.5 / 12.99),
      // 3+ — как разделитель тысяч (1.250 → 1250). Иначе "1.5 р." парсится в 15.
      if (afterDot === 1 || afterDot === 2) {
        normalized = raw.replace(/\.(?=.*\.)/g, '');
      } else {
        normalized = raw.replace(/\./g, '');
      }
    } else {
      normalized = raw;
    }

    const n = parseFloat(normalized);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ---------- Форматирование ----------

  const SYMBOLS = { USD: '$', EUR: '€', RUB: '₽' };

  function formatConverted(bynAmount) {
    if (!state.rates || !state.rates[state.targetCurrency]) return null;
    const rate = state.rates[state.targetCurrency].rate;
    const converted = bynAmount / rate;

    const rounded = converted < 10
      ? converted.toFixed(2)
      : Math.round(converted).toLocaleString('ru-RU');

    return `~${SYMBOLS[state.targetCurrency]}${rounded}`;
  }

  function makeSuffix(amount, converted) {
    const rateInfo = state.rates?.[state.targetCurrency];
    const span = document.createElement('span');
    span.className = SUFFIX_CLASS;
    span.textContent = ` (${converted})`;
    span.style.cssText = 'color:#888;font-weight:normal;margin-left:4px;font-size:0.9em;';
    if (rateInfo) {
      span.title = `Курс НБ РБ: 1 ${state.targetCurrency} = ${rateInfo.rate.toFixed(4)} BYN`;
    }
    span.setAttribute(PROCESSED_ATTR, String(amount));
    return span;
  }

  // ---------- Обход DOM ----------

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA',
    'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE',
  ]);

  function shouldVisit(node) {
    const text = node.nodeValue;
    if (!text || text.length < 2) return false;

    const p = node.parentElement;
    if (!p) return false;
    if (SKIP_TAGS.has(p.tagName)) return false;
    if (p.isContentEditable) return false;
    if (p.classList.contains(SUFFIX_CLASS)) return false;

    // Если рядом уже стоит наш суффикс — этот текст мы уже конвертировали.
    const next = node.nextSibling;
    if (next && next.nodeType === 1 && next.classList?.contains(SUFFIX_CLASS)) return false;

    // Text-walker всегда строгий: на уровне отдельной text-ноды у нас нет
    // class-контекста, поэтому полагаемся на маркер валюты.
    return PRICE_REGEX_STRICT.test(text);
  }

  function convertTextNode(textNode) {
    const text = textNode.nodeValue;
    const parent = textNode.parentElement;
    if (!parent) return;

    // В окружении уже есть $/€/₽/USD/EUR/RUB — не дублируем.
    if (SKIP_NEAR.test(parent.textContent || '')) return;

    const m = text.match(PRICE_REGEX_STRICT);
    if (!m) return;
    const amount = normalizeAmount(m[1]);
    if (amount === null) return;

    const converted = formatConverted(amount);
    if (!converted) return;

    const matchEnd = m.index + m[0].length;
    const beforeText = text.slice(0, matchEnd);
    const afterText = text.slice(matchEnd);

    const parentNode = textNode.parentNode;
    parentNode.insertBefore(document.createTextNode(beforeText), textNode);
    parentNode.insertBefore(makeSuffix(amount, converted), textNode);
    parentNode.insertBefore(document.createTextNode(afterText), textNode);
    parentNode.removeChild(textNode);
  }

  // Контейнер с фрагментированной ценой: textContent ловится регуляркой
  // целиком, хотя ни одна отдельная text-нода внутри её не содержит.
  // Например, salon.av.by режет цену на три узла:
  //   <span>от</span><div>189 447</div><span>р.</span>
  // Длину текста ограничиваем, чтобы не ходить по огромным описаниям/комментам.
  const MAX_CONTAINER_TEXT_LEN = 100;

  // Класс может быть SVGAnimatedString — берём строкой через getAttribute.
  function regexForContainer(el) {
    const cls = el.getAttribute?.('class') || '';
    return CLASS_HINT.test(cls) ? PRICE_REGEX_LOOSE : PRICE_REGEX_STRICT;
  }

  function shouldVisitContainer(el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.classList?.contains(SUFFIX_CLASS)) return false;
    if (el.hasAttribute(PROCESSED_ATTR)) return false;
    const text = el.textContent;
    if (!text || text.length < 3 || text.length > MAX_CONTAINER_TEXT_LEN) return false;
    if (SKIP_NEAR.test(text)) return false;
    if (!regexForContainer(el).test(text)) return false;
    // Внутри уже работал text-walker.
    if (el.querySelector(`[${PROCESSED_ATTR}], .${SUFFIX_CLASS}`)) return false;
    return true;
  }

  function convertContainer(el) {
    const m = el.textContent.match(regexForContainer(el));
    if (!m) return;
    const amount = normalizeAmount(m[1]);
    if (amount === null) return;
    const converted = formatConverted(amount);
    if (!converted) return;
    el.setAttribute(PROCESSED_ATTR, String(amount));
    el.appendChild(makeSuffix(amount, converted));
  }

  function processAll(root = document.body) {
    if (!state.enabled || !state.rates || !root) return;

    // 1. text-ноды: цена целиком в одной текстовой ноде (Kufar и т.п.).
    const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (shouldVisit(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    let n;
    while ((n = textWalker.nextNode())) nodes.push(n);
    for (const textNode of nodes) convertTextNode(textNode);

    // 2. контейнеры с фрагментированной ценой. Собираем кандидатов и оставляем
    // только самые глубокие — если матчится и обёртка, и её ребёнок, метим только
    // ребёнка, чтобы не получить вложенные суффиксы.
    const containerWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (shouldVisitContainer(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const containers = [];
    let c;
    while ((c = containerWalker.nextNode())) containers.push(c);
    const deepest = containers.filter((el) =>
      !containers.some((other) => other !== el && el.contains(other))
    );
    for (const el of deepest) convertContainer(el);

    // 3. рекурсия в open shadow roots.
    const shadowWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (el.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const hosts = [];
    let host;
    while ((host = shadowWalker.nextNode())) hosts.push(host);
    for (const h of hosts) {
      knownShadowRoots.add(h.shadowRoot);
      processAll(h.shadowRoot);
    }
  }

  function resetAll() {
    // Удаляем суффиксы и снимаем PROCESSED_ATTR с контейнеров (он теперь живёт
    // и на самих span-суффиксах, и на обёртках с фрагментированной ценой).
    // normalize() склеивает соседние text-ноды, оставшиеся после удаления
    // суффикса, — иначе DOM фрагментируется при каждой смене валюты.
    const parents = new Set();
    const collect = (root) => {
      root.querySelectorAll(`.${SUFFIX_CLASS}`).forEach((el) => {
        if (el.parentNode) parents.add(el.parentNode);
        el.remove();
      });
      root.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
        el.removeAttribute(PROCESSED_ATTR);
      });
    };
    collect(document);
    for (const shadowRoot of knownShadowRoots) {
      if (shadowRoot.isConnected) collect(shadowRoot);
    }
    parents.forEach((p) => p.normalize?.());
  }

  // ---------- MutationObserver для SPA ----------

  let debounceTimer = null;
  function scheduleProcess() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processAll();
    }, 150);
  }

  const observer = new MutationObserver((mutations) => {
    // Игнорируем свои же вставки (наш суффикс-span).
    const relevant = mutations.some((m) =>
      Array.from(m.addedNodes).some((n) =>
        n.nodeType === 1 && !n.classList?.contains(SUFFIX_CLASS)
      )
    );
    if (relevant) scheduleProcess();
  });

  // ---------- Загрузка состояния и старт ----------

  async function loadState() {
    const { ratesPayload, settings } = await chrome.storage.local.get(['ratesPayload', 'settings']);
    if (ratesPayload) state.rates = ratesPayload.rates;
    if (settings) {
      state.targetCurrency = settings.targetCurrency || 'USD';
      state.enabled = settings.enabled !== false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ratesPayload) state.rates = changes.ratesPayload.newValue?.rates || null;
    if (changes.settings) {
      const s = changes.settings.newValue || {};
      state.targetCurrency = s.targetCurrency || 'USD';
      state.enabled = s.enabled !== false;
    }
    resetAll();
    processAll();
  });

  (async () => {
    await loadState();
    processAll();
    observer.observe(document.body, { childList: true, subtree: true });
  })();
})();

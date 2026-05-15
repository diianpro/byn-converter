const $ = (id) => document.getElementById(id);
const currencyRadios = () => document.querySelectorAll('input[name="currency"]');

// Только https — соответствует manifest.optional_host_permissions ["https://*/*"].
const originPattern = (hostname) => `https://${hostname}/*`;

// ---------- Курсы и настройки ----------

async function loadSettings() {
  const { settings, ratesPayload } = await chrome.storage.local.get(['settings', 'ratesPayload']);
  const s = settings || { targetCurrency: 'USD', enabled: true };

  for (const radio of currencyRadios()) {
    radio.checked = radio.value === s.targetCurrency;
  }
  $('enabled').checked = s.enabled !== false;

  renderRates(ratesPayload);
}

function renderRates(payload) {
  const el = $('ratesInfo');
  el.replaceChildren();
  if (!payload || !payload.rates) {
    el.textContent = 'Курсы не загружены';
    return;
  }
  // Собираем DOM через createElement/textContent, без innerHTML — данные из
  // network не должны попадать в HTML-парсер popup'а.
  for (const [code, info] of Object.entries(payload.rates)) {
    if (!info || typeof info.rate !== 'number') continue;
    const line = document.createElement('div');
    line.textContent = `1 ${code} = ${info.rate.toFixed(4)} BYN`;
    el.appendChild(line);
  }
  const date = payload.rates.USD?.date?.slice(0, 10) || '';
  const note = document.createElement('div');
  note.className = 'muted';
  note.textContent = `Источник: НБ РБ${date ? `, на ${date}` : ''}`;
  el.appendChild(note);
}

async function saveSettings() {
  const selected = document.querySelector('input[name="currency"]:checked');
  const settings = {
    targetCurrency: selected ? selected.value : 'USD',
    enabled: $('enabled').checked,
  };
  await chrome.storage.local.set({ settings });
}

// ---------- Текущий сайт и список пользовательских ----------

async function getCurrentTabHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}

async function listSites() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'list-sites' }, (resp) => {
      resolve(resp || { ok: false, sites: [], builtIn: [] });
    });
  });
}

// "kufar.by" против "www.kufar.by" / "m.kufar.by": хост поддерживается,
// если совпадает с baked-in или оканчивается на .<built-in>.
function matchesBuiltIn(hostname, builtIn) {
  return builtIn.some((b) => hostname === b || hostname.endsWith('.' + b));
}

async function renderThisSite() {
  const host = await getCurrentTabHost();
  const { sites = [], builtIn = [] } = await listSites();

  const hostEl = $('thisSiteHost');
  const statusEl = $('thisSiteStatus');
  const btn = $('thisSiteAction');

  if (!host) {
    hostEl.textContent = '—';
    statusEl.textContent = 'недоступно на системных страницах';
    statusEl.className = 'status';
    btn.hidden = true;
    return;
  }

  hostEl.textContent = host;

  if (matchesBuiltIn(host, builtIn)) {
    statusEl.textContent = 'поддерживается из коробки';
    statusEl.className = 'status ok';
    btn.hidden = true;
    return;
  }

  const enabled = sites.includes(host);
  if (enabled) {
    statusEl.textContent = 'включён';
    statusEl.className = 'status ok';
    btn.hidden = false;
    btn.textContent = 'Выключить здесь';
    btn.className = '';
    btn.onclick = () => removeSite(host);
  } else {
    statusEl.textContent = 'не включён';
    statusEl.className = 'status';
    btn.hidden = false;
    btn.textContent = '+ Включить на этом сайте';
    btn.className = 'primary';
    btn.onclick = () => addSite(host);
  }
}

async function renderUserSites() {
  const { sites = [] } = await listSites();
  const section = $('userSitesSection');
  const ul = $('userSitesList');
  ul.innerHTML = '';

  if (sites.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  for (const host of sites) {
    const li = document.createElement('li');
    const hostSpan = document.createElement('span');
    hostSpan.className = 'host';
    hostSpan.textContent = host;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Удалить';
    removeBtn.addEventListener('click', () => removeSite(host));
    li.appendChild(hostSpan);
    li.appendChild(removeBtn);
    ul.appendChild(li);
  }
}

async function addSite(host) {
  const btn = $('thisSiteAction');
  btn.disabled = true;

  // chrome.permissions.request требует user gesture, поэтому вызываем напрямую
  // из обработчика клика. После grant'а просим background зарегистрировать
  // content script на этом origin'е.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(host)] });
  } catch (err) {
    console.error('[BYN Converter] permission request failed:', err);
  }

  if (!granted) {
    btn.disabled = false;
    return;
  }

  const resp = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'add-site', hostname: host }, resolve)
  );

  if (!resp?.ok) {
    console.error('[BYN Converter] add-site failed:', resp?.error);
    // permission уже выдан, но регистрация упала — откатим permission.
    await chrome.permissions.remove({ origins: [originPattern(host)] }).catch(() => {});
  }

  btn.disabled = false;
  await renderThisSite();
  await renderUserSites();
}

async function removeSite(host) {
  await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'remove-site', hostname: host }, resolve)
  );
  await renderThisSite();
  await renderUserSites();
}

// ---------- Слушатели ----------

for (const radio of currencyRadios()) {
  radio.addEventListener('change', saveSettings);
}
$('enabled').addEventListener('change', saveSettings);

$('refresh').addEventListener('click', async () => {
  $('ratesInfo').textContent = 'Обновляем…';
  const resp = await chrome.runtime.sendMessage({ type: 'refresh-rates' });
  if (resp?.ok) {
    renderRates(resp.payload);
  } else {
    $('ratesInfo').textContent = 'Ошибка обновления';
  }
});

// Старт.
loadSettings();
renderThisSite();
renderUserSites();

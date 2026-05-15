// Service worker:
//   - тянет курсы НБ РБ раз в 6 часов, кладёт в chrome.storage.local;
//   - регистрирует динамические content scripts для пользовательских сайтов,
//     добавленных через popup ("Включить на этом сайте").

const NBRB_API = 'https://api.nbrb.by/exrates/rates?periodicity=0';
const ALARM_NAME = 'refresh-rates';
const REFRESH_INTERVAL_MIN = 60 * 6;

// НБ РБ в Cur_ID кладёт собственный внутренний идентификатор, а не ISO 4217.
// Надёжная идентификация — по Cur_Abbreviation (буквенный ISO-код).
const TARGET_CURRENCIES = new Set(['USD', 'EUR', 'RUB']);

// Хосты с baked-in конфигами в sites/*.js — для них пользовательскую регистрацию
// делать не нужно, они уже описаны в manifest.content_scripts.
const BUILT_IN_HOSTS = new Set(['kufar.by', 'realt.by', 'av.by']);

// ---------- Курсы НБ РБ ----------

const FETCH_TIMEOUT_MS = 15000;

// In-flight memoization: alarm и popup могут одновременно дёрнуть fetchRates;
// гоняем один запрос, всем вернём один и тот же результат.
let inFlightFetch = null;

function fetchRates() {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = doFetchRates().finally(() => { inFlightFetch = null; });
  return inFlightFetch;
}

async function doFetchRates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(NBRB_API, { signal: controller.signal });
    if (!resp.ok) {
      console.error('[BYN Converter] НБ РБ вернул', resp.status);
      return null;
    }
    const data = await resp.json();

    // [{ Cur_ID, Cur_Abbreviation, Cur_Scale, Cur_OfficialRate, Date }, ...]
    // Cur_Scale — количество единиц (например, 100 RUB),
    // Cur_OfficialRate — BYN за Cur_Scale единиц.
    const rates = {};
    for (const item of data) {
      const code = item.Cur_Abbreviation;
      if (!TARGET_CURRENCIES.has(code)) continue;
      rates[code] = {
        rate: item.Cur_OfficialRate / item.Cur_Scale,
        date: item.Date,
      };
    }

    if (Object.keys(rates).length === 0) {
      console.error('[BYN Converter] не нашли целевых валют в ответе НБ РБ');
      return null;
    }

    const payload = { rates, fetchedAt: Date.now(), source: 'nbrb' };
    await chrome.storage.local.set({ ratesPayload: payload });
    console.log('[BYN Converter] курсы обновлены', payload);
    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[BYN Converter] таймаут при запросе курсов');
    } else {
      console.error('[BYN Converter] ошибка получения курсов:', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Регистрация пользовательских content scripts ----------

const scriptId = (hostname) => `user-${hostname}`;
// https-only: optional_host_permissions ограничен https://*/*. Это покрывает все
// реальные кейсы (любой современный классифайд) и сокращает список запрашиваемых
// permission'ов при ревью в Chrome Web Store.
const originPattern = (hostname) => `https://${hostname}/*`;

// Подтянуть из storage список пользовательских сайтов.
async function getUserSites() {
  const { userSites } = await chrome.storage.local.get('userSites');
  return Array.isArray(userSites) ? userSites : [];
}

async function setUserSites(sites) {
  await chrome.storage.local.set({ userSites: sites });
}

// Зарегистрировать content script для одного хоста. Permission на origin
// уже должен быть предоставлен (запрашиваем его на стороне popup, потому что
// chrome.permissions.request требует user gesture).
async function registerForHost(hostname) {
  const granted = await chrome.permissions.contains({ origins: [originPattern(hostname)] });
  if (!granted) {
    throw new Error(`no permission for ${hostname}`);
  }
  const id = scriptId(hostname);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([{
      id,
      matches: [originPattern(hostname)],
      js: ['content.js'],
      runAt: 'document_idle',
      allFrames: true,
    }]);
  } else {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [originPattern(hostname)],
      js: ['content.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
  }
}

async function unregisterForHost(hostname) {
  const id = scriptId(hostname);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  }
}

// Синхронизировать зарегистрированные скрипты со storage. На случай, если
// после reload расширения часть пропала, или storage был очищен.
async function syncRegistrations() {
  const sites = await getUserSites();
  const allRegistered = await chrome.scripting.getRegisteredContentScripts({});
  const ours = allRegistered.filter((s) => s.id.startsWith('user-'));
  const oursIds = new Set(ours.map((s) => s.id));
  const wantIds = new Set(sites.map(scriptId));

  // Удалить устаревшие.
  const toUnregister = [...oursIds].filter((id) => !wantIds.has(id));
  if (toUnregister.length) {
    await chrome.scripting.unregisterContentScripts({ ids: toUnregister });
  }

  // Зарегистрировать новые (если permission всё ещё есть).
  for (const host of sites) {
    if (oursIds.has(scriptId(host))) continue;
    try {
      await registerForHost(host);
    } catch (err) {
      console.warn('[BYN Converter] не смог зарегистрировать', host, err.message);
    }
  }
}

// ---------- Жизненный цикл ----------

chrome.runtime.onInstalled.addListener(async () => {
  await fetchRates();
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MIN });
  await syncRegistrations();
});

chrome.runtime.onStartup.addListener(async () => {
  const { ratesPayload } = await chrome.storage.local.get('ratesPayload');
  const stale = !ratesPayload || (Date.now() - ratesPayload.fetchedAt) > 6 * 60 * 60 * 1000;
  if (stale) await fetchRates();
  await syncRegistrations();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchRates();
});

// Если пользователь отозвал permission через chrome://extensions — снимаем
// и регистрацию, и запись в allowlist. Сериализуем через очередь — несколько
// одновременных revoke'ов иначе делают read-modify-write на userSites гонкой.
let revokeQueue = Promise.resolve();

chrome.permissions.onRemoved.addListener((perm) => {
  revokeQueue = revokeQueue
    .then(() => handlePermissionRemoved(perm))
    .catch((err) => console.error('[BYN Converter] revoke handler failed:', err));
});

async function handlePermissionRemoved(perm) {
  if (!perm.origins?.length) return;
  const removedHosts = perm.origins
    .map(hostnameFromPattern)
    .filter((h) => h && h !== '*');
  if (removedHosts.length === 0) return;

  const sites = await getUserSites();
  const remaining = sites.filter((h) => !removedHosts.includes(h));
  if (remaining.length !== sites.length) {
    await setUserSites(remaining);
  }
  for (const host of removedHosts) {
    await unregisterForHost(host).catch(() => {});
  }
}

function hostnameFromPattern(pattern) {
  try {
    return new URL(pattern.replace('*://', 'https://').replace('/*', '')).hostname;
  } catch {
    return null;
  }
}

// ---------- Message bus ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh-rates') {
    fetchRates().then((payload) => sendResponse({ ok: !!payload, payload }));
    return true;
  }

  if (msg.type === 'add-site') {
    (async () => {
      const host = msg.hostname;
      if (!host || BUILT_IN_HOSTS.has(host)) {
        sendResponse({ ok: false, error: 'invalid or built-in host' });
        return;
      }
      try {
        await registerForHost(host);
        const sites = await getUserSites();
        if (!sites.includes(host)) {
          sites.push(host);
          await setUserSites(sites);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'remove-site') {
    (async () => {
      const host = msg.hostname;
      if (!host) {
        sendResponse({ ok: false, error: 'no hostname' });
        return;
      }
      await unregisterForHost(host).catch(() => {});
      const sites = await getUserSites();
      await setUserSites(sites.filter((h) => h !== host));
      await chrome.permissions.remove({ origins: [originPattern(host)] }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'list-sites') {
    getUserSites().then((sites) => sendResponse({ ok: true, sites, builtIn: [...BUILT_IN_HOSTS] }));
    return true;
  }
});

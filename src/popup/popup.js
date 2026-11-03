/**
 * Popup: renders one switch per registered feature and persists changes to
 * chrome.storage.sync. The content script picks the change up live.
 *
 * Access is optional. Until the user clicks "Enable on Microsoft Teams",
 * Chrome has not granted the Teams origin, nothing is injected, and the
 * switches stay locked.
 */
(function () {
  'use strict';

  const { STORAGE_KEY, FEATURES, normalize } = globalThis.TeamsPlusPlus;
  const STATUS_DEFAULT = 'Settings sync automatically across all your devices.';

  /** The only sites Teams++ ever touches. Requested optionally, on a click. */
  const TEAMS_ORIGINS = [
    'https://teams.microsoft.com/*',
    'https://teams.cloud.microsoft/*',
    'https://teams.live.com/*'
  ];

  const list = document.getElementById('features');
  const status = document.getElementById('status');
  const tipBtn = document.getElementById('tipBtn');
  const welcomeLink = document.getElementById('welcomeLink');
  const versionLink = document.getElementById('versionLink');
  const enableCard = document.getElementById('enableCard');
  const enableBtn = document.getElementById('enableBtn');
  const settingsGroup = document.getElementById('settingsGroup');
  const inputs = new Map();

  /**
   * One tooltip at a time, positioned by script.
   *
   * The hints used to be a CSS pseudo-element hung off the icon, which put them
   * above it — and above the first card there is no room in the popup, so the
   * top of the text was cut off. This measures the popup and places the tip
   * below the icon, or above it when below would overflow, so the whole hint is
   * always inside the window.
   */
  let tipEl = null;
  let tipTimer = 0;

  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = 0;
    tipEl?.remove();
    tipEl = null;
  }

  function showTip(anchor, text) {
    hideTip();

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    document.body.append(tip);
    tipEl = tip;

    const margin = 8;
    const icon = anchor.getBoundingClientRect();
    const box = tip.getBoundingClientRect();

    let left = icon.left + icon.width / 2 - box.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

    let top = icon.bottom + 6;
    if (top + box.height > window.innerHeight - margin) top = icon.top - box.height - 6;

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(top, margin))}px`;
  }

  function attachTip(anchor, text) {
    anchor.addEventListener('mouseenter', () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(anchor, text), 130);
    });
    anchor.addEventListener('mouseleave', hideTip);
    anchor.addEventListener('focus', () => showTip(anchor, text));
    anchor.addEventListener('blur', hideTip);
  }

  function renderRow(feature) {
    const card = document.createElement('div');
    card.className = 'card';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = feature.label;

    const info = document.createElement('span');
    info.className = 'info-icon';
    info.setAttribute('role', 'img');
    info.setAttribute('aria-label', feature.hint);
    info.tabIndex = 0;
    attachTip(info, feature.hint);
    label.append(info);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.featureId = feature.id;
    input.setAttribute('aria-label', feature.label);

    const slider = document.createElement('span');
    slider.className = 'slider';

    switchLabel.append(input, slider);
    card.append(label, switchLabel);

    input.addEventListener('change', save);

    inputs.set(feature.id, input);
    return card;
  }

  /** Apply a state object to the checkboxes without triggering saves. */
  function fill(state) {
    for (const [id, input] of inputs) {
      input.checked = Boolean(state[id]);
    }
  }

  let statusTimer = 0;

  function setStatus(text, color) {
    status.textContent = text;
    status.style.color = color || '';
    clearTimeout(statusTimer);
    if (text === STATUS_DEFAULT) return;
    statusTimer = setTimeout(() => {
      status.textContent = STATUS_DEFAULT;
      status.style.color = '';
    }, 3000);
  }

  function save() {
    const next = {};
    for (const [id, input] of inputs) next[id] = input.checked;

    chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Could not save changes.', '#b91c1c');
        return;
      }
      setStatus('Settings saved and synced!', '#4b53a0');
    });
  }

  /**
   * Without site access nothing is injected, so the switches stay locked and
   * the Enable button takes their place.
   */
  function setAccessState(granted) {
    if (enableCard) enableCard.hidden = granted;
    if (settingsGroup) settingsGroup.classList.toggle('is-locked', !granted);
    for (const input of inputs.values()) input.disabled = !granted;
  }

  function checkAccess() {
    if (!chrome.permissions || !chrome.permissions.contains) {
      setAccessState(false);
      return;
    }
    chrome.permissions.contains({ origins: TEAMS_ORIGINS }, (granted) => {
      setAccessState(Boolean(granted) && !chrome.runtime.lastError);
    });
  }

  // Must run straight from the click: Chrome only prompts for a gesture.
  if (enableBtn) {
    enableBtn.addEventListener('click', () => {
      enableBtn.disabled = true;
      chrome.permissions.request({ origins: TEAMS_ORIGINS }, (granted) => {
        enableBtn.disabled = false;
        if (chrome.runtime.lastError || !granted) {
          setStatus('Access was not granted, so Teams++ stays off.', '#b91c1c');
          return;
        }
        setAccessState(true);
        // The background worker registers the content script and refreshes
        // Teams tabs that are already open.
        chrome.runtime.sendMessage(
          { type: 'teams-access-changed', granted: true },
          () => void chrome.runtime.lastError
        );
        setStatus('Enabled — open Microsoft Teams to see it.', '#6264a7');
      });
    });
  }

  // Locked features are part of the extension rather than a preference: the
  // pin bars have no switch, so no row is drawn for them.
  for (const feature of FEATURES) {
    if (feature.locked) continue;
    list.append(renderRow(feature));
  }

  // A tooltip never outlives the popup or the scroll it was placed against.
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);

  chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
    fill(normalize(items[STORAGE_KEY]));
  });

  // Reflect edits made in another popup window or synced from another device.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    fill(normalize(changes[STORAGE_KEY].newValue));
  });

  if (tipBtn) {
    tipBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://ko-fi.com/coolpuddytat' });
    });
  }

  if (welcomeLink) {
    welcomeLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    });
  }

  if (versionLink) {
    versionLink.textContent = `v. ${chrome.runtime.getManifest().version}`;
    versionLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('changelog.html') });
    });
  }

  checkAccess();
})();

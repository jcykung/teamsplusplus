/**
 * Popup: renders one checkbox per registered feature and persists changes to
 * chrome.storage.sync. The content script picks the change up live.
 */
(function () {
  'use strict';

  const { STORAGE_KEY, FEATURES, normalize } = globalThis.BetterTeams;

  const list = document.getElementById('features');
  const status = document.getElementById('status');
  const inputs = new Map();

  function renderRow(feature) {
    const row = document.createElement('label');
    row.className = 'feature';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.featureId = feature.id;

    const text = document.createElement('span');
    text.className = 'feature-text';

    const label = document.createElement('span');
    label.className = 'feature-label';
    label.textContent = feature.label;

    const hint = document.createElement('span');
    hint.className = 'feature-hint';
    hint.textContent = feature.hint;

    text.append(label, hint);
    row.append(input, text);

    input.addEventListener('change', () => save());

    inputs.set(feature.id, input);
    return row;
  }

  /** Apply a state object to the checkboxes without triggering saves. */
  function fill(state) {
    for (const [id, input] of inputs) {
      input.checked = Boolean(state[id]);
    }
  }

  function save() {
    const next = {};
    for (const [id, input] of inputs) next[id] = input.checked;

    chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => {
      status.textContent = chrome.runtime.lastError ? 'Could not save changes.' : 'Saved.';
    });
  }

  for (const feature of FEATURES) list.append(renderRow(feature));

  chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
    fill(normalize(items[STORAGE_KEY]));
  });

  // Reflect edits made in another popup window or synced from another device.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    fill(normalize(changes[STORAGE_KEY].newValue));
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const changelogLink = document.getElementById('changelogLink');
  const tipBtn = document.getElementById('tipBtn');
  const permissionNote = document.getElementById('permissionNote');

  // Site access is optional: Chrome asks for the Teams origins only when the
  // user clicks, never at install.
  const TEAMS_ORIGINS = [
    'https://teams.microsoft.com/*',
    'https://teams.cloud.microsoft/*',
    'https://teams.live.com/*'
  ];
  let accessGranted = false;

  function render() {
    if (startBtn) {
      startBtn.textContent = accessGranted
        ? 'Open Microsoft Teams'
        : 'Enable on Microsoft Teams';
    }
    if (permissionNote) {
      permissionNote.textContent = accessGranted
        ? 'Enabled. Teams++ now runs on Microsoft Teams — open a channel to see your inbox.'
        : 'Chrome will ask for access to Teams once. Teams++ only reads the page you are already on, and never sends anything anywhere.';
    }
  }

  function setAccessState(granted) {
    accessGranted = Boolean(granted);
    render();
  }

  function checkAccess() {
    if (!chrome.permissions || !chrome.permissions.contains) return setAccessState(false);
    chrome.permissions.contains({ origins: TEAMS_ORIGINS }, (granted) => {
      setAccessState(Boolean(granted) && !chrome.runtime.lastError);
    });
  }

  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (accessGranted) {
        chrome.tabs.create({ url: 'https://teams.microsoft.com/' });
        return;
      }
      // Must run straight from the click: Chrome only prompts for a gesture.
      chrome.permissions.request({ origins: TEAMS_ORIGINS }, (granted) => {
        if (chrome.runtime.lastError || !granted) return;
        setAccessState(true);
        // The background worker registers the content script and refreshes any
        // Teams tab that is already open.
        chrome.runtime.sendMessage(
          { type: 'teams-access-changed', granted: true },
          () => void chrome.runtime.lastError
        );
      });
    });
  }

  if (changelogLink) {
    changelogLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('changelog.html') });
    });
  }

  if (tipBtn) {
    tipBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://ko-fi.com/coolpuddytat' });
    });
  }

  checkAccess();
});

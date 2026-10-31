document.addEventListener('DOMContentLoaded', () => {
  const welcomeBtn = document.getElementById('welcomeBtn');
  const closeBtn = document.getElementById('closeBtn');
  const tipBtn = document.getElementById('tipBtn');

  if (welcomeBtn) {
    welcomeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  if (tipBtn) {
    tipBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://ko-fi.com/coolpuddytat' });
    });
  }
});

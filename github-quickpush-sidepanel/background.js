/* ──────────────────────────────────────────────────────────────
   background.js — Service Worker (Manifest V3)
   Handles: context menus, side panel opening, message routing
   ────────────────────────────────────────────────────────────── */

// ── Context Menu Setup ──────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'quickpush-snippet',
    title: 'Push snippet to GitHub',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'quickpush-snippet-gist',
    parentId: 'quickpush-snippet',
    title: 'Create as Gist',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'quickpush-snippet-cheatsheet',
    parentId: 'quickpush-snippet',
    title: 'Append to Cheat Sheet',
    contexts: ['selection'],
  });

  // Enable side panel on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('SidePanel behavior error:', err));
});

// ── Context Menu Click Handler ──────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.selectionText) return;

  const payload = {
    text: info.selectionText,
    pageUrl: tab?.url || '',
    pageTitle: tab?.title || '',
  };

  if (info.menuItemId === 'quickpush-snippet-gist') {
    payload.action = 'create-gist';
  } else if (info.menuItemId === 'quickpush-snippet-cheatsheet') {
    payload.action = 'append-cheatsheet';
  } else {
    return;
  }

  // Open side panel for this tab and relay the snippet
  try {
    if (tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (e) {
    console.warn('Could not open side panel:', e);
  }

  // Give side panel a moment to initialize, then send the snippet
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'SNIPPET_FROM_CONTEXT_MENU',
      payload,
    }).catch(() => {
      // Side panel may not be ready yet; store and retry
      chrome.storage.session.set({ pendingSnippet: payload });
    });
  }, 600);
});

// ── Message Router ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Side panel asking for active tab info (for Bookmark mode)
  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ title: tabs[0].title, url: tabs[0].url });
      } else {
        sendResponse({ title: '', url: '' });
      }
    });
    return true; // async response
  }

  // Side panel checking for pending snippet from context menu
  if (message.type === 'CHECK_PENDING_SNIPPET') {
    chrome.storage.session.get('pendingSnippet', (data) => {
      if (data.pendingSnippet) {
        sendResponse(data.pendingSnippet);
        chrome.storage.session.remove('pendingSnippet');
      } else {
        sendResponse(null);
      }
    });
    return true;
  }

  return false;
});

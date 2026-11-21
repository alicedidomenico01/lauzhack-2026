// Opens the side panel when the toolbar icon is clicked.
// Nothing else lives in the service worker: it is not where we do the work,
// because a MV3 service worker cannot hold a microphone stream.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("sidePanel behavior:", err));

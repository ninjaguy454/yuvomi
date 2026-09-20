// No identity, credentials or Task data crosses the popup boundary. The opener
// reads its scoped receipt through the authenticated, context-bound device API.
if (window.opener) {
  window.opener.postMessage({type:'device-approval-return'},location.origin);
  window.close();
}

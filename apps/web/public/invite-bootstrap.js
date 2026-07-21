(() => {
  "use strict";
  const token = new URLSearchParams(window.location.hash.slice(1)).get("invite")?.trim() ?? "";
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    window.sessionStorage.setItem("stuga-invitation-token", token);
  }
  window.history.replaceState(window.history.state, "", "/invite-bootstrap");
  window.location.replace("/");
})();

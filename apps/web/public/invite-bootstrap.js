(() => {
  "use strict";
  const fragment = window.location.hash.slice(1);
  const stugbyInvitation = fragment.trim();
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}$/i.test(stugbyInvitation)) {
    const invitationUrl = `${window.location.origin}/invite-bootstrap#${stugbyInvitation}`;
    window.history.replaceState(window.history.state, "", "/invite-bootstrap");
    document.title = "Join a Stugby";
    const message = document.querySelector("p");
    if (message) {
      message.textContent = "Copy this one-time invitation and paste it into the Stugby page on the Stuga that should join. The secret stays in this tab and is not sent to this server.";
    }
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Stugby invitation");
    input.value = invitationUrl;
    input.addEventListener("focus", () => input.select());
    document.body.append(input);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy invitation";
    copy.addEventListener("click", () => {
      input.select();
      if (!navigator.clipboard) return;
      void navigator.clipboard.writeText(invitationUrl).then(() => {
        copy.textContent = "Copied";
      }).catch(() => {
        copy.textContent = "Select and copy the invitation";
      });
    });
    document.body.append(copy);
    return;
  }

  const token = new URLSearchParams(fragment).get("invite")?.trim() ?? "";
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    window.sessionStorage.setItem("stuga-invitation-token", token);
  }
  window.history.replaceState(window.history.state, "", "/invite-bootstrap");
  window.location.replace("/");
})();

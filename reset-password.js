(function () {
  "use strict";

  // Captured before the Supabase client (created below) processes and may
  // strip the URL fragment, so we have our own record of what kind of link
  // this was, independent of the SDK's own hash handling.
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var queryParams = new URLSearchParams(window.location.search);
  var isRecoveryLink = hashParams.get("type") === "recovery" || queryParams.get("type") === "recovery";
  var linkError = hashParams.get("error") || queryParams.get("error");

  // Removes the access/refresh tokens from the visible URL and browser
  // history once we no longer need them there — they're a live credential
  // for this account and shouldn't linger in the address bar, history, or
  // anywhere they could be copy-pasted (e.g. into a support request).
  function scrubUrl() {
    window.history.replaceState(null, "", window.location.pathname);
  }

  var sb = window.supabase.createClient(
    window.PASSBOOK_CONFIG.SUPABASE_URL,
    window.PASSBOOK_CONFIG.SUPABASE_ANON_KEY
  );

  var verified = false;

  function showForm() {
    if (verified) return;
    verified = true;
    scrubUrl();
    document.getElementById("status-tagline").textContent = "Choose a new password";
    document.getElementById("verify-error").hidden = true;
    document.getElementById("back-link").hidden = true;
    document.getElementById("reset-form").hidden = false;
  }

  function showInvalid() {
    if (verified) return;
    scrubUrl();
    document.getElementById("status-tagline").textContent = "Reset link";
    document.getElementById("verify-error").hidden = false;
    document.getElementById("back-link").hidden = false;
  }

  // Supabase surfaces an expired/used recovery link as error params on the
  // redirect URL rather than firing PASSWORD_RECOVERY. Also refuse to show
  // the form for any session that isn't from this specific recovery link —
  // e.g. an ordinary signed-in session on this device/tab shouldn't be
  // enough to change the password without knowing the current one.
  if (linkError || !isRecoveryLink) {
    showInvalid();
  } else {
    sb.auth.onAuthStateChange(function (event) {
      if (event === "PASSWORD_RECOVERY") showForm();
    });
    setTimeout(function () { if (!verified) showInvalid(); }, 4000);
  }

  document.getElementById("reset-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var errEl = document.getElementById("reset-error");
    var submitBtn = document.getElementById("reset-submit");
    errEl.hidden = true;

    var password = document.getElementById("new-password").value;
    var confirm = document.getElementById("confirm-password").value;

    if (password.length < 6) {
      errEl.textContent = "Password must be at least 6 characters.";
      errEl.hidden = false;
      return;
    }
    if (password !== confirm) {
      errEl.textContent = "Passwords don't match.";
      errEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    sb.auth.updateUser({ password: password }).then(function (res) {
      if (res.error) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Set new password";
        errEl.textContent = res.error.message || "Could not update password.";
        errEl.hidden = false;
        return;
      }
      sb.auth.signOut().then(function () {
        document.getElementById("reset-form").hidden = true;
        document.getElementById("reset-success").hidden = false;
      });
    });
  });
})();

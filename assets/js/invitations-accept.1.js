    (() => {
      const iv = (k) => (window.TF_I18N ? window.TF_I18N.t('invite.' + k, k) : k);
      const LANG_NAMES = {en:'🇬🇧 English',fr:'🇫🇷 Français',de:'🇩🇪 Deutsch',it:'🇮🇹 Italiano',es:'🇪🇸 Español',nl:'🇳🇱 Nederlands',pt:'🇵🇹 Português'};
      function mountLangSelect() {
        const slot = document.getElementById('invite-lang-slot');
        const api = window.TF_I18N;
        if (!slot || !api) return;
        slot.innerHTML = `<select id="invite-lang-select" aria-label="Language">${api.supported.map((l) => `<option value="${l}"${l === api.lang ? ' selected' : ''}>${LANG_NAMES[l] || l}</option>`).join('')}</select>`;
        slot.firstChild.onchange = (e) => api.setLanguage(e.target.value);
      }
      const token = new URLSearchParams(location.search).get('token');
      if (token) history.replaceState({}, document.title, `${location.pathname}${location.hash}`);
      const message = document.getElementById('message');
      const signIn = document.getElementById('clerk-sign-in');
      const actions = document.getElementById('actions');
      const acceptButton = document.getElementById('accept-button');
      let clerk;
      let accepted = false;
      let lastMessage = null;
      function show(text, kind) { message.textContent = text; message.className = `message ${kind || ''}`; }
      // Memorise le rendu plutot que la chaine : au changement de langue on
      // rejoue la fonction et le message suit, comme le reste de la page.
      function showFn(fn, kind) { lastMessage = () => show(fn(), kind); lastMessage(); }
      function errorLabel(error) {
        const connu = ({ invalid_invitation_token:iv('errInvalidToken'), invalid_or_expired_invitation:iv('errExpired'), invitation_email_mismatch:iv('errEmailMismatch'), user_already_member:iv('errAlreadyMember'), unauthorized:iv('errUnauthorized') })[error];
        if (connu) return connu;
        if (error) console.error('[tracefab] invitation:', error);
        return iv('errGeneric');
      }
      async function accept() {
        if (accepted || !clerk?.user || !token) return;
        accepted = true; acceptButton.disabled = true; showFn(() => iv('validating'));
        try {
          const authToken = await clerk.session.getToken();
          const response = await fetch('/api/invitations/accept', { method:'POST', headers:{ 'Content-Type':'application/json', ...(authToken ? { Authorization:`Bearer ${authToken}` } : {}) }, body:JSON.stringify({ invitationToken:token }) });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || `request_failed_${response.status}`);
          showFn(() => iv('accepted'), 'success');
          actions.hidden = false; acceptButton.hidden = true;
        } catch (error) { accepted = false; acceptButton.disabled = false; showFn(() => errorLabel(error.message), 'error'); actions.hidden = false; }
      }
      async function boot() {
        if (!token || token.length > 256) { showFn(() => iv('errMissingToken'), 'error'); return; }
        try {
          const config = await fetch('/api/config').then((response) => response.json());
          if (!config.publishableKey) throw new Error(config.error || 'clerk_not_configured');
          await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js'; script.onload = resolve; script.onerror = () => reject(new Error('clerk_sdk_unavailable')); document.head.appendChild(script); });
          clerk = new window.Clerk(config.publishableKey); await clerk.load();
          clerk.addListener(() => { if (clerk.user) { signIn.hidden = true; actions.hidden = false; showFn(() => `${iv('signedInAs')} ${clerk.user.primaryEmailAddress?.emailAddress || iv('fallbackUser')}. ${iv('clickToAccept')}`); } });
          if (clerk.user) { signIn.hidden = true; actions.hidden = false; showFn(() => `${iv('signedInAs')} ${clerk.user.primaryEmailAddress?.emailAddress || iv('fallbackUser')}. ${iv('clickToAccept')}`); }
          else { clerk.mountSignIn(signIn, { routing:'hash', appearance:{ elements:{ card:'shadow-none', rootBox:'w-full' } } }); showFn(() => iv('signInPrompt')); }
        } catch (error) { if (error && error.message) console.error('[tracefab] invitation boot:', error.message);
          showFn(() => iv('errUnavailable'), 'error'); }
      }
      acceptButton.addEventListener('click', () => accept());
      document.addEventListener('tf:languagechange', () => { mountLangSelect(); if (lastMessage) lastMessage(); });
      (window.TF_I18N ? window.TF_I18N.setLanguage(window.TF_I18N.lang) : Promise.resolve())
        .then(mountLangSelect, mountLangSelect)
        .then(boot, boot);
    })();
  

(function() {
  const body = document.body;
  const status = document.getElementById('wiki-share-status');
  const applyTheme = (isDark) => {
    body.classList.toggle('jp-mod-dark', isDark);
    body.classList.toggle('jp-mod-light', !isDark);
    body.setAttribute('data-jp-theme-light', String(!isDark));
    body.setAttribute('data-jp-theme-name', isDark ? 'JupyterLab Dark' : 'JupyterLab Light');
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  applyTheme(media.matches);
  if (media.addEventListener) {
    media.addEventListener('change', (event) => applyTheme(event.matches));
  } else if (media.addListener) {
    media.addListener((event) => applyTheme(event.matches));
  }
  const announce = (message) => {
    if (!status) {
      return;
    }
    status.textContent = message;
    window.setTimeout(() => { status.textContent = ''; }, 1500);
  };
  body.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-share]');
    if (!trigger) {
      return;
    }
    event.preventDefault();
    const shareTarget = trigger.getAttribute('data-share') || window.location.pathname;
    const url = new URL(shareTarget, window.location.origin).toString();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        trigger.classList.add('wiki-share-success');
        window.setTimeout(() => trigger.classList.remove('wiki-share-success'), 1500);
        announce('Link copied to clipboard.');
      }).catch(() => {
        window.prompt('Copy this link', url);
      });
    } else {
      window.prompt('Copy this link', url);
    }
  });

  /* ── sidebar navigation ───────────────────────────────────── */
  const sidebar = document.querySelector('.wiki-sidebar');
  if (!sidebar) return;

  const currentPath = window.location.pathname;

  // Determine nav.json URL relative to this page
  // Pages live in /wiki/ or /wiki/subdir/ — nav.json is at /wiki/nav.json
  const navJsonUrl = (() => {
    const wikiIdx = currentPath.indexOf('/wiki/');
    if (wikiIdx !== -1) {
      return currentPath.substring(0, wikiIdx) + '/wiki/nav.json';
    }
    return '/wiki/nav.json';
  })();

  function renderNav(tree, depth) {
    depth = depth || 0;
    let html = '';

    // Render pages at this level
    if (tree.pages && tree.pages.length) {
      const cls = depth > 0 ? 'wiki-nav-items wiki-nav-nested' : 'wiki-nav-items';
      html += '<ul class="' + cls + '">';
      for (let i = 0; i < tree.pages.length; i++) {
        const p = tree.pages[i];
        const isActive = currentPath === p.href || currentPath === p.href.replace(/\.html$/, '/');
        html += '<li class="wiki-nav-item' + (isActive ? ' active' : '') + '">';
        html += '<a href="' + p.href + '">' + escHtml(p.title) + '</a></li>';
      }
      html += '</ul>';
    }

    // Render subdirectories
    if (tree.dirs && tree.dirs.length) {
      for (let i = 0; i < tree.dirs.length; i++) {
        const d = tree.dirs[i];
        // auto-expand if current page is inside this directory
        const isInside = currentPath.indexOf(d.href.replace(/index\.html$/, '')) === 0;
        html += '<div class="wiki-nav-section">';
        html += '<div class="wiki-nav-folder-header" data-wiki-toggle>';
        html += '<span class="wiki-nav-arrow' + (isInside ? ' open' : '') + '">&#9654;</span>';
        html += '<a href="' + d.href + '" style="color:inherit;text-decoration:none">' + escHtml(d.name) + '</a>';
        html += '</div>';
        html += '<div class="wiki-nav-items' + (isInside ? '' : ' collapsed') + '">';
        html += renderNav(d, depth + 1);
        html += '</div></div>';
      }
    }
    return html;
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  fetch(navJsonUrl)
    .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function(tree) {
      let html = '<div style="padding:0.5rem 0.75rem;font-weight:600;font-size:14px">';
      html += '<a href="/wiki/index.html" style="color:inherit;text-decoration:none">Wiki</a></div>';
      html += renderNav(tree, 0);
      sidebar.innerHTML = html;
    })
    .catch(function() {
      sidebar.innerHTML = '<div style="padding:1rem;color:var(--jp-ui-font-color2)">Navigation unavailable</div>';
    });

  // Toggle folder sections in sidebar
  sidebar.addEventListener('click', function(event) {
    const header = event.target.closest('[data-wiki-toggle]');
    if (!header) return;
    // Don't toggle if they clicked the link
    if (event.target.tagName === 'A') return;
    event.preventDefault();
    const arrow = header.querySelector('.wiki-nav-arrow');
    const items = header.nextElementSibling;
    if (items) {
      items.classList.toggle('collapsed');
      if (arrow) arrow.classList.toggle('open');
    }
  });
})();

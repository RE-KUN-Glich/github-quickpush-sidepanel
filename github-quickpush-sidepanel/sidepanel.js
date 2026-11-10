/* ──────────────────────────────────────────────────────────────
   sidepanel.js — Main UI Controller
   Handles: DOM events, drag-and-drop, staging tree, file scanning,
            settings/token validation, mode switching, push orchestration.
   ────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const state = {
    proMode: false,
    activeMode: 'repo',
    token: '',
    user: null,
    repos: [],
    // Repo mode
    repoFiles: [],          // { path, file, size, excluded, sensitive }
    stagedPaths: new Set(),
    // File mode
    singleFiles: [],        // { file, name }
    // Bookmark
    bookmarkTitle: '',
    bookmarkUrl: '',
    // Release
    releaseAsset: null,
    // Busy
    pushing: false,
  };

  const api = new GitHubAPI();

  // ── Safe-Clean Exclusion Patterns ──────────────────────────
  const EXCLUDE_DIRS = [
    'node_modules', '.git', '__pycache__', '.next', '.nuxt',
    '.cache', '.parcel-cache', 'target', 'dist', 'build',
    '.idea', '.vscode', '.DS_Store', 'coverage', '.nyc_output',
    'vendor', 'bower_components',
  ];
  const EXCLUDE_FILES = ['.env', '.env.local', '.env.production', '.DS_Store', 'Thumbs.db'];
  const SENSITIVE_PATTERNS = [
    /\.env$/i,
    /\.pem$/i,
    /\.key$/i,
    /id_rsa/i,
    /id_ed25519/i,
    /\.p12$/i,
    /credentials\.json$/i,
    /secret/i,
  ];
  const SENSITIVE_CONTENT_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,                       // AWS Access Key
    /ghp_[A-Za-z0-9_]{36}/,                   // GitHub PAT (classic)
    /github_pat_[A-Za-z0-9_]{22,}/,           // GitHub PAT (fine-grained)
    /sk-[A-Za-z0-9]{48}/,                     // OpenAI key
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,  // Private keys
    /PRIVATE KEY/,
    /aws_secret_access_key\s*=\s*\S+/i,
  ];
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
  const WARN_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

  // ── DOM References ─────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    // Header
    userInfo:        $('#user-info'),
    userAvatar:      $('#user-avatar'),
    userLogin:       $('#user-login'),
    rateLimitBadge:  $('#rate-limit-badge'),
    settingsToggle:  $('#settings-toggle'),
    // Settings
    settingsPanel:   $('#settings-panel'),
    patInput:        $('#pat-input'),
    togglePatVis:    $('#toggle-pat-vis'),
    tokenStatus:     $('#token-status'),
    saveTokenBtn:    $('#save-token-btn'),
    proModeToggle:   $('#pro-mode-toggle'),
    // Tabs
    tabs:            $$('.tab'),
    panels:          $$('.mode-panel'),
    // Repo mode
    repoDropzone:    $('#repo-dropzone'),
    repoFolderInput: $('#repo-folder-input'),
    scannerAlerts:   $('#scanner-alerts'),
    stagingArea:     $('#staging-area'),
    fileTree:        $('#file-tree'),
    stagedCount:     $('#staged-count'),
    selectAllBtn:    $('#select-all-btn'),
    deselectAllBtn:  $('#deselect-all-btn'),
    fileSummary:     $('#file-summary'),
    summaryText:     $('#summary-text'),
    repoControls:    $('#repo-controls'),
    repoSelect:      $('#repo-select'),
    repoNewRepoBtn:  $('#repo-new-repo-btn'),
    repoNewRepoDrawer: $('#repo-new-repo-drawer'),
    repoNewRepoName: $('#repo-new-repo-name'),
    repoNewRepoPrivate: $('#repo-new-repo-private'),
    repoCreateRepoBtn: $('#repo-create-repo-btn'),
    repoCancelRepoBtn: $('#repo-cancel-repo-btn'),
    branchControls:  $('#branch-controls'),
    branchSelect:    $('#branch-select'),
    newBranchBtn:    $('#new-branch-btn'),
    newBranchRow:    $('#new-branch-input-row'),
    newBranchName:   $('#new-branch-name'),
    createBranchBtn: $('#create-branch-btn'),
    cancelBranchBtn: $('#cancel-branch-btn'),
    commitTitle:     $('#commit-title'),
    commitBody:      $('#commit-body'),
    // File mode
    fileDropzone:    $('#file-dropzone'),
    fileInput:       $('#file-file-input'),
    fileList:        $('#file-list'),
    fileControls:    $('#file-controls'),
    fileDestPath:    $('#file-dest-path'),
    fileRepoSelect:  $('#file-repo-select'),
    fileNewRepoBtn:  $('#file-new-repo-btn'),
    fileNewRepoDrawer: $('#file-new-repo-drawer'),
    fileNewRepoName: $('#file-new-repo-name'),
    fileNewRepoPrivate: $('#file-new-repo-private'),
    fileCreateRepoBtn: $('#file-create-repo-btn'),
    fileCancelRepoBtn: $('#file-cancel-repo-btn'),
    fileBranchCtrl:  $('#file-branch-controls'),
    fileBranchSel:   $('#file-branch-select'),
    fileCommitTitle: $('#file-commit-title'),
    // Gist mode
    gistFilename:    $('#gist-filename'),
    gistContent:     $('#gist-content'),
    gistDescription: $('#gist-description'),
    // Bookmark mode
    clipPageBtn:     $('#clip-page-btn'),
    bookmarkPreview: $('#bookmark-preview'),
    bookmarkTitle:   $('#bookmark-title'),
    bookmarkUrl:     $('#bookmark-url'),
    bookmarkRepoSel: $('#bookmark-repo-select'),
    bookmarkNewRepoBtn: $('#bookmark-new-repo-btn'),
    bookmarkNewRepoDrawer: $('#bookmark-new-repo-drawer'),
    bookmarkNewRepoName: $('#bookmark-new-repo-name'),
    bookmarkNewRepoPrivate: $('#bookmark-new-repo-private'),
    bookmarkCreateRepoBtn: $('#bookmark-create-repo-btn'),
    bookmarkCancelRepoBtn: $('#bookmark-cancel-repo-btn'),
    bookmarkFilePath:$('#bookmark-file-path'),
    bookmarkBranchCtrl: $('#bookmark-branch-controls'),
    bookmarkBranchSel: $('#bookmark-branch-select'),
    // Release mode
    releaseRepoSel:  $('#release-repo-select'),
    releaseNewRepoBtn: $('#release-new-repo-btn'),
    releaseNewRepoDrawer: $('#release-new-repo-drawer'),
    releaseNewRepoName: $('#release-new-repo-name'),
    releaseNewRepoPrivate: $('#release-new-repo-private'),
    releaseCreateRepoBtn: $('#release-create-repo-btn'),
    releaseCancelRepoBtn: $('#release-cancel-repo-btn'),
    releaseTag:      $('#release-tag'),
    releaseTitle:    $('#release-title'),
    releaseBody:     $('#release-body'),
    releaseDraft:    $('#release-draft'),
    releasePrerelease:$('#release-prerelease'),
    releaseDropzone: $('#release-dropzone'),
    releaseFileInput:$('#release-file-input'),
    releaseFileInfo: $('#release-file-info'),
    // Progress
    progressContainer: $('#progress-container'),
    progressBar:     $('#progress-bar'),
    progressText:    $('#progress-text'),
    // Footer
    pushBtn:         $('#push-btn'),
    pushBtnText:     $('#push-btn-text'),
    // Toast
    toast:           $('#toast'),
  };

  // ── Initialization ─────────────────────────────────────────
  async function init() {
    loadSettings();
    bindEvents();
    await tryRestoreToken();
    checkPendingSnippet();
  }

  async function loadSettings() {
    const data = await chromeStorageGet(['github_pat', 'pro_mode']);
    if (data.pro_mode) {
      state.proMode = true;
      els.proModeToggle.checked = true;
    }
    applyMode();
  }

  function applyMode() {
    document.body.classList.toggle('pro-mode', state.proMode);
    document.body.classList.toggle('beginner-mode', !state.proMode);
    $$('.mode-label').forEach((el) => {
      el.classList.toggle('active', el.dataset.mode === (state.proMode ? 'pro' : 'beginner'));
    });
    // Show/hide pro-only elements based on file state
    if (state.repoFiles.length > 0) {
      showStagingOrSummary();
    }
  }

  async function tryRestoreToken() {
    const data = await chromeStorageGet(['github_pat']);
    if (data.github_pat) {
      els.patInput.value = data.github_pat;
      await verifyToken(data.github_pat);
    }
  }

  // ── Event Bindings ─────────────────────────────────────────
  function bindEvents() {
    // Settings toggle
    els.settingsToggle.addEventListener('click', () => {
      els.settingsPanel.classList.toggle('hidden');
    });

    // PAT visibility
    els.togglePatVis.addEventListener('click', () => {
      els.patInput.type = els.patInput.type === 'password' ? 'text' : 'password';
    });

    // Save token
    els.saveTokenBtn.addEventListener('click', () => verifyToken(els.patInput.value.trim()));

    // Pro mode toggle
    els.proModeToggle.addEventListener('change', (e) => {
      state.proMode = e.target.checked;
      chromeStorageSet({ pro_mode: state.proMode });
      applyMode();
    });

    // Mode tabs
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    });

    // Repo dropzone
    setupDropzone(els.repoDropzone, els.repoFolderInput, handleRepoFiles, true);

    // File dropzone
    setupDropzone(els.fileDropzone, els.fileInput, handleSingleFiles, false);

    // Release dropzone
    setupDropzone(els.releaseDropzone, els.releaseFileInput, handleReleaseFile, false);

    // Staging controls
    els.selectAllBtn.addEventListener('click', () => toggleAllStaged(true));
    els.deselectAllBtn.addEventListener('click', () => toggleAllStaged(false));

    // Branch creation
    els.newBranchBtn.addEventListener('click', () => {
      els.newBranchRow.classList.toggle('hidden');
      els.newBranchName.focus();
    });
    els.cancelBranchBtn.addEventListener('click', () => {
      els.newBranchRow.classList.add('hidden');
      els.newBranchName.value = '';
    });
    els.createBranchBtn.addEventListener('click', handleCreateBranch);

    // ── Inline "New Repo" drawers (all 4 modes) ──────────────
    bindNewRepoDrawer({
      toggleBtn:  els.repoNewRepoBtn,
      drawer:     els.repoNewRepoDrawer,
      nameInput:  els.repoNewRepoName,
      privateCb:  els.repoNewRepoPrivate,
      createBtn:  els.repoCreateRepoBtn,
      cancelBtn:  els.repoCancelRepoBtn,
      targetSelect: els.repoSelect,
      branchCtx:  'repo',
    });
    bindNewRepoDrawer({
      toggleBtn:  els.fileNewRepoBtn,
      drawer:     els.fileNewRepoDrawer,
      nameInput:  els.fileNewRepoName,
      privateCb:  els.fileNewRepoPrivate,
      createBtn:  els.fileCreateRepoBtn,
      cancelBtn:  els.fileCancelRepoBtn,
      targetSelect: els.fileRepoSelect,
      branchCtx:  'file',
    });
    bindNewRepoDrawer({
      toggleBtn:  els.bookmarkNewRepoBtn,
      drawer:     els.bookmarkNewRepoDrawer,
      nameInput:  els.bookmarkNewRepoName,
      privateCb:  els.bookmarkNewRepoPrivate,
      createBtn:  els.bookmarkCreateRepoBtn,
      cancelBtn:  els.bookmarkCancelRepoBtn,
      targetSelect: els.bookmarkRepoSel,
      branchCtx:  'bookmark',
    });
    bindNewRepoDrawer({
      toggleBtn:  els.releaseNewRepoBtn,
      drawer:     els.releaseNewRepoDrawer,
      nameInput:  els.releaseNewRepoName,
      privateCb:  els.releaseNewRepoPrivate,
      createBtn:  els.releaseCreateRepoBtn,
      cancelBtn:  els.releaseCancelRepoBtn,
      targetSelect: els.releaseRepoSel,
      branchCtx:  null, // releases don't have branch selects
    });

    // Repo selects — load branches on change
    els.repoSelect.addEventListener('change', () => loadBranches('repo'));
    els.fileRepoSelect.addEventListener('change', () => loadBranches('file'));
    els.bookmarkRepoSel.addEventListener('change', () => loadBranches('bookmark'));

    // Bookmark clip
    els.clipPageBtn.addEventListener('click', handleClipPage);

    // Push button
    els.pushBtn.addEventListener('click', handlePush);
  }

  // ── Token Verification ─────────────────────────────────────
  async function verifyToken(token) {
    if (!token) {
      setTokenStatus('Please enter a token', 'invalid');
      return;
    }
    setTokenStatus('Verifying...', 'checking');
    api.setToken(token);
    try {
      const user = await api.verifyToken();
      state.token = token;
      state.user = user;
      await chromeStorageSet({ github_pat: token });

      // Update header UI
      els.userAvatar.src = user.avatar_url;
      els.userLogin.textContent = user.login;
      els.userInfo.classList.remove('hidden');
      updateRateLimitBadge();

      // Check scopes
      const hasRepo = user.scopes.includes('repo');
      const hasGist = user.scopes.includes('gist');
      const scopeWarnings = [];
      if (!hasRepo) scopeWarnings.push('repo');
      if (!hasGist) scopeWarnings.push('gist');

      if (scopeWarnings.length > 0) {
        setTokenStatus(`⚠ Missing scopes: ${scopeWarnings.join(', ')}`, 'invalid');
      } else {
        setTokenStatus(`✓ Authenticated as ${user.login}`, 'valid');
      }

      // Load repos
      await loadRepos();
    } catch (err) {
      setTokenStatus(`✗ ${err.message}`, 'invalid');
      els.userInfo.classList.add('hidden');
    }
  }

  function setTokenStatus(text, cls) {
    els.tokenStatus.textContent = text;
    els.tokenStatus.className = `token-status ${cls}`;
  }

  function updateRateLimitBadge() {
    const info = api.getRateLimitInfo();
    if (info.remaining === null) return;
    els.rateLimitBadge.textContent = info.remaining;
    els.rateLimitBadge.classList.remove('warning', 'danger');
    if (info.remaining < 100) els.rateLimitBadge.classList.add('danger');
    else if (info.remaining < 500) els.rateLimitBadge.classList.add('warning');
    els.rateLimitBadge.title = `API calls remaining: ${info.remaining}`;
  }

  // ── Repository & Branch Loading ────────────────────────────
  async function loadRepos() {
    try {
      const repos = await api.listRepos(1, 100);
      state.repos = repos;
      const selects = [els.repoSelect, els.fileRepoSelect, els.bookmarkRepoSel, els.releaseRepoSel];
      selects.forEach((sel) => {
        const current = sel.value;
        sel.innerHTML = '<option value="">— Select Repository —</option>';
        repos.forEach((repo) => {
          const opt = document.createElement('option');
          opt.value = `${repo.owner.login}/${repo.name}`;
          opt.textContent = `${repo.owner.login}/${repo.name}`;
          if (repo.private) opt.textContent += ' 🔒';
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      });
    } catch (err) {
      showToast(`Failed to load repos: ${err.message}`, 'error');
    }
  }

  async function loadBranches(context) {
    let repoVal, branchSel;
    if (context === 'repo') {
      repoVal = els.repoSelect.value;
      branchSel = els.branchSelect;
    } else if (context === 'file') {
      repoVal = els.fileRepoSelect.value;
      branchSel = els.fileBranchSel;
    } else if (context === 'bookmark') {
      repoVal = els.bookmarkRepoSel.value;
      branchSel = els.bookmarkBranchSel;
    }
    if (!repoVal || !branchSel) return;

    const [owner, repo] = repoVal.split('/');
    try {
      const branches = await api.listBranches(owner, repo);
      branchSel.innerHTML = '';
      branches.forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name;
        branchSel.appendChild(opt);
      });
      updateRateLimitBadge();
    } catch (err) {
      showToast(`Failed to load branches: ${err.message}`, 'error');
    }
  }

  // ── Mode Switching ─────────────────────────────────────────
  function switchMode(mode) {
    state.activeMode = mode;
    els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    els.panels.forEach((p) => p.classList.toggle('active', p.dataset.mode === mode));
    updatePushButton();
  }

  // ── Dropzone Setup ─────────────────────────────────────────
  function setupDropzone(dropzone, fileInput, handler, isFolder) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.items) {
        const entries = [];
        for (const item of e.dataTransfer.items) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) entries.push(entry);
        }
        if (isFolder && entries.length > 0) {
          readEntriesRecursive(entries).then(handler);
        } else {
          const files = Array.from(e.dataTransfer.files);
          handler(files);
        }
      }
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      handler(files);
      fileInput.value = '';
    });
  }

  // ── Read Directory Entries Recursively ─────────────────────
  function readEntriesRecursive(entries) {
    const files = [];
    function readEntry(entry, basePath = '') {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((file) => {
            // Preserve relative path
            const path = basePath ? `${basePath}/${entry.name}` : entry.name;
            file._relativePath = path;
            files.push(file);
            resolve();
          });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
          readAll(reader, dirPath).then(resolve);
        } else {
          resolve();
        }
      });
    }
    function readAll(reader, basePath) {
      return new Promise((resolve) => {
        const allEntries = [];
        function readBatch() {
          reader.readEntries(async (batch) => {
            if (batch.length === 0) {
              await Promise.all(allEntries.map((e) => readEntry(e, basePath)));
              resolve();
            } else {
              allEntries.push(...batch);
              readBatch();
            }
          });
        }
        readBatch();
      });
    }
    return Promise.all(entries.map((e) => readEntry(e))).then(() => files);
  }

  // ── Repo Mode: Handle Dropped Folder ──────────────────────
  async function handleRepoFiles(files) {
    if (files.length === 0) return;

    // Build file list with relative paths
    state.repoFiles = files.map((f) => {
      const path = f._relativePath || f.webkitRelativePath || f.name;
      return {
        path,
        file: f,
        size: f.size,
        excluded: false,
        sensitive: false,
        reason: '',
      };
    });

    // Run safety scanner
    await runSafetyScanner();

    // Show staging or summary
    showStagingOrSummary();

    // Show controls
    els.repoControls.classList.remove('hidden');
    els.repoDropzone.classList.add('has-files');

    // Auto-generate commit message
    const rootFolder = state.repoFiles[0]?.path.split('/')[0] || 'files';
    if (!els.commitTitle.value) {
      els.commitTitle.value = `Add ${rootFolder}`;
    }

    updatePushButton();
  }

  // ── Safety Scanner ─────────────────────────────────────────
  async function runSafetyScanner() {
    const alerts = [];
    const sensitiveFiles = [];
    const largeFiles = [];
    const oversizedFiles = [];
    let hasReadme = false;

    for (const item of state.repoFiles) {
      const segments = item.path.split('/');

      // Check exclusion dirs
      const inExcludedDir = segments.some((seg) =>
        EXCLUDE_DIRS.includes(seg)
      );
      if (inExcludedDir) {
        item.excluded = true;
        item.reason = 'safe-clean';
        continue;
      }

      // Check excluded filenames
      const fileName = segments[segments.length - 1];
      if (EXCLUDE_FILES.includes(fileName)) {
        item.excluded = true;
        item.reason = 'safe-clean';
        continue;
      }

      // Check sensitive filename patterns
      const isSensitiveName = SENSITIVE_PATTERNS.some((re) => re.test(item.path));
      if (isSensitiveName) {
        item.sensitive = true;
        sensitiveFiles.push(item.path);
      }

      // Size checks
      if (item.size >= MAX_FILE_SIZE) {
        item.excluded = true;
        item.reason = 'oversized';
        oversizedFiles.push({ path: item.path, size: item.size });
      } else if (item.size >= WARN_FILE_SIZE) {
        largeFiles.push({ path: item.path, size: item.size });
      }

      // README check
      if (fileName.toLowerCase() === 'readme.md') hasReadme = true;
    }

    // Content scanning for sensitive data (sample first 4KB of text files)
    for (const item of state.repoFiles) {
      if (item.excluded || item.sensitive) continue;
      if (item.size > 512 * 1024) continue; // skip large files
      const ext = item.path.split('.').pop().toLowerCase();
      const textExts = ['js','ts','py','rb','json','yaml','yml','toml','cfg','ini','sh','bat','env','txt','md','html','css','xml','csv'];
      if (!textExts.includes(ext)) continue;

      try {
        const slice = item.file.slice(0, 4096);
        const text = await slice.text();
        const hasSecret = SENSITIVE_CONTENT_PATTERNS.some((re) => re.test(text));
        if (hasSecret) {
          item.sensitive = true;
          if (!sensitiveFiles.includes(item.path)) {
            sensitiveFiles.push(item.path);
          }
        }
      } catch { /* skip unreadable */ }
    }

    // Build alerts UI
    els.scannerAlerts.innerHTML = '';

    // Excluded by safe-clean
    const cleanedCount = state.repoFiles.filter((f) => f.reason === 'safe-clean').length;
    if (cleanedCount > 0) {
      alerts.push(createAlert(
        'success', '🧹',
        'Safe Clean Applied',
        `${cleanedCount} files/folders auto-excluded (node_modules, .git, .env, etc.)`,
      ));
    }

    // Sensitive files
    if (sensitiveFiles.length > 0) {
      const alert = createAlert(
        'danger', '🔐',
        'Sensitive Data Detected!',
        `${sensitiveFiles.length} file(s) may contain secrets or private keys.`,
        sensitiveFiles.join('\n'),
      );
      const excludeBtn = document.createElement('button');
      excludeBtn.className = 'btn btn-danger btn-xs';
      excludeBtn.textContent = 'Exclude Sensitive Files';
      excludeBtn.addEventListener('click', () => {
        state.repoFiles.forEach((f) => {
          if (f.sensitive) { f.excluded = true; f.reason = 'sensitive'; }
        });
        alert.remove();
        showStagingOrSummary();
        updatePushButton();
        showToast('Sensitive files excluded', 'info');
      });
      alert.querySelector('.alert-content').appendChild(excludeBtn);
      alerts.push(alert);
    }

    // Oversized files
    if (oversizedFiles.length > 0) {
      alerts.push(createAlert(
        'danger', '📦',
        'Files Exceed 100 MB Limit',
        `${oversizedFiles.length} file(s) exceed GitHub's hard limit and were excluded.`,
        oversizedFiles.map((f) => `${f.path} (${formatSize(f.size)})`).join('\n'),
      ));
    }

    // Large files warning
    if (largeFiles.length > 0) {
      alerts.push(createAlert(
        'warning', '⚠️',
        'Large Files Detected',
        `${largeFiles.length} file(s) are over 50 MB.`,
        largeFiles.map((f) => `${f.path} (${formatSize(f.size)})`).join('\n'),
      ));
    }

    // README scaffold offer
    if (!hasReadme) {
      const alert = createAlert(
        'info', '📄',
        'No README.md found',
        'Would you like to add a starter README?',
      );
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-outline btn-xs';
      addBtn.textContent = '+ Add README.md';
      addBtn.addEventListener('click', () => {
        const rootFolder = state.repoFiles[0]?.path.split('/')[0] || 'Project';
        const readmeContent = `# ${rootFolder}\n\nA brief description of your project.\n\n## Getting Started\n\nInstructions for setup and usage.\n\n## License\n\nMIT\n`;
        const readmeBlob = new Blob([readmeContent], { type: 'text/markdown' });
        const readmeFile = new File([readmeBlob], 'README.md');
        readmeFile._relativePath = state.repoFiles[0]?.path.split('/')[0]
          ? `${state.repoFiles[0].path.split('/')[0]}/README.md`
          : 'README.md';
        state.repoFiles.push({
          path: readmeFile._relativePath,
          file: readmeFile,
          size: readmeBlob.size,
          excluded: false,
          sensitive: false,
          reason: '',
        });
        alert.remove();
        showStagingOrSummary();
        updatePushButton();
        showToast('README.md added', 'info');
      });
      alert.querySelector('.alert-content').appendChild(addBtn);
      alerts.push(alert);
    }

    if (alerts.length > 0) {
      alerts.forEach((a) => els.scannerAlerts.appendChild(a));
      els.scannerAlerts.classList.remove('hidden');
    } else {
      els.scannerAlerts.classList.add('hidden');
    }
  }

  function createAlert(type, icon, title, text, details = '') {
    const div = document.createElement('div');
    div.className = `alert alert-${type}`;
    div.innerHTML = `
      <span class="alert-icon">${icon}</span>
      <div class="alert-content">
        <div class="alert-title">${title}</div>
        <div>${text}</div>
        ${details ? `<div class="alert-details">${escapeHtml(details)}</div>` : ''}
      </div>
    `;
    return div;
  }

  // ── Staging Tree (Pro) / Summary (Beginner) ────────────────
  function showStagingOrSummary() {
    const included = state.repoFiles.filter((f) => !f.excluded);

    if (state.proMode) {
      // Build interactive file tree
      els.stagingArea.classList.remove('hidden');
      els.fileSummary.classList.add('hidden');
      buildFileTree(included);
    } else {
      // Simple summary
      els.fileSummary.classList.remove('hidden');
      els.stagingArea.classList.add('hidden');
      const totalSize = included.reduce((s, f) => s + f.size, 0);
      els.summaryText.innerHTML = `<strong>${included.length}</strong> files ready (${formatSize(totalSize)})`;
      // Auto-stage all in beginner mode
      state.stagedPaths = new Set(included.map((f) => f.path));
    }

    updateStagedCount();
    updatePushButton();
  }

  function buildFileTree(files) {
    els.fileTree.innerHTML = '';
    // Sort by path for grouping
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

    sorted.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'tree-item';
      if (item.excluded) div.classList.add('excluded');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.stagedPaths.has(item.path);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          state.stagedPaths.add(item.path);
        } else {
          state.stagedPaths.delete(item.path);
        }
        updateStagedCount();
        updatePushButton();
      });

      const pathSpan = document.createElement('span');
      pathSpan.className = 'tree-path';
      pathSpan.textContent = item.path;
      if (item.sensitive) pathSpan.style.color = '#f85149';

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'tree-size';
      sizeSpan.textContent = formatSize(item.size);

      div.appendChild(cb);
      div.appendChild(pathSpan);
      div.appendChild(sizeSpan);
      els.fileTree.appendChild(div);

      // Default: stage non-excluded files
      if (!item.excluded && !state.stagedPaths.has(item.path)) {
        state.stagedPaths.add(item.path);
        cb.checked = true;
      }
    });

    updateStagedCount();
  }

  function toggleAllStaged(selectAll) {
    const included = state.repoFiles.filter((f) => !f.excluded);
    if (selectAll) {
      included.forEach((f) => state.stagedPaths.add(f.path));
    } else {
      state.stagedPaths.clear();
    }
    els.fileTree.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selectAll;
    });
    updateStagedCount();
    updatePushButton();
  }

  function updateStagedCount() {
    els.stagedCount.textContent = state.stagedPaths.size;
  }

  // ── File Mode: Handle Individual Files ─────────────────────
  function handleSingleFiles(files) {
    if (files.length === 0) return;
    state.singleFiles = files.map((f) => ({ file: f, name: f.name }));
    renderFileList();
    els.fileControls.classList.remove('hidden');
    els.fileDropzone.classList.add('has-files');
    if (!els.fileCommitTitle.value) {
      els.fileCommitTitle.value = `Add ${files.length} file(s)`;
    }
    updatePushButton();
  }

  function renderFileList() {
    els.fileList.innerHTML = '';
    state.singleFiles.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'file-list-item';
      div.innerHTML = `
        <span>${escapeHtml(item.name)}</span>
        <button class="remove-file" data-idx="${idx}" title="Remove">✕</button>
      `;
      div.querySelector('.remove-file').addEventListener('click', () => {
        state.singleFiles.splice(idx, 1);
        renderFileList();
        if (state.singleFiles.length === 0) {
          els.fileControls.classList.add('hidden');
          els.fileDropzone.classList.remove('has-files');
        }
        updatePushButton();
      });
      els.fileList.appendChild(div);
    });
    els.fileList.classList.toggle('hidden', state.singleFiles.length === 0);
  }

  // ── Release Mode: Handle Asset File ────────────────────────
  function handleReleaseFile(files) {
    if (files.length === 0) return;
    state.releaseAsset = files[0];
    els.releaseFileInfo.textContent = `📎 ${files[0].name} (${formatSize(files[0].size)})`;
    els.releaseFileInfo.classList.remove('hidden');
    els.releaseDropzone.classList.add('has-files');
    updatePushButton();
  }

  // ── Bookmark: Clip Current Page ────────────────────────────
  async function handleClipPage() {
    try {
      const tab = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, resolve);
      });
      if (tab && tab.url) {
        state.bookmarkTitle = tab.title || 'Untitled';
        state.bookmarkUrl = tab.url;
        els.bookmarkTitle.textContent = state.bookmarkTitle;
        els.bookmarkUrl.textContent = state.bookmarkUrl;
        els.bookmarkPreview.classList.remove('hidden');
        updatePushButton();
      } else {
        showToast('Could not capture current tab', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  // ── Branch Creation ────────────────────────────────────────
  async function handleCreateBranch() {
    const name = els.newBranchName.value.trim();
    if (!name) return;
    const repoVal = els.repoSelect.value;
    if (!repoVal) { showToast('Select a repository first', 'error'); return; }
    const [owner, repo] = repoVal.split('/');
    const sourceBranch = els.branchSelect.value || 'main';

    try {
      els.createBranchBtn.disabled = true;
      await api.createBranch(owner, repo, name, sourceBranch);
      await loadBranches('repo');
      els.branchSelect.value = name;
      els.newBranchRow.classList.add('hidden');
      els.newBranchName.value = '';
      showToast(`Branch "${name}" created`, 'info');
    } catch (err) {
      showToast(`Branch creation failed: ${err.message}`, 'error');
    } finally {
      els.createBranchBtn.disabled = false;
    }
  }

  // ── Inline "New Repo" Drawer — Generic Binder ─────────────
  function bindNewRepoDrawer(cfg) {
    const { toggleBtn, drawer, nameInput, privateCb, createBtn, cancelBtn, targetSelect, branchCtx } = cfg;

    // Toggle drawer visibility
    toggleBtn.addEventListener('click', () => {
      drawer.classList.toggle('hidden');
      if (!drawer.classList.contains('hidden')) {
        nameInput.value = '';
        privateCb.checked = false;
        nameInput.focus();
      }
    });

    // Cancel button
    cancelBtn.addEventListener('click', () => {
      drawer.classList.add('hidden');
      nameInput.value = '';
      privateCb.checked = false;
    });

    // Create & Select button
    createBtn.addEventListener('click', () => {
      handleCreateRepo(nameInput, privateCb, createBtn, drawer, targetSelect, branchCtx);
    });

    // Allow Enter key in the name input to submit
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreateRepo(nameInput, privateCb, createBtn, drawer, targetSelect, branchCtx);
      }
      if (e.key === 'Escape') {
        drawer.classList.add('hidden');
      }
    });
  }

  // ── Inline Repo Creation Handler ───────────────────────────
  async function handleCreateRepo(nameInput, privateCb, createBtn, drawer, targetSelect, branchCtx) {
    // Sanitize: trim, lowercase, replace spaces/underscores with hyphens, strip invalid chars
    let repoName = nameInput.value
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\-\.]/g, '')
      .replace(/^-+|-+$/g, '');

    if (!repoName) {
      showToast('Please enter a valid repository name', 'error');
      nameInput.focus();
      return;
    }

    const isPrivate = privateCb.checked;

    try {
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';

      // Call GitHub API with auto_init: true to guarantee main branch exists
      const newRepo = await api.createRepo(repoName, isPrivate, true);
      const fullName = `${newRepo.owner.login}/${newRepo.name}`;

      // Refresh the repo cache and rebuild ALL dropdowns
      await loadRepos();

      // Auto-select the newly created repo in the originating dropdown
      targetSelect.value = fullName;

      // Load branches for the new repo so the branch pointer is set
      if (branchCtx) {
        await loadBranches(branchCtx);
      }

      // Reset and close the drawer
      drawer.classList.add('hidden');
      nameInput.value = '';
      privateCb.checked = false;

      // Re-evaluate push button state
      updatePushButton();
      updateRateLimitBadge();

      // Success toast with direct link
      showToast(
        `Repository "${fullName}" created${isPrivate ? ' (private)' : ''}`,
        'success',
        newRepo.html_url
      );
    } catch (err) {
      showToast(`Repo creation failed: ${err.message}`, 'error');
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create & Select';
    }
  }

  // ── Pending Snippet from Context Menu ──────────────────────
  async function checkPendingSnippet() {
    // Listen for direct messages from background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'SNIPPET_FROM_CONTEXT_MENU') {
        applySnippet(msg.payload);
      }
    });

    // Check if there's a stored pending snippet
    try {
      const pending = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CHECK_PENDING_SNIPPET' }, resolve);
      });
      if (pending) applySnippet(pending);
    } catch { /* first load, no pending */ }
  }

  function applySnippet(payload) {
    if (payload.action === 'create-gist') {
      switchMode('gist');
      els.gistContent.value = payload.text;
      els.gistDescription.value = `Snippet from ${payload.pageTitle}`;
      // Auto-detect extension from content
      const ext = detectLanguageExtension(payload.text);
      els.gistFilename.value = `snippet${ext}`;
    } else if (payload.action === 'append-cheatsheet') {
      switchMode('file');
      const content = `\n## From: ${payload.pageTitle}\n\n\`\`\`\n${payload.text}\n\`\`\`\n\n---\n`;
      // Create a file to push
      const blob = new Blob([content], { type: 'text/markdown' });
      const file = new File([blob], 'cheatsheet.md');
      state.singleFiles = [{ file, name: 'cheatsheet.md' }];
      renderFileList();
      els.fileControls.classList.remove('hidden');
      els.fileDestPath.value = '';
      els.fileCommitTitle.value = `cheatsheet: ${payload.pageTitle}`;
    }
    updatePushButton();
  }

  function detectLanguageExtension(text) {
    if (/^\s*(import |from |def |class |print\()/.test(text)) return '.py';
    if (/^\s*(const |let |var |function |=>|import )/.test(text)) return '.js';
    if (/^\s*(package |func |fmt\.)/.test(text)) return '.go';
    if (/^\s*(use |fn |let mut|impl )/.test(text)) return '.rs';
    if (/^\s*(<\?php|namespace |use )/.test(text)) return '.php';
    if (/^\s*(#include|int main|void )/.test(text)) return '.c';
    if (/^\s*(public class|System\.out)/.test(text)) return '.java';
    if (/^\s*(SELECT|INSERT|CREATE|ALTER)\s/i.test(text)) return '.sql';
    if (/^\s*(<[a-z]|<!DOCTYPE)/i.test(text)) return '.html';
    if (/[{}\[\]":,]\s*$/.test(text.trim())) return '.json';
    return '.txt';
  }

  // ── Push Button State ──────────────────────────────────────
  function updatePushButton() {
    let ready = false;
    const mode = state.activeMode;

    if (!state.token) {
      els.pushBtnText.textContent = 'Set Token First';
      els.pushBtn.disabled = true;
      return;
    }

    switch (mode) {
      case 'repo':
        ready = state.stagedPaths.size > 0 && !!els.repoSelect.value && !!els.commitTitle.value;
        els.pushBtnText.textContent = `Push ${state.stagedPaths.size} File${state.stagedPaths.size !== 1 ? 's' : ''}`;
        break;
      case 'file':
        ready = state.singleFiles.length > 0 && !!els.fileRepoSelect.value;
        els.pushBtnText.textContent = `Push ${state.singleFiles.length} File${state.singleFiles.length !== 1 ? 's' : ''}`;
        break;
      case 'gist':
        ready = !!els.gistContent.value.trim() && !!els.gistFilename.value.trim();
        els.pushBtnText.textContent = 'Create Gist';
        break;
      case 'bookmark':
        ready = !!state.bookmarkUrl && !!els.bookmarkRepoSel.value;
        els.pushBtnText.textContent = 'Save Bookmark';
        break;
      case 'release':
        ready = !!els.releaseRepoSel.value && !!els.releaseTag.value.trim();
        els.pushBtnText.textContent = 'Create Release';
        break;
    }

    els.pushBtn.disabled = !ready || state.pushing;
  }

  // Bind real-time validation to text inputs
  document.addEventListener('input', updatePushButton);

  // ── PUSH ORCHESTRATION ─────────────────────────────────────
  async function handlePush() {
    if (state.pushing) return;
    state.pushing = true;
    els.pushBtn.disabled = true;
    const originalText = els.pushBtnText.textContent;
    els.pushBtnText.innerHTML = '<span class="btn-spinner"></span> Pushing...';
    els.pushBtn.classList.add('loading');
    showProgress(0, 'Starting...');

    try {
      switch (state.activeMode) {
        case 'repo':    await pushRepo(); break;
        case 'file':    await pushFiles(); break;
        case 'gist':    await pushGist(); break;
        case 'bookmark':await pushBookmark(); break;
        case 'release': await pushRelease(); break;
      }
    } catch (err) {
      showProgress(100, `Error: ${err.message}`, true);
      showToast(`Push failed: ${err.message}`, 'error');
    } finally {
      state.pushing = false;
      els.pushBtn.classList.remove('loading');
      els.pushBtnText.textContent = originalText;
      updatePushButton();
      updateRateLimitBadge();
    }
  }

  // ── Push: Repo Mode (Git Data API) ─────────────────────────
  async function pushRepo() {
    const [owner, repo] = els.repoSelect.value.split('/');
    const branch = state.proMode ? (els.branchSelect.value || 'main') : 'main';
    const message = els.commitTitle.value || 'Add files';
    const body = state.proMode ? els.commitBody.value : '';

    // Collect staged files
    const stagedItems = state.repoFiles.filter(
      (f) => state.stagedPaths.has(f.path) && !f.excluded
    );

    if (stagedItems.length === 0) {
      showToast('No files staged for push', 'error');
      return;
    }

    showProgress(5, 'Reading files...');

    // Read and base64-encode all files
    const files = [];
    for (let i = 0; i < stagedItems.length; i++) {
      const item = stagedItems[i];
      const arrayBuffer = await item.file.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      files.push({ path: item.path, content: base64 });
      showProgress(5 + (i / stagedItems.length) * 15, `Reading: ${item.path}`);
    }

    showProgress(20, 'Pushing to GitHub...');

    const result = await api.pushTree(owner, repo, branch, files, message, body, (step, total, msg) => {
      const pct = 20 + (step / total) * 75;
      showProgress(pct, msg);
    });

    showProgress(100, 'Push complete!');
    showToast(`Pushed ${result.filesUploaded} files`, 'success', result.commitUrl);
  }

  // ── Push: File Mode (Contents API) ─────────────────────────
  async function pushFiles() {
    const [owner, repo] = els.fileRepoSelect.value.split('/');
    const branch = state.proMode ? (els.fileBranchSel.value || 'main') : 'main';
    const destPath = els.fileDestPath.value.replace(/^\/|\/$/g, '');
    const message = els.fileCommitTitle.value || 'Add files';

    for (let i = 0; i < state.singleFiles.length; i++) {
      const item = state.singleFiles[i];
      const filePath = destPath ? `${destPath}/${item.name}` : item.name;
      showProgress((i / state.singleFiles.length) * 100, `Uploading: ${filePath}`);

      const content = await item.file.text();
      const existing = await api.getFileContent(owner, repo, filePath, branch);
      await api.putFileContent(
        owner, repo, filePath, content, `${message}: ${item.name}`,
        branch, existing?.sha || null
      );
    }

    showProgress(100, 'Files uploaded!');
    showToast(`Pushed ${state.singleFiles.length} file(s)`, 'success');
  }

  // ── Push: Gist Mode ────────────────────────────────────────
  async function pushGist() {
    const filename = els.gistFilename.value.trim();
    const content = els.gistContent.value;
    const description = els.gistDescription.value;
    const isPublic = document.querySelector('input[name="gist-visibility"]:checked').value === 'public';

    showProgress(50, 'Creating gist...');

    const gist = await api.createGist(filename, content, description, isPublic);

    showProgress(100, 'Gist created!');
    showToast('Gist created successfully', 'success', gist.html_url);
  }

  // ── Push: Bookmark Mode ────────────────────────────────────
  async function pushBookmark() {
    const [owner, repo] = els.bookmarkRepoSel.value.split('/');
    const filePath = els.bookmarkFilePath.value || 'links.md';
    const branch = state.proMode ? (els.bookmarkBranchSel.value || 'main') : 'main';

    showProgress(50, 'Saving bookmark...');

    await api.appendBookmark(owner, repo, filePath, state.bookmarkTitle, state.bookmarkUrl, branch);

    showProgress(100, 'Bookmark saved!');
    showToast('Bookmark saved to repository', 'success');
  }

  // ── Push: Release Mode ─────────────────────────────────────
  async function pushRelease() {
    const [owner, repo] = els.releaseRepoSel.value.split('/');
    const tag = els.releaseTag.value.trim();
    const title = els.releaseTitle.value.trim() || tag;
    const body = els.releaseBody.value;
    const draft = els.releaseDraft.checked;
    const prerelease = els.releasePrerelease.checked;

    showProgress(30, 'Creating release...');

    const release = await api.createRelease(owner, repo, tag, title, body, draft, prerelease);

    if (state.releaseAsset) {
      showProgress(60, 'Uploading asset...');
      await api.uploadReleaseAsset(
        release.upload_url,
        state.releaseAsset,
        state.releaseAsset.type || 'application/octet-stream'
      );
    }

    showProgress(100, 'Release created!');
    showToast('Release published', 'success', release.html_url);
  }

  // ── Progress Bar ───────────────────────────────────────────
  function showProgress(percent, text, isError = false) {
    els.progressContainer.classList.remove('hidden');
    els.progressBar.style.width = `${Math.min(percent, 100)}%`;
    els.progressBar.classList.toggle('error', isError);
    els.progressText.textContent = text;
    if (percent >= 100) {
      setTimeout(() => {
        els.progressContainer.classList.add('hidden');
        els.progressBar.style.width = '0%';
      }, 3000);
    }
  }

  // ── Toast Notifications ────────────────────────────────────
  function showToast(message, type = 'info', url = null) {
    els.toast.className = `toast toast-${type}`;
    els.toast.innerHTML = escapeHtml(message);
    if (url) {
      const link = document.createElement('a');
      link.className = 'toast-link';
      link.textContent = 'Open ↗';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      els.toast.appendChild(link);
    }
    els.toast.classList.remove('hidden');
    setTimeout(() => els.toast.classList.add('hidden'), 5000);
  }

  // ── Helpers ────────────────────────────────────────────────
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function chromeStorageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function chromeStorageSet(items) {
    return new Promise((resolve) => {
      chrome.storage.local.set(items, resolve);
    });
  }

  // ── Boot ───────────────────────────────────────────────────
  init();
})();

/* ──────────────────────────────────────────────────────────────
   github-api.js — Modular GitHub API Client
   Implements: Git Data API pipeline, Contents API, Gists API,
               Releases API, rate-limit handling.
   ────────────────────────────────────────────────────────────── */

class GitHubAPI {
  constructor() {
    this.baseUrl = 'https://api.github.com';
    this.token = '';
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
  }

  // ── Configuration ──────────────────────────────────────────

  setToken(token) {
    this.token = token;
  }

  _headers(extraHeaders = {}) {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  // ── Core Fetch Wrapper with Rate-Limit Tracking ────────────

  async _request(method, endpoint, body = null, customHeaders = {}) {
    if (this.rateLimitRemaining !== null && this.rateLimitRemaining <= 0) {
      const resetDate = new Date(this.rateLimitReset * 1000);
      throw new GitHubAPIError(
        `Rate limit exceeded. Resets at ${resetDate.toLocaleTimeString()}`,
        403
      );
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: this._headers(customHeaders),
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // Track rate limits
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
    if (reset !== null) this.rateLimitReset = parseInt(reset, 10);

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { message: response.statusText };
      }
      throw new GitHubAPIError(
        errorBody.message || `HTTP ${response.status}`,
        response.status,
        errorBody
      );
    }

    if (response.status === 204) return null;
    return response.json();
  }

  // ── Authentication & User ──────────────────────────────────

  async verifyToken() {
    const user = await this._request('GET', '/user');
    const scopes = await this._getScopes();
    return {
      login: user.login,
      avatar_url: user.avatar_url,
      name: user.name,
      scopes,
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitReset: this.rateLimitReset,
    };
  }

  async _getScopes() {
    const response = await fetch(`${this.baseUrl}/user`, {
      headers: this._headers(),
    });
    const scopes = response.headers.get('x-oauth-scopes');
    return scopes ? scopes.split(',').map((s) => s.trim()) : [];
  }

  getRateLimitInfo() {
    return {
      remaining: this.rateLimitRemaining,
      resetAt: this.rateLimitReset
        ? new Date(this.rateLimitReset * 1000)
        : null,
    };
  }

  // ── Repository Operations ──────────────────────────────────

  async createRepo(name, isPrivate = false, autoInit = true, description = '') {
    return this._request('POST', '/user/repos', {
      name,
      private: isPrivate,
      auto_init: autoInit,
      description,
    });
  }

  async listRepos(page = 1, perPage = 30, sort = 'updated') {
    return this._request(
      'GET',
      `/user/repos?per_page=${perPage}&page=${page}&sort=${sort}&affiliation=owner,collaborator`
    );
  }

  async getRepo(owner, repo) {
    return this._request('GET', `/repos/${owner}/${repo}`);
  }

  // ── Branch Operations ──────────────────────────────────────

  async listBranches(owner, repo) {
    return this._request('GET', `/repos/${owner}/${repo}/branches?per_page=100`);
  }

  async createBranch(owner, repo, newBranchName, sourceBranch = 'main') {
    const sourceRef = await this._request(
      'GET',
      `/repos/${owner}/${repo}/git/refs/heads/${sourceBranch}`
    );
    return this._request('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${newBranchName}`,
      sha: sourceRef.object.sha,
    });
  }

  // ── Contents API (Single files, bookmarks, snippets) ──────

  async getFileContent(owner, repo, path, branch = 'main') {
    try {
      return await this._request(
        'GET',
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`
      );
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async putFileContent(owner, repo, path, content, message, branch = 'main', existingSha = null) {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
    };
    if (existingSha) body.sha = existingSha;
    return this._request('PUT', `/repos/${owner}/${repo}/contents/${path}`, body);
  }

  // ── Git Data API Pipeline (Full folder push in single commit) ──

  /**
   * Push an entire file tree as a single clean commit.
   * @param {string} owner - Repo owner
   * @param {string} repo  - Repo name
   * @param {string} branch - Target branch
   * @param {Array<{path: string, content: string}>} files - Files with base64 content
   * @param {string} commitMessage - Commit title
   * @param {string} commitBody - Extended description
   * @param {function} onProgress - Progress callback (step, total, message)
   */
  async pushTree(owner, repo, branch, files, commitMessage, commitBody = '', onProgress = null) {
    const totalSteps = files.length + 3; // blobs + tree + commit + ref update
    let currentStep = 0;

    const report = (msg) => {
      currentStep++;
      if (onProgress) onProgress(currentStep, totalSteps, msg);
    };

    // Step 1: Get the current reference (HEAD of branch)
    let parentSha;
    let baseTreeSha;
    try {
      const ref = await this._request(
        'GET',
        `/repos/${owner}/${repo}/git/refs/heads/${branch}`
      );
      parentSha = ref.object.sha;

      const parentCommit = await this._request(
        'GET',
        `/repos/${owner}/${repo}/git/commits/${parentSha}`
      );
      baseTreeSha = parentCommit.tree.sha;
    } catch (err) {
      if (err.status === 409 || err.status === 404) {
        // Empty repo — no parent commit
        parentSha = null;
        baseTreeSha = null;
      } else {
        throw err;
      }
    }

    // Step 2: Create blobs for each file
    const treeItems = [];
    for (const file of files) {
      const blob = await this._request(
        'POST',
        `/repos/${owner}/${repo}/git/blobs`,
        {
          content: file.content,
          encoding: 'base64',
        }
      );
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
      report(`Uploaded: ${file.path}`);
    }

    // Step 3: Create tree
    const treePayload = { tree: treeItems };
    if (baseTreeSha) treePayload.base_tree = baseTreeSha;

    const tree = await this._request(
      'POST',
      `/repos/${owner}/${repo}/git/trees`,
      treePayload
    );
    report('Tree created');

    // Step 4: Create commit
    const fullMessage = commitBody
      ? `${commitMessage}\n\n${commitBody}`
      : commitMessage;

    const commitPayload = {
      message: fullMessage,
      tree: tree.sha,
    };
    if (parentSha) commitPayload.parents = [parentSha];

    const commit = await this._request(
      'POST',
      `/repos/${owner}/${repo}/git/commits`,
      commitPayload
    );
    report('Commit created');

    // Step 5: Update branch reference
    if (parentSha) {
      await this._request(
        'PATCH',
        `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { sha: commit.sha }
      );
    } else {
      // Create the ref for a fresh repo
      try {
        await this._request(
          'POST',
          `/repos/${owner}/${repo}/git/refs`,
          {
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
          }
        );
      } catch (e) {
        // If ref exists, patch it
        await this._request(
          'PATCH',
          `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
          { sha: commit.sha }
        );
      }
    }
    report('Branch updated');

    return {
      commitSha: commit.sha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
      filesUploaded: files.length,
    };
  }

  // ── Gists API ──────────────────────────────────────────────

  async createGist(filename, content, description = '', isPublic = true) {
    const body = {
      description,
      public: isPublic,
      files: {
        [filename]: { content },
      },
    };
    return this._request('POST', '/gists', body);
  }

  // ── Releases API ──────────────────────────────────────────

  async createRelease(owner, repo, tagName, name, body = '', draft = false, prerelease = false) {
    return this._request('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tagName,
      name,
      body,
      draft,
      prerelease,
    });
  }

  async uploadReleaseAsset(uploadUrl, file, contentType) {
    // uploadUrl comes with {?name,label} template — strip it
    const cleanUrl = uploadUrl.replace(/\{[^}]+\}/g, '');
    const url = `${cleanUrl}?name=${encodeURIComponent(file.name)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${this.token}`,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: file,
    });

    // Track rate limits
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
    if (reset !== null) this.rateLimitReset = parseInt(reset, 10);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ message: response.statusText }));
      throw new GitHubAPIError(errorBody.message, response.status, errorBody);
    }

    return response.json();
  }

  // ── Bookmark Helper ────────────────────────────────────────

  async appendBookmark(owner, repo, filePath, title, url, branch = 'main') {
    const today = new Date().toISOString().split('T')[0];
    const entry = `- [${title}](${url}) — ${today}\n`;

    const existing = await this.getFileContent(owner, repo, filePath, branch);

    if (existing) {
      const currentContent = atob(existing.content.replace(/\n/g, ''));
      const newContent = currentContent + entry;
      return this.putFileContent(owner, repo, filePath, newContent,
        `bookmark: ${title}`, branch, existing.sha);
    } else {
      const newContent = `# Bookmarks\n\n${entry}`;
      return this.putFileContent(owner, repo, filePath, newContent,
        `bookmark: ${title}`, branch);
    }
  }
}

// ── Custom Error Class ───────────────────────────────────────

class GitHubAPIError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = 'GitHubAPIError';
    this.status = status;
    this.body = body;
  }
}

// Export for use in sidepanel.js
// (Chrome extensions use classic scripts in side panels)
window.GitHubAPI = GitHubAPI;
window.GitHubAPIError = GitHubAPIError;

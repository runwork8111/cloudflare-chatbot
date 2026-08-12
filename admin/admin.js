(function () {
  const settings = {
    apiBase: localStorage.getItem("cbw_admin_apiBase") || "",
    adminSecret: localStorage.getItem("cbw_admin_secret") || "",
    widgetUrl: localStorage.getItem("cbw_admin_widgetUrl") || "",
  };

  let tenants = [];
  let selectedTenantId = null;
  let lastMintedKey = null; // in-memory only — never persisted, matches "shown once" on the server

  const el = (id) => document.getElementById(id);
  const settingsDialog = el("settingsDialog");
  const detailPanel = el("detailPanel");

  function saveSettings() {
    localStorage.setItem("cbw_admin_apiBase", settings.apiBase);
    localStorage.setItem("cbw_admin_secret", settings.adminSecret);
    localStorage.setItem("cbw_admin_widgetUrl", settings.widgetUrl);
  }

  function openSettings() {
    el("apiBaseInput").value = settings.apiBase;
    el("adminSecretInput").value = settings.adminSecret;
    el("widgetUrlInput").value = settings.widgetUrl;
    settingsDialog.showModal();
  }

  el("settingsBtn").addEventListener("click", openSettings);
  el("settingsForm").addEventListener("submit", () => {
    settings.apiBase = el("apiBaseInput").value.trim().replace(/\/$/, "");
    settings.adminSecret = el("adminSecretInput").value.trim();
    settings.widgetUrl = el("widgetUrlInput").value.trim();
    saveSettings();
    loadTenants();
  });

  async function api(path, options = {}) {
    const res = await fetch(settings.apiBase + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.adminSecret,
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
    return body;
  }

  async function loadTenants() {
    if (!settings.apiBase || !settings.adminSecret) {
      openSettings();
      return;
    }
    try {
      const { tenants: list } = await api("/admin/tenants");
      tenants = list;
      renderTenantList();
    } catch (err) {
      el("tenantListEl").textContent = "Failed to load: " + err.message;
    }
  }

  function renderTenantList() {
    const container = el("tenantListEl");
    container.innerHTML = "";
    for (const tenant of tenants) {
      const row = document.createElement("button");
      row.className = "tenant-row" + (tenant.id === selectedTenantId ? " active" : "");
      row.innerHTML =
        '<span class="name"></span><span class="slug"></span>';
      row.querySelector(".name").textContent = tenant.name;
      row.querySelector(".slug").textContent = tenant.slug;
      row.addEventListener("click", () => selectTenant(tenant.id));
      container.appendChild(row);
    }
  }

  el("newTenantBtn").addEventListener("click", async () => {
    const name = prompt("Tenant name (e.g. \"Acme Co\"):");
    if (!name) return;
    const slug = prompt(
      "Slug (lowercase, hyphens only):",
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    );
    if (!slug) return;

    try {
      await api("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name }) });
      await loadTenants();
    } catch (err) {
      alert("Failed to create tenant: " + err.message);
    }
  });

  async function selectTenant(id) {
    selectedTenantId = id;
    lastMintedKey = null;
    renderTenantList();

    try {
      const tenant = await api("/admin/tenants/" + id);
      detailPanel.hidden = false;
      el("detailName").textContent = tenant.name;
      el("detailSlug").textContent = tenant.slug;
      el("fieldName").value = tenant.name;
      el("fieldModel").value = tenant.model;
      el("fieldSystemPrompt").value = tenant.system_prompt;
      el("fieldBrandConfig").value = JSON.stringify(tenant.brand_config, null, 2);
      el("fieldBudget").value = tenant.monthly_budget_usd ?? "";
      el("saveStatus").textContent = "";
      await loadApiKeys(id);
      await loadDocuments(id);
      await loadUsage(id);
      renderEmbedSnippet(tenant);
    } catch (err) {
      alert("Failed to load tenant: " + err.message);
    }
  }

  async function loadDocuments(tenantId) {
    const { documents } = await api("/admin/tenants/" + tenantId + "/documents");
    const container = el("documentListEl");
    container.innerHTML = "";
    for (const doc of documents) {
      const row = document.createElement("div");
      row.className = "doc-row";
      const label = document.createElement("span");
      label.textContent = doc.filename;
      const status = document.createElement("span");
      status.className = "doc-status " + doc.status;
      status.textContent = doc.status;
      if (doc.error) status.title = doc.error;
      const right = document.createElement("span");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.appendChild(status);
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-danger";
      deleteBtn.style.marginLeft = "8px";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        if (!confirm("Delete " + doc.filename + "? This removes it from the knowledge base.")) return;
        await api("/admin/tenants/" + tenantId + "/documents/" + doc.id, { method: "DELETE" });
        await loadDocuments(tenantId);
      });
      right.appendChild(deleteBtn);
      row.appendChild(label);
      row.appendChild(right);
      container.appendChild(row);
    }
    if (documents.length === 0) {
      container.innerHTML = '<p class="hint">No documents uploaded yet — the bot answers from its system prompt alone.</p>';
    }
  }

  el("uploadDocForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = el("uploadDocStatus");
    const filename = el("docFilename").value.trim();
    const content = el("docContent").value;
    try {
      await api("/admin/tenants/" + selectedTenantId + "/documents", {
        method: "POST",
        body: JSON.stringify({ filename, content }),
      });
      el("docFilename").value = "";
      el("docContent").value = "";
      statusEl.textContent = "Uploaded — ingesting in the background";
      statusEl.className = "status ok";
      await loadDocuments(selectedTenantId);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status error";
    }
  });

  async function loadUsage(tenantId) {
    const container = el("usageSummary");
    try {
      const { summary } = await api("/admin/tenants/" + tenantId + "/usage?days=30");
      container.innerHTML = "";
      const stats = [
        ["Requests", summary.requestCount.toLocaleString()],
        ["Input tokens", summary.tokensInput.toLocaleString()],
        ["Output tokens", summary.tokensOutput.toLocaleString()],
        ["Est. cost", "$" + summary.costUsd.toFixed(2)],
      ];
      for (const [label, value] of stats) {
        const stat = document.createElement("div");
        stat.className = "usage-stat";
        stat.innerHTML = '<div class="value"></div><div class="label"></div>';
        stat.querySelector(".value").textContent = value;
        stat.querySelector(".label").textContent = label;
        container.appendChild(stat);
      }
    } catch (err) {
      container.textContent = "Failed to load usage: " + err.message;
    }
  }

  el("tenantForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = el("saveStatus");
    let brandConfig;
    try {
      brandConfig = JSON.parse(el("fieldBrandConfig").value || "{}");
    } catch {
      statusEl.textContent = "brand_config is not valid JSON";
      statusEl.className = "status error";
      return;
    }

    const budgetRaw = el("fieldBudget").value.trim();

    try {
      const updated = await api("/admin/tenants/" + selectedTenantId, {
        method: "PATCH",
        body: JSON.stringify({
          name: el("fieldName").value,
          model: el("fieldModel").value,
          system_prompt: el("fieldSystemPrompt").value,
          brand_config: brandConfig,
          monthly_budget_usd: budgetRaw === "" ? null : Number(budgetRaw),
        }),
      });
      statusEl.textContent = "Saved";
      statusEl.className = "status ok";
      el("detailName").textContent = updated.name;
      renderEmbedSnippet(updated);
      await loadTenants();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status error";
    }
  });

  async function loadApiKeys(tenantId) {
    const { api_keys } = await api("/admin/tenants/" + tenantId + "/api-keys");
    const container = el("apiKeyListEl");
    container.innerHTML = "";
    for (const key of api_keys) {
      const row = document.createElement("div");
      row.className = "key-row" + (key.revoked_at ? " revoked" : "");
      const label = document.createElement("span");
      label.textContent = (key.label || "(unlabeled)") + (key.revoked_at ? " — revoked" : "");
      row.appendChild(label);
      if (!key.revoked_at) {
        const revokeBtn = document.createElement("button");
        revokeBtn.className = "btn-danger";
        revokeBtn.textContent = "Revoke";
        revokeBtn.addEventListener("click", async () => {
          if (!confirm("Revoke this key? This can't be undone.")) return;
          await api("/admin/tenants/" + selectedTenantId + "/api-keys/" + key.id + "/revoke", {
            method: "POST",
            body: "{}",
          });
          await loadApiKeys(selectedTenantId);
        });
        row.appendChild(revokeBtn);
      }
      container.appendChild(row);
    }
    if (api_keys.length === 0) {
      container.innerHTML = '<p class="hint">No API keys yet.</p>';
    }
  }

  el("newKeyBtn").addEventListener("click", async () => {
    const label = prompt("Label for this key (e.g. \"production widget\"):") || "";
    try {
      const key = await api("/admin/tenants/" + selectedTenantId + "/api-keys", {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      lastMintedKey = key.key;
      const resultEl = el("newKeyResult");
      resultEl.hidden = false;
      resultEl.innerHTML =
        "Save this now — it won't be shown again:<code></code>";
      resultEl.querySelector("code").textContent = key.key;
      await loadApiKeys(selectedTenantId);
      const tenant = tenants.find((t) => t.id === selectedTenantId);
      if (tenant) renderEmbedSnippet(tenant);
    } catch (err) {
      alert("Failed to create key: " + err.message);
    }
  });

  function renderEmbedSnippet(tenant) {
    const snippetEl = el("embedSnippet");
    if (!lastMintedKey) {
      snippetEl.textContent = "Mint a key above to generate an embed snippet.";
      return;
    }
    const scriptSrc = settings.widgetUrl || "<configure widget script URL in Settings>";
    snippetEl.textContent =
      '<script\n' +
      '  src="' + scriptSrc + '"\n' +
      '  data-api-base="' + settings.apiBase + '"\n' +
      '  data-api-key="' + lastMintedKey + '"\n' +
      '  data-title="' + (tenant.name || "Chat with us") + '"\n' +
      '></' + "script>";
  }

  loadTenants();
})();

(function () {
  const scriptTag = document.currentScript;
  const apiBase = scriptTag.getAttribute("data-api-base");
  const apiKey = scriptTag.getAttribute("data-api-key");
  const title = scriptTag.getAttribute("data-title") || "Chat with us";
  const turnstileSiteKey = scriptTag.getAttribute("data-turnstile-site-key");

  if (!apiBase || !apiKey) {
    console.error("[chatbot-widget] data-api-base and data-api-key are required");
    return;
  }

  let conversationId = null;

  const style = document.createElement("style");
  style.textContent = `
    .cbw-bubble { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px;
      border-radius: 50%; background: #2A55C9; color: #fff; border: none; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); font-size: 24px; z-index: 999999; }
    .cbw-panel { position: fixed; bottom: 88px; right: 20px; width: 340px; max-width: calc(100vw - 40px);
      height: 460px; max-height: calc(100vh - 120px); background: #fff; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.2); display: none; flex-direction: column; overflow: hidden;
      z-index: 999999; font-family: system-ui, -apple-system, sans-serif; }
    .cbw-panel.cbw-open { display: flex; }
    .cbw-header { background: #2A55C9; color: #fff; padding: 14px 16px; font-weight: 600; font-size: 14px; }
    .cbw-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .cbw-msg { max-width: 80%; padding: 8px 12px; border-radius: 10px; font-size: 13.5px;
      line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .cbw-msg.cbw-user { align-self: flex-end; background: #2A55C9; color: #fff; }
    .cbw-sources { margin-top: 6px; font-size: 11px; opacity: 0.65; }
    .cbw-msg.cbw-assistant { align-self: flex-start; background: #F0F1F3; color: #1A1F26; }
    .cbw-inputRow { display: flex; border-top: 1px solid #e5e5e5; }
    .cbw-input { flex: 1; border: none; padding: 12px; font-size: 13.5px; outline: none; }
    .cbw-send { border: none; background: none; color: #2A55C9; font-weight: 600; padding: 0 14px; cursor: pointer; }
    .cbw-send:disabled { color: #A7B2C3; cursor: default; }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement("button");
  bubble.className = "cbw-bubble";
  bubble.textContent = "\u{1F4AC}";
  bubble.setAttribute("aria-label", "Open chat");

  const panel = document.createElement("div");
  panel.className = "cbw-panel";

  const header = document.createElement("div");
  header.className = "cbw-header";
  header.textContent = title;

  const messagesEl = document.createElement("div");
  messagesEl.className = "cbw-messages";

  const inputRow = document.createElement("div");
  inputRow.className = "cbw-inputRow";

  const inputEl = document.createElement("input");
  inputEl.className = "cbw-input";
  inputEl.type = "text";
  inputEl.placeholder = "Type a message…";

  const sendEl = document.createElement("button");
  sendEl.className = "cbw-send";
  sendEl.textContent = "Send";

  inputRow.appendChild(inputEl);
  inputRow.appendChild(sendEl);
  panel.appendChild(header);
  panel.appendChild(messagesEl);
  panel.appendChild(inputRow);

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  bubble.addEventListener("click", () => {
    panel.classList.toggle("cbw-open");
    if (panel.classList.contains("cbw-open")) inputEl.focus();
  });

  function appendMessage(role, text) {
    const el = document.createElement("div");
    el.className = "cbw-msg cbw-" + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // Loads the Turnstile script and runs an invisible challenge, once, the
  // first time a visitor sends a message. Silently skipped when no site key
  // is configured (e.g. local dev) — the server only requires a token when
  // it has a secret key to verify it against.
  let turnstileScriptPromise = null;
  function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve();
    if (!turnstileScriptPromise) {
      turnstileScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Turnstile"));
        document.head.appendChild(script);
      });
    }
    return turnstileScriptPromise;
  }

  function getTurnstileToken() {
    if (!turnstileSiteKey) return Promise.resolve(undefined);

    return loadTurnstileScript().then(
      () =>
        new Promise((resolve) => {
          const container = document.createElement("div");
          container.style.display = "none";
          document.body.appendChild(container);

          window.turnstile.render(container, {
            sitekey: turnstileSiteKey,
            size: "invisible",
            callback: (token) => {
              container.remove();
              resolve(token);
            },
            "error-callback": () => {
              container.remove();
              resolve(undefined);
            },
          });
        })
    );
  }

  async function ensureConversation() {
    if (conversationId) return conversationId;

    const turnstileToken = await getTurnstileToken().catch(() => undefined);
    const res = await fetch(apiBase + "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(turnstileToken ? { turnstile_token: turnstileToken } : {}),
    });
    if (!res.ok) throw new Error("Failed to start conversation (" + res.status + ")");
    const data = await res.json();
    conversationId = data.id;
    return conversationId;
  }

  // Parses a text/event-stream body per the SSE spec: events are separated
  // by a blank line, and multiple `data:` lines within one event are joined
  // with "\n" — required since assistant replies can contain real newlines.
  async function streamReply(text, onDelta, onDone) {
    const res = await fetch(
      apiBase + "/v1/conversations/" + conversationId + "/messages/stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ message: text }),
      }
    );

    if (!res.ok || !res.body) {
      throw new Error("Chat request failed (" + res.status + ")");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        let event = "message";
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
          }
        }
        const data = dataLines.join("\n");
        if (event === "delta") onDelta(data);
        else if (event === "error") throw new Error(data || "Upstream model request failed");
        else if (event === "done" && onDone) {
          try {
            onDone(JSON.parse(data));
          } catch {
            // malformed done payload — non-fatal, the reply already rendered
          }
        }
      }
    }
  }

  async function sendMessage(text) {
    await ensureConversation();
    appendMessage("user", text);
    const assistantEl = appendMessage("assistant", "");

    await streamReply(
      text,
      (delta) => {
        assistantEl.textContent += delta;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      (donePayload) => {
        if (donePayload.sources && donePayload.sources.length > 0) {
          const sourcesEl = document.createElement("div");
          sourcesEl.className = "cbw-sources";
          sourcesEl.textContent = "Sources: " + donePayload.sources.join(", ");
          assistantEl.appendChild(sourcesEl);
        }
      }
    );
  }

  function handleSend() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    sendEl.disabled = true;
    inputEl.disabled = true;

    sendMessage(text)
      .catch((err) => {
        console.error("[chatbot-widget]", err);
        appendMessage("assistant", "Sorry, something went wrong. Please try again.");
      })
      .finally(() => {
        sendEl.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
      });
  }

  sendEl.addEventListener("click", handleSend);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSend();
  });
})();

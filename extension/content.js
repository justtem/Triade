(() => {
  const hostname = location.hostname;

  const sources = {
    "chatgpt.com": "chatgpt",
    "claude.ai": "claude",
    "gemini.google.com": "gemini"
  };

  const source = sources[hostname];

  if (!source) return;

  console.log("[AI Council] Piloto 100% Automatizado iniciado:", source);

  // ============================================
  // 1. DETECTOR DE LIMITES GRATUITOS
  // ============================================

  const SELECTORS = [
    '[role="alert"]',
    '[role="alertdialog"]',
    '[role="dialog"]',
    '[data-testid*="limit"]',
    '[data-testid*="banner"]',
    '[data-testid*="toast"]'
  ];

  const CONVERSATION_EXCLUSION_SELECTORS = [
    'textarea',
    '[contenteditable="true"]',
    '#prompt-textarea',
    '.ProseMirror',
    '.ql-editor',
    'form',
    'pre',
    'code',
    '[data-message-author-role]',
    '[data-testid*="conversation-turn"]',
    '.font-claude-message',
    '.font-claude-response',
    'message-content',
    'model-response',
    'user-query',
    '#ai-council-assistant-widget'
  ].join(", ");

  const blockedPatterns = {
    chatgpt: [
      /you(?:'|’)ve reached your (?:gpt[-\w. ]+ )?limit/i,
      /you(?:'|’)ve reached (?:your |the )?(?:free (?:plan )?)?(?:usage|message|cap) limit/i,
      /you have reached (?:your |the )?(?:free (?:plan )?)?(?:usage|message|cap) limit/i,
      /you(?:'|’)ve hit (?:your |the )?(?:free plan |usage |message )?limit/i,
      /limite (?:gratuito |do plano gratuito )?de (?:uso|mensagens|utilização|utilizacao) atingido/i,
      /você atingiu (?:o |seu )?limite (?:gratuito |do plano gratuito |de uso|de mensagens|de utilização|de utilizacao|do gpt)/i,
      /voce atingiu (?:o |seu )?limite (?:gratuito |do plano gratuito |de uso|de mensagens|de utilização|de utilizacao|do gpt)/i
    ],

    claude: [
      /you(?:'|’)ve reached your (?:\w+ )?usage limit/i,
      /you(?:'|’)ve reached your (?:free |message |daily |5-hour )?limit/i,
      /usage limit reached/i,
      /message limit reached/i,
      /out of (?:free )?messages until/i,
      /no (?:free )?messages remaining/i,
      /limite de (?:uso|mensagens|utilização|utilizacao) atingido/i,
      /você atingiu (?:o |seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i,
      /voce atingiu (?:o |seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i,
      /sem mensagens (?:gratuitas )?restantes até/i
    ],

    gemini: [
      /you(?:'|’)ve reached your limit for gemini/i,
      /you(?:'|’)ve reached your (?:daily |usage |prompt )?limit/i,
      /daily limit reached/i,
      /usage limit reached/i,
      /limite (?:diário|diario|de uso|de solicitações|de solicitacoes) atingido/i,
      /você atingiu (?:o |seu )?limite (?:diário|diario|de uso|para o gemini)/i,
      /voce atingiu (?:o |seu )?limite (?:diário|diario|de uso|para o gemini)/i
    ]
  };

  const warningPatterns = [
    /approaching (?:your )?(?:usage |message |daily |free )?limit/i,
    /nearing (?:your )?(?:usage |message |daily |free )?limit/i,
    /close to (?:your )?(?:usage |message |daily |free )?limit/i,
    /almost (?:at|reached) your (?:usage |message |daily |free )?limit/i,
    /\b\d+\s+(?:free\s+)?messages?\s+(?:left|remaining)\s+until\b/i,
    /\b\d+\s+mensagens?\s+(?:gratuitas?\s+)?restantes?\s+até\b/i,
    /quase atingiu (?:o |seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i,
    /próximo (?:do|ao) (?:seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i,
    /proximo (?:do|ao) (?:seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i,
    /perto (?:do|ao) (?:seu )?limite de (?:uso|mensagens|utilização|utilizacao)/i
  ];

  const SELECTOR_TEXT_MAX = 800;
  const COOLDOWN_MS = 10 * 60 * 1000;
  const MAX_RETRY_ATTEMPTS = 3;
  const BASE_RETRY_DELAY_MS = 2000;

  const lastSent = new Map();
  const inFlight = new Set();

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style = getComputedStyle(element);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      parseFloat(style.opacity || "1") > 0 &&
      element.getClientRects().length > 0
    );
  }

  function isInsideConversation(element) {
    return Boolean(element.closest(CONVERSATION_EXCLUSION_SELECTORS));
  }

  function normalizeText(rawText) {
    return (rawText || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function classify(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    const blocked = blockedPatterns[source] || [];
    if (blocked.some((pattern) => pattern.test(normalized))) {
      return {
        severity: "blocked",
        signal: "usage_limit_reached",
        confidence: "high"
      };
    }

    if (warningPatterns.some((pattern) => pattern.test(normalized))) {
      return {
        severity: "warning",
        signal: "approaching_usage_limit",
        confidence: "medium"
      };
    }

    return null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sendEventWithRetry(event, fingerprint) {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await browser.runtime.sendMessage({
          type: "AI_COUNCIL_LIMIT_EVENT",
          event
        });

        if (result?.saved) {
          lastSent.set(fingerprint, Date.now());
          return true;
        }
      } catch {
        // Ignora erro temporário
      }

      if (attempt < MAX_RETRY_ATTEMPTS) {
        await delay(BASE_RETRY_DELAY_MS * attempt);
      }
    }

    return false;
  }

  async function evaluateAndReport(element, text) {
    const classification = classify(text);
    if (!classification) return;

    const fingerprint = `${source}:${classification.signal}`;
    const previous = lastSent.get(fingerprint);

    if (previous && Date.now() - previous < COOLDOWN_MS) {
      return;
    }

    if (inFlight.has(fingerprint)) {
      return;
    }

    inFlight.add(fingerprint);

    const event = {
      source,
      severity: classification.severity,
      signal: classification.signal,
      confidence: classification.confidence,
      message:
        classification.severity === "blocked"
          ? "Possível limite de utilização atingido."
          : "Possível aviso de proximidade do limite.",
      matchedText: text.slice(0, SELECTOR_TEXT_MAX),
      url: location.origin
    };

    try {
      await sendEventWithRetry(event, fingerprint);
    } finally {
      inFlight.delete(fingerprint);
    }
  }

  function inspectElement(element) {
    if (!isVisible(element)) return;
    if (isInsideConversation(element)) return;

    const text = normalizeText(element.innerText || element.textContent || "");
    if (!text) return;

    if (text.length <= SELECTOR_TEXT_MAX) {
      evaluateAndReport(element, text);
      return;
    }

    const childCandidates = element.querySelectorAll(
      "p, span, div, h1, h2, h3, h4, li"
    );

    for (const child of childCandidates) {
      if (!isVisible(child)) continue;
      if (isInsideConversation(child)) continue;

      const childText = normalizeText(
        child.innerText || child.textContent || ""
      );

      if (
        childText &&
        childText.length <= SELECTOR_TEXT_MAX &&
        child.children.length <= 4
      ) {
        evaluateAndReport(child, childText);
      }
    }
  }

  function scan() {
    const visited = new Set();

    for (const selector of SELECTORS) {
      const elements = document.querySelectorAll(selector);

      for (const element of elements) {
        if (visited.has(element)) continue;
        visited.add(element);
        inspectElement(element);
      }
    }
  }

  let scanScheduled = false;

  const observer = new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;

    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 500);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "aria-hidden"]
  });

  scan();

  // ============================================
  // 2. MOTOR 100% AUTOMATIZADO (ZERO INTERVENÇÃO HUMANA)
  // ============================================

  const STAGE_NAMES = {
    initial_response: "Análise Inicial",
    critique: "Debate e Crítica Cruzada",
    synthesis: "Síntese e Conclusão Final"
  };

  let currentPendingData = null;
  let autoPilotEnabled = true;

  let activeAutoTaskId = null;
  let autoTaskPhase = "idle";
  let baselineResponseCount = 0;
  let baselineLastText = "";
  let lastObservedText = "";
  let stableTicks = 0;

  function setWidgetStatus(text, color = "#e9ad54") {
    const statusEl = document.getElementById("ai-council-widget-status");
    if (statusEl) {
      statusEl.style.color = color;
      statusEl.textContent = text;
    }
  }

  function findChatInputBox() {
    if (source === "chatgpt") {
      return (
        document.querySelector('#prompt-textarea[contenteditable="true"]') ||
        document.querySelector("#prompt-textarea") ||
        document.querySelector('div.ProseMirror[contenteditable="true"]') ||
        document.querySelector("textarea")
      );
    }

    if (source === "claude") {
      return (
        document.querySelector('div.ProseMirror[contenteditable="true"]') ||
        document.querySelector('fieldset [contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector("textarea")
      );
    }

    if (source === "gemini") {
      return (
        document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
        document.querySelector('div.ql-editor[contenteditable="true"]') ||
        document.querySelector('rich-textarea [contenteditable="true"]') ||
        document.querySelector('div[role="textbox"][contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector("textarea")
      );
    }

    return null;
  }

  // Injeção nativa no MAIN WORLD da página (via wrappedJSObject do Firefox)
  // Isso faz o React/ProseMirror do ChatGPT reconhecer o texto instantaneamente e ativar a setinha de enviar!
  function injectTextViaPageContext(inputEl, promptText) {
    try {
      const pageWin = window.wrappedJSObject || window;
      const rawEl = inputEl.wrappedJSObject || inputEl;

      rawEl.focus();

      // 1. Posiciona a seleção dentro do elemento no contexto da página
      const sel = pageWin.getSelection();
      const range = pageWin.document.createRange();
      range.selectNodeContents(rawEl);
      sel.removeAllRanges();
      sel.addRange(range);

      // 2. Cria DataTransfer e ClipboardEvent usando os construtores REAIS da página (sem Xray wrapper!)
      const dt = new pageWin.DataTransfer();
      dt.setData("text/plain", promptText);

      const pasteInit = cloneInto(
        {
          bubbles: true,
          cancelable: true
        },
        pageWin
      );
      pasteInit.clipboardData = dt;

      const pasteEv = new pageWin.ClipboardEvent("paste", pasteInit);
      rawEl.dispatchEvent(pasteEv);

      // 3. Se ainda estiver vazio após o paste nativo, usa execCommand da página
      const afterPaste = (inputEl.innerText || inputEl.textContent || "").trim();
      if (afterPaste.length < 15) {
        pageWin.document.execCommand("selectAll", false, null);
        pageWin.document.execCommand("insertText", false, promptText);
      }

      // 4. Se ainda estiver vazio (ex: janela não focada no SO), injeta no <p> e dispara beforeinput + input da página
      const afterExec = (inputEl.innerText || inputEl.textContent || "").trim();
      if (afterExec.length < 15) {
        let pNode = rawEl.querySelector("p");
        if (!pNode) {
          pNode = pageWin.document.createElement("p");
          rawEl.appendChild(pNode);
        }
        pNode.classList.remove("placeholder");
        pNode.removeAttribute("data-placeholder");
        pNode.textContent = promptText;

        const inputInit = cloneInto(
          {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: promptText
          },
          pageWin
        );
        rawEl.dispatchEvent(new pageWin.InputEvent("beforeinput", inputInit));
        rawEl.dispatchEvent(new pageWin.InputEvent("input", inputInit));
      }

      const finalCheck = (inputEl.innerText || inputEl.textContent || "").trim();
      return finalCheck.length >= 15;
    } catch (err) {
      console.warn("[AI Council] Fallback de injeção:", err);
      return false;
    }
  }

  function findSendButton() {
    if (source === "chatgpt") {
      const directBtn =
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Enviar prompt"]') ||
        document.querySelector('button[aria-label*="Enviar mensagem"]') ||
        document.querySelector('button[aria-label*="Send prompt"]') ||
        document.querySelector('button[aria-label*="Send message"]');

      if (directBtn) return directBtn;

      const inputEl = findChatInputBox();
      if (inputEl) {
        const container = inputEl.closest("form") || inputEl.parentElement?.parentElement;
        if (container) {
          // Procura qualquer botão de submit habilitado que NÃO seja o botão de voz (speech) nem de anexo
          const buttons = Array.from(container.querySelectorAll("button:not([disabled])"));
          for (let i = buttons.length - 1; i >= 0; i--) {
            const b = buttons[i];
            const testId = (b.getAttribute("data-testid") || "").toLowerCase();
            const label = (b.getAttribute("aria-label") || "").toLowerCase();
            if (
              testId.includes("speech") ||
              testId.includes("voice") ||
              label.includes("voz") ||
              label.includes("voice") ||
              label.includes("anexar") ||
              label.includes("attach") ||
              label.includes("pensar") ||
              label.includes("think") ||
              label.includes("pesquisar") ||
              label.includes("search")
            ) {
              continue;
            }
            if (testId.includes("send") || b.type === "submit") {
              return b;
            }
          }
        }
      }
      return null;
    }

    if (source === "claude") {
      return (
        document.querySelector('button[aria-label*="Send Message"]') ||
        document.querySelector('button[aria-label*="Send message"]') ||
        document.querySelector('button[aria-label*="Enviar"]') ||
        document.querySelector('fieldset button[type="button"]:not([disabled])')
      );
    }

    if (source === "gemini") {
      return (
        document.querySelector("button.send-button") ||
        document.querySelector('button[aria-label*="Send message"]') ||
        document.querySelector('button[aria-label*="Enviar mensagem"]') ||
        document.querySelector('button[aria-label*="Enviar"]') ||
        document.querySelector(".send-button-container button")
      );
    }

    return null;
  }

  async function triggerSendAutomatically() {
    const pageWin = window.wrappedJSObject || window;

    // 1. Aguarda até 2.5s pelo botão de enviar aparecer e clica nele no contexto da página
    for (let i = 0; i < 10; i++) {
      const sendBtn = findSendButton();
      if (
        sendBtn &&
        !sendBtn.disabled &&
        sendBtn.getAttribute("aria-disabled") !== "true"
      ) {
        const rawBtn = sendBtn.wrappedJSObject || sendBtn;
        rawBtn.click();
        return true;
      }
      await delay(250);
    }

    // 2. Se o botão não foi clicado (ou o ChatGPT espera Enter no ProseMirror), dispara Enter nativo da página!
    const inputEl = findChatInputBox();
    if (inputEl) {
      try {
        const rawEl = inputEl.wrappedJSObject || inputEl;
        rawEl.focus();

        const keyInit = cloneInto(
          {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          },
          pageWin
        );

        rawEl.dispatchEvent(new pageWin.KeyboardEvent("keydown", keyInit));
        rawEl.dispatchEvent(new pageWin.KeyboardEvent("keypress", keyInit));
        rawEl.dispatchEvent(new pageWin.KeyboardEvent("keyup", keyInit));

        await delay(300);

        // Verifica se a caixa esvaziou (sinal de que o Enter enviou a mensagem!)
        const remaining = (inputEl.innerText || inputEl.textContent || "").trim();
        if (remaining.length < 15) {
          return true;
        }

        // Último recurso: requestSubmit() direto no <form> do ChatGPT
        const form = inputEl.closest("form");
        if (form) {
          const rawForm = form.wrappedJSObject || form;
          if (typeof rawForm.requestSubmit === "function") {
            rawForm.requestSubmit();
            return true;
          }
        }
      } catch (err) {
        console.warn("[AI Council] Erro ao disparar Enter nativo:", err);
      }
    }

    return false;
  }

  function isAIStillGenerating() {
    if (source === "chatgpt") {
      const stopBtn =
        document.querySelector('button[data-testid="stop-button"]') ||
        document.querySelector('button[aria-label*="Stop streaming"]') ||
        document.querySelector('button[aria-label*="Stop generating"]');
      return Boolean(stopBtn && isVisible(stopBtn));
    }

    if (source === "claude") {
      const streamingEl = document.querySelector('[data-is-streaming="true"]');
      const stopBtn =
        document.querySelector('button[aria-label*="Stop"]') ||
        document.querySelector('button[aria-label*="Parar"]');
      return Boolean(streamingEl || (stopBtn && isVisible(stopBtn)));
    }

    if (source === "gemini") {
      const stopBtn =
        document.querySelector('button[aria-label*="Stop"]') ||
        document.querySelector('button[aria-label*="Parar"]') ||
        document.querySelector("button.stop");
      return Boolean(stopBtn && isVisible(stopBtn));
    }

    return false;
  }

  function isPromptEcho(text) {
    return (
      text.includes("REGRA ABSOLUTA DE FORMATO (BLOCO MARKDOWN ÚNICO):") ||
      text.includes("SUA MISSÃO NESTA RODADA 1:") ||
      text.includes("SUA MISSÃO FINAL COMO RELATOR") ||
      text.includes("TAREFA (RODADA 1 — PROPOSTA E RESPOSTA CONCRETA):") ||
      text.includes("REGRAS DE FORMATAÇÃO DA SUA RESPOSTA:")
    );
  }

  function getAssistantResponseElements() {
    if (source === "chatgpt") {
      const allBlocks = Array.from(
        document.querySelectorAll(
          'pre, code, .cm-content, [data-message-author-role="assistant"], .markdown'
        )
      ).filter((el) => {
        if (el.closest("#ai-council-assistant-widget")) return false;
        if (el.closest("form")) return false;
        if (el.closest('[data-message-author-role="user"]')) return false;

        const txt = (el.innerText || el.textContent || "").trim();
        if (txt.length < 30) return false;
        if (isPromptEcho(txt)) return false;

        return true;
      });

      return allBlocks.filter(
        (el) => !allBlocks.some((other) => other !== el && other.contains(el))
      );
    }

    if (source === "claude") {
      const rawCandidates = Array.from(
        document.querySelectorAll(
          '.font-claude-response, .font-claude-message, [data-is-streaming="false"], div.standard-markdown'
        )
      ).filter((el) => !el.closest('[data-testid="user-message"]'));

      const topLevel = rawCandidates.filter(
        (el) =>
          !rawCandidates.some((other) => other !== el && other.contains(el))
      );

      return topLevel.filter((el) => {
        if (el.closest("#ai-council-assistant-widget")) return false;
        const txt = (el.innerText || el.textContent || "").trim();
        return txt.length > 20 && !isPromptEcho(txt);
      });
    }

    if (source === "gemini") {
      const rawCandidates = Array.from(
        document.querySelectorAll(
          "model-response message-content, model-response .markdown, model-response"
        )
      );

      const topLevel = rawCandidates.filter(
        (el) =>
          !rawCandidates.some((other) => other !== el && other.contains(el))
      );

      return topLevel.filter((el) => {
        if (el.closest("#ai-council-assistant-widget")) return false;
        const txt = (el.innerText || el.textContent || "").trim();
        return txt.length > 20 && !isPromptEcho(txt);
      });
    }

    return [];
  }

  function cleanExtractedText(raw) {
    return (raw || "")
      .replace(/^<\/>\s*Markdown\s*\n?/i, "")
      .replace(/^Markdown\s*\n/i, "")
      .replace(/^~~~~+markdown\s*/i, "")
      .replace(/^~~~+markdown\s*/i, "")
      .replace(/^```+markdown\s*/i, "")
      .replace(/~~~~+\s*$/i, "")
      .replace(/#*\s*\[FIM_DA_RESPOSTA\]/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function convertElementToCleanMarkdown(rootEl) {
    if (!rootEl) return null;

    const innerCodeWithEnd = Array.from(
      rootEl.querySelectorAll("code, .cm-content, pre")
    ).find((node) =>
      /\[FIM_DA_RESPOSTA\]/i.test(node.innerText || node.textContent || "")
    );

    if (innerCodeWithEnd) {
      const cleanedInner = cleanExtractedText(
        innerCodeWithEnd.innerText || innerCodeWithEnd.textContent || ""
      );
      if (cleanedInner.length > 25) {
        return cleanedInner;
      }
    }

    const clone = rootEl.cloneNode(true);

    const uiButtons = clone.querySelectorAll(
      'button, svg, [role="toolbar"], [aria-label*="Copy"], [aria-label*="Copiar"]'
    );
    for (const btn of uiButtons) {
      if (!btn.querySelector("code, .cm-content")) {
        btn.remove();
      }
    }

    const preElements = clone.querySelectorAll("pre");
    for (const pre of preElements) {
      const codeEl = pre.querySelector("code, .cm-content");
      const codeContent = ((codeEl || pre).textContent || "").trim();
      const classAttr = (codeEl?.className || pre.className || "").toLowerCase();
      const langMatch = classAttr.match(/language-([a-z0-9_+-]+)/);
      const lang =
        langMatch && langMatch[1] !== "markdown" ? langMatch[1] : "";

      if (lang) {
        const fenced = `\n\`\`\`${lang}\n${codeContent}\n\`\`\`\n`;
        pre.replaceWith(document.createTextNode(fenced));
      } else {
        pre.replaceWith(document.createTextNode(`\n${codeContent}\n`));
      }
    }

    const headings = clone.querySelectorAll("h1, h2, h3, h4");
    for (const h of headings) {
      const level = Number(h.tagName.slice(1)) || 2;
      h.textContent = `\n${"#".repeat(level)} ${(h.textContent || "").trim()}\n`;
    }

    const listItems = clone.querySelectorAll("li");
    for (const li of listItems) {
      if (!li.querySelector("li")) {
        li.textContent = `\n- ${(li.textContent || "").trim()}`;
      }
    }

    const cleaned = cleanExtractedText(clone.innerText || clone.textContent || "");
    return cleaned.length > 25 ? cleaned : null;
  }

  function extractLastAssistantResponse() {
    const validElements = getAssistantResponseElements();
    if (validElements.length === 0) return null;
    return convertElementToCleanMarkdown(
      validElements[validElements.length - 1]
    );
  }

  async function submitCapturedResponseToCouncil(content) {
    if (!currentPendingData?.task?.id || !currentPendingData?.debateId) {
      return false;
    }

    autoTaskPhase = "submitting";
    setWidgetStatus(
      "🤖 Enviando resposta em Markdown ao AI Council...",
      "#8ca5ff"
    );

    try {
      const res = await browser.runtime.sendMessage({
        type: "AI_COUNCIL_SUBMIT_TASK_RESPONSE",
        payload: {
          debateId: currentPendingData.debateId,
          taskId: currentPendingData.task.id,
          content
        }
      });

      if (res?.ok) {
        autoTaskPhase = "done";
        setWidgetStatus(
          "✔ Resposta salva no AI Council com sucesso!",
          "#39c98a"
        );
        setTimeout(() => {
          pollPendingTask();
        }, 1000);
        return true;
      } else {
        autoTaskPhase = "idle";
        setWidgetStatus(res?.error || "Erro ao enviar resposta.", "#ed6674");
        return false;
      }
    } catch {
      autoTaskPhase = "idle";
      setWidgetStatus("Falha de comunicação ao enviar resposta.", "#ed6674");
      return false;
    }
  }

  async function startAutoPilotForCurrentTask() {
    if (!autoPilotEnabled || !currentPendingData?.task) return;

    const task = currentPendingData.task;

    if (activeAutoTaskId === task.id && autoTaskPhase !== "idle") {
      return;
    }

    activeAutoTaskId = task.id;

    const currentElements = getAssistantResponseElements();
    if (currentElements.length > 0) {
      const lastEl = currentElements[currentElements.length - 1];
      const lastTxt = (lastEl.innerText || lastEl.textContent || "").trim();
      if (
        /\[FIM_DA_RESPOSTA\]/i.test(lastTxt) &&
        lastTxt !== baselineLastText
      ) {
        const readyMd = convertElementToCleanMarkdown(lastEl);
        if (readyMd && readyMd.length > 30) {
          baselineLastText = lastTxt;
          await submitCapturedResponseToCouncil(readyMd);
          return;
        }
      }
    }

    autoTaskPhase = "injecting";

    baselineResponseCount = currentElements.length;
    baselineLastText =
      currentElements.length > 0
        ? (
            currentElements[currentElements.length - 1].innerText ||
            currentElements[currentElements.length - 1].textContent ||
            ""
          ).trim()
        : "";
    lastObservedText = "";
    stableTicks = 0;

    setWidgetStatus("🤖 Auto-Pilot: injetando e enviando pergunta...", "#8ca5ff");

    await delay(400);

    const inputEl = findChatInputBox();
    if (!inputEl) {
      autoTaskPhase = "idle";
      return;
    }

    const inserted = injectTextViaPageContext(inputEl, task.prompt);
    if (!inserted) {
      autoTaskPhase = "idle";
      return;
    }

    const sent = await triggerSendAutomatically();
    if (sent) {
      setWidgetStatus(
        "🤖 Pergunta enviada automaticamente! Aguardando resposta...",
        "#e9ad54"
      );
      autoTaskPhase = "waiting_response";
    } else {
      // Se não enviou na primeira tentativa, volta para idle para tentar no próximo ciclo de 3s!
      autoTaskPhase = "idle";
      activeAutoTaskId = null;
    }
  }

  async function checkAutoPilotResponseProgress() {
    if (
      !autoPilotEnabled ||
      autoTaskPhase !== "waiting_response" ||
      !currentPendingData?.task ||
      activeAutoTaskId !== currentPendingData.task.id
    ) {
      return;
    }

    const elements = getAssistantResponseElements();
    if (elements.length === 0) return;

    const latestEl = elements[elements.length - 1];
    const latestRawText = (latestEl.innerText || latestEl.textContent || "").trim();

    const hasExplicitEndMarker = /\[FIM_DA_RESPOSTA\]/i.test(latestRawText);

    if (hasExplicitEndMarker && latestRawText !== baselineLastText) {
      const cleanMarkdown = convertElementToCleanMarkdown(latestEl);
      if (cleanMarkdown && cleanMarkdown.length > 30) {
        baselineLastText = latestRawText;
        await submitCapturedResponseToCouncil(cleanMarkdown);
        return;
      }
    }

    const isNewResponse =
      elements.length > baselineResponseCount ||
      (latestRawText !== baselineLastText && latestRawText.length > 35);

    if (!isNewResponse) {
      return;
    }

    if (isAIStillGenerating()) {
      stableTicks = 0;
      lastObservedText = latestRawText;
      setWidgetStatus(
        `🤖 IA gerando resposta (${latestRawText.length} caracteres)...`,
        "#e9ad54"
      );
      return;
    }

    if (latestRawText === lastObservedText && latestRawText.length > 35) {
      stableTicks += 1;
      setWidgetStatus(
        `🤖 Confirmando fim da resposta (${Math.min(stableTicks, 3)}/3)...`,
        "#8ca5ff"
      );
    } else {
      stableTicks = 0;
      lastObservedText = latestRawText;
      return;
    }

    if (stableTicks >= 3) {
      const cleanMarkdown = convertElementToCleanMarkdown(latestEl);
      if (cleanMarkdown && cleanMarkdown.length > 30) {
        baselineLastText = latestRawText;
        await submitCapturedResponseToCouncil(cleanMarkdown);
      }
    }
  }

  function ensureWidgetElement() {
    let widget = document.getElementById("ai-council-assistant-widget");
    if (widget) return widget;

    widget = document.createElement("div");
    widget.id = "ai-council-assistant-widget";
    widget.style.cssText = [
      "position: fixed",
      "bottom: 20px",
      "right: 20px",
      "z-index: 2147483647",
      "width: 340px",
      "background: #131a26",
      "border: 1px solid #6385ff",
      "border-radius: 12px",
      "padding: 14px",
      "color: #edf1fa",
      "font-family: Inter, Segoe UI, Arial, sans-serif",
      "font-size: 12px",
      "box-shadow: 0 10px 30px rgba(0,0,0,0.65)",
      "pointer-events: auto",
      "display: none"
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:700;color:#8ca5ff;";

    const headerTitle = document.createElement("span");
    headerTitle.textContent = "⚖ AI COUNCIL";

    const autoToggleBtn = document.createElement("button");
    autoToggleBtn.type = "button";
    autoToggleBtn.style.cssText = [
      "padding: 3px 8px",
      "border-radius: 12px",
      "border: 1px solid rgba(57, 201, 138, 0.5)",
      "background: rgba(57, 201, 138, 0.15)",
      "color: #39c98a",
      "font-size: 10px",
      "font-weight: 700",
      "cursor: pointer"
    ].join(";");
    autoToggleBtn.textContent = "🤖 Auto-Pilot: ON";

    autoToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      autoPilotEnabled = !autoPilotEnabled;
      if (autoPilotEnabled) {
        autoToggleBtn.textContent = "🤖 Auto-Pilot: ON";
        autoToggleBtn.style.color = "#39c98a";
        if (currentPendingData?.task) {
          autoTaskPhase = "idle";
          activeAutoTaskId = null;
          startAutoPilotForCurrentTask();
        }
      } else {
        autoToggleBtn.textContent = "🤖 Auto-Pilot: OFF";
        autoToggleBtn.style.color = "#e9ad54";
        setWidgetStatus("Piloto automático pausado.", "#9ba8bb");
      }
    });

    header.append(headerTitle, autoToggleBtn);

    const info = document.createElement("div");
    info.id = "ai-council-widget-info";
    info.style.cssText =
      "color:#9ba8bb;font-size:11px;line-height:1.4;margin-bottom:10px;";

    const btnInsert = document.createElement("button");
    btnInsert.type = "button";
    btnInsert.textContent = "1. Reenviar / Inserir Pergunta na IA";
    btnInsert.style.cssText = [
      "width: 100%",
      "padding: 8px 10px",
      "margin-bottom: 6px",
      "background: #6385ff",
      "color: #fff",
      "border: none",
      "border-radius: 8px",
      "font-weight: 600",
      "cursor: pointer"
    ].join(";");

    const btnCapture = document.createElement("button");
    btnCapture.type = "button";
    btnCapture.textContent = "2. Forçar Captura da Última Resposta";
    btnCapture.style.cssText = [
      "width: 100%",
      "padding: 8px 10px",
      "background: rgba(57, 201, 138, 0.18)",
      "color: #39c98a",
      "border: 1px solid rgba(57, 201, 138, 0.45)",
      "border-radius: 8px",
      "font-weight: 600",
      "cursor: pointer"
    ].join(";");

    const statusMsg = document.createElement("div");
    statusMsg.id = "ai-council-widget-status";
    statusMsg.style.cssText =
      "margin-top:8px;font-size:11px;color:#e9ad54;min-height:16px;line-height:1.35;";

    btnInsert.addEventListener("click", async (e) => {
      e.stopPropagation();
      autoTaskPhase = "idle";
      activeAutoTaskId = null;
      await startAutoPilotForCurrentTask();
    });

    btnCapture.addEventListener("click", async (e) => {
      e.stopPropagation();

      const lastResponse = extractLastAssistantResponse();
      if (!lastResponse) {
        setWidgetStatus(
          "Ainda não encontrei uma resposta válida da IA nesta página.",
          "#ed6674"
        );
        return;
      }

      btnCapture.disabled = true;
      await submitCapturedResponseToCouncil(lastResponse);
      btnCapture.disabled = false;
    });

    widget.append(header, info, btnInsert, btnCapture, statusMsg);
    document.body.appendChild(widget);
    return widget;
  }

  async function pollPendingTask() {
    try {
      const response = await browser.runtime.sendMessage({
        type: "AI_COUNCIL_GET_PENDING_TASK",
        source
      });

      const widget = ensureWidgetElement();
      const infoEl = document.getElementById("ai-council-widget-info");

      if (!response?.ok || !response.task) {
        currentPendingData = null;
        activeAutoTaskId = null;
        autoTaskPhase = "idle";
        widget.style.display = "none";
        return;
      }

      const isNewTask =
        !currentPendingData ||
        currentPendingData.task?.id !== response.task.id;

      currentPendingData = response;
      widget.style.display = "block";

      const stageLabel =
        STAGE_NAMES[response.task.stage] || response.task.stage;

      if (infoEl) {
        infoEl.textContent = `Debate: "${response.debateTitle}" • Rodada ${response.currentRound}/${response.totalRounds} (${stageLabel})`;
      }

      if (isNewTask || autoTaskPhase === "idle") {
        startAutoPilotForCurrentTask();
      }
    } catch {
      // Silencioso se o servidor estiver desligado
    }
  }

  setInterval(pollPendingTask, 3000);
  setInterval(checkAutoPilotResponseProgress, 1500);
  setTimeout(pollPendingTask, 1000);
})();
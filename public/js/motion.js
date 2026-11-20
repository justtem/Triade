import {
  AUTO_PLATFORM_IDS,
  $,
  $$,
  state,
  getSessionTurns,
  getActiveOrSelectedDebate,
  scheduleParallaxRender,
  setScrollFocusedAiInRightDock
} from "./state.js";

export function attachHorizontalScrollPhysics(viewportEl, options = {}) {
  if (!viewportEl || viewportEl.dataset.hScrollBound === "true") return;
  viewportEl.dataset.hScrollBound = "true";

  let targetScrollLeft = viewportEl.scrollLeft;
  let isAnimatingWheel = false;
  let isPointerDown = false;
  let startX = 0;
  let startScrollLeft = 0;
  let hasDragged = false;

  const updateHorizontalScrollLinkedState = () => {
    const maxScroll = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
    const current = viewportEl.scrollLeft;
    const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, current / maxScroll)) : 1;

    if (options.progressFillEl) {
      const pct = maxScroll > 0 ? Math.max(15, Math.round(ratio * 100)) : 100;
      options.progressFillEl.style.width = `${pct}%`;
    }

    // Parallax horizontal conectado ao scroll da trilha
    state.parallaxScrollX = current;
    scheduleParallaxRender();

    // Efeito Scroll-Linked de escala e foco nos cards da trilha horizontal
    const cards = Array.from(viewportEl.querySelectorAll(options.cardSelector || ".ai-response-card, .zero-h-card"));
    if (cards.length === 0) return;

    const viewportRect = viewportEl.getBoundingClientRect();
    const viewportCenter = viewportRect.left + viewportRect.width / 2;

    let closestCard = null;
    let minDistance = Infinity;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const cardCenter = rect.left + rect.width / 2;
      const dist = Math.abs(viewportCenter - cardCenter);
      const normDist = Math.min(1, dist / Math.max(1, viewportRect.width * 0.65));

      const scale = (1 - normDist * 0.032).toFixed(4);
      const offsetY = (normDist * 4).toFixed(1);
      card.style.setProperty("--card-h-scale", scale);
      card.style.setProperty("--card-h-y", `${offsetY}px`);

      if (dist < minDistance) {
        minDistance = dist;
        closestCard = card;
      }
    }

    for (const card of cards) {
      card.classList.toggle("is-h-centered", card === closestCard && cards.length > 1);
    }

    if (closestCard && options.onCenteredCardChange) {
      options.onCenteredCardChange(closestCard);
    }
  };

  const animateWheelStep = () => {
    const diff = targetScrollLeft - viewportEl.scrollLeft;
    if (Math.abs(diff) < 0.8) {
      viewportEl.scrollLeft = targetScrollLeft;
      isAnimatingWheel = false;
      updateHorizontalScrollLinkedState();
      return;
    }
    viewportEl.scrollLeft += diff * 0.24;
    updateHorizontalScrollLinkedState();
    requestAnimationFrame(animateWheelStep);
  };

  // Conversão Híbrida Inteligente de Wheel Vertical -> Horizontal Scroll
  viewportEl.addEventListener(
    "wheel",
    (e) => {
      if (options.isStacked && options.isStacked()) return;

      const maxScroll = viewportEl.scrollWidth - viewportEl.clientWidth;
      if (maxScroll <= 4) return;

      // Se o cursor estiver dentro de um corpo de resposta ou código que pode rolar verticalmente, respeita a leitura interna
      const scrollableInner = e.target.closest(".ai-response-body, .code-block-pre, .prompt-preview");
      if (scrollableInner && scrollableInner.scrollHeight > scrollableInner.clientHeight + 4) {
        const atTop = scrollableInner.scrollTop <= 0;
        const atBottom =
          scrollableInner.scrollTop + scrollableInner.clientHeight >=
          scrollableInner.scrollHeight - 2;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
          return;
        }
      }

      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 1) return;

      const currentBase = isAnimatingWheel ? targetScrollLeft : viewportEl.scrollLeft;
      const goingRight = delta > 0;
      const goingLeft = delta < 0;

      const canGoRight = currentBase < maxScroll - 2;
      const canGoLeft = currentBase > 2;

      if ((goingRight && canGoRight) || (goingLeft && canGoLeft)) {
        e.preventDefault();
        targetScrollLeft = Math.max(0, Math.min(maxScroll, currentBase + delta * 1.15));
        if (!isAnimatingWheel) {
          isAnimatingWheel = true;
          requestAnimationFrame(animateWheelStep);
        }
      }
    },
    { passive: false }
  );

  // Drag com mouse / touch
  viewportEl.addEventListener("pointerdown", (e) => {
    if (options.isStacked && options.isStacked()) return;
    if (e.target.closest("button, a, input, textarea, select, code, pre")) return;

    isPointerDown = true;
    hasDragged = false;
    isAnimatingWheel = false;
    startX = e.clientX;
    startScrollLeft = viewportEl.scrollLeft;
    targetScrollLeft = startScrollLeft;
    viewportEl.classList.add("is-dragging");
  });

  window.addEventListener("pointermove", (e) => {
    if (!isPointerDown) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 5) {
      hasDragged = true;
    }
    viewportEl.scrollLeft = startScrollLeft - dx;
    targetScrollLeft = viewportEl.scrollLeft;
    updateHorizontalScrollLinkedState();
  });

  window.addEventListener("pointerup", () => {
    if (!isPointerDown) return;
    isPointerDown = false;
    viewportEl.classList.remove("is-dragging");
  });

  viewportEl.addEventListener(
    "click",
    (e) => {
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
        hasDragged = false;
      }
    },
    true
  );

  viewportEl.addEventListener("scroll", () => {
    if (!isAnimatingWheel) {
      targetScrollLeft = viewportEl.scrollLeft;
    }
    updateHorizontalScrollLinkedState();
  });

  if (options.prevBtn) {
    options.prevBtn.addEventListener("click", () => {
      const step = Math.max(280, Math.round(viewportEl.clientWidth * 0.72));
      targetScrollLeft = Math.max(0, viewportEl.scrollLeft - step);
      if (!isAnimatingWheel) {
        isAnimatingWheel = true;
        requestAnimationFrame(animateWheelStep);
      }
    });
  }

  if (options.nextBtn) {
    options.nextBtn.addEventListener("click", () => {
      const maxScroll = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
      const step = Math.max(280, Math.round(viewportEl.clientWidth * 0.72));
      targetScrollLeft = Math.min(maxScroll, viewportEl.scrollLeft + step);
      if (!isAnimatingWheel) {
        isAnimatingWheel = true;
        requestAnimationFrame(animateWheelStep);
      }
    });
  }

  // Inicializa estado visual após layout
  requestAnimationFrame(updateHorizontalScrollLinkedState);
}

// ============================================================================
// MINI-MAPA DE RODADAS E TIMELINE SCROLL-LINKED DO CHAT
// ============================================================================

export function buildChatRoundMinimap(debate) {
  const minimap = $("#chat-round-minimap");
  const stepsContainer = $("#minimap-steps");
  if (!minimap || !stepsContainer) return;

  if (!debate && !state.optimisticSubmission) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  const turns = debate ? getSessionTurns(debate) : [];

  // Em chat direto de 1 turno, oculta o minimapa para manter o visual limpo.
  if (
    !debate &&
    state.optimisticSubmission &&
    state.optimisticSubmission.interactionMode === "direct" &&
    !state.optimisticSubmission.parentDebateId
  ) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  if (
    debate &&
    turns.length === 1 &&
    turns[0].interactionMode === "direct" &&
    !state.optimisticSubmission
  ) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  minimap.hidden = false;
  stepsContainer.replaceChildren();

  let steps = [];
  if (turns.length > 1 || (debate && state.optimisticSubmission?.parentDebateId)) {
    steps = turns.map((t) => ({
      id: `step-turn-${t.index}`,
      label: `Msg ${t.index}`
    }));
    if (state.optimisticSubmission?.parentDebateId) {
      steps.push({
        id: `step-turn-${turns.length + 1}`,
        label: `Msg ${turns.length + 1}`
      });
    }
  } else {
    const singleTurn = turns[0] || {
      totalRounds: state.optimisticSubmission?.totalRounds || 2
    };
    steps = [{ id: "step-user", label: "Início" }];
    for (let r = 1; r <= (singleTurn.totalRounds || 1); r++) {
      steps.push({ id: `step-round-${r}`, label: `Rodada ${r}` });
    }
    steps.push({ id: "step-synthesis", label: "Síntese" });
  }

  steps.forEach((st, idx) => {
    if (idx > 0) {
      const conn = document.createElement("span");
      conn.className = "minimap-connector";
      conn.textContent = "→";
      stepsContainer.appendChild(conn);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `minimap-step-btn${idx === 0 ? " is-current" : ""}`;
    btn.setAttribute("data-minimap-target", st.id);
    btn.textContent = st.label;

    btn.addEventListener("click", () => {
      const sectionEl = document.getElementById(st.id);
      const chatScroll = $("#chat-scroll-area");
      if (sectionEl && chatScroll) {
        chatScroll.scrollTo({
          top: Math.max(0, sectionEl.offsetTop - 16),
          behavior: "smooth"
        });
      }
    });

    stepsContainer.appendChild(btn);
  });
}

export function isChatNearBottom(chatScroll = $("#chat-scroll-area")) {
  if (!chatScroll) return true;
  const distanceFromBottom =
    chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop;
  return distanceFromBottom <= 140;
}

export function setUnreadScrollPillVisible(visible, label = "Nova resposta") {
  state.hasUnreadBelow = Boolean(visible);
  const pill = $("#scroll-to-latest-btn");
  if (!pill) return;
  pill.hidden = !state.hasUnreadBelow;
  const textEl = pill.querySelector(".scroll-pill-text");
  if (textEl && label) {
    textEl.textContent = label;
  }
}

export function scrollChatToBottom(smooth = true) {
  const chatScroll = $("#chat-scroll-area");
  if (!chatScroll) return;
  state.isUserNearChatBottom = true;
  setUnreadScrollPillVisible(false);
  chatScroll.scrollTo({
    top: chatScroll.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}

export function handleSmartAutoScroll(options = {}) {
  const { force = false, smooth = true, label = "Nova resposta" } = options;
  const chatScroll = $("#chat-scroll-area");
  if (!chatScroll) return;

  if (force || state.isUserNearChatBottom) {
    requestAnimationFrame(() => {
      scrollChatToBottom(smooth);
    });
  } else {
    setUnreadScrollPillVisible(true, label);
  }
}

export function updateChatScrollLinkedEffects() {
  const chatScroll = $("#chat-scroll-area");
  const threadEl = $("#chat-thread");
  const composerDock = $("#composer-dock");
  if (!chatScroll) return;

  const scrollTop = chatScroll.scrollTop;
  const maxScroll = Math.max(0, chatScroll.scrollHeight - chatScroll.clientHeight);
  const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
  const pct = Math.round(ratio * 100);

  // Rastreia se o usuário está lendo no final ou rolou para cima (auto-scroll inteligente)
  state.isUserNearChatBottom = maxScroll - scrollTop <= 140;
  if (state.isUserNearChatBottom && state.hasUnreadBelow) {
    setUnreadScrollPillVisible(false);
  }

  // 0. Mantém o Composer estável sem layout-shift durante o scroll (evita loop de resize/scroll)
  if (composerDock && composerDock.classList.contains("is-scroll-compact")) {
    composerDock.classList.remove("is-scroll-compact");
  }

  // 1. Atualiza Parallax vertical
  state.parallaxScrollY = scrollTop;
  scheduleParallaxRender();

  // 2. Atualiza barra de progresso Scroll-Linked do Mini-Mapa e Timeline do Chat
  const progressBar = $("#chat-scroll-progress-bar");
  const pctLabel = $("#minimap-scroll-pct");
  if (progressBar) {
    progressBar.style.width = `${pct}%`;
  }
  if (pctLabel) {
    pctLabel.textContent = `${pct}%`;
  }
  if (threadEl) {
    threadEl.style.setProperty("--chat-timeline-progress", `${Math.max(8, pct)}%`);
  }

  // 3. Scroll-Spy nas seções do debate para iluminar o nó ativo no Mini-Mapa
  const sections = $$("[data-minimap-section]");
  if (sections.length > 0) {
    let activeSectionId = sections[0].id;
    const triggerLine = scrollTop + chatScroll.clientHeight * 0.28;

    for (const sec of sections) {
      if (sec.offsetTop <= triggerLine) {
        activeSectionId = sec.id;
      }
    }

    for (const btn of $$("[data-minimap-target]")) {
      const isMatch = btn.getAttribute("data-minimap-target") === activeSectionId;
      btn.classList.toggle("is-current", isMatch);
    }

    // Sincroniza a IA em foco na seção ativa com o Sticky Dock da Barra Lateral Direita
    const activeSecEl = document.getElementById(activeSectionId);
    const centeredCard = activeSecEl?.querySelector(".ai-response-card.is-h-centered, .ai-response-card");
    const focusedPlat = centeredCard?.getAttribute("data-response-platform") || null;
    setScrollFocusedAiInRightDock(focusedPlat);
  } else {
    setScrollFocusedAiInRightDock(null);
  }
}

export function openImageLightbox(src, caption = "") {
  const overlay = $("#image-lightbox-modal");
  const img = $("#image-lightbox-img");
  const cap = $("#image-lightbox-caption");
  if (!overlay || !img) return;
  img.src = src;
  img.alt = caption || "Imagem anexada";
  if (cap) cap.textContent = caption || "";
  overlay.hidden = false;
}

export function closeImageLightbox() {
  const overlay = $("#image-lightbox-modal");
  const img = $("#image-lightbox-img");
  if (overlay) overlay.hidden = true;
  if (img) img.removeAttribute("src");
}

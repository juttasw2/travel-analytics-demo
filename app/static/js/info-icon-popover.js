(() => {
  const TRIGGER_SELECTOR = "[data-info-popover-trigger]";
  const PANEL_SELECTOR = "[data-info-popover-panel]";
  const CLOSE_SELECTOR = "[data-info-popover-close]";

  const openPopover = (trigger, panel) => {
    trigger.setAttribute("aria-expanded", "true");
    panel.hidden = false;
  };

  const closePopover = (trigger, panel) => {
    trigger.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };

  const closeAll = () => {
    document.querySelectorAll(TRIGGER_SELECTOR).forEach((trigger) => {
      const panelId = trigger.getAttribute("data-info-popover-trigger");
      if (!panelId) return;
      const panel = document.getElementById(panelId);
      if (!panel) return;
      closePopover(trigger, panel);
    });
  };

  const getPanelForTrigger = (trigger) => {
    const panelId = trigger.getAttribute("data-info-popover-trigger");
    if (!panelId) return null;
    return document.getElementById(panelId);
  };

  const handleTriggerClick = (event) => {
    const trigger = event.target.closest(TRIGGER_SELECTOR);
    if (!trigger) return;

    const panel = getPanelForTrigger(trigger);
    if (!panel) return;

    const isOpen = trigger.getAttribute("aria-expanded") === "true";
    closeAll();
    if (!isOpen) {
      openPopover(trigger, panel);
    }
  };

  const handleDocumentClick = (event) => {
    const clickedTrigger = event.target.closest(TRIGGER_SELECTOR);
    if (clickedTrigger) return;

    const clickedPanel = event.target.closest(PANEL_SELECTOR);
    if (!clickedPanel) {
      closeAll();
      return;
    }

    const clickedClose = event.target.closest(CLOSE_SELECTOR);
    if (clickedClose) {
      closeAll();
    }
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") {
      closeAll();
    }
  };

  const init = () => {
    document.querySelectorAll(TRIGGER_SELECTOR).forEach((trigger) => {
      const panel = getPanelForTrigger(trigger);
      if (!panel) return;

      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-haspopup", "dialog");
      panel.hidden = true;
    });

    document.addEventListener("click", handleTriggerClick);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

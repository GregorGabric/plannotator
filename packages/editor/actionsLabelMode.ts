import type { ActionsLabelMode } from "@plannotator/ui/types";

/** Map the plan area's border-box width to the available action-label space. */
export function actionsLabelModeForWidth(width: number): ActionsLabelMode {
  return width >= 800 ? "full" : width >= 680 ? "short" : "icon";
}

/**
 * Measure and observe action-label space using the element's border box for
 * both the initial read and every ResizeObserver notification.
 */
export function observeActionsLabelMode(
  element: HTMLElement,
  onModeChange: (mode: ActionsLabelMode) => void,
): () => void {
  const update = () => {
    onModeChange(actionsLabelModeForWidth(element.getBoundingClientRect().width));
  };

  update();
  const observer = new ResizeObserver(update);
  observer.observe(element);
  return () => observer.disconnect();
}

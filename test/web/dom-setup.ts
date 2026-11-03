import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

/**
 * jsdom ships without matchMedia; the workbench shells use it for pane layout.
 *
 * It is re-installed before every test rather than once per file: a test that overrides
 * it (the workbench's `viewport()`) would otherwise leave its stub behind, and the next
 * file in the same worker would silently inherit someone else's pane layout. That made
 * coverage depend on file order and worker assignment.
 */
const defaultMatchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

beforeEach(() => {
  window.matchMedia = defaultMatchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = defaultMatchMedia;
});

// Radix panels observe resize; jsdom has no ResizeObserver.
if (!("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// Radix command palette scrolls the active item into view.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

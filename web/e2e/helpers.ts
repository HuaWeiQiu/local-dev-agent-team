import { expect, type Page } from "@playwright/test";

/** On narrow viewports the sidebar is a drawer; open it before touching navigation or the project switcher. */
export async function openNav(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "打开导航" });
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
}

export async function goToWorkspace(page: Page, name: string): Promise<void> {
  await openNav(page);
  await page.getByRole("button", { name, exact: true }).click();
}

export async function selectProject(page: Page, projectId: string): Promise<void> {
  await openNav(page);
  await page.getByRole("button", { name: "当前项目" }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(projectId) }).click();
}

/** Opens a run from the board by (a prefix of) its goal. */
export async function openRun(page: Page, goal: string | RegExp): Promise<void> {
  const name = typeof goal === "string" ? new RegExp(goal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : goal;
  await page.getByRole("button", { name: new RegExp(`打开运行：.*${name.source}`) }).click();
  await expect(page.getByRole("tablist", { name: "运行视图" })).toBeVisible();
}

export async function openRunTab(page: Page, tab: string): Promise<void> {
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

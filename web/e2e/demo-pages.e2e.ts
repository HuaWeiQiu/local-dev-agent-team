import { expect, test, type Page } from "@playwright/test";
import { goToWorkspace, openNav } from "./helpers";

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
}

test("demo mode renders every workspace without errors or horizontal overflow", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/?demo=1");
  await expect(page.getByRole("heading", { name: "看板", level: 1 })).toBeVisible();
  await noHorizontalOverflow(page);

  await openNav(page);
  await page.getByRole("button", { name: "全局设置" }).click();
  await expect(page.getByRole("region", { name: "全局设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent CLI 与角色默认", level: 1 })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /自动检测/ }).first()).toBeChecked();
  await noHorizontalOverflow(page);

  await openNav(page);
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "项目设置" }).click();
  await expect(page.getByRole("heading", { name: "项目角色覆盖", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Jev 本地分流模型" })).toBeVisible();
  await noHorizontalOverflow(page);

  for (const workspace of ["策略编排", "演进工作台", "经验库"]) {
    await goToWorkspace(page, workspace);
    await noHorizontalOverflow(page);
  }

  expect(browserErrors).toEqual([]);
});

import { expect, test } from "@playwright/test";

test("creates, preflights, applies and rolls back an evolution candidate", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByLabel("当前项目")).toBeVisible();
  await page.getByRole("button", { name: "演进工作台", exact: true }).click();
  const workbench = page.getByRole("region", { name: "演进工作台" });
  await expect(workbench).toBeVisible();

  const newCandidateButton = workbench.getByRole("button", { name: "新建", exact: true });
  await newCandidateButton.click();
  const proposalDialog = page.getByRole("dialog");
  await expect(proposalDialog.getByRole("heading", { name: "新建演进候选" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(proposalDialog).toBeHidden();
  await expect(newCandidateButton).toBeFocused();
  await newCandidateButton.click();
  await expect(proposalDialog).toBeVisible();
  const targetName = `balanced-evolved-${testInfo.project.name}`;
  await proposalDialog.getByLabel("候选策略名称").fill(targetName);
  await proposalDialog.getByLabel("最大并行数").fill("3");
  await proposalDialog.getByRole("button", { name: "创建候选" }).click();

  await expect(workbench.getByRole("heading", { name: targetName, exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "开始预检" }).click();
  await workbench.getByRole("tab", { name: "预检" }).click();
  await expect(workbench.getByText("结构预检通过", { exact: true })).toBeVisible();
  await expect(workbench.getByText("此结果只验证结构和本地安全条件，未执行候选策略或提示词。")).toBeVisible();

  let releasePreview: (() => void) | undefined;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  await page.route("**/actions/promote/preview", async (route) => {
    await previewGate;
    await route.continue();
  }, { times: 1 });
  await workbench.getByRole("button", { name: "查看并应用" }).click();
  await expect(workbench.getByLabel("搜索候选")).toBeDisabled();
  await expect(workbench.getByLabel("候选状态筛选")).toBeDisabled();
  releasePreview?.();
  const promoteDialog = page.getByRole("dialog");
  await expect(promoteDialog.getByRole("heading", { name: "确认应用候选" })).toBeVisible();
  await expect(promoteDialog.getByText("当前", { exact: true })).toBeVisible();
  await expect(promoteDialog.getByText("应用后", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-evolution-preview.png`), fullPage: false });
  await promoteDialog.getByLabel("决定理由").fill("已核对精确策略变更");
  await promoteDialog.getByRole("button", { name: "确认应用" }).click();
  await expect(workbench.locator(".evolution-detail-header .status-badge")).toHaveText("已应用");

  await workbench.getByRole("button", { name: "预览回滚" }).click();
  const rollbackDialog = page.getByRole("dialog");
  await expect(rollbackDialog.getByRole("heading", { name: "确认回滚目标" })).toBeVisible();
  await rollbackDialog.getByLabel("决定理由").fill("完成演进界面回归验证");
  await rollbackDialog.getByRole("button", { name: "确认回滚" }).click();
  await expect(workbench.locator(".evolution-detail-header .status-badge")).toHaveText("已回滚");

  if (testInfo.project.name === "mobile") {
    await workbench.getByRole("button", { name: "返回候选列表" }).click();
  }
  await workbench.getByRole("button", { name: "新建", exact: true }).click();
  const promptDialog = page.getByRole("dialog");
  await promptDialog.getByRole("button", { name: "角色提示词" }).click();
  const promptContent = `你好，执行者 👋\n请保持变更可验证。\n${testInfo.project.name}\n`;
  await promptDialog.getByLabel("提示词内容").fill(promptContent);
  await promptDialog.getByRole("button", { name: "创建候选" }).click();
  await expect(workbench.getByRole("heading", { name: "worker.md", exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "开始预检" }).click();
  await expect(workbench.getByRole("button", { name: "查看并应用" })).toBeVisible();
  await workbench.getByRole("button", { name: "查看并应用" }).click();
  const promptPromoteDialog = page.getByRole("dialog");
  await expect(promptPromoteDialog.getByText("prompts/worker.md", { exact: true })).toBeVisible();
  await expect(promptPromoteDialog.locator("pre").first()).toContainText("Original worker prompt");
  await expect(promptPromoteDialog.locator("pre").nth(1)).toContainText("请保持变更可验证");
  await promptPromoteDialog.getByLabel("决定理由").fill("已核对中文提示词精确变更");
  await promptPromoteDialog.getByRole("button", { name: "确认应用" }).click();
  await expect(workbench.locator(".evolution-detail-header .status-badge")).toHaveText("已应用");
  await workbench.getByRole("button", { name: "预览回滚" }).click();
  const promptRollbackDialog = page.getByRole("dialog");
  await expect(promptRollbackDialog.locator("pre").nth(1)).toContainText("Original worker prompt");
  await promptRollbackDialog.getByLabel("决定理由").fill("完成提示词界面回归验证");
  await promptRollbackDialog.getByRole("button", { name: "确认回滚" }).click();
  await expect(workbench.locator(".evolution-detail-header .status-badge")).toHaveText("已回滚");

  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-evolution-workbench.png`),
    fullPage: false,
  });
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
  expect(browserErrors).toEqual([]);
});

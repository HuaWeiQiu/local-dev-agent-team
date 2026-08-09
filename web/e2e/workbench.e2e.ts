import { expect, test } from "@playwright/test";

test("renders and operates the multi-agent workbench", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });

  await page.goto("/");
  const projectSwitcher = page.getByLabel("当前项目");
  await expect(projectSwitcher).toBeVisible();
  await expect(projectSwitcher.locator("option")).toHaveCount(2);
  await projectSwitcher.selectOption("service");
  await expect(page.locator(".canvas-heading h2")).toContainText("独立校验服务接口契约");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "运行", exact: true }).click();
    await expect(
      page.locator(".run-rail").getByText("校验跨服务接口契约与发布边界", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "任务进度" }).first()).toHaveAttribute("aria-valuetext", "1/1 个任务");
  } else {
    await expect(page.getByText("校验跨服务接口契约与发布边界", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "任务进度" }).first()).toHaveAttribute("aria-valuetext", "1/1 个任务");
  }
  const runRail = page.locator(".run-rail");
  await runRail.getByLabel("运行状态筛选").selectOption("attention");
  await expect(runRail.getByText("校验跨服务接口契约与发布边界", { exact: true })).toBeVisible();
  await runRail.getByLabel("运行状态筛选").selectOption("all");
  await runRail.getByRole("button", { name: "清理历史" }).click();
  const cleanupDialog = page.getByRole("dialog");
  await expect(cleanupDialog.getByRole("heading", { name: "清理本地运行历史" })).toBeVisible();
  await cleanupDialog.getByRole("button", { name: "生成预览" }).click();
  await expect(cleanupDialog.getByText("这个保留范围内没有可清理运行")).toBeVisible();
  await expect(cleanupDialog.getByRole("button", { name: "确认删除 0 个运行" })).toBeDisabled();
  await cleanupDialog.getByRole("button", { name: "关闭" }).click();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "任务图" }).click();
  }
  await page.getByRole("button", { name: "处理审批" }).click();
  const approvalDialog = page.getByRole("dialog");
  await expect(approvalDialog.getByRole("heading", { name: "审批交付结果" })).toBeVisible();
  await approvalDialog.getByLabel("操作者").fill("e2e-reviewer");
  await approvalDialog.getByLabel("理由").fill("已核对交付证据");
  await expect(approvalDialog.getByRole("button", { name: "拒绝" })).toBeEnabled();
  await expect(approvalDialog.getByRole("button", { name: "批准" })).toBeEnabled();
  await expect(approvalDialog.getByRole("button", { name: "批准" })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-approval.png`),
    fullPage: false,
  });
  await approvalDialog.getByRole("button", { name: "关闭" }).click();
  await projectSwitcher.selectOption("visual");
  await expect(page.locator(".canvas-heading h2")).toContainText("按依赖波次执行");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("button", { name: "重试为新运行" })).toBeVisible();
    await page.getByRole("button", { name: "详情", exact: true }).click();
  }

  const telemetryHeading = page.getByRole("heading", { name: "资源与追踪" });
  await telemetryHeading.scrollIntoViewIfNeeded();
  await expect(telemetryHeading).toBeVisible();
  await expect(page.getByText("11 / 64", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.4187", { exact: true })).toBeVisible();
  await expect(page.getByText("92cf2896e58c4aa3a63dc1cc7ed949b6", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-telemetry.png`),
    fullPage: false,
  });
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "证据", exact: true }).click();
  } else {
    await page.getByRole("tab", { name: "交付证据" }).click();
  }
  const evidenceCenter = page.getByLabel("交付证据中心");
  await expect(evidenceCenter).toBeVisible();
  await expect(evidenceCenter.getByText("需要处理", { exact: true })).toBeVisible();
  await expect(evidenceCenter.getByRole("table", { name: "任务交付矩阵" })).toBeVisible();
  await evidenceCenter.locator(".artifact-list button").filter({ hasText: "1.log" }).click();
  await expect(evidenceCenter.locator(".evidence-code")).toContainText("refund idempotency regression passed");
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-evidence.png`),
    fullPage: false,
  });
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "任务图" }).click();
  } else {
    await page.getByRole("tab", { name: "任务图" }).click();
  }

  const ledgerNode = page.locator(".react-flow__node").filter({ hasText: "幂等账本" });
  await ledgerNode.click();
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("heading", { name: "任务详情" })).toBeVisible();
    await page.getByRole("button", { name: "任务图" }).click();
  } else {
    await expect(page.getByRole("heading", { name: "任务详情" })).toBeVisible();
  }

  await page.getByRole("button", { name: "新建运行" }).first().click();
  const launcher = page.getByRole("dialog");
  await expect(launcher.getByRole("heading", { name: "启动 Agent 团队" })).toBeVisible();
  await expect(launcher.getByText("balanced", { exact: true })).toBeVisible();
  await expect(launcher.getByText("strict", { exact: true })).toBeVisible();
  await expect(launcher.getByText("MCP 继承：worker", { exact: true })).toBeVisible();
  await launcher.getByText("strict", { exact: true }).click();
  const strictStrategy = launcher.locator(".strategy-segments label").filter({ hasText: "strict" });
  await launcher.getByLabel("目标").focus();
  await page.keyboard.press("Tab");
  await expect(strictStrategy.locator("input")).toBeFocused();
  await expect(strictStrategy).toHaveCSS("outline-style", "solid");
  await launcher.getByRole("button", { name: "角色 Profile 覆盖" }).click();
  await expect(launcher.locator(".profile-grid select")).toHaveCount(5);
  await expect(
    launcher.locator(".profile-grid label").filter({ hasText: "architect" }).locator("option").first(),
  ).toHaveText("策略默认 (claude-reviewer)");
  await expect(launcher.getByRole("button", { name: "启动运行" })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-interop-policy.png`),
    fullPage: false,
  });
  await launcher.getByRole("button", { name: "关闭" }).click();

  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "编排", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "策略编排", exact: true }).click();
  }
  const composer = page.getByRole("region", { name: "策略编排器" });
  await expect(composer).toBeVisible();
  await expect(composer.locator(".strategy-stage-node")).toHaveCount(7);
  await composer.getByLabel("策略模板").selectOption("strict");
  if (testInfo.project.name === "mobile") {
    await composer.getByRole("button", { name: "策略设置", exact: true }).click();
  }
  await expect(composer.getByRole("button", { name: "串行", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(composer.locator(".strategy-stage-node").filter({ hasText: "串行执行" })).toBeVisible();
  const blueprintName = `strict-${testInfo.project.name}`;
  await composer.getByLabel("策略蓝图名称").fill(blueprintName);
  await composer.locator(".policy-toggle input").check();
  await expect(composer.locator(".strategy-stage-node")).toHaveCount(8);
  await expect(composer.locator(".strategy-stage-node").filter({ hasText: "计划审批" })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await composer.getByRole("button", { name: "关闭策略设置" }).click();
  }
  await expect(composer.getByText("草稿待预检", { exact: true })).toBeVisible();
  await composer.getByRole("button", { name: "预检", exact: true }).click();
  await expect(composer.getByText("服务端预检通过", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-strategy-composer.png`),
    fullPage: false,
  });
  if (testInfo.project.name === "desktop") {
    const architectureNode = composer.locator(".strategy-stage-node").filter({ hasText: "任务规划" });
    const approvalNode = composer.locator(".strategy-stage-node").filter({ hasText: "计划审批" });
    const desktopArchitectureBox = await architectureNode.boundingBox();
    const desktopApprovalBox = await approvalNode.boundingBox();
    expect(Math.abs(desktopApprovalBox!.y - desktopArchitectureBox!.y)).toBeLessThan(10);

    await page.setViewportSize({ width: 700, height: 900 });
    await expect(composer.getByLabel("策略模板")).toBeVisible();
    await expect.poll(async () => {
      const architectureBox = await architectureNode.boundingBox();
      const approvalBox = await approvalNode.boundingBox();
      return approvalBox!.y - architectureBox!.y;
    }).toBeGreaterThan(100);
    await page.setViewportSize({ width: 1440, height: 960 });
    await composer.getByRole("button", { name: "策略设置", exact: true }).click();
  }
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(composer.getByText("已保存并编译", { exact: true })).toBeVisible();
  await expect(composer.getByLabel("策略模板")).toHaveValue(blueprintName);
  await expect(composer.locator(".strategy-stage-node")).toHaveCount(8);
  if (testInfo.project.name === "mobile") {
    await composer.getByRole("button", { name: "策略设置", exact: true }).click();
  }
  const architectProfile = composer.locator(".role-policy-list label")
    .filter({ hasText: "architect" })
    .locator("select");
  await architectProfile.selectOption("");
  await architectProfile.selectOption("claude-reviewer");
  await expect(composer.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  await composer.locator(".policy-toggle input").uncheck();
  await expect(composer.locator(".strategy-stage-node")).toHaveCount(7);
  await composer.getByRole("button", { name: "重置策略草稿" }).click();
  await expect(composer.locator(".strategy-stage-node")).toHaveCount(8);
  await composer.getByRole("button", { name: "运行", exact: true }).click();
  const blueprintLauncher = page.getByRole("dialog");
  const savedStrategy = blueprintLauncher.locator(".strategy-segments label").filter({ hasText: blueprintName });
  await expect(savedStrategy.locator("input")).toBeChecked();
  await blueprintLauncher.getByRole("button", { name: "关闭" }).click();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "任务图" }).click();
  } else {
    await page.getByRole("button", { name: "运行监控", exact: true }).click();
  }

  if (testInfo.project.name === "desktop") {
    await page.getByRole("tab", { name: "活动日志" }).click();
    await page.getByRole("tab", { name: /输出/ }).click();
    await expect(page.locator(".output-log")).toContainText("implemented refund idempotency ledger");
  }

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
  expect(browserErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-workbench.png`),
    fullPage: false,
  });
});

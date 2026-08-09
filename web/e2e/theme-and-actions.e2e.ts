import { expect, test, type Page } from "@playwright/test";

const VISUAL_RUN_ID = "run-visual-20260808";

test("dark color scheme renders workbench and strategy composer without errors", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.getByLabel("当前项目")).toBeVisible();
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(lightBackground);
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  // 等待主题切换的 140–160ms 过渡结束，避免截图拍到中间帧
  await page.waitForTimeout(300);

  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-dark-workbench.png`),
    fullPage: false,
  });

  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "编排", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "策略编排", exact: true }).click();
  }
  const composer = page.getByRole("region", { name: "策略编排器" });
  await expect(composer).toBeVisible();
  await expect(composer.locator(".strategy-stage-node").first()).toBeVisible();
  if (testInfo.project.name === "mobile") {
    const controlsBox = await composer.locator(".react-flow__controls").boundingBox();
    const summaryBox = await composer.locator(".composer-canvas-summary").boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(summaryBox!.y);
  }
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-dark-strategy.png`),
    fullPage: false,
  });

  if (testInfo.project.name === "mobile") {
    await page.getByLabel("移动端视图").getByRole("button", { name: "运行", exact: true }).click();
    await page.getByLabel("移动端视图").getByRole("button", { name: "用量", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "运行监控", exact: true }).click();
    await page.getByRole("tab", { name: "用量" }).click();
  }
  await expect(page.getByLabel("用量与成本")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-dark-usage.png`),
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

test("theme toggle cycles modes and persists the explicit choice", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "切换主题" });
  await expect(toggle).toBeVisible();
  const html = page.locator("html");
  const storedTheme = () => page.evaluate(() => localStorage.getItem("agent-team-theme"));

  // 初始为跟随系统：不写 data-theme
  await expect(html).not.toHaveAttribute("data-theme", /./);

  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect.poll(storedTheme).toBe("light");

  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect.poll(storedTheme).toBe("dark");

  // 刷新后显式选择仍然生效
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(storedTheme).toBe("dark");

  await page.getByRole("button", { name: "切换主题" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  await expect.poll(storedTheme).toBe("system");
});

test("cancel issues a cancel request for the active run", async ({ page }) => {
  let cancelRequested = false;
  // 把运行详情拦截为 implementing（活跃）状态，取消按钮才会出现；
  // 其余请求继续走真实 fixture 服务
  await page.route(`**/runs/${VISUAL_RUN_ID}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.run.status = "implementing";
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/runs/${VISUAL_RUN_ID}/actions/cancel`, async (route) => {
    cancelRequested = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: VISUAL_RUN_ID, status: "cancel-requested" }),
    });
  });

  await page.goto("/");
  const cancelButton = topbarAction(page, /取消/);
  await expect(cancelButton).toBeVisible();
  await cancelButton.click();
  await expect.poll(() => cancelRequested).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("retry issues a retry request for a retryable run", async ({ page }, testInfo) => {
  let retryRequested = false;
  // fixture 运行带有过期的 supervisorId，服务启动恢复后处于 interrupted（可重试）
  await page.route(`**/runs/${VISUAL_RUN_ID}/actions/retry`, async (route) => {
    retryRequested = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: VISUAL_RUN_ID, deduplicated: false }),
    });
  });

  await page.goto("/");
  if (testInfo.project.name === "desktop") {
    await expect(page.getByText("已中断", { exact: true }).first()).toBeVisible();
  }
  const retryButton = topbarAction(page, /重试/);
  await expect(retryButton).toBeVisible();
  await retryButton.click();
  await expect.poll(() => retryRequested).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** 顶栏操作按钮：桌面端取按钮文本，移动端取 title 兜底的可访问名。 */
function topbarAction(page: Page, name: RegExp) {
  return page.locator(".topbar-actions").getByRole("button", { name });
}

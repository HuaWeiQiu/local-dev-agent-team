import { expect, test } from "@playwright/test";

const VISUAL_RUN_ID = "run-visual-20260808";

test("export button downloads the run event log as NDJSON", async ({ page }, testInfo) => {
  let exportRequested = false;
  await page.route(`**/runs/${VISUAL_RUN_ID}/export`, async (route) => {
    exportRequested = true;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      headers: { "Content-Disposition": `attachment; filename="${VISUAL_RUN_ID}.ndjson"` },
      body: `${JSON.stringify({
        sequence: 1,
        id: "evt-export",
        schemaVersion: 1,
        runId: VISUAL_RUN_ID,
        type: "run.queued",
        occurredAt: new Date().toISOString(),
        payload: {},
      })}\n`,
    });
  });

  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "日志", exact: true }).click();
  } else {
    await page.getByRole("tab", { name: "活动日志" }).click();
  }
  const exportButton = page.getByRole("button", { name: "导出日志" });
  await expect(exportButton).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${VISUAL_RUN_ID}.ndjson`);
  expect(exportRequested).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("usage panel aggregates telemetry across runs", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "用量", exact: true }).click();
  } else {
    await page.getByRole("tab", { name: "用量" }).click();
  }
  const panel = page.getByLabel("用量与成本");
  await expect(panel).toBeVisible();
  // 用量按当前项目聚合：visual fixture 运行带 agentInvocations 11、inputTokens 48,220、cost 0.4187
  await expect(panel.locator(".usage-card.is-emphasis strong")).toHaveText("$0.4187");
  await expect(panel.getByText("11", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("48,220", { exact: true })).toBeVisible();
  await expect(panel.getByText("8,430", { exact: true })).toBeVisible();
  await expect(panel.getByText("实现订单退款幂等控制并提供可视化审计")).toBeVisible();
  await expect(panel.getByText("1 个运行")).toBeVisible();
  await expect(page.getByRole("table", { name: "按运行聚合的用量" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-usage.png`),
    fullPage: false,
  });
});

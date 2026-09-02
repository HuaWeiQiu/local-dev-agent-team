export interface GoalTemplate {
  id: "fix" | "feature" | "test";
  title: string;
  summary: string;
  strategy: "strict" | "balanced";
  goal: string;
}

export const goalTemplates: GoalTemplate[] = [
  {
    id: "fix",
    title: "修缺陷",
    summary: "小范围路径，正式 PR，必须补测试",
    strategy: "strict",
    goal:
      "修复一个明确缺陷：写清复现、期望行为和涉及路径。不要改无关模块，不要动 .github/workflows 与密钥文件。补齐能锁住回归的测试；pnpm check 与 pnpm test 必须通过。",
  },
  {
    id: "feature",
    title: "做功能",
    summary: "可并行拆任务，计划可审批",
    strategy: "balanced",
    goal:
      "实现一个完整功能：写清用户可见结果、范围和验收。列出主要路径与不要改的边界。拆成可并行的任务，补测试；本地 check/test 必须通过后再提正式 PR。",
  },
  {
    id: "test",
    title: "补测试 / 重构",
    summary: "少改行为，优先覆盖和清理",
    strategy: "strict",
    goal:
      "在不改变对外行为的前提下补测试或做小范围重构。写清现有行为、要覆盖的路径和禁止改动的公共 API。不要扩大范围；检查与测试必须保持绿色。",
  },
];

export function goalTemplateById(id: string): GoalTemplate | undefined {
  return goalTemplates.find((item) => item.id === id);
}

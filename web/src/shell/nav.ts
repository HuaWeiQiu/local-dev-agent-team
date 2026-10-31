export type WorkspaceMode = "monitor" | "design" | "evolution" | "experience" | "project" | "settings";

export const workspaceTitles: Record<WorkspaceMode, { title: string; hint: string }> = {
  monitor: { title: "看板", hint: "所有运行与需要你处理的事项" },
  design: { title: "策略编排", hint: "拓扑与执行政策" },
  evolution: { title: "演进工作台", hint: "候选、预检与人工门禁" },
  experience: { title: "经验库", hint: "候选晋升与跨项目共享" },
  project: { title: "项目设置", hint: "当前项目的角色覆盖" },
  settings: { title: "全局设置", hint: "本机 CLI 与角色默认" },
};

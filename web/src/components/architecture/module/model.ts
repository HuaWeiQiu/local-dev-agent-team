import {
  ARCHITECTURE_KIND_LABEL,
  ARCHITECTURE_RELATION_LABEL,
  type ArchitectureDiagram,
  type ArchitectureEdge,
} from "../../../architecture";

export function moduleById(diagram: ArchitectureDiagram, moduleId: string) {
  return diagram.boxes.find((box) => box.id === moduleId);
}

/** A module's label, falling back to the raw id for an unknown one. */
export function labelOf(diagram: ArchitectureDiagram, id: string): string {
  return moduleById(diagram, id)?.label ?? id;
}

export function incomingEdges(diagram: ArchitectureDiagram, moduleId: string): ArchitectureEdge[] {
  return diagram.edges.filter((edge) => edge.to === moduleId);
}

export function outgoingEdges(diagram: ArchitectureDiagram, moduleId: string): ArchitectureEdge[] {
  return diagram.edges.filter((edge) => edge.from === moduleId);
}

export function kindPrefix(kind: string | undefined): string {
  return kind ? `${ARCHITECTURE_KIND_LABEL[kind as keyof typeof ARCHITECTURE_KIND_LABEL]} · ` : "";
}

export function relationSuffix(kind: string | undefined): string {
  if (!kind) return "";
  return ` · ${ARCHITECTURE_RELATION_LABEL[kind as keyof typeof ARCHITECTURE_RELATION_LABEL]}`;
}

export function responsibilityOf(module: { responsibility?: string }): string {
  return module.responsibility ?? "这个元素来自任务路径的推断。点下面的任务看具体改动、门禁和评审。";
}

/** Paths shown for a module: the repository index path first, then declared ones. */
export function pathRows(
  module: { paths: string[] },
  indexed: string | undefined,
): Array<{ label: string; value: string }> {
  return [
    ...(indexed ? [{ label: "索引", value: indexed }] : []),
    ...module.paths.map((path) => ({ label: "路径", value: path })),
  ];
}

import {
  ARCHITECTURE_SOURCE_LABEL,
  type ArchitectureBox,
  type ArchitectureDiagram,
  type ArchitectureEdge,
  type ArchitecturePresentation,
} from "../../../architecture";
import type { RepoTrace } from "../../../types";
import { cn } from "../../../ui/cn";
import {
  boxFooter,
  boxSubtitle,
  edgeGeometry,
  moduleForPath,
  STATUS_DOT,
  STATUS_LABEL,
} from "./model";

type ArchitectureSource = ArchitecturePresentation["source"];

export const SOURCE_HINT: Record<ArchitectureSource, string> = {
  architect: "架构师给出的系统设计。点一个元素，看职责、上下游和正在做的任务。",
  controller: "目标已经写明路径，控制面直接生成了这份结构。",
  inferred: "没有设计稿时按任务路径推断；补上架构设计会更准。",
};

export function DiagramHeader({
  source,
  summary,
}: {
  source: ArchitectureSource;
  summary: string | undefined;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-xs font-medium text-ink-2">系统架构</h3>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-muted">
          {ARCHITECTURE_SOURCE_LABEL[source]}
        </span>
      </div>
      {summary && <p className="m-0 mt-1 text-xs text-ink-2">{summary}</p>}
      {source !== "architect" && (
        <p className="m-0 mt-1 text-xs text-muted">{SOURCE_HINT[source]}</p>
      )}
    </>
  );
}

export function TraceIndex({
  trace,
  diagram,
  focused,
  onSelectModule,
}: {
  trace: RepoTrace;
  diagram: ArchitectureDiagram;
  focused: string | undefined;
  onSelectModule(id: string): void;
}) {
  const paths = trace.nodes.map((node) => node.path);
  if (paths.length === 0) return null;
  return (
    <div className="bd mt-2 overflow-hidden rounded-lg">
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 bg-surface-2 px-3 py-1.5 text-2xs text-muted">
        <span>索引</span>
        <span>{trace.matched ? "目标命中" : "仓库目录"}</span>
      </div>
      <ul className="m-0 list-none divide-y p-0">
        {tracePaths(trace).map((path) => (
          <TraceRow
            key={path}
            path={path}
            moduleId={moduleForPath(diagram.boxes, path)}
            active={focused !== undefined && moduleForPath(diagram.boxes, path) === focused}
            onSelectModule={onSelectModule}
          />
        ))}
      </ul>
    </div>
  );
}

function TraceRow({
  path,
  moduleId,
  active,
  onSelectModule,
}: {
  path: string;
  moduleId: string | undefined;
  active: boolean;
  onSelectModule(id: string): void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => moduleId && onSelectModule(moduleId)}
        className={cn(
          "grid w-full cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left hover:bg-surface-2 focus-ring",
          active && "bg-surface-2",
        )}
      >
        <span className="text-2xs text-muted">路径</span>
        <code className={cn("truncate text-xs", active ? "text-ink" : "text-ink-2")}>{path}</code>
      </button>
    </li>
  );
}

function tracePaths(trace: RepoTrace): string[] {
  const paths = trace.nodes.map((node) => node.path).filter((item) => item.length > 0);
  return paths
    .filter((path) => !paths.some((other) => other !== path && other.startsWith(`${path}/`)))
    .slice(0, 8);
}

export function ViewSwitch({
  view,
  focused,
  focusedName,
  onSelectView,
  onClearModule,
}: {
  view: "structure" | "sequence";
  focused: string | undefined;
  focusedName: string | undefined;
  onSelectView(view: "structure" | "sequence"): void;
  onClearModule: (() => void) | undefined;
}) {
  return (
    <div className="mb-3 mt-2 flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="架构视图">
        {(["structure", "sequence"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={view === item}
            onClick={() => onSelectView(item)}
            className={cn(
              "cursor-pointer rounded-md px-3 py-1 text-xs focus-ring",
              view === item ? "bg-surface font-medium text-ink shadow-sm" : "border-0 bg-transparent text-muted",
            )}
          >
            {item === "structure" ? "结构" : "时序"}
          </button>
        ))}
      </div>
      {focused && (
        <span className="text-xs text-ink-2">
          下钻 {focusedName ?? focused}
          {onClearModule && (
            <button
              type="button"
              onClick={onClearModule}
              className="ml-2 cursor-pointer border-0 bg-transparent p-0 text-accent-ink hover:underline focus-ring"
            >
              看整个系统
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function EdgeLayer({
  diagram,
  boxOf,
  focused,
  neighborhood,
}: {
  diagram: ArchitectureDiagram;
  boxOf: Map<string, ArchitectureBox>;
  focused: string | undefined;
  neighborhood: Set<string>;
}) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0" width={diagram.width} height={diagram.height}>
      <defs>
        <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted)" />
        </marker>
      </defs>
      {diagram.edges.map((edge) => (
        <EdgePath
          key={`${edge.from}-${edge.to}-${edge.kind ?? "link"}`}
          edge={edge}
          boxOf={boxOf}
          focused={focused}
          neighborhood={neighborhood}
        />
      ))}
    </svg>
  );
}

function EdgePath({
  edge,
  boxOf,
  focused,
  neighborhood,
}: {
  edge: ArchitectureEdge;
  boxOf: Map<string, ArchitectureBox>;
  focused: string | undefined;
  neighborhood: Set<string>;
}) {
  const from = boxOf.get(edge.from);
  const to = boxOf.get(edge.to);
  if (!from || !to) return null;
  const geometry = edgeGeometry(edge, from, to);
  return (
    <g opacity={isEdgeFaded(edge, focused, neighborhood) ? 0.25 : 1}>
      <path
        d={`M ${geometry.x1} ${geometry.y1} C ${geometry.x1} ${geometry.mid}, ${geometry.x2} ${geometry.mid}, ${geometry.x2} ${geometry.y2 - 2}`}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={1.5}
        markerEnd="url(#arch-arrow)"
      />
      {geometry.caption && <EdgeCaption geometry={geometry} caption={geometry.caption} />}
    </g>
  );
}

/** Outside the drill-down neighbourhood: dim the relation. */
export function isEdgeFaded(
  edge: ArchitectureEdge,
  focused: string | undefined,
  neighborhood: Set<string>,
): boolean {
  if (!focused) return false;
  return !neighborhood.has(edge.from) || !neighborhood.has(edge.to);
}

function EdgeCaption({
  geometry,
  caption,
}: {
  geometry: ReturnType<typeof edgeGeometry>;
  caption: string;
}) {
  return (
    <text
      x={captionX(geometry)}
      y={captionY(geometry)}
      textAnchor={geometry.vertical ? "start" : "middle"}
      fill="var(--muted)"
      fontSize={10}
    >
      {caption}
    </text>
  );
}

function captionX(geometry: ReturnType<typeof edgeGeometry>): number {
  if (geometry.vertical) return Math.max(geometry.x1, geometry.x2) + 10;
  return (geometry.x1 + geometry.x2) / 2;
}

function captionY(geometry: ReturnType<typeof edgeGeometry>): number {
  return geometry.vertical ? geometry.mid + 3 : geometry.mid - 4;
}

export function BoxLayer({
  boxes,
  selectedModuleId,
  focused,
  neighborhood,
  onSelectModule,
}: {
  boxes: ArchitectureBox[];
  selectedModuleId: string | undefined;
  focused: string | undefined;
  neighborhood: Set<string>;
  onSelectModule(id: string): void;
}) {
  return (
    <>
      {boxes.map((box) => (
        <ModuleBox
          key={box.id}
          box={box}
          selected={selectedModuleId === box.id}
          faded={focused !== undefined && !neighborhood.has(box.id)}
          onSelectModule={onSelectModule}
        />
      ))}
    </>
  );
}

function ModuleBox({
  box,
  selected,
  faded,
  onSelectModule,
}: {
  box: ArchitectureBox;
  selected: boolean;
  faded: boolean;
  onSelectModule(id: string): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectModule(box.id)}
      aria-pressed={selected}
      className={cn(
        "absolute flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-solid bg-surface-2 px-3 py-2 text-left hover:bg-surface focus-ring",
        selected && "border-accent outline-2 outline-offset-2 outline-accent",
        box.status === "blocked" && "border-danger/40",
        box.status === "working" && "border-accent/50",
        faded && "opacity-30",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="flex w-full items-center gap-1.5">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[box.status])} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{box.label}</span>
      </span>
      <span className="line-clamp-2 text-2xs leading-snug text-ink-2">{boxSubtitle(box)}</span>
      <span className="text-2xs text-muted">{boxFooter(box)}</span>
    </button>
  );
}

export { STATUS_LABEL };

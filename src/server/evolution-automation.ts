// Thin server-side shell for the automatic evolution controller.
//
// The controller itself lives in the evolution layer
// (../evolution/automatic-controller.js) and depends on the server only
// through the structural AutomaticEvolutionHost interface; RunSupervisor
// satisfies it directly, supplying session binding (beginAutomationSession),
// supervisor ownership acquisition (beginEvolutionMutation), and the
// command-idempotency event log. This module remains the stable entry point
// for HTTP/control-plane callers (http.ts, evolution-service.ts).

export {
  AutomaticEvolutionController,
  AutomaticEvolutionError,
} from "../evolution/automatic-controller.js";
export type {
  AutomaticEvolutionCommandEvents,
  AutomaticEvolutionDependencies,
  AutomaticEvolutionErrorCode,
  AutomaticEvolutionHost,
  AutomaticEvolutionRunRequest,
  AutomaticEvolutionRunSession,
  AutomaticProposalContext,
} from "../evolution/automatic-controller.js";

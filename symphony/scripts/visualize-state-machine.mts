#!/usr/bin/env node --experimental-strip-types
/**
 * visualize-state-machine.mts — Print the Symphony ticket-lifecycle XState
 * machine config as JSON. Pipe into the stately.ai online visualizer (or
 * `npx @statelyai/inspect`) to render the chart.
 *
 *   node --experimental-strip-types symphony/scripts/visualize-state-machine.mts
 *
 * The machine itself is defined in state-machine.mts and is the single source
 * of truth for which states + transitions exist.
 */
import { ticketMachine } from './state-machine.mts';

const out = {
  id: ticketMachine.id,
  initial: ticketMachine.config.initial,
  states: ticketMachine.config.states,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');

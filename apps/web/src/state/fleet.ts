import { createFleetEnvironmentAtoms } from "@t3tools/client-runtime/state/fleet";

import { connectionAtomRuntime } from "../connection/runtime";

export const fleetEnvironment = createFleetEnvironmentAtoms(connectionAtomRuntime);

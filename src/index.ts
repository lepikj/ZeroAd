/**
 * ZeroAd: Main Entry Point (Cron Handler & Router Glue)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Bindings } from "./types";
import { SyncEngine } from "./engine";
import router from "./router";

export default {
  /**
   * Cron Trigger Handler: Orchestrates the background sync cycle.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const engine = new SyncEngine(env);

    // Concurrency Lock: Ensure only one worker is active at a time
    if (await engine.isLocked()) {
      console.log("Another worker is active. Skipping cron run.");
      return;
    }

    // Process the next step in the state machine
    await engine.processNextStep();
  },

  /**
   * HTTP Fetch Handler: Delegates all requests to the Hono router.
   */
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return router.fetch(request, env, ctx);
  },
};

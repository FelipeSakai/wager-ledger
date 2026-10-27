// Test-only preload: production entrypoints and dependencies are otherwise real.
// No fault-injection environment switch is interpreted by production code.
import { OperationalTelemetry } from '../../src/modules/financial/infrastructure/observability/operational-telemetry';
import { OperationalService } from '../../src/platform/observability/operational-service';

const observe = OperationalTelemetry.prototype.observe;
OperationalTelemetry.prototype.observe = function (input) {
  observe.call(this, input);
  if (input.event === 'service_started')
    process.send?.({ type: 'READY', role: this.role, pid: process.pid });
};
const close = OperationalService.prototype.close;
OperationalService.prototype.close = async function () {
  await close.call(this);
  process.send?.({ type: 'CLEANUP_ENTERED', pid: process.pid });
  if (process.env.WAGER_TEST_CLEANUP === 'failed') {
    setInterval(() => {}, 1000);
    throw new Error('Injected cleanup failure with an open handle');
  }
  if (process.env.WAGER_TEST_CLEANUP === 'stalled') {
    // A hung resource keeps the event loop alive, like an open server/socket.
    await new Promise<void>(() => {
      setInterval(() => {}, 1000);
    });
  }
};

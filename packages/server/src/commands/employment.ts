import type { CommandHandlers } from "../sync.js";
import { extraWorkCommandHandler } from "./extra-work.js";
import { manualAdjustmentCommandHandler } from "./manual-adjustment.js";
import { recordPaymentHandler } from "./payment.js";
import { settlementCommandHandler } from "./settlement.js";
import { agreementCommandHandler, vacationCommandHandler } from "./vacation.js";

/**
 * Mapa de handlers del expediente laboral y pago (oleada 2) listo para
 * enchufarse a la ruta de sync: `processSyncBatch(pool, principal, commands,
 * { ...employmentCommandHandlers, expense: submitExpenseHandler })`.
 */
export const employmentCommandHandlers: CommandHandlers = {
  extra_work: extraWorkCommandHandler,
  settlement: settlementCommandHandler,
  payment: recordPaymentHandler,
  leave_request: vacationCommandHandler,
  agreement: agreementCommandHandler,
  manual_adjustment: manualAdjustmentCommandHandler,
};
